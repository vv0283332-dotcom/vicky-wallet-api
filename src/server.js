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

import { PaymentService } from "./payments/payment-service.js";
import { WebhookService } from "./payments/webhook-service.js";
import { MockProvider } from "./payments/providers/mock-provider.js";
import { FlutterwaveProvider } from "./payments/providers/flutterwave-provider.js";
import { createEarningsService } from "./earnings/earnings-service.js";
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
  db.exec(`ALTER TABLE users ADD COLUMN referral_code TEXT`);
} catch (error) {
  if (!String(error?.message || "").toLowerCase().includes("duplicate column")) {
    console.warn("Referral-code migration:", error.message);
  }
}

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code
  ON users(referral_code)
  WHERE referral_code IS NOT NULL;
`);

const paymentProviders = {
  mock: new MockProvider(),
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

const moveWalletFunds = db.transaction(({
  senderId,
  recipientId,
  amount,
  description = "Wallet transfer",
  currency
}) => {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Invalid transfer amount");
  }

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

  db.prepare(`
    UPDATE users
    SET balance = balance - ?
    WHERE id = ? AND balance >= ?
  `).run(amount, sender.id, amount);

  db.prepare(`
    UPDATE users
    SET balance = balance + ?
    WHERE id = ?
  `).run(amount, recipient.id);

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

  return {
    transaction_id: sentId,
    received_transaction_id: receivedId
  };
});


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

app.post("/payments/test-intent", auth, async (req, res) => {
  try {
    const value = Number(req.body.amount);

    if (!amount(value)) {
      return res.status(400).json({
        error: "Invalid payment amount"
      });
    }

    const currency = String(
      req.body.currency || req.user.currency || "USD"
    ).trim().toUpperCase();

    if (!/^[A-Z]{3}$/.test(currency)) {
      return res.status(400).json({
        error: "Invalid currency"
      });
    }

    const payment = paymentService.createPaymentIntent({
      userId: req.user.id,
      provider: "mock",
      amount: value,
      currency,
      type: "deposit",
      description: String(
        req.body.description || "Payment engine test"
      )
    });

    const provider = paymentService.getProvider("mock");

    const checkout = await provider.createDeposit({
      paymentId: payment.id,
      amount: payment.amount,
      currency: payment.currency
    });

    paymentService.setProviderReference(
      payment.id,
      checkout.provider_reference
    );

    const updated = paymentService.getPaymentIntent(payment.id);

    res.status(201).json({
      message: "Payment engine test created",
      payment_id: updated.id,
      provider: checkout.provider,
      provider_reference: checkout.provider_reference,
      status: updated.status,
      amount: updated.amount,
      currency: updated.currency
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Payment engine test failed"
    });
  }
});

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
      req.body.provider ||
      "flutterwave"
    ).trim().toLowerCase();

    if (providerName !== "flutterwave") {
      return res.status(400).json({
        error: "Only Flutterwave deposits are enabled"
      });
    }

    const provider =
      paymentService.getProvider(
        providerName
      );

    const payment =
      paymentService.createPaymentIntent({
        userId: req.user.id,
        provider: providerName,
        amount: value,
        currency,
        description: String(
          req.body.description ||
          "Wallet deposit"
        )
      });

    try {
      const checkout =
        await provider.createDeposit({
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
        message: `Your ${payment.amount} ${payment.currency} deposit is being processed.`
      });

      return res.status(201).json({
        message:
          "Deposit checkout created",
        payment_id: payment.id,
        provider:
          checkout.provider,
        provider_reference:
          checkout.provider_reference,
        checkout_url:
          checkout.checkout_url,
        status: "processing",
        amount:
          payment.amount,
        currency:
          payment.currency
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
  res.status(501).json({
    error: "Real-money deposits are not enabled yet",
    message:
      "A verified payment provider must be configured before wallet balances can be funded."
  });
});

app.post("/wallet/withdraw", auth, (req, res) => {
  try {
    const value = Number(req.body.amount);

    if (!Number.isFinite(value) || value <= 0) {
      return res.status(400).json({
        error: "Enter a valid withdrawal amount"
      });
    }

    if (value > 100000000) {
      return res.status(400).json({
        error: "Withdrawal amount is too large"
      });
    }

    const user = db.prepare(`
      SELECT id, full_name, email, balance, currency
      FROM users
      WHERE id = ?
    `).get(req.user.id);

    if (!user) {
      return res.status(401).json({
        error: "User account not found"
      });
    }

    if (Number(user.balance) < value) {
      return res.status(400).json({
        error: "Insufficient balance"
      });
    }

    const currency = String(
      req.body.currency || user.currency || "USD"
    ).trim().toUpperCase();

    if (!/^[A-Z]{3}$/.test(currency)) {
      return res.status(400).json({
        error: "Invalid currency"
      });
    }

    const description = String(
      req.body.description || "Wallet withdrawal"
    ).trim();

    const withdrawal = paymentService.createPaymentIntent({
      userId: user.id,
      provider: String(
        req.body.provider || "flutterwave"
      ).trim().toLowerCase(),
      amount: value,
      currency,
      type: "withdrawal",
      description: description || "Wallet withdrawal"
    });

    createNotification({
      userId: user.id,
      type: "withdrawal",
      title: "Withdrawal request",
      message: `Your withdrawal request for ${value} ${currency} was received.`
    });

    res.status(201).json({
      message: "Withdrawal request created",
      payment_id: withdrawal.id,
      amount: value,
      currency,
      status: "pending",
      balance: Number(user.balance),
      description: description || "Wallet withdrawal"
    });
  } catch (error) {
    console.error("Withdrawal initialization error:", error);

    return res.status(400).json({
      error: error.message || "Unable to create withdrawal"
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Vicky Pay running on port ${PORT}`);
  console.log(`🗄️ SQLite database: data/vicky-wallet.sqlite`);
  console.log(`🔐 JWT authentication enabled`);
});
