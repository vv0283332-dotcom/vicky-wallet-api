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

const app = express();

const PORT = Number(process.env.PORT || 5000);
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is missing");
}

app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
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

const db = new DatabaseSync("./data/vicky-wallet.sqlite");

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
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
      SELECT id, full_name, email, currency, balance, created_at
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
    const createdAt = now();

    db.prepare(`
      INSERT INTO users
      (id, full_name, email, password_hash, currency, balance, created_at)
      VALUES (?, ?, ?, ?, ?, 0, ?)
    `).run(
      userId,
      fullName,
      userEmail,
      passwordHash,
      currency,
      createdAt
    );

    const user = db.prepare(`
      SELECT id, full_name, email, currency, balance, created_at
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

app.post("/wallet/deposit", auth, (req, res) => {
  try {
    const value = Number(req.body.amount);

    if (!amount(value)) {
      return res.status(400).json({
        error: "Invalid deposit amount"
      });
    }

    db.exec("BEGIN IMMEDIATE");

    try {
      db.prepare(`
        UPDATE users
        SET balance = balance + ?
        WHERE id = ?
      `).run(value, req.user.id);

      const transactionId = id();

      db.prepare(`
        INSERT INTO transactions
        (id,user_id,type,amount,currency,description,status,created_at)
        VALUES (?,?,'deposit',?,?,?,'completed',?)
      `).run(
        transactionId,
        req.user.id,
        value,
        req.user.currency,
        String(req.body.description || "Wallet deposit"),
        now()
      );

      db.exec("COMMIT");

      const updated = db.prepare(`
        SELECT balance,currency FROM users WHERE id = ?
      `).get(req.user.id);

      res.status(201).json({
        message: "Deposit successful",
        balance: Number(updated.balance),
        currency: updated.currency,
        transaction_id: transactionId
      });
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Deposit failed" });
  }
});

app.post("/wallet/withdraw", auth, (req, res) => {
  try {
    const value = Number(req.body.amount);

    if (!amount(value)) {
      return res.status(400).json({
        error: "Invalid withdrawal amount"
      });
    }

    db.exec("BEGIN IMMEDIATE");

    try {
      const user = db.prepare(`
        SELECT balance,currency FROM users WHERE id = ?
      `).get(req.user.id);

      if (Number(user.balance) < value) {
        db.exec("ROLLBACK");
        return res.status(400).json({
          error: "Insufficient balance"
        });
      }

      db.prepare(`
        UPDATE users
        SET balance = balance - ?
        WHERE id = ? AND balance >= ?
      `).run(value, req.user.id, value);

      const transactionId = id();

      db.prepare(`
        INSERT INTO transactions
        (id,user_id,type,amount,currency,description,status,created_at)
        VALUES (?,?,'withdrawal',?,?,?,'completed',?)
      `).run(
        transactionId,
        req.user.id,
        value,
        user.currency,
        String(req.body.description || "Wallet withdrawal"),
        now()
      );

      db.exec("COMMIT");

      const updated = db.prepare(`
        SELECT balance,currency FROM users WHERE id = ?
      `).get(req.user.id);

      res.status(201).json({
        message: "Withdrawal successful",
        balance: Number(updated.balance),
        currency: updated.currency,
        transaction_id: transactionId
      });
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Withdrawal failed" });
  }
});

app.post("/wallet/transfer", auth, (req, res) => {
  try {
    const recipientEmail = email(
      req.body.recipient_email ||
      req.body.recipientEmail ||
      req.body.email
    );

    const value = Number(req.body.amount);

    if (!recipientEmail) {
      return res.status(400).json({
        error: "Recipient email is required"
      });
    }

    if (!amount(value)) {
      return res.status(400).json({
        error: "Invalid transfer amount"
      });
    }

    if (recipientEmail === req.user.email) {
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
        SELECT id,balance,currency
        FROM users WHERE email = ?
      `).get(recipientEmail);

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

app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Vicky Wallet running on port ${PORT}`);
  console.log(`🗄️ SQLite database: data/vicky-wallet.sqlite`);
  console.log(`🔐 JWT authentication enabled`);
});
