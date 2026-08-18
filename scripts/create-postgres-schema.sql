CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'USD',
    balance NUMERIC(30,10) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL,
    account_id TEXT UNIQUE,
    referral_code TEXT UNIQUE,
    avatar_url TEXT
);

CREATE TABLE IF NOT EXISTS wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL REFERENCES users(id),
    currency CHAR(3) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, currency)
);

CREATE TABLE IF NOT EXISTS wallet_balances (
    wallet_id UUID PRIMARY KEY REFERENCES wallets(id),
    available NUMERIC(30,10) NOT NULL DEFAULT 0,
    locked NUMERIC(30,10) NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (available >= 0),
    CHECK (locked >= 0)
);

CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    type TEXT NOT NULL,
    amount NUMERIC(30,10) NOT NULL,
    currency CHAR(3) NOT NULL,
    description TEXT,
    related_user_id TEXT REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'completed',
    created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger_entries (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    wallet_id UUID REFERENCES wallets(id),
    payment_intent_id TEXT,
    transaction_id TEXT REFERENCES transactions(id),
    entry_type TEXT NOT NULL,
    amount NUMERIC(30,10) NOT NULL,
    currency CHAR(3) NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_intents (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    provider TEXT NOT NULL,
    provider_reference TEXT,
    amount NUMERIC(30,10) NOT NULL,
    currency CHAR(3) NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_webhooks (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_event_id TEXT,
    event_type TEXT,
    payload_hash TEXT NOT NULL,
    processed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL,
    processed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_webhooks_provider_event
ON payment_webhooks(provider, provider_event_id)
WHERE provider_event_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_webhooks_hash
ON payment_webhooks(payload_hash);

CREATE TABLE IF NOT EXISTS linked_accounts (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    provider TEXT NOT NULL,
    provider_account_id TEXT NOT NULL,
    account_name TEXT,
    masked_account_number TEXT,
    account_type TEXT,
    currency CHAR(3) NOT NULL DEFAULT 'NGN',
    balance NUMERIC(30,10) NOT NULL DEFAULT 0,
    balance_updated_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'connected',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS referrals (
    id TEXT PRIMARY KEY,
    referrer_id TEXT NOT NULL REFERENCES users(id),
    referred_id TEXT NOT NULL REFERENCES users(id),
    referral_code TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    qualifying_payment_id TEXT,
    reward_amount NUMERIC(30,10) NOT NULL DEFAULT 5,
    reward_currency CHAR(3) NOT NULL DEFAULT 'USD',
    rewarded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS earning_accounts (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    available NUMERIC(30,10) NOT NULL DEFAULT 0,
    lifetime_earned NUMERIC(30,10) NOT NULL DEFAULT 0,
    lifetime_withdrawn NUMERIC(30,10) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS earning_transactions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    type TEXT NOT NULL,
    amount NUMERIC(30,10) NOT NULL,
    currency CHAR(3) NOT NULL,
    description TEXT NOT NULL,
    referral_id TEXT REFERENCES referrals(id),
    transaction_id TEXT REFERENCES transactions(id),
    created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    read BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS exchange_transactions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    from_wallet_id UUID NOT NULL REFERENCES wallets(id),
    to_wallet_id UUID NOT NULL REFERENCES wallets(id),
    from_amount NUMERIC(30,10) NOT NULL,
    to_amount NUMERIC(30,10) NOT NULL,
    from_currency CHAR(3) NOT NULL,
    to_currency CHAR(3) NOT NULL,
    rate NUMERIC(30,15) NOT NULL,
    provider TEXT NOT NULL,
    rate_timestamp TIMESTAMPTZ NOT NULL,
    fee_amount NUMERIC(30,10) NOT NULL DEFAULT 0,
    fee_currency CHAR(3),
    status TEXT NOT NULL DEFAULT 'completed',
    created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    key TEXT NOT NULL,
    operation TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    response_status INTEGER,
    response_body JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, key, operation)
);

CREATE INDEX IF NOT EXISTS idx_wallets_user
ON wallets(user_id);

CREATE INDEX IF NOT EXISTS idx_transactions_user_created
ON transactions(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ledger_user_created
ON ledger_entries(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_exchange_user_created
ON exchange_transactions(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_user
ON notifications(user_id, read, created_at DESC);

CREATE TABLE IF NOT EXISTS referral_codes (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    code TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_codes_code
ON referral_codes(code);

-- Case-insensitive email uniqueness
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower
ON users (LOWER(email));


-- VICKY PAYMENT SAFETY CONSTRAINTS

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
