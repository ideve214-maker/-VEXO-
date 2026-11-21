-- 2.1.0 用户分类：human 真实注册，ai 内部机器人。旧行默认真人，避免被误标。
ALTER TABLE users ADD COLUMN account_kind TEXT NOT NULL DEFAULT 'human';
CREATE INDEX IF NOT EXISTS idx_users_account_kind ON users(account_kind);
