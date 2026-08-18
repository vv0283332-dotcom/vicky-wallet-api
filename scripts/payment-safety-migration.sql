CREATE UNIQUE INDEX IF NOT EXISTS
idx_ledger_payment_credit_once
ON ledger_entries(payment_intent_id)
WHERE payment_intent_id IS NOT NULL
  AND entry_type = 'credit';

CREATE UNIQUE INDEX IF NOT EXISTS
idx_ledger_payment_debit_once
ON ledger_entries(payment_intent_id)
WHERE payment_intent_id IS NOT NULL
  AND entry_type = 'debit';

CREATE UNIQUE INDEX IF NOT EXISTS
idx_payment_webhooks_event_once
ON payment_webhooks(provider, provider_event_id)
WHERE provider_event_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS
idx_payment_webhooks_payload_once
ON payment_webhooks(payload_hash);
