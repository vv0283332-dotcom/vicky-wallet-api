export class WebhookService {
  constructor(db) {
    this.db = db;
  }

  alreadyProcessed(provider, eventId) {
    if (!eventId) return false;

    const row = this.db.prepare(`
      SELECT id
      FROM payment_webhooks
      WHERE provider = ? AND provider_event_id = ?
      LIMIT 1
    `).get(provider, eventId);

    return Boolean(row);
  }

  recordWebhook({
    id,
    provider,
    eventId,
    eventType,
    payloadHash
  }) {
    const createdAt = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO payment_webhooks
      (
        id,
        provider,
        provider_event_id,
        event_type,
        payload_hash,
        processed,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, 0, ?)
    `).run(
      id,
      provider,
      eventId || null,
      eventType || null,
      payloadHash,
      createdAt
    );
  }
}
