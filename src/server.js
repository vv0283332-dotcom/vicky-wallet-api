import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";

import { PaymentService } from "./payments/payment-service.js";
import { WebhookService } from "./payments/webhook-service.js";
import { FlutterwaveProvider } from "./payments/providers/flutterwave-provider.js";
import { createEarningsService } from "./earnings/earnings-service.js";

import {
  providerStatus,
  monoConfigured,
  createMonoSession,
  exchangeMonoCode,
  getMonoAccount,
  opayConfigured,
  getOpayWalletBalance
} from "./providers/financial-provider.js";

const app = express();

/* ================= SECURITY HARDENING ================= */

app.disable("x-powered-by");

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

app.use(express.json({
  limit: "100kb",
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

app.use(express.urlencoded({
  extended: false,
  limit: "50kb"
}));

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error: "Too many requests. Please try again later."
  }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: {
    error: "Too many authentication attempts. Please try again later."
  }
});

app.use(globalLimiter);


const PORT = Number(process.env.PORT || 5000);
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is missing");
}

app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(morgan("combined"));

// Support both /auth/... and /api/auth/... routes.
// The existing Vite frontend uses the /api prefix.
app.use((req, res, next) => {
  if (req.url === "/api" || req.url.startsWith("/api/")) {
    req.url = req.url.slice(4) || "/";
  }
  next();
});

const dataDir = new URL("../data/", import.meta.url).pathname;
await import("node:fs/promises").then(fs => fs.mkdir(dataDir, { recursive: true }));
const db = new DatabaseSync(new URL("../data/vicky-wallet.sqlite", import.meta.url).pathname);
try {
  const usersTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'"
  ).get();

  if (usersTable) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code
      ON users(referral_code)
      WHERE referral_code IS NOT NULL;
    `);
  } else {
    console.warn("Referral-code index deferred until users table exists.");
  }
} catch (error) {
  console.warn("Referral-code index deferred:", error.message);
}

const paymentProviders = {
  flutterwave: new FlutterwaveProvider()
};

const paymentService = new PaymentService(db, paymentProviders);
const earningsService = createEarningsService(db);
const webhookService = new WebhookService(db);


db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  account_id TEXT UNIQUE,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  balance REAL NOT NULL DEFAULT 0,
  referral_code TEXT UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_notifications_user
ON notifications(user_id, read, created_at DESC);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  description TEXT,
  related_user_id TEXT,
  status TEXT NOT NULL DEFAULT 'completed',
  created_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS payment_intents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_reference TEXT,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('deposit','withdrawal')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','processing','completed','failed','cancelled')),
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_provider_reference
ON payment_intents(provider, provider_reference)
WHERE provider_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_intents_user
ON payment_intents(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  payment_intent_id TEXT,
  transaction_id TEXT,
  entry_type TEXT NOT NULL CHECK(entry_type IN ('credit','debit')),
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(payment_intent_id) REFERENCES payment_intents(id),
  FOREIGN KEY(transaction_id) REFERENCES transactions(id)
);

CREATE INDEX IF NOT EXISTS idx_ledger_user
ON ledger_entries(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS payment_webhooks (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_event_id TEXT,
  event_type TEXT,
  payload_hash TEXT NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  processed_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_provider_event
ON payment_webhooks(provider, provider_event_id)
WHERE provider_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_webhooks_hash
ON payment_webhooks(payload_hash);

CREATE INDEX IF NOT EXISTS idx_transactions_user
ON transactions(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS referral_codes (
  user_id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS referrals (
  id TEXT PRIMARY KEY,
  referrer_id TEXT NOT NULL,
  referred_id TEXT NOT NULL UNIQUE,
  referral_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  qualifying_payment_id TEXT,
  reward_amount REAL NOT NULL DEFAULT 5,
  reward_currency TEXT NOT NULL DEFAULT 'USD',
  rewarded_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(referrer_id) REFERENCES users(id),
  FOREIGN KEY(referred_id) REFERENCES users(id),
  FOREIGN KEY(qualifying_payment_id) REFERENCES payment_intents(id)
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer
ON referrals(referrer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS earning_transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  description TEXT NOT NULL,
  referral_id TEXT,
  transaction_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(referral_id) REFERENCES referrals(id),
  FOREIGN KEY(transaction_id) REFERENCES transactions(id)
);

CREATE INDEX IF NOT EXISTS idx_earning_transactions_user
ON earning_transactions(user_id, created_at DESC);

`);

const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();

function createNotification({
  userId,
  type = "activity",
  title,
  message
}) {
  if (!userId || !title || !message) return null;

  const notificationId = id();

  db.prepare(`
    INSERT INTO notifications
    (id, user_id, type, title, message, read, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?)
  `).run(
    notificationId,
    userId,
    String(type),
    String(title),
    String(message),
    now()
  );

  return notificationId;
}

function notifyOwner({
  type = "owner_activity",
  title,
  message
}) {
  const ownerEmail = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();

  if (!ownerEmail) {
    console.warn("ADMIN_EMAIL is not configured; owner notification skipped.");
    return null;
  }

  const owner = db.prepare(`
    SELECT id
    FROM users
    WHERE lower(email) = lower(?)
    LIMIT 1
  `).get(ownerEmail);

  if (!owner) {
    console.warn("Owner account not found for ADMIN_EMAIL:", ownerEmail);
    return null;
  }

  return createNotification({
    userId: owner.id,
    type,
    title,
    message
  });
}

const moveWalletFunds = ({
  senderId,
  recipientId,
  amount,
  description = "Wallet transfer",
  currency
}) => {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Invalid transfer amount");
  }

  db.exec("BEGIN");

  try {
    const sender = db.prepare(`
      SELECT id, account_id, balance, currency
      FROM users
      WHERE id = ?
    `).get(senderId);

    const recipient = db.prepare(`
      SELECT id, account_id, full_name, balance, currency
      FROM users
      WHERE id = ?
    `).get(recipientId);

    if (!sender) throw new Error("Sender not found");
    if (!recipient) throw new Error("Recipient not found");

    if (sender.id === recipient.id) {
      throw new Error("You cannot transfer to yourself");
    }

    if (Number(sender.balance) < amount) {
      throw new Error("Insufficient balance");
    }

    const createdAt = now();
    const sentId = id();
    const receivedId = id();

    const debit = db.prepare(`
      UPDATE users
      SET balance = balance - ?
      WHERE id = ? AND balance >= ?
    `).run(amount, sender.id, amount);

    if (Number(debit.changes) !== 1) {
      throw new Error("Transfer could not debit sender balance");
    }

    const credit = db.prepare(`
      UPDATE users
      SET balance = balance + ?
      WHERE id = ?
    `).run(amount, recipient.id);

    if (Number(credit.changes) !== 1) {
      throw new Error("Transfer could not credit recipient balance");
    }

    db.prepare(`
      INSERT INTO transactions
      (id,user_id,type,amount,currency,description,related_user_id,status,created_at)
      VALUES (?, ?, 'transfer_sent', ?, ?, ?, ?, 'completed', ?)
    `).run(
      sentId,
      sender.id,
      amount,
      currency || sender.currency,
      description,
      recipient.id,
      createdAt
    );

    db.prepare(`
      INSERT INTO transactions
      (id,user_id,type,amount,currency,description,related_user_id,status,created_at)
      VALUES (?, ?, 'transfer_received', ?, ?, ?, ?, 'completed', ?)
    `).run(
      receivedId,
      recipient.id,
      amount,
      currency || recipient.currency,
      description,
      sender.id,
      createdAt
    );

    db.exec("COMMIT");

    return {
      transaction_id: sentId,
      received_transaction_id: receivedId
    };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}

    throw error;
  }
};

function email(value) {
  return String(value || "").trim().toLowerCase();
}

function amount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= 100000000;
}

function token(user) {
  return jwt.sign(
    { sub: user.id, email: user.email },
    JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
  );
}

function userData(user) {
  return {
    id: user.id,
    account_id: user.account_id,
    full_name: user.full_name,
    email: user.email,
    currency: user.currency,
    balance: Number(user.balance),
    referral_code: user.referral_code || null,
    created_at: user.created_at
  };
}

function auth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const accessToken = header.startsWith("Bearer ")
      ? header.slice(7)
      : req.cookies?.token;

    if (!accessToken) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const payload = jwt.verify(accessToken, JWT_SECRET);

    const user = db.prepare(`
      SELECT id, account_id, full_name, email, currency, balance, referral_code, created_at
      FROM users WHERE id = ?
    `).get(payload.sub);

    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }

    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

app.get("/", (req, res) => {
  res.json({
    name: "Vicky Pay API",
    status: "online",
    database: "SQLite",
    version: "2.0.0"
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    database: "SQLite",
    time: now()
  });
});


function generateReferralCode(fullName = "") {
  const clean = String(fullName)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  const prefix = clean.slice(0, 4) || "VICKY";

  let code;

  do {
    const random = crypto.randomBytes(3).toString("hex").toUpperCase();
    code = `${prefix}-${random}`;
  } while (
    db.prepare("SELECT 1 FROM referral_codes WHERE code = ?").get(code)
  );

  return code;
}

function ensureReferralCode(userId, fullName = "") {
  const existing = db.prepare(`
    SELECT code
    FROM referral_codes
    WHERE user_id = ?
  `).get(userId);

  if (existing) return existing.code;

  const code = generateReferralCode(fullName);

  db.prepare(`
    INSERT INTO referral_codes
    (user_id, code, created_at)
    VALUES (?, ?, ?)
  `).run(userId, code, now());

  return code;
}

function createReferral({
  referrerId,
  referredId,
  referralCode
}) {
  if (!referrerId || !referredId || !referralCode) {
    return null;
  }

  if (referrerId === referredId) {
    return null;
  }

  const existing = db.prepare(`
    SELECT *
    FROM referrals
    WHERE referred_id = ?
    LIMIT 1
  `).get(referredId);

  if (existing) return existing;

  const referrer = db.prepare(`
    SELECT id
    FROM users
    WHERE id = ?
    LIMIT 1
  `).get(referrerId);

  if (!referrer) return null;

  const referral = {
    id: id(),
    referrerId,
    referredId,
    referralCode: String(referralCode).trim().toUpperCase()
  };

  db.prepare(`
    INSERT INTO referrals
    (
      id,
      referrer_id,
      referred_id,
      referral_code,
      status,
      reward_amount,
      reward_currency,
      created_at
    )
    VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
  `).run(
    referral.id,
    referral.referrerId,
    referral.referredId,
    referral.referralCode,
    Number(process.env.REFERRAL_REWARD_AMOUNT || 5),
    String(process.env.REFERRAL_REWARD_CURRENCY || "USD").toUpperCase(),
    now()
  );

  return db.prepare(`
    SELECT *
    FROM referrals
    WHERE id = ?
  `).get(referral.id);
}

function rewardReferralForDeposit({
  referredUserId,
  paymentIntentId
}) {
  const minDeposit = Number(
    process.env.REFERRAL_MIN_DEPOSIT || 20
  );

  const rewardAmount = Number(
    process.env.REFERRAL_REWARD_AMOUNT || 5
  );

  const rewardCurrency = String(
    process.env.REFERRAL_REWARD_CURRENCY || "USD"
  ).toUpperCase();

  const referral = db.prepare(`
    SELECT *
    FROM referrals
    WHERE referred_id = ?
      AND status = 'pending'
    LIMIT 1
  `).get(referredUserId);

  if (!referral) return null;

  if (Number(referral.reward_amount) !== rewardAmount) {
    return null;
  }

  if (
    String(referral.reward_currency).toUpperCase() !==
    rewardCurrency
  ) {
    return null;
  }

  const payment = db.prepare(`
    SELECT *
    FROM payment_intents
    WHERE id = ?
      AND status = 'completed'
    LIMIT 1
  `).get(paymentIntentId);

  if (!payment) return null;

  if (Number(payment.amount) < minDeposit) {
    return null;
  }

  if (
    String(payment.currency).toUpperCase() !==
    rewardCurrency
  ) {
    return null;
  }

  const referrer = db.prepare(`
    SELECT *
    FROM users
    WHERE id = ?
    LIMIT 1
  `).get(referral.referrer_id);

  if (!referrer) return null;

  const referred = db.prepare(`
    SELECT *
    FROM users
    WHERE id = ?
    LIMIT 1
  `).get(referredUserId);

  if (!referred) return null;

  if (referrer.id === referred.id) return null;

  const existingReward = db.prepare(`
    SELECT *
    FROM earning_transactions
    WHERE referral_id = ?
      AND type = 'referral_reward'
    LIMIT 1
  `).get(referral.id);

  if (existingReward) {
    db.prepare(`
      UPDATE referrals
      SET status = 'rewarded',
          qualifying_payment_id = COALESCE(qualifying_payment_id, ?),
          rewarded_at = COALESCE(rewarded_at, ?)
      WHERE id = ?
        AND status = 'pending'
    `).run(
      paymentIntentId,
      existingReward.created_at || now(),
      referral.id
    );

    return {
      already_rewarded: true,
      referral,
      earning: existingReward
    };
  }

  const earningId = id();
  const createdAt = now();

  db.prepare(`
    INSERT INTO earning_transactions
    (
      id,
      user_id,
      type,
      amount,
      currency,
      description,
      referral_id,
      transaction_id,
      created_at
    )
    VALUES (?, ?, 'referral_reward', ?, ?, ?, ?, NULL, ?)
  `).run(
    earningId,
    referrer.id,
    rewardAmount,
    rewardCurrency,
    `Earned ${rewardCurrency} ${rewardAmount} referral reward from ${referred.full_name}`,
    referral.id,
    createdAt
  );

  db.prepare(`
    UPDATE referrals
    SET
      status = 'rewarded',
      qualifying_payment_id = ?,
      rewarded_at = ?
    WHERE id = ?
      AND status = 'pending'
  `).run(
    paymentIntentId,
    createdAt,
    referral.id
  );

  return {
    already_rewarded: false,
    referral_id: referral.id,
    earning_id: earningId,
    referrer_user_id: referrer.id,
    referred_user_id: referred.id,
    amount: rewardAmount,
    currency: rewardCurrency
  };
}


function generateAccountId() {
  let accountId;

  do {
    accountId =
      "VW-" +
      Math.floor(10000000 + Math.random() * 90000000);
  } while (
    db.prepare(
      "SELECT 1 FROM users WHERE account_id = ?"
    ).get(accountId)
  );

  return accountId;
}

app.post("/auth/register", authLimiter, async (req, res) => {
  try {
    const fullName = String(
      req.body.full_name || req.body.fullName || ""
    ).trim();

    const userEmail = String(
      email(req.body.email)
    ).trim().toLowerCase();

    const password = String(req.body.password || "");

    const currency = String(
      req.body.preferred_currency ||
      req.body.preferredCurrency ||
      req.body.currency ||
      "USD"
    ).trim().toUpperCase();

    const referralCode = String(
      req.body.referral_code ||
      req.body.referralCode ||
      ""
    ).trim().toUpperCase();

    if (!fullName) {
      return res.status(400).json({
        error: "Full name is required"
      });
    }

    if (!userEmail || !userEmail.includes("@")) {
      return res.status(400).json({
        error: "Valid email is required"
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        error: "Password must contain at least 8 characters"
      });
    }

    if (!/^[A-Z]{3}$/.test(currency)) {
      return res.status(400).json({
        error: "Currency must be a 3-letter code"
      });
    }

    const existing = db.prepare(
      "SELECT id FROM users WHERE lower(email) = lower(?) LIMIT 1"
    ).get(userEmail);

    if (existing) {
      return res.status(409).json({
        error: "An account with this email already exists"
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const userId = id();
    const accountId = generateAccountId();
    const createdAt = now();

    let referrer = null;

    if (referralCode) {
      referrer = db.prepare(`
        SELECT user_id, code
        FROM referral_codes
        WHERE upper(code) = ?
        LIMIT 1
      `).get(referralCode);

      if (!referrer) {
        return res.status(400).json({
          error: "Invalid referral code"
        });
      }

      if (referrer.user_id === userId) {
        return res.status(400).json({
          error: "You cannot use your own referral code"
        });
      }
    }

    try {
      db.prepare(`
        INSERT INTO users
        (
          id,
          account_id,
          full_name,
          email,
          password_hash,
          currency,
          balance,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 0, ?)
      `).run(
        userId,
        accountId,
        fullName,
        userEmail,
        passwordHash,
        currency,
        createdAt
      );
    } catch (insertError) {
      if (
        String(insertError?.message || "")
          .toLowerCase()
          .includes("unique")
      ) {
        return res.status(409).json({
          error: "An account with this email already exists"
        });
      }

      throw insertError;
    }

    const ownReferralCode = ensureReferralCode(userId, fullName);

    db.prepare(`
      UPDATE users
      SET referral_code = ?
      WHERE id = ?
    `).run(ownReferralCode, userId);

    if (referrer) {
      createReferral({
        referrerId: referrer.user_id,
        referredId: userId,
        referralCode: referrer.code
      });
    }

    const user = db.prepare(`
      SELECT
        id,
        account_id,
        full_name,
        email,
        currency,
        balance,
        referral_code,
        created_at
      FROM users
      WHERE id = ?
    `).get(userId);

    createNotification({
      userId: user.id,
      type: "account",
      title: "Welcome to Vicky Pay",
      message: "Your Vicky Pay account was created successfully."
    });

    notifyOwner({
      type: "new_user",
      title: "New User Registration",
      message: `${user.full_name} (${user.email}) just created a new Vicky Pay account.`
    });

    return res.status(201).json({
      message: "Registration successful",
      token: token(user),
      user: userData(user)
    });
  } catch (error) {
    console.error("Registration error:", error);

    return res.status(500).json({
      error: "Registration failed"
    });
  }
});

app.post("/auth/login", authLimiter, async (req, res) => {
  try {
    const userEmail = String(
      email(req.body.email)
    ).trim().toLowerCase();

    const password = String(req.body.password || "");

    if (!userEmail || !userEmail.includes("@") || !password) {
      return res.status(401).json({
        error: "Invalid email or password"
      });
    }

    const user = db.prepare(`
      SELECT *
      FROM users
      WHERE lower(email) = lower(?)
      LIMIT 1
    `).get(userEmail);

    if (!user || !user.password_hash) {
      return res.status(401).json({
        error: "Invalid email or password"
      });
    }

    const valid = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!valid) {
      return res.status(401).json({
        error: "Invalid email or password"
      });
    }

    createNotification({
      userId: user.id,
      type: "login",
      title: "Login successful",
      message: "You successfully signed in to Vicky Pay."
    });

    notifyOwner({
      type: "user_login",
      title: "User Login",
      message: `${user.full_name} (${user.email}) successfully logged in to Vicky Pay.`
    });

    return res.json({
      message: "Login successful",
      token: token(user),
      user: userData(user)
    });
  } catch (error) {
    console.error("Login error:", error);

    return res.status(500).json({
      error: "Login failed"
    });
  }
});


app.get("/referrals", auth, (req, res) => {
  try {
    const userId = req.user.id;

    const user = db.prepare(`
      SELECT id, full_name, email, referral_code
      FROM users
      WHERE id = ?
    `).get(userId);

    if (!user) {
      return res.status(404).json({
        error: "User not found"
      });
    }

    const referrals = db.prepare(`
      SELECT
        r.id,
        r.referral_code,
        r.status,
        r.reward_amount,
        r.reward_currency,
        r.rewarded_at,
        r.created_at,
        u.id AS referred_user_id,
        u.full_name AS referred_name,
        u.created_at AS referred_created_at
      FROM referrals r
      JOIN users u ON u.id = r.referred_id
      WHERE r.referrer_id = ?
      ORDER BY r.created_at DESC
    `).all(userId);

    const totals = db.prepare(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(
          CASE WHEN status = 'rewarded'
          THEN reward_amount ELSE 0 END
        ), 0) AS total_rewards
      FROM referrals
      WHERE referrer_id = ?
    `).get(userId);

    return res.json({
      referral: {
        code: user.referral_code || null,
        total: Number(totals?.total || 0),
        total_rewards: Number(totals?.total_rewards || 0)
      },
      referrals: referrals.map(r => ({
        id: r.id,
        code: r.referral_code,
        status: r.status,
        reward_amount: Number(r.reward_amount || 0),
        reward_currency: r.reward_currency,
        rewarded_at: r.rewarded_at,
        created_at: r.created_at,
        referred_user: {
          id: r.referred_user_id,
          full_name: r.referred_name,
          created_at: r.referred_created_at
        }
      }))
    });
  } catch (error) {
    console.error("Referral lookup error:", error);

    return res.status(500).json({
      error: "Unable to load referrals"
    });
  }
});

app.get("/auth/me", auth, (req, res) => {
  res.json({ user: userData(req.user) });
});

app.patch("/auth/profile", auth, async (req, res) => {
  try {
    const fullName = String(req.body.full_name || "").trim();
    const newEmail = email(req.body.email);
    const currency = String(req.body.currency || "").trim().toUpperCase();
    const currentPassword = String(req.body.current_password || "");
    const newPassword = String(req.body.new_password || "");

    if (!fullName) {
      return res.status(400).json({ error: "Full name is required" });
    }

    if (!newEmail || !newEmail.includes("@")) {
      return res.status(400).json({ error: "Valid email is required" });
    }

    if (!/^[A-Z]{3}$/.test(currency)) {
      return res.status(400).json({
        error: "Currency must be a 3-letter code"
      });
    }

    const existingEmail = db.prepare(
      "SELECT id FROM users WHERE email = ? AND id != ?"
    ).get(newEmail, req.user.id);

    if (existingEmail) {
      return res.status(409).json({
        error: "That email is already in use"
      });
    }

    const user = db.prepare(
      "SELECT * FROM users WHERE id = ?"
    ).get(req.user.id);

    let passwordHash = user.password_hash;

    if (newPassword) {
      if (!currentPassword) {
        return res.status(400).json({
          error: "Current password is required to change your password"
        });
      }

      const valid = await bcrypt.compare(
        currentPassword,
        user.password_hash
      );

      if (!valid) {
        return res.status(401).json({
          error: "Current password is incorrect"
        });
      }

      if (newPassword.length < 8) {
        return res.status(400).json({
          error: "New password must contain at least 8 characters"
        });
      }

      passwordHash = await bcrypt.hash(newPassword, 12);
    }

    db.prepare(`
      UPDATE users
      SET full_name = ?,
          email = ?,
          currency = ?,
          password_hash = ?
      WHERE id = ?
    `).run(
      fullName,
      newEmail,
      currency,
      passwordHash,
      req.user.id
    );

    const updatedUser = db.prepare(`
      SELECT id, full_name, email, currency, balance, created_at
      FROM users WHERE id = ?
    `).get(req.user.id);

    res.json({
      message: "Profile updated successfully",
      token: token(updatedUser),
      user: userData(updatedUser)
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Profile update failed" });
  }
});

app.post("/auth/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ message: "Logged out" });
});

app.get("/wallet/balance", auth, (req, res) => {
  const user = db.prepare(`
    SELECT balance, currency FROM users WHERE id = ?
  `).get(req.user.id);

  res.json({
    balance: Number(user.balance),
    currency: user.currency
  });
});

// ==================== PAYMENT FLOW ====================
// Provider-backed payment intents.
// Wallet balances are changed only after verified provider settlement.


async function settleFlutterwaveDeposit({
  transactionId,
  txRef
}) {
  const provider = paymentService.getProvider("flutterwave");

  let verification;

  if (transactionId) {
    verification = await provider.verifyPayment(
      transactionId
    );
  } else {
    throw new Error(
      "Flutterwave transaction ID is missing"
    );
  }

  if (!verification.verified) {
    throw new Error(
      verification.reason ||
      "Flutterwave payment could not be verified"
    );
  }

  const payment = db.prepare(`
    SELECT *
    FROM payment_intents
    WHERE provider = 'flutterwave'
      AND (
        provider_reference = ?
        OR provider_reference = ?
      )
    LIMIT 1
  `).get(
    txRef || "",
    verification.provider_reference || ""
  );

  if (!payment) {
    throw new Error(
      "Payment intent not found"
    );
  }

  if (payment.type !== "deposit") {
    throw new Error(
      "Payment intent is not a deposit"
    );
  }

  if (payment.status === "completed") {
    return {
      already_completed: true,
      payment
    };
  }

  const verifiedAmount =
    Number(verification.amount);

  const expectedAmount =
    Number(payment.amount);

  const verifiedCurrency =
    String(
      verification.currency || ""
    ).toUpperCase();

  const expectedCurrency =
    String(
      payment.currency || ""
    ).toUpperCase();

  if (
    Math.abs(verifiedAmount - expectedAmount) >
    0.000001
  ) {
    throw new Error(
      "Verified payment amount does not match payment intent"
    );
  }

  if (
    verifiedCurrency !== expectedCurrency
  ) {
    throw new Error(
      "Verified payment currency does not match payment intent"
    );
  }

  db.exec("BEGIN IMMEDIATE");

  try {
    const currentPayment = db.prepare(`
      SELECT *
      FROM payment_intents
      WHERE id = ?
    `).get(payment.id);

    if (!currentPayment) {
      throw new Error(
        "Payment intent disappeared"
      );
    }

    if (currentPayment.status === "completed") {
      db.exec("COMMIT");

      return {
        already_completed: true,
        payment: currentPayment
      };
    }

    const user = db.prepare(`
      SELECT id, balance, currency
      FROM users
      WHERE id = ?
    `).get(currentPayment.user_id);

    if (!user) {
      throw new Error(
        "Payment owner not found"
      );
    }

    /*
     * Idempotency guard:
     * if this payment intent already has a credit
     * ledger entry, do not credit the wallet again.
     */
    const existingCredit = db.prepare(`
      SELECT id
      FROM ledger_entries
      WHERE payment_intent_id = ?
        AND entry_type = 'credit'
      LIMIT 1
    `).get(currentPayment.id);

    if (existingCredit) {
      db.prepare(`
        UPDATE payment_intents
        SET status = 'completed',
            updated_at = ?
        WHERE id = ?
      `).run(
        now(),
        currentPayment.id
      );

      db.exec("COMMIT");

      return {
        already_completed: true,
        payment: db.prepare(`
          SELECT *
          FROM payment_intents
          WHERE id = ?
        `).get(currentPayment.id)
      };
    }

    const transactionIdNew = id();
    const createdAt = now();

    db.prepare(`
      UPDATE users
      SET balance = balance + ?
      WHERE id = ?
    `).run(
      expectedAmount,
      user.id
    );

    db.prepare(`
      INSERT INTO transactions
      (
        id,
        user_id,
        type,
        amount,
        currency,
        description,
        related_user_id,
        status,
        created_at
      )
      VALUES (?, ?, 'deposit', ?, ?, ?, NULL, 'completed', ?)
    `).run(
      transactionIdNew,
      user.id,
      expectedAmount,
      expectedCurrency,
      currentPayment.description ||
        "Wallet deposit",
      createdAt
    );

    db.prepare(`
      INSERT INTO ledger_entries
      (
        id,
        user_id,
        payment_intent_id,
        transaction_id,
        entry_type,
        amount,
        currency,
        description,
        created_at
      )
      VALUES (?, ?, ?, ?, 'credit', ?, ?, ?, ?)
    `).run(
      id(),
      user.id,
      currentPayment.id,
      transactionIdNew,
      expectedAmount,
      expectedCurrency,
      currentPayment.description ||
        "Flutterwave wallet deposit",
      createdAt
    );

    db.prepare(`
      UPDATE payment_intents
      SET status = 'completed',
          updated_at = ?
      WHERE id = ?
    `).run(
      createdAt,
      currentPayment.id
    );

    let referralReward = null;

    try {
      referralReward = rewardReferralForDeposit({
        referredUserId: user.id,
        paymentIntentId: currentPayment.id
      });
    } catch (referralError) {
      console.error("Referral reward error:", referralError);
      throw referralError;
    }

    db.exec("COMMIT");

    createNotification({
      userId: user.id,
      type: "deposit_completed",
      title: "Deposit completed",
      message: `Your ${expectedAmount} ${expectedCurrency} deposit has been credited to your wallet.`
    });

    if (referralReward && !referralReward.already_rewarded) {
      createNotification({
        userId: referralReward.referrer_user_id,
        type: "referral_reward",
        title: "Referral reward earned",
        message: `You earned ${referralReward.amount} ${referralReward.currency} from a successful referral.`
      });
    }

    return {
      already_completed: false,
      payment_id: currentPayment.id,
      transaction_id: transactionIdNew,
      amount: expectedAmount,
      currency: expectedCurrency
    };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}

    throw error;
  }
}

app.post("/payments/webhook/flutterwave", async (req, res) => {
  try {
    const provider =
      paymentService.getProvider("flutterwave");

    const validWebhook =
      provider.verifyWebhook({
        verifHash:
          req.headers["verif-hash"],
        flutterwaveSignature:
          req.headers["flutterwave-signature"],
        rawBody:
          req.rawBody
      });

    if (!validWebhook) {
      return res.status(401).json({
        error: "Invalid webhook signature"
      });
    }

    const payload = req.body || {};

    const eventId = String(
      payload.id ||
      payload.webhook_id ||
      payload.data?.id ||
      payload.data?.tx_ref ||
      ""
    ).trim();

    const eventType = String(
      payload.type ||
      payload.event ||
      ""
    ).trim();

    const payloadHash = crypto
      .createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex");

    if (
      webhookService.alreadyProcessed(
        "flutterwave",
        eventId
      )
    ) {
      return res.status(200).json({
        received: true,
        duplicate: true
      });
    }

    webhookService.recordWebhook({
      id: id(),
      provider: "flutterwave",
      eventId: eventId || null,
      eventType: eventType || null,
      payloadHash
    });

    const transactionId =
      payload.data?.id;

    const txRef =
      payload.data?.tx_ref ||
      payload.data?.reference ||
      "";

    /*
     * Real Flutterwave transfer reconciliation.
     * Withdrawal references use the form:
     * vicky_wd_<payment-intent-id>
     */
    if (
      txRef.startsWith("vicky_wd_") &&
      payload.data?.id
    ) {
      try {
        const withdrawalResult =
          await settleFlutterwaveWithdrawal({
            transactionId: payload.data.id,
            txRef,
            eventStatus:
              payload.data?.status
        });

        db.prepare(`
          UPDATE payment_webhooks
          SET processed = 1,
              processed_at = ?
          WHERE provider = ?
            AND (
              provider_event_id = ?
              OR payload_hash = ?
            )
        `).run(
          now(),
          "flutterwave",
          eventId || null,
          payloadHash
        );

        return res.status(200).json({
          received: true,
          processed: true,
          withdrawal: true,
          status:
            withdrawalResult.status || "processing"
        });
      } catch (withdrawalError) {
        console.error(
          "Flutterwave withdrawal webhook error:",
          withdrawalError
        );

        return res.status(200).json({
          received: true,
          processed: false,
          withdrawal: true,
          error: withdrawalError.message
        });
      }
    }

    if (
      eventType === "charge.completed" ||
      String(payload.data?.status || "").toLowerCase() ===
        "successful"
    ) {
      try {
        await settleFlutterwaveDeposit({
          transactionId,
          txRef
        });
      } catch (error) {
        console.error(
          "Flutterwave settlement error:",
          error.message
        );

        return res.status(200).json({
          received: true,
          processed: false,
          error: error.message
        });
      }
    }

    db.prepare(`
      UPDATE payment_webhooks
      SET processed = 1,
          processed_at = ?
      WHERE provider = ?
        AND (
          provider_event_id = ?
          OR payload_hash = ?
        )
    `).run(
      now(),
      "flutterwave",
      eventId || null,
      payloadHash
    );

    return res.status(200).json({
      received: true,
      processed: true
    });
  } catch (error) {
    console.error(
      "Flutterwave webhook error:",
      error
    );

    return res.status(500).json({
      error: "Webhook processing failed"
    });
  }
});


function getUserLinkedFinancialAccount(userId, accountId) {
  const id = Number(accountId);

  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }

  return db.prepare(`
    SELECT
      id,
      user_id,
      provider,
      provider_account_id,
      account_name,
      masked_account_number,
      account_type,
      currency,
      balance,
      balance_updated_at,
      status
    FROM linked_accounts
    WHERE id = ?
      AND user_id = ?
      AND status = 'connected'
    LIMIT 1
  `).get(id, userId);
}

app.post("/payments/deposit", auth, async (req, res) => {
  try {
    const value = Number(req.body.amount);

    if (!paymentService.validateAmount(value)) {
      return res.status(400).json({
        error: "Invalid deposit amount"
      });
    }

    const currency = String(
      req.body.currency ||
      req.user.currency ||
      "USD"
    ).trim().toUpperCase();

    if (!/^[A-Z]{3}$/.test(currency)) {
      return res.status(400).json({
        error: "Invalid currency"
      });
    }

    const providerName = String(
      req.body.provider || "flutterwave"
    ).trim().toLowerCase();

    if (providerName !== "flutterwave") {
      return res.status(400).json({
        error: "Only Flutterwave deposits are enabled"
      });
    }

    /*
     * A connected account is optional for Flutterwave checkout.
     * If the caller supplies one, validate it and attach it to
     * the payment description/response. Card checkout does not
     * require a linked account.
     */
    const sourceAccountId =
      req.body.source_account_id ??
      req.body.sourceAccountId ??
      req.body.account_id ??
      req.body.accountId;

    const sourceAccount = sourceAccountId
      ? getUserLinkedFinancialAccount(
          req.user.id,
          sourceAccountId
        )
      : null;

    if (sourceAccountId && !sourceAccount) {
      return res.status(400).json({
        error: "The selected funding account is not connected to your account"
      });
    }

    const sourceDescription = sourceAccount
      ? `Wallet deposit from ${
          sourceAccount.account_name ||
          sourceAccount.masked_account_number ||
          sourceAccount.provider ||
          "connected account"
        }`
      : "Wallet deposit via Flutterwave";

    const provider = paymentService.getProvider(providerName);

    const payment = paymentService.createPaymentIntent({
      userId: req.user.id,
      provider: providerName,
      amount: value,
      currency,
      description: String(
        req.body.description || sourceDescription
      )
    });

    try {
      const checkout = await provider.createDeposit({
        paymentId: payment.id,
        amount: payment.amount,
        currency: payment.currency,
        email: req.user.email,
        name: req.user.full_name,
        redirectUrl:
          process.env.PAYMENT_REDIRECT_URL ||
          "https://vicky-wallet-frontend.onrender.com/payment/callback"
      });

      db.prepare(`
        UPDATE payment_intents
        SET provider_reference = ?,
            status = 'processing',
            updated_at = ?
        WHERE id = ?
      `).run(
        checkout.provider_reference || null,
        now(),
        payment.id
      );

      createNotification({
        userId: req.user.id,
        type: "deposit",
        title: "Deposit started",
        message:
          `Your ${payment.amount} ${payment.currency} deposit is being processed.`
      });

      return res.status(201).json({
        message: "Deposit checkout created",
        payment_id: payment.id,
        provider: checkout.provider,
        provider_reference: checkout.provider_reference,
        checkout_url: checkout.checkout_url,
        status: "processing",
        amount: payment.amount,
        currency: payment.currency,
        source_account: sourceAccount
          ? {
              id: sourceAccount.id,
              provider: sourceAccount.provider,
              account_name: sourceAccount.account_name,
              account_number:
                sourceAccount.masked_account_number,
              currency: sourceAccount.currency
            }
          : null
      });
    } catch (providerError) {
      paymentService.updateStatus(
        payment.id,
        "failed"
      );

      throw providerError;
    }
  } catch (error) {
    console.error(
      "Deposit initialization error:",
      error
    );

    return res.status(400).json({
      error:
        error.message ||
        "Unable to initialize deposit"
    });
  }
});
app.post("/wallet/deposit", auth, (req, res) => {
  return res.status(410).json({
    error: "This deposit endpoint has been retired",
    use: "/payments/deposit"
  });
});


async function settleFlutterwaveWithdrawal({
  transactionId,
  txRef,
  eventStatus = null
}) {
  const provider = paymentService.getProvider("flutterwave");

  const payment = db.prepare(`
    SELECT *
    FROM payment_intents
    WHERE provider = 'flutterwave'
      AND type = 'withdrawal'
      AND provider_reference = ?
    LIMIT 1
  `).get(String(txRef || "").trim());

  if (!payment) {
    throw new Error("Withdrawal payment intent not found");
  }

  if (payment.status === "completed") {
    return {
      already_completed: true,
      status: "completed",
      payment
    };
  }

  if (payment.status === "failed" || payment.status === "cancelled") {
    return {
      already_finalized: true,
      status: payment.status,
      payment
    };
  }

  if (!transactionId) {
    throw new Error("Flutterwave transfer ID is missing");
  }

  const verification = await provider.verifyWithdrawal({
    transferId: transactionId
  });

  const verifiedAmount = Number(verification.amount || 0);
  const expectedAmount = Number(payment.amount || 0);

  const verifiedCurrency = String(
    verification.currency || ""
  ).toUpperCase();

  const expectedCurrency = String(
    payment.currency || ""
  ).toUpperCase();

  if (
    verifiedAmount > 0 &&
    Math.abs(verifiedAmount - expectedAmount) > 0.000001
  ) {
    throw new Error(
      "Verified withdrawal amount does not match payment intent"
    );
  }

  if (
    verifiedCurrency &&
    verifiedCurrency !== expectedCurrency
  ) {
    throw new Error(
      "Verified withdrawal currency does not match payment intent"
    );
  }

  const status = String(
    verification.status || eventStatus || "unknown"
  ).toLowerCase();

  const successful = status === "successful";
  const failed = ["failed", "cancelled"].includes(status);

  if (!successful && !failed) {
    return {
      already_completed: false,
      status: "processing",
      payment
    };
  }

  db.exec("BEGIN IMMEDIATE");

  try {
    const currentPayment = db.prepare(`
      SELECT *
      FROM payment_intents
      WHERE id = ?
    `).get(payment.id);

    if (!currentPayment) {
      throw new Error("Withdrawal payment intent disappeared");
    }

    if (
      currentPayment.status === "completed" ||
      currentPayment.status === "failed" ||
      currentPayment.status === "cancelled"
    ) {
      db.exec("COMMIT");

      return {
        already_finalized: true,
        status: currentPayment.status,
        payment: currentPayment
      };
    }

    const user = db.prepare(`
      SELECT id, balance, currency
      FROM users
      WHERE id = ?
    `).get(currentPayment.user_id);

    if (!user) {
      throw new Error("Withdrawal owner not found");
    }

    const withdrawalTransaction = db.prepare(`
      SELECT *
      FROM transactions
      WHERE user_id = ?
        AND type = 'withdrawal'
        AND description LIKE ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(
      user.id,
      `%${currentPayment.id}%`
    );

    if (successful) {
      db.prepare(`
        UPDATE payment_intents
        SET status = 'completed',
            updated_at = ?
        WHERE id = ?
      `).run(
        now(),
        currentPayment.id
      );

      if (withdrawalTransaction) {
        db.prepare(`
          UPDATE transactions
          SET status = 'completed'
          WHERE id = ?
        `).run(withdrawalTransaction.id);
      }

      db.exec("COMMIT");

      createNotification({
        userId: user.id,
        type: "withdrawal_completed",
        title: "Withdrawal completed",
        message:
          `Your ${expectedAmount} ${expectedCurrency} withdrawal has been completed.`
      });

      return {
        already_completed: false,
        status: "completed",
        payment: db.prepare(`
          SELECT *
          FROM payment_intents
          WHERE id = ?
        `).get(currentPayment.id)
      };
    }

    /*
     * Failed/cancelled payout:
     * release the balance that was reserved when the withdrawal
     * was created. The refund ledger entry makes the reversal
     * auditable.
     */
    db.prepare(`
      UPDATE users
      SET balance = balance + ?
      WHERE id = ?
    `).run(
      expectedAmount,
      user.id
    );

    const refundTransactionId = id();

    db.prepare(`
      INSERT INTO transactions
      (
        id,
        user_id,
        type,
        amount,
        currency,
        description,
        related_user_id,
        status,
        created_at
      )
      VALUES (?, ?, 'withdrawal_refund', ?, ?, ?, NULL, 'completed', ?)
    `).run(
      refundTransactionId,
      user.id,
      expectedAmount,
      expectedCurrency,
      `Refund for failed withdrawal ${currentPayment.id}`,
      now()
    );

    db.prepare(`
      INSERT INTO ledger_entries
      (
        id,
        user_id,
        payment_intent_id,
        transaction_id,
        entry_type,
        amount,
        currency,
        description,
        created_at
      )
      VALUES (?, ?, ?, ?, 'credit', ?, ?, ?, ?)
    `).run(
      id(),
      user.id,
      currentPayment.id,
      refundTransactionId,
      expectedAmount,
      expectedCurrency,
      `Withdrawal refund for ${currentPayment.id}`,
      now()
    );

    db.prepare(`
      UPDATE payment_intents
      SET status = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      status === "cancelled" ? "cancelled" : "failed",
      now(),
      currentPayment.id
    );

    if (withdrawalTransaction) {
      db.prepare(`
        UPDATE transactions
        SET status = 'failed'
        WHERE id = ?
      `).run(withdrawalTransaction.id);
    }

    db.exec("COMMIT");

    createNotification({
      userId: user.id,
      type: "withdrawal_failed",
      title: "Withdrawal failed",
      message:
        `Your ${expectedAmount} ${expectedCurrency} withdrawal failed. The reserved funds have been returned to your wallet.`
    });

    return {
      already_completed: false,
      status: status === "cancelled" ? "cancelled" : "failed",
      refunded: true,
      payment: db.prepare(`
        SELECT *
        FROM payment_intents
        WHERE id = ?
      `).get(currentPayment.id)
    };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}


app.post("/wallet/withdraw", auth, async (req, res) => {
  try {
    const value = Number(req.body?.amount);

    if (!paymentService.validateAmount(value)) {
      return res.status(400).json({
        error: "Invalid withdrawal amount"
      });
    }

    const currency = String(
      req.body?.currency ||
      req.user.currency ||
      "USD"
    ).trim().toUpperCase();

    if (!/^[A-Z]{3}$/.test(currency)) {
      return res.status(400).json({
        error: "Invalid currency"
      });
    }

    const accountNumber = String(
      req.body?.account_number ||
      req.body?.accountNumber ||
      ""
    ).trim();

    const bankCode = String(
      req.body?.bank_code ||
      req.body?.bankCode ||
      ""
    ).trim();

    const beneficiaryName = String(
      req.body?.beneficiary_name ||
      req.body?.beneficiaryName ||
      ""
    ).trim();

    const narration = String(
      req.body?.narration ||
      "Vicky Pay withdrawal"
    ).trim();

    if (!accountNumber) {
      return res.status(400).json({
        error: "Bank account number is required"
      });
    }

    if (!bankCode) {
      return res.status(400).json({
        error: "Bank code is required"
      });
    }

    if (!beneficiaryName) {
      return res.status(400).json({
        error: "Beneficiary name is required"
      });
    }

    if (currency !== String(req.user.currency || "").toUpperCase()) {
      return res.status(400).json({
        error:
          `Your wallet currency is ${req.user.currency}.`
      });
    }

    const user = db.prepare(`
      SELECT id, account_id, full_name, email, currency, balance
      FROM users
      WHERE id = ?
    `).get(req.user.id);

    if (!user) {
      return res.status(401).json({
        error: "User account not found"
      });
    }

    /*
     * Create the payment intent and reserve the wallet balance
     * atomically before contacting Flutterwave.
     */
    const payment = paymentService.createPaymentIntent({
      userId: user.id,
      provider: "flutterwave",
      amount: value,
      currency,
      type: "withdrawal",
      description:
        `Withdrawal ${value} ${currency}`
    });

    try {
      db.exec("BEGIN IMMEDIATE");

      const currentUser = db.prepare(`
        SELECT id, balance, currency
        FROM users
        WHERE id = ?
      `).get(user.id);

      if (!currentUser) {
        throw new Error("User account not found");
      }

      if (Number(currentUser.balance) < value) {
        throw new Error("Insufficient balance");
      }

      const debit = db.prepare(`
        UPDATE users
        SET balance = balance - ?
        WHERE id = ?
          AND balance >= ?
      `).run(
        value,
        user.id,
        value
      );

      if (Number(debit.changes) !== 1) {
        throw new Error("Insufficient balance");
      }

      const transactionId = id();

      db.prepare(`
        INSERT INTO transactions
        (
          id,
          user_id,
          type,
          amount,
          currency,
          description,
          related_user_id,
          status,
          created_at
        )
        VALUES (?, ?, 'withdrawal', ?, ?, ?, NULL, 'processing', ?)
      `).run(
        transactionId,
        user.id,
        value,
        currency,
        `Withdrawal ${payment.id}`,
        now()
      );

      db.prepare(`
        INSERT INTO ledger_entries
        (
          id,
          user_id,
          payment_intent_id,
          transaction_id,
          entry_type,
          amount,
          currency,
          description,
          created_at
        )
        VALUES (?, ?, ?, ?, 'debit', ?, ?, ?, ?)
      `).run(
        id(),
        user.id,
        payment.id,
        transactionId,
        value,
        currency,
        `Withdrawal reservation ${payment.id}`,
        now()
      );

      db.exec("COMMIT");
    } catch (reservationError) {
      try {
        db.exec("ROLLBACK");
      } catch {}

      paymentService.updateStatus(
        payment.id,
        "failed"
      );

      throw reservationError;
    }

    try {
      const provider =
        paymentService.getProvider("flutterwave");

      const payout =
        await provider.createWithdrawal({
          paymentId: payment.id,
          amount: value,
          currency,
          accountNumber,
          bankCode,
          beneficiaryName,
          narration,
          callbackUrl:
            process.env.PAYMENT_REDIRECT_URL || ""
        });

      paymentService.setProviderReference(
        payment.id,
        payout.provider_reference
      );

      const updated =
        paymentService.getPaymentIntent(payment.id);

      /*
       * If Flutterwave already returned a terminal successful
       * status, reconcile immediately. Otherwise leave it
       * processing and let verification/webhook finalize it.
       */
      if (String(payout.status || "").toLowerCase() === "successful") {
        await settleFlutterwaveWithdrawal({
          transactionId: payout.transfer_id,
          txRef: payout.provider_reference,
          eventStatus: "successful"
        });
      }

      const finalPayment =
        paymentService.getPaymentIntent(payment.id);

      const updatedUser = db.prepare(`
        SELECT balance, currency
        FROM users
        WHERE id = ?
      `).get(user.id);

      createNotification({
        userId: user.id,
        type: "withdrawal_started",
        title: "Withdrawal submitted",
        message:
          `Your ${value} ${currency} withdrawal has been submitted to Flutterwave.`
      });

      return res.status(201).json({
        message: "Withdrawal submitted",
        payment_id: payment.id,
        provider: "flutterwave",
        provider_reference:
          payout.provider_reference,
        transfer_id:
          payout.transfer_id,
        status:
          finalPayment?.status ||
          "processing",
        amount: value,
        currency,
        balance:
          Number(updatedUser.balance),
        beneficiary: {
          name: beneficiaryName,
          account_number:
            accountNumber.replace(
              /.(?=.{4})/g,
              "*"
            ),
          bank_code: bankCode
        }
      });
    } catch (providerError) {
      console.error(
        "Flutterwave withdrawal error:",
        providerError
      );

      /*
       * The transfer request failed before we obtained a
       * provider reference. Release the reserved balance.
       */
      try {
        db.exec("BEGIN IMMEDIATE");

        const currentPayment =
          paymentService.getPaymentIntent(payment.id);

        if (
          currentPayment &&
          currentPayment.status !== "completed" &&
          currentPayment.status !== "failed" &&
          currentPayment.status !== "cancelled"
        ) {
          db.prepare(`
            UPDATE users
            SET balance = balance + ?
            WHERE id = ?
          `).run(
            value,
            user.id
          );

          const refundTransactionId = id();

          db.prepare(`
            INSERT INTO transactions
            (
              id,
              user_id,
              type,
              amount,
              currency,
              description,
              related_user_id,
              status,
              created_at
            )
            VALUES (?, ?, 'withdrawal_refund', ?, ?, ?, NULL, 'completed', ?)
          `).run(
            refundTransactionId,
            user.id,
            value,
            currency,
            `Withdrawal initialization refund ${payment.id}`,
            now()
          );

          db.prepare(`
            INSERT INTO ledger_entries
            (
              id,
              user_id,
              payment_intent_id,
              transaction_id,
              entry_type,
              amount,
              currency,
              description,
              created_at
            )
            VALUES (?, ?, ?, ?, 'credit', ?, ?, ?, ?)
          `).run(
            id(),
            user.id,
            payment.id,
            refundTransactionId,
            value,
            currency,
            `Refund for failed withdrawal initialization ${payment.id}`,
            now()
          );

          db.prepare(`
            UPDATE payment_intents
            SET status = 'failed',
                updated_at = ?
            WHERE id = ?
          `).run(
            now(),
            payment.id
          );
        }

        db.exec("COMMIT");
      } catch (refundError) {
        try {
          db.exec("ROLLBACK");
        } catch {}

        console.error(
          "CRITICAL withdrawal refund error:",
          refundError
        );
      }

      return res.status(502).json({
        error:
          providerError.message ||
          "Flutterwave withdrawal could not be created",
        payment_id: payment.id,
        status: "failed"
      });
    }
  } catch (error) {
    console.error(
      "Wallet withdrawal error:",
      error
    );

    const message =
      error.message ||
      "Withdrawal failed";

    return res.status(
      message === "Insufficient balance" ? 400 : 400
    ).json({
      error: message
    });
  }
});


app.get("/wallet/withdraw/:paymentId", auth, async (req, res) => {
  try {
    const payment = db.prepare(`
      SELECT *
      FROM payment_intents
      WHERE id = ?
        AND user_id = ?
        AND type = 'withdrawal'
      LIMIT 1
    `).get(
      String(req.params.paymentId),
      req.user.id
    );

    if (!payment) {
      return res.status(404).json({
        error: "Withdrawal not found"
      });
    }

    if (
      payment.provider === "flutterwave" &&
      payment.provider_reference &&
      payment.status === "processing"
    ) {
      const provider =
        paymentService.getProvider("flutterwave");

      /*
       * Flutterwave transfer IDs are returned when the transfer
       * is created. Older records may only have the reference.
       * In that case the webhook remains the authoritative
       * reconciliation path.
       */
      let verified = null;

      const transferId =
        String(req.query.transfer_id || "").trim();

      if (transferId) {
        verified =
          await provider.verifyWithdrawal({
            transferId
          });

        if (
          verified.verified &&
          (
            verified.successful ||
            verified.failed
          )
        ) {
          await settleFlutterwaveWithdrawal({
            transactionId: transferId,
            txRef: payment.provider_reference,
            eventStatus: verified.status
          });
        }
      }
    }

    const updated =
      paymentService.getPaymentIntent(payment.id);

    return res.json({
      payment: updated
    });
  } catch (error) {
    console.error(
      "Withdrawal status error:",
      error
    );

    return res.status(502).json({
      error:
        error.message ||
        "Unable to retrieve withdrawal status"
    });
  }
});



app.get("/payments/:paymentId", auth, (req, res) => {
  try {
    const payment = db.prepare(`
      SELECT
        id,
        provider,
        provider_reference,
        amount,
        currency,
        type,
        status,
        description,
        created_at,
        updated_at
      FROM payment_intents
      WHERE id = ?
        AND user_id = ?
      LIMIT 1
    `).get(
      String(req.params.paymentId),
      req.user.id
    );

    if (!payment) {
      return res.status(404).json({
        error: "Payment not found"
      });
    }

    return res.json({
      payment: {
        ...payment,
        amount: Number(payment.amount)
      }
    });
  } catch (error) {
    console.error(
      "Payment status error:",
      error
    );

    return res.status(500).json({
      error: "Unable to load payment status"
    });
  }
});

app.get("/wallet/recipient/:accountId", auth, (req, res) => {
  try {
    const accountId = String(req.params.accountId || "").trim().toUpperCase();

    if (!/^VW-[0-9]{8}$/.test(accountId)) {
      return res.status(400).json({
        error: "Invalid Account ID"
      });
    }

    if (accountId === req.user.account_id) {
      return res.status(400).json({
        error: "You cannot select your own account"
      });
    }

    const recipient = db.prepare(`
      SELECT account_id, full_name, currency
      FROM users
      WHERE account_id = ?
    `).get(accountId);

    if (!recipient) {
      return res.status(404).json({
        error: "Recipient not found"
      });
    }

    res.json({
      account_id: recipient.account_id,
      full_name: recipient.full_name,
      currency: recipient.currency
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Unable to find recipient"
    });
  }
});

app.post("/wallet/transfer", auth, (req, res) => {
  try {
    const recipientAccountId = String(
      req.body.recipient_account_id ||
      req.body.recipientAccountId ||
      req.body.account_id ||
      ""
    ).trim().toUpperCase();

    const value = Number(req.body.amount);

    if (!/^VW-[0-9]{8}$/.test(recipientAccountId)) {
      return res.status(400).json({
        error: "Valid recipient Account ID is required"
      });
    }

    if (!amount(value)) {
      return res.status(400).json({
        error: "Invalid transfer amount"
      });
    }

    if (recipientAccountId === req.user.account_id) {
      return res.status(400).json({
        error: "You cannot transfer to yourself"
      });
    }

    const recipient = db.prepare(`
      SELECT id, account_id, full_name, currency
      FROM users
      WHERE account_id = ?
    `).get(recipientAccountId);

    if (!recipient) {
      return res.status(404).json({
        error: "Recipient not found"
      });
    }

    const sender = db.prepare(`
      SELECT id, account_id, balance, currency
      FROM users
      WHERE id = ?
    `).get(req.user.id);

    if (!sender) {
      return res.status(401).json({
        error: "User account not found"
      });
    }

    const description = String(
      req.body.description || "Wallet transfer"
    ).trim();

    const result = moveWalletFunds({
      senderId: sender.id,
      recipientId: recipient.id,
      amount: value,
      description: description || "Wallet transfer",
      currency: sender.currency
    });

    createNotification({
      userId: sender.id,
      type: "transfer_sent",
      title: "Money sent",
      message: `You sent ${value} ${sender.currency} to ${recipient.full_name}.`
    });

    createNotification({
      userId: recipient.id,
      type: "transfer_received",
      title: "Money received",
      message: `You received ${value} ${sender.currency} from ${sender.account_id}.`
    });

    const updatedSender = db.prepare(`
      SELECT balance, currency
      FROM users
      WHERE id = ?
    `).get(sender.id);

    res.status(201).json({
      message: "Transfer successful",
      transaction_id: result.transaction_id,
      balance: Number(updatedSender.balance),
      currency: updatedSender.currency,
      recipient: {
        account_id: recipient.account_id,
        full_name: recipient.full_name
      },
      amount: value,
      status: "completed"
    });
  } catch (error) {
    console.error("Wallet transfer error:", error);

    const message = error.message || "Transfer failed";

    if (
      message === "Insufficient balance" ||
      message === "You cannot transfer to yourself"
    ) {
      return res.status(400).json({
        error: message
      });
    }

    return res.status(400).json({
      error: message
    });
  }
});

app.get("/notifications", auth, (req, res) => {
  try {
    const limit = Math.min(
      Math.max(Number(req.query.limit) || 50, 1),
      100
    );

    const notifications = db.prepare(`
      SELECT id, type, title, message, read, created_at
      FROM notifications
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(req.user.id, limit);

    const unread = db.prepare(`
      SELECT COUNT(*) AS count
      FROM notifications
      WHERE user_id = ?
        AND read = 0
    `).get(req.user.id);

    return res.json({
      notifications,
      unread_count: Number(unread?.count || 0)
    });
  } catch (error) {
    console.error("Notification load error:", error);
    return res.status(500).json({
      error: "Unable to load notifications"
    });
  }
});

app.patch("/notifications/:id/read", auth, (req, res) => {
  try {
    const result = db.prepare(`
      UPDATE notifications
      SET read = 1
      WHERE id = ?
        AND user_id = ?
    `).run(
      String(req.params.id),
      req.user.id
    );

    if (!result.changes) {
      return res.status(404).json({
        error: "Notification not found"
      });
    }

    return res.json({
      message: "Notification marked as read"
    });
  } catch (error) {
    console.error("Notification read error:", error);
    return res.status(500).json({
      error: "Unable to update notification"
    });
  }
});

app.post("/notifications/read-all", auth, (req, res) => {
  try {
    db.prepare(`
      UPDATE notifications
      SET read = 1
      WHERE user_id = ?
        AND read = 0
    `).run(req.user.id);

    return res.json({
      message: "All notifications marked as read"
    });
  } catch (error) {
    console.error("Notification read-all error:", error);
    return res.status(500).json({
      error: "Unable to update notifications"
    });
  }
});

app.get("/wallet/transactions", auth, (req, res) => {
  const limit = Math.min(
    Math.max(Number(req.query.limit) || 50, 1),
    100
  );

  const transactions = db.prepare(`
    SELECT id,type,amount,currency,description,
           related_user_id,status,created_at
    FROM transactions
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(req.user.id, limit);

  res.json({
    transactions: transactions.map(item => ({
      ...item,
      amount: Number(item.amount)
    }))
  });
});




// ==================== USER EARNINGS API ====================

app.get("/earnings", auth, (req, res) => {
  try {
    const account = earningsService.getAccount(req.user.id);

    const history = earningsService.getHistory(req.user.id);

    res.json({
      earnings: {
        available: Number(account.available),
        lifetime_earned: Number(account.lifetime_earned),
        lifetime_withdrawn: Number(account.lifetime_withdrawn)
      },
      history: history.map(item => ({
        ...item,
        amount: Number(item.amount)
      }))
    });
  } catch (error) {
    console.error("Earnings error:", error);

    res.status(500).json({
      error: "Unable to load earnings"
    });
  }
});

app.get("/earnings/history", auth, (req, res) => {
  try {
    const history = earningsService.getHistory(req.user.id);

    res.json({
      transactions: history.map(item => ({
        ...item,
        amount: Number(item.amount)
      }))
    });
  } catch (error) {
    console.error("Earnings history error:", error);

    res.status(500).json({
      error: "Unable to load earning history"
    });
  }
});


// ==================== LINKED FINANCIAL ACCOUNTS ====================

db.exec(`
  CREATE TABLE IF NOT EXISTS linked_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    provider_account_id TEXT NOT NULL,
    account_name TEXT,
    masked_account_number TEXT,
    account_type TEXT,
    currency TEXT NOT NULL DEFAULT 'NGN',
    balance REAL NOT NULL DEFAULT 0,
    balance_updated_at TEXT,
    status TEXT NOT NULL DEFAULT 'connected',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, provider, provider_account_id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_linked_accounts_user
  ON linked_accounts(user_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS financial_account_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    linked_account_id INTEGER,
    user_id INTEGER,
    provider TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_id TEXT,
    payload TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_financial_events_user
  ON financial_account_events(user_id, created_at DESC);
`);

app.get("/linked-accounts", auth, (req, res) => {
  try {
    const accounts = db.prepare(`
      SELECT
        id,
        provider,
        provider_account_id,
        account_name,
        masked_account_number,
        account_type,
        currency,
        balance,
        balance_updated_at,
        status,
        created_at,
        updated_at
      FROM linked_accounts
      WHERE user_id = ?
      ORDER BY updated_at DESC
    `).all(req.user.id);

    res.json({
      accounts: accounts.map(account => ({
        ...account,
        balance: Number(account.balance || 0)
      }))
    });
  } catch (error) {
    console.error("Linked accounts error:", error);
    res.status(500).json({
      error: "Unable to load linked accounts"
    });
  }
});

app.get("/linked-accounts/summary", auth, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT currency, COALESCE(SUM(balance), 0) AS total
      FROM linked_accounts
      WHERE user_id = ?
        AND status = 'connected'
      GROUP BY currency
    `).all(req.user.id);

    const accounts = rows.map(row => ({
      currency: row.currency,
      total: Number(row.total || 0)
    }));

    res.json({ accounts });
  } catch (error) {
    console.error("Linked account summary error:", error);
    res.status(500).json({
      error: "Unable to load external balance summary"
    });
  }
});

app.get("/linked-accounts/:id", auth, (req, res) => {
  try {
    const account = db.prepare(`
      SELECT
        id,
        provider,
        provider_account_id,
        account_name,
        masked_account_number,
        account_type,
        currency,
        balance,
        balance_updated_at,
        status,
        created_at,
        updated_at
      FROM linked_accounts
      WHERE id = ?
        AND user_id = ?
    `).get(Number(req.params.id), req.user.id);

    if (!account) {
      return res.status(404).json({
        error: "Linked account not found"
      });
    }

    res.json({
      account: {
        ...account,
        balance: Number(account.balance || 0)
      }
    });
  } catch (error) {
    console.error("Linked account lookup error:", error);
    res.status(500).json({
      error: "Unable to load linked account"
    });
  }
});

app.delete("/linked-accounts/:id", auth, (req, res) => {
  try {
    const account = db.prepare(`
      SELECT id
      FROM linked_accounts
      WHERE id = ?
        AND user_id = ?
    `).get(Number(req.params.id), req.user.id);

    if (!account) {
      return res.status(404).json({
        error: "Linked account not found"
      });
    }

    db.prepare(`
      DELETE FROM linked_accounts
      WHERE id = ?
        AND user_id = ?
    `).run(Number(req.params.id), req.user.id);

    res.json({
      message: "Linked account disconnected"
    });
  } catch (error) {
    console.error("Disconnect linked account error:", error);
    res.status(500).json({
      error: "Unable to disconnect account"
    });
  }
});

// Provider callback/event endpoint.
// Individual providers must be validated before updating balances.
app.post("/webhooks/financial/:provider", (req, res) => {
  try {
    const provider = String(req.params.provider || "").trim().toLowerCase();

    if (!provider) {
      return res.status(400).json({
        error: "Provider is required"
      });
    }

    console.log(`Financial provider webhook received: ${provider}`);

    res.status(200).json({
      received: true
    });
  } catch (error) {
    console.error("Financial webhook error:", error);
    res.status(500).json({
      error: "Webhook processing failed"
    });
  }
});

// ==================== OWNER / ADMIN API ====================

function adminAuth(req, res, next) {
  auth(req, res, () => {
    const adminEmail = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();

    if (!adminEmail) {
      return res.status(503).json({
        error: "Admin access is not configured"
      });
    }

    if (String(req.user.email).toLowerCase() !== adminEmail) {
      return res.status(403).json({
        error: "Owner access required"
      });
    }

    next();
  });
}

app.get("/admin/stats", adminAuth, (req, res) => {
  const users = db.prepare(`
    SELECT COUNT(*) AS count FROM users
  `).get();

  const balances = db.prepare(`
    SELECT COALESCE(SUM(balance), 0) AS total
    FROM users
  `).get();

  const transactions = db.prepare(`
    SELECT COUNT(*) AS count FROM transactions
  `).get();

  const deposits = db.prepare(`
    SELECT
      COUNT(*) AS count,
      COALESCE(SUM(amount), 0) AS total
    FROM transactions
    WHERE type = 'deposit'
  `).get();

  const withdrawals = db.prepare(`
    SELECT
      COUNT(*) AS count,
      COALESCE(SUM(amount), 0) AS total
    FROM transactions
    WHERE type = 'withdraw'
  `).get();

  const transfers = db.prepare(`
    SELECT
      COUNT(*) AS count,
      COALESCE(SUM(amount), 0) AS total
    FROM transactions
    WHERE type IN ('transfer_sent', 'transfer_received')
  `).get();

  res.json({
    users: Number(users.count),
    total_balance: Number(balances.total),
    transactions: Number(transactions.count),
    deposits: {
      count: Number(deposits.count),
      total: Number(deposits.total)
    },
    withdrawals: {
      count: Number(withdrawals.count),
      total: Number(withdrawals.total)
    },
    transfers: {
      count: Number(transfers.count),
      total: Number(transfers.total)
    }
  });
});

app.get("/admin/users", adminAuth, (req, res) => {
  const limit = Math.min(
    Math.max(Number(req.query.limit) || 50, 1),
    100
  );

  const users = db.prepare(`
    SELECT id, full_name, email, currency, balance, created_at
    FROM users
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit);

  res.json({
    users: users.map(user => ({
      ...user,
      balance: Number(user.balance)
    }))
  });
});

app.get("/admin/transactions", adminAuth, (req, res) => {
  const limit = Math.min(
    Math.max(Number(req.query.limit) || 100, 1),
    200
  );

  const transactions = db.prepare(`
    SELECT
      t.id,
      t.user_id,
      u.full_name,
      u.email,
      t.type,
      t.amount,
      t.currency,
      t.description,
      t.related_user_id,
      t.status,
      t.created_at
    FROM transactions t
    LEFT JOIN users u ON u.id = t.user_id
    ORDER BY t.created_at DESC
    LIMIT ?
  `).all(limit);

  res.json({
    transactions: transactions.map(item => ({
      ...item,
      amount: Number(item.amount)
    }))
  });
});

app.get("/admin/user/:id", adminAuth, (req, res) => {
  const user = db.prepare(`
    SELECT id, full_name, email, currency, balance, created_at
    FROM users
    WHERE id = ?
  `).get(req.params.id);

  if (!user) {
    return res.status(404).json({
      error: "User not found"
    });
  }

  const transactions = db.prepare(`
    SELECT
      id, type, amount, currency,
      description, related_user_id,
      status, created_at
    FROM transactions
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 100
  `).all(user.id);

  res.json({
    user: {
      ...user,
      balance: Number(user.balance)
    },
    transactions: transactions.map(item => ({
      ...item,
      amount: Number(item.amount)
    }))
  });
});

app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});


// ==================== ONE-TIME OWNER BOOTSTRAP ====================
const bootstrapPassword = String(process.env.ADMIN_BOOTSTRAP_PASSWORD || "").trim();
const bootstrapEmail = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();

if (bootstrapEmail && bootstrapPassword.length >= 8) {
  const existingOwner = db.prepare(
    "SELECT id FROM users WHERE email = ?"
  ).get(bootstrapEmail);

  const passwordHash = await bcrypt.hash(bootstrapPassword, 12);

  if (existingOwner) {
    db.prepare(`
      UPDATE users
      SET password_hash = ?
      WHERE email = ?
    `).run(passwordHash, bootstrapEmail);

    console.log("🔐 Owner password bootstrapped");
  } else {
    db.prepare(`
      INSERT INTO users
      (id, account_id, full_name, email, password_hash, currency, balance, created_at)
      VALUES (?, ?, ?, ?, ?, 'USD', 0, ?)
    `).run(
      crypto.randomUUID(),
      generateAccountId(),
      "Owner",
      bootstrapEmail,
      passwordHash,
      new Date().toISOString()
    );

    console.log("👑 Owner account bootstrapped");
  }
}



// ============================================================
// FINANCIAL PROVIDER CONNECTIONS
// ============================================================

// Provider availability.
// Never expose provider secrets.
app.get("/financial/providers", auth, (req, res) => {
  try {
    res.json({
      providers: providerStatus(),
      mono: monoConfigured(),
      opay: opayConfigured()
    });
  } catch (error) {
    console.error("Provider status error:", error);
    res.status(500).json({
      error: "Unable to load provider status"
    });
  }
});

// Start official Mono bank authorization.
// Vicky Pay never receives or stores the user's bank password.
app.post("/financial/bank/connect", auth, async (req, res) => {
  try {
    const institution = String(
      req.body?.institution || ""
    ).trim();

    const name = String(
      req.user.full_name || ""
    ).trim();

    const customerEmail = String(
      req.user.email || ""
    ).trim().toLowerCase();

    const authMethod = String(
      req.body?.auth_method || "internet_banking"
    ).trim();

    if (!institution) {
      return res.status(400).json({
        error: "Bank institution is required"
      });
    }

    if (!monoConfigured()) {
      return res.status(503).json({
        error: "Mono bank integration is not configured"
      });
    }

    const session = await createMonoSession({
      institution,
      name,
      email: customerEmail,
      authMethod
    });

    return res.json({
      provider: "mono",
      status: "authorization_required",
      session
    });
  } catch (error) {
    console.error("Mono connection error:", error);

    return res.status(502).json({
      error: error.message || "Unable to start bank connection"
    });
  }
});

// Exchange the code returned by Mono's official authorization
// flow, then retrieve the connected account information.
app.post("/financial/bank/accounts", auth, async (req, res) => {
  try {
    const code = String(
      req.body?.code || ""
    ).trim();

    if (!code) {
      return res.status(400).json({
        error: "Mono authorization code is required"
      });
    }

    if (!monoConfigured()) {
      return res.status(503).json({
        error: "Mono bank integration is not configured"
      });
    }

    const authorization = await exchangeMonoCode(code);

    const accountId =
      authorization?.id ||
      authorization?.data?.id ||
      authorization?.account_id ||
      authorization?.data?.account_id;

    if (!accountId) {
      return res.status(502).json({
        error: "Mono did not return a permanent account ID"
      });
    }

    const account = await getMonoAccount(accountId);

    return res.json({
      provider: "mono",
      account_id: accountId,
      account
    });
  } catch (error) {
    console.error("Mono account retrieval error:", error);

    return res.status(502).json({
      error: error.message || "Unable to retrieve bank account"
    });
  }
});

// OPay wallet balance.
// This requires an eligible OPay Business/Digital Wallet
// integration and its official credentials.
app.post("/financial/opay/balance", auth, async (req, res) => {
  try {
    const depositCode = String(
      req.body?.deposit_code ||
      req.body?.depositCode ||
      ""
    ).trim();

    if (!depositCode) {
      return res.status(400).json({
        error: "OPay deposit code is required"
      });
    }

    if (!opayConfigured()) {
      return res.status(503).json({
        error: "OPay integration is not configured"
      });
    }

    const wallet = await getOpayWalletBalance(depositCode);

    return res.json({
      provider: "opay",
      wallet
    });
  } catch (error) {
    console.error("OPay balance error:", error);

    return res.status(502).json({
      error: error.message || "Unable to retrieve OPay wallet balance"
    });
  }
});

// OPay integration status.
app.get("/financial/opay/status", auth, (req, res) => {
  return res.json({
    provider: "opay",
    configured: opayConfigured(),
    status: opayConfigured()
      ? "configured"
      : "credentials_required"
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Vicky Pay running on port ${PORT}`);
  console.log(`🗄️ SQLite database: data/vicky-wallet.sqlite`);
  console.log(`🔐 JWT authentication enabled`);
});

// Production deployment: referral rewards API
