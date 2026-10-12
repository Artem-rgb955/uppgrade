-- Схема базы данных CRYPTO UPGRADE. Безопасно запускать повторно (в том числе на старой базе).

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  telegram_id TEXT UNIQUE NOT NULL,
  username TEXT NOT NULL DEFAULT 'Player',
  steam_inventory_url TEXT NOT NULL DEFAULT '',
  balance_cents BIGINT NOT NULL DEFAULT 0 CHECK (balance_cents >= 0), -- баланс в копейках (RUB)
  welcome_bonus_claimed BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE users ALTER COLUMN balance_cents SET DEFAULT 0;

-- Цены в таблице items хранятся в копейках (колонка называется price_cents по историческим причинам).
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  weapon TEXT NOT NULL,
  skin TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  image_url TEXT NOT NULL DEFAULT '',
  rarity TEXT NOT NULL DEFAULT 'Consumer',
  is_demo BOOLEAN NOT NULL DEFAULT FALSE
);
ALTER TABLE items ADD COLUMN IF NOT EXISTS market_hash_name TEXT NOT NULL DEFAULT '';
ALTER TABLE items ADD COLUMN IF NOT EXISTS market_url TEXT NOT NULL DEFAULT '';
ALTER TABLE items ADD COLUMN IF NOT EXISTS listings INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE INDEX IF NOT EXISTS items_price_idx ON items (price_cents, id);

CREATE TABLE IF NOT EXISTS inventory (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id),
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS inventory_user_idx ON inventory (user_id);

CREATE TABLE IF NOT EXISTS transactions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  amount_cents BIGINT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- external_id нужен для крипто-платежей: один и тот же платёж нельзя зачислить дважды.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS external_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS transactions_external_id_idx ON transactions (external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS upgrade_history (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_item_id TEXT NOT NULL REFERENCES items(id),
  target_item_id TEXT NOT NULL REFERENCES items(id),
  chance_percent INTEGER NOT NULL CHECK (chance_percent IN (80,75,50,30,10)),
  success BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Удаляем старые выдуманные тестовые предметы (если на них никто не ссылается).
-- Настоящий каталог с реальными ценами и картинками загружается командой: npm run import:steam
DELETE FROM items i
WHERE i.id IN ('ak-slate','awp-neo-noir','p250-sand-dune','galil-tuxedo','m4a1s-decimator','usp-printstream',
               'awp-asiimov','ak-redline','glock-vogue','m4a4-emperor','knife-demo','gloves-demo')
  AND NOT EXISTS (SELECT 1 FROM inventory v WHERE v.item_id = i.id)
  AND NOT EXISTS (SELECT 1 FROM upgrade_history h WHERE h.source_item_id = i.id OR h.target_item_id = i.id);
