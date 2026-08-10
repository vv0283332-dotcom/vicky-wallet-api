export class PaymentService {
  constructor(db, providers = {}) {
    this.db = db;
    this.providers = providers;
  }

  getProvider(name) {
    const provider = this.providers[name];

    if (!provider) {
      throw new Error(`Payment provider "${name}" is not configured`);
    }

    return provider;
  }

  createPaymentIntent({
    userId,
    provider,
    amount,
    currency,
    description
  }) {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("Invalid payment amount");
    }

    const paymentId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO payment_intents
      (
        id,
        user_id,
        provider,
        amount,
        currency,
        type,
        status,
        description,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, 'deposit', 'pending', ?, ?, ?)
    `).run(
      paymentId,
      userId,
      provider,
      amount,
      currency,
      description || "Wallet deposit",
      timestamp,
      timestamp
    );

    return this.db.prepare(`
      SELECT *
      FROM payment_intents
      WHERE id = ?
    `).get(paymentId);
  }
}
