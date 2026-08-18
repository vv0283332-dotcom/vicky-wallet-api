export class WebhookService {
  constructor(db) {
    this.db = db;
  }

  async alreadyProcessed(provider, eventId) {
    if (!eventId) return false;

    const row = await this.db.prepare(`
      SELECT id, processed
      FROM payment_webhooks
      WHERE provider = ?
        AND provider_event_id = ?
      LIMIT 1
    `).get(provider, eventId);

    return Boolean(row);
  }

  async recordWebhook({
    id,
    provider,
    eventId,
    eventType,
    payloadHash
  }) {
    const createdAt = new Date().toISOString();

    await this.db.prepare(`
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
      VALUES (?, ?, ?, ?, ?, FALSE, ?)
      ON CONFLICT DO NOTHING
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
