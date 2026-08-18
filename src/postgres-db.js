import pg from "pg";
import { AsyncLocalStorage } from "node:async_hooks";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : { rejectUnauthorized: false }
});

const transactionStorage = new AsyncLocalStorage();

function currentClient() {
  return transactionStorage.getStore()?.client || null;
}

function executor() {
  return currentClient() || pool;
}

function convertSql(sql, params = []) {
  let index = 0;

  const converted = sql
    .replace(/`/g, "")
    .replace(/\?/g, () => `$${++index}`);

  return {
    sql: converted,
    params
  };
}

function normalizeRows(rows) {
  return rows.map(row => ({ ...row }));
}

class PreparedStatement {
  constructor(sql) {
    this.sql = sql;
  }

  async all(...params) {
    const converted = convertSql(this.sql, params);

    const result = await executor().query(
      converted.sql,
      converted.params
    );

    return normalizeRows(result.rows);
  }

  async get(...params) {
    const converted = convertSql(this.sql, params);

    const result = await executor().query(
      converted.sql,
      converted.params
    );

    return result.rows[0];
  }

  async run(...params) {
    const converted = convertSql(this.sql, params);

    const result = await executor().query(
      converted.sql,
      converted.params
    );

    return {
      changes: result.rowCount,
      lastInsertRowid: result.rows[0]?.id ?? null
    };
  }
}

async function beginLegacyTransaction() {
  if (currentClient()) {
    throw new Error("Transaction already active");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    transactionStorage.enterWith({ client });
  } catch (error) {
    client.release();
    throw error;
  }
}

async function finishLegacyTransaction(sql) {
  const state = transactionStorage.getStore();

  if (!state?.client) {
    throw new Error(`No active PostgreSQL transaction for ${sql}`);
  }

  const client = state.client;

  try {
    await client.query(sql);
  } finally {
    client.release();

    // Clear the transaction from this async execution context.
    transactionStorage.enterWith(null);
  }
}

export const db = {
  prepare(sql) {
    return new PreparedStatement(sql);
  },

  async exec(sql) {
    const normalized = String(sql).trim().toUpperCase();

    if (normalized === "BEGIN") {
      return beginLegacyTransaction();
    }

    if (normalized === "COMMIT") {
      return finishLegacyTransaction("COMMIT");
    }

    if (normalized === "ROLLBACK") {
      return finishLegacyTransaction("ROLLBACK");
    }

    return executor().query(sql);
  },

  async transaction(callback) {
    if (currentClient()) {
      throw new Error("Nested PostgreSQL transaction is not allowed");
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      return await transactionStorage.run(
        { client },
        async () => {
          const tx = {
            prepare(sql) {
              return {
                async all(...params) {
                  const converted = convertSql(sql, params);

                  const result = await client.query(
                    converted.sql,
                    converted.params
                  );

                  return normalizeRows(result.rows);
                },

                async get(...params) {
                  const converted = convertSql(sql, params);

                  const result = await client.query(
                    converted.sql,
                    converted.params
                  );

                  return result.rows[0];
                },

                async run(...params) {
                  const converted = convertSql(sql, params);

                  const result = await client.query(
                    converted.sql,
                    converted.params
                  );

                  return {
                    changes: result.rowCount,
                    lastInsertRowid:
                      result.rows[0]?.id ?? null
                  };
                }
              };
            }
          };

          try {
            const result = await callback(tx);

            await client.query("COMMIT");

            return result;
          } catch (error) {
            try {
              await client.query("ROLLBACK");
            } catch {}

            throw error;
          }
        }
      );
    } finally {
      client.release();
    }
  },

  pool
};

export async function closePostgres() {
  await pool.end();
}
