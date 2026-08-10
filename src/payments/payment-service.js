import crypto from "node:crypto";

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

  validateAmount(amount) {
    return Number.isFinite(amount) &&
      amount > 0 &&
      amount <= 100000000;
  }

  createPaymentIntent({
    userId,
    provider,
    amount,
    currency,
    type = "deposit",
    description
  }) {
    if (!this.validateAmount(amount)) {
      throw new Error("Invalid payment amount");
    }

    if (!["deposit", "withdrawal"].includes(type)) {
      throw new Error("Invalid payment type");
    }

    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new Error("Invalid currency");
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
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(
      paymentId,
      userId,
      provider,
      amount,
      currency,
      type,
      description ||
        (type === "withdrawal"
          ? "Wallet withdrawal"
          : "Wallet deposit"),
      timestamp,
      timestamp
    );

    return this.getPaymentIntent(paymentId);
  }

  getPaymentIntent(paymentId) {
    return this.db.prepare(`
      SELECT *
      FROM payment_intents
      WHERE id = ?
    `).get(paymentId);
  }

  setProviderReference(paymentId, providerReference) {
    if (!providerReference) {
      throw new Error("Provider reference is required");
    }

    const updatedAt = new Date().toISOString();

    this.db.prepare(`
      UPDATE payment_intents
      SET provider_reference = ?,
          status = 'processing',
          updated_at = ?
      WHERE id = ?
    `).run(
      providerReference,
      updatedAt,
      paymentId
    );

    return this.getPaymentIntent(paymentId);
  }

  updateStatus(paymentId, status) {
    const allowed = [
      "pending",
      "processing",
      "completed",
      "failed",
      "cancelled"
    ];

    if (!allowed.includes(status)) {
      throw new Error("Invalid payment status");
    }

    const updatedAt = new Date().toISOString();

    this.db.prepare(`
      UPDATE payment_intents
      SET status = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      status,
      updatedAt,
      paymentId
    );

    return this.getPaymentIntent(paymentId);
  }
}
