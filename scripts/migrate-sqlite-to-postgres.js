import "dotenv/config";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import fs from "node:fs/promises";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const sqlite = new DatabaseSync("./data/vicky-wallet.sqlite");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const client = await pool.connect();

const tables = [
  "users",
  "transactions",
  "ledger_entries",
  "payment_intents",
  "payment_webhooks",
  "linked_accounts",
  "referrals",
  "earning_accounts",
  "earning_transactions",
  "notifications"
];

try {
  console.log("Connecting to PostgreSQL...");
  await client.query("SELECT 1");

  const schema = await fs.readFile(
    "./scripts/create-postgres-schema.sql",
    "utf8"
  );

  await client.query(schema);

  await client.query("BEGIN");

  // USERS
  const users = sqlite.prepare(`
    SELECT id, full_name, email, password_hash, currency, balance,
           created_at, account_id, referral_code, avatar_url
    FROM users
  `).all();

  for (const u of users) {
    await client.query(`
      INSERT INTO users
      (id,full_name,email,password_hash,currency,balance,created_at,
       account_id,referral_code,avatar_url)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (id) DO UPDATE SET
        full_name=EXCLUDED.full_name,
        email=EXCLUDED.email,
        password_hash=EXCLUDED.password_hash,
        currency=EXCLUDED.currency,
        balance=EXCLUDED.balance,
        account_id=EXCLUDED.account_id,
        referral_code=EXCLUDED.referral_code,
        avatar_url=EXCLUDED.avatar_url
    `, [
      u.id,u.full_name,u.email,u.password_hash,u.currency,u.balance,
      u.created_at,u.account_id,u.referral_code,u.avatar_url
    ]);

    const wallet = await client.query(`
      INSERT INTO wallets (user_id,currency)
      VALUES ($1,$2)
      ON CONFLICT (user_id,currency)
      DO UPDATE SET currency=EXCLUDED.currency
      RETURNING id
    `, [u.id, u.currency]);

    await client.query(`
      INSERT INTO wallet_balances(wallet_id,available,locked)
      VALUES($1,$2,0)
      ON CONFLICT(wallet_id)
      DO UPDATE SET
        available=EXCLUDED.available,
        updated_at=NOW()
    `, [wallet.rows[0].id, u.balance]);
  }

  // Generic table migrations for existing SQLite records.
  const columns = {
    transactions: [
      "id","user_id","type","amount","currency","description",
      "related_user_id","status","created_at"
    ],
    ledger_entries: [
      "id","user_id","payment_intent_id","transaction_id","entry_type",
      "amount","currency","description","created_at"
    ],
    payment_intents: [
      "id","user_id","provider","provider_reference","amount","currency",
      "type","status","description","created_at","updated_at"
    ],
    payment_webhooks: [
      "id","provider","provider_event_id","event_type","payload_hash",
      "processed","created_at","processed_at"
    ],
    linked_accounts: [
      "id","user_id","provider","provider_account_id","account_name",
      "masked_account_number","account_type","currency","balance",
      "balance_updated_at","status","created_at","updated_at"
    ],
    referrals: [
      "id","referrer_id","referred_id","referral_code","status",
      "qualifying_payment_id","reward_amount","reward_currency",
      "rewarded_at","created_at"
    ],
    earning_accounts: [
      "user_id","available","lifetime_earned","lifetime_withdrawn",
      "created_at","updated_at"
    ],
    earning_transactions: [
      "id","user_id","type","amount","currency","description",
      "referral_id","transaction_id","created_at"
    ],
    notifications: [
      "id","user_id","type","title","message","read","created_at"
    ]
  };

  for (const table of tables.slice(1)) {
    const exists = sqlite.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name=?
    `).get(table);

    if (!exists) continue;

    const rows = sqlite.prepare(`SELECT * FROM "${table}"`).all();

    if (!rows.length) continue;

    const cols = columns[table];

    for (const row of rows) {
      const values = cols.map(c => row[c] ?? null);
      const placeholders = values.map((_, i) => `$${i + 1}`).join(",");

      const conflict =
        table === "earning_accounts"
          ? "ON CONFLICT (user_id) DO NOTHING"
          : table === "linked_accounts"
            ? "ON CONFLICT (id) DO NOTHING"
            : "ON CONFLICT DO NOTHING";

      await client.query(`
        INSERT INTO "${table}" (${cols.join(",")})
        VALUES (${placeholders})
        ${conflict}
      `, values);
    }
  }

  await client.query("COMMIT");

  console.log("=================================");
  console.log("VICKY PAY POSTGRES MIGRATION DONE");
  console.log(`Users: ${users.length}`);
  console.log("Existing SQLite database untouched.");
  console.log("=================================");

} catch (error) {
  try {
    await client.query("ROLLBACK");
  } catch {}

  console.error("MIGRATION FAILED:", error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
