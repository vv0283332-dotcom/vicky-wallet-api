export function createEarningsService(db) {
  const now = () => new Date().toISOString();

  db.exec(`
    CREATE TABLE IF NOT EXISTS earning_accounts (
      user_id TEXT PRIMARY KEY,
      available REAL NOT NULL DEFAULT 0,
      lifetime_earned REAL NOT NULL DEFAULT 0,
      lifetime_withdrawn REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

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
      FOREIGN KEY(referral_id) REFERENCES referrals(id)
    );

    CREATE INDEX IF NOT EXISTS idx_earning_transactions_user
      ON earning_transactions(user_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_earning_transactions_referral
      ON earning_transactions(referral_id);
  `);

  function ensureAccount(userId) {
    const existing = db.prepare(`
      SELECT *
      FROM earning_accounts
      WHERE user_id = ?
    `).get(userId);

    if (existing) return existing;

    const timestamp = now();

    db.prepare(`
      INSERT INTO earning_accounts
        (user_id, available, lifetime_earned, lifetime_withdrawn,
         created_at, updated_at)
      VALUES (?, 0, 0, 0, ?, ?)
    `).run(userId, timestamp, timestamp);

    return db.prepare(`
      SELECT *
      FROM earning_accounts
      WHERE user_id = ?
    `).get(userId);
  }

  function getAccount(userId) {
    ensureAccount(userId);

    const totals = db.prepare(`
      SELECT
        COALESCE(SUM(
          CASE
            WHEN amount > 0 THEN amount
            ELSE 0
          END
        ), 0) AS lifetime_earned,

        COALESCE(SUM(
          CASE
            WHEN amount < 0 THEN ABS(amount)
            ELSE 0
          END
        ), 0) AS lifetime_withdrawn

      FROM earning_transactions
      WHERE user_id = ?
    `).get(userId);

    const available = Math.max(
      0,
      Number(totals.lifetime_earned || 0) -
      Number(totals.lifetime_withdrawn || 0)
    );

    const timestamp = now();

    db.prepare(`
      UPDATE earning_accounts
      SET
        available = ?,
        lifetime_earned = ?,
        lifetime_withdrawn = ?,
        updated_at = ?
      WHERE user_id = ?
    `).run(
      available,
      Number(totals.lifetime_earned || 0),
      Number(totals.lifetime_withdrawn || 0),
      timestamp,
      userId
    );

    return db.prepare(`
      SELECT *
      FROM earning_accounts
      WHERE user_id = ?
    `).get(userId);
  }

  function getHistory(userId, limit = 100) {
    const safeLimit = Math.min(
      Math.max(Number(limit) || 100, 1),
      100
    );

    return db.prepare(`
      SELECT
        id,
        type,
        amount,
        currency,
        description,
        referral_id,
        transaction_id,
        created_at
      FROM earning_transactions
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ${safeLimit}
    `).all(userId).map(item => ({
      ...item,
      amount: Number(item.amount)
    }));
  }

  return {
    ensureAccount,
    getAccount,
    getHistory
  };
}
