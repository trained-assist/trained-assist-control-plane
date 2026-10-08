-- Telegram self-registration, profile and immutable starter allowance.
-- Identity keys are private Telegram user IDs scoped by the registered bot.
CREATE TABLE telegram_accounts (
  account_id TEXT PRIMARY KEY,
  bot_identity TEXT NOT NULL,
  telegram_user_id TEXT NOT NULL,
  profile_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE(bot_identity, telegram_user_id)
);

CREATE TABLE telegram_profiles (
  profile_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL UNIQUE REFERENCES telegram_accounts(account_id),
  display_name TEXT NOT NULL,
  activity_text TEXT NOT NULL,
  social_url TEXT NOT NULL,
  private_chat_id TEXT NOT NULL,
  consent_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE account_budget_ledger (
  entry_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES telegram_accounts(account_id),
  profile_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('grant','reserve','settle','release','expire','adjust')),
  amount INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  task_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_budget_account_created ON account_budget_ledger(account_id, created_at);

CREATE TABLE account_budget_state (
  account_id TEXT PRIMARY KEY REFERENCES telegram_accounts(account_id),
  grant_amount INTEGER NOT NULL CHECK(grant_amount >= 0),
  reserved_amount INTEGER NOT NULL DEFAULT 0 CHECK(reserved_amount >= 0),
  consumed_amount INTEGER NOT NULL DEFAULT 0 CHECK(consumed_amount >= 0),
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE telegram_onboarding_sessions (
  bot_identity TEXT NOT NULL,
  telegram_user_id TEXT NOT NULL,
  private_chat_id TEXT NOT NULL,
  step TEXT NOT NULL CHECK(step IN ('activity','social_url','profile_name','complete')),
  activity_text TEXT,
  social_url TEXT,
  profile_name TEXT,
  consent_version TEXT NOT NULL,
  last_update_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(bot_identity, telegram_user_id)
);

CREATE TABLE telegram_update_receipts (
  bot_identity TEXT NOT NULL,
  update_id INTEGER NOT NULL,
  telegram_user_id TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(bot_identity, update_id)
);
