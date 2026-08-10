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
const app = express();

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
const paymentProviders = {
  mock: new MockProvider(),
  flutterwave: new FlutterwaveProvider()
};

const paymentService = new PaymentService(db, paymentProviders);
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
  created_at TEXT NOT NULL
);

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
`);

const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();

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
      SELECT id, account_id, full_name, email, currency, balance, created_at
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
    name: "Vicky Wallet API",
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

app.post("/auth/register", async (req, res) => {
  try {
    const fullName = String(
      req.body.full_name || req.body.fullName || ""
    ).trim();

    const userEmail = email(req.body.email);
    const password = String(req.body.password || "");

    const currency = String(
      req.body.preferred_currency ||
      req.body.preferredCurrency ||
      req.body.currency ||
      "USD"
    ).trim().toUpperCase();

    if (!fullName) {
      return res.status(400).json({ error: "Full name is required" });
    }

    if (!userEmail.includes("@")) {
      return res.status(400).json({ error: "Valid email is required" });
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
      "SELECT id FROM users WHERE email = ?"
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

    db.prepare(`
      INSERT INTO users
      (id, account_id, full_name, email, password_hash, currency, balance, created_at)
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

    const user = db.prepare(`
      SELECT id, account_id, full_name, email, currency, balance, created_at
      FROM users WHERE id = ?
    `).get(userId);

    res.status(201).json({
      message: "Registration successful",
      token: token(user),
      user: userData(user)
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Registration failed" });
  }
});

app.post("/auth/login", async (req, res) => {
  try {
    const userEmail = email(req.body.email);
    const password = String(req.body.password || "");

    const user = db.prepare(
      "SELECT * FROM users WHERE email = ?"
    ).get(userEmail);

    if (!user) {
      return res.status(401).json({
        error: "Invalid email or password"
      });
    }

    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({
        error: "Invalid email or password"
      });
    }

    res.json({
      message: "Login successful",
      token: token(user),
      user: userData(user)
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Login failed" });
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

    db.exec("COMMIT");

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
  res.status(501).json({
    error: "Real-money withdrawals are not enabled yet",
    message:
      "A verified payout provider must be configured before funds can leave the wallet."
  });
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

    db.exec("BEGIN IMMEDIATE");

    try {
      const sender = db.prepare(`
        SELECT id,balance,currency
        FROM users WHERE id = ?
      `).get(req.user.id);

      const recipient = db.prepare(`
        SELECT id,account_id,full_name,balance,currency
        FROM users WHERE account_id = ?
      `).get(recipientAccountId);

      if (!recipient) {
        db.exec("ROLLBACK");
        return res.status(404).json({
          error: "Recipient not found"
        });
      }

      if (sender.currency !== recipient.currency) {
        db.exec("ROLLBACK");
        return res.status(400).json({
          error: "Currencies must match"
        });
      }

      if (Number(sender.balance) < value) {
        db.exec("ROLLBACK");
        return res.status(400).json({
          error: "Insufficient balance"
        });
      }

      db.prepare(`
        UPDATE users
        SET balance = balance - ?
        WHERE id = ? AND balance >= ?
      `).run(value, sender.id, value);

      db.prepare(`
        UPDATE users
        SET balance = balance + ?
        WHERE id = ?
      `).run(value, recipient.id);

      const transferId = id();
      const createdAt = now();
      const description = String(
        req.body.description || "Wallet transfer"
      );

      db.prepare(`
        INSERT INTO transactions
        (id,user_id,type,amount,currency,description,related_user_id,status,created_at)
        VALUES (?,?,'transfer_sent',?,?,?,?, 'completed',?)
      `).run(
        transferId,
        sender.id,
        value,
        sender.currency,
        description,
        recipient.id,
        createdAt
      );

      db.prepare(`
        INSERT INTO transactions
        (id,user_id,type,amount,currency,description,related_user_id,status,created_at)
        VALUES (?,?,'transfer_received',?,?,?,?, 'completed',?)
      `).run(
        id(),
        recipient.id,
        value,
        recipient.currency,
        description,
        sender.id,
        createdAt
      );

      db.exec("COMMIT");

      const updated = db.prepare(`
        SELECT balance,currency FROM users WHERE id = ?
      `).get(sender.id);

      res.status(201).json({
        message: "Transfer successful",
        transaction_id: transferId,
        balance: Number(updated.balance),
        currency: updated.currency
      });
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Transfer failed" });
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
  console.log(`🚀 Vicky Wallet running on port ${PORT}`);
  console.log(`🗄️ SQLite database: data/vicky-wallet.sqlite`);
  console.log(`🔐 JWT authentication enabled`);
});
