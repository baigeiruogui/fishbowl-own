-- 鱼缸小镇（自建版）数据库 schema
-- 约定：金额单位「鱼币」= 整数；任何余额变动都走 postLedger 并写 ledger（append-only）。
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);

CREATE TABLE IF NOT EXISTS owner (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact TEXT,
  created_at INTEGER NOT NULL
);

-- 多主人账号：ownerToken 只存 sha256 哈希；revoked_at 非空即已撤销
CREATE TABLE IF NOT EXISTS owner_credential (
  owner_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS fish (
  id TEXT PRIMARY KEY,
  owner_id TEXT REFERENCES owner(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'resident',   -- resident | npc
  persona TEXT NOT NULL DEFAULT '',
  intro TEXT NOT NULL DEFAULT '',
  look_note TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',    -- active | paused | banned
  balance INTEGER NOT NULL DEFAULT 0,        -- 鱼币
  day_cap INTEGER,                           -- 每日消费上限（鱼币，NULL=不限）
  quiet_hours TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fish_owner ON fish(owner_id);

CREATE TABLE IF NOT EXISTS resident_code (
  fish_id TEXT PRIMARY KEY REFERENCES fish(id),
  code_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fish_id TEXT NOT NULL REFERENCES fish(id),
  delta INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  reason TEXT NOT NULL,
  ref TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_fish ON ledger(fish_id, id);

CREATE TABLE IF NOT EXISTS job_offer (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  place TEXT,
  pay INTEGER NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 60,
  slots INTEGER NOT NULL DEFAULT 1,
  requirements TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS job_contract (
  id TEXT PRIMARY KEY,
  fish_id TEXT NOT NULL REFERENCES fish(id),
  offer_id TEXT NOT NULL REFERENCES job_offer(id),
  started_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  pay INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'working',    -- working | done | quit
  settled_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_contract_fish ON job_contract(fish_id, state);

CREATE TABLE IF NOT EXISTS shop (
  id TEXT PRIMARY KEY,
  owner_fish_id TEXT NOT NULL REFERENCES fish(id),
  name TEXT NOT NULL,
  kind TEXT,
  open INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shop_item (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shop(id),
  name TEXT NOT NULL,
  price INTEGER NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0,
  desc TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  buyer_fish_id TEXT NOT NULL REFERENCES fish(id),
  shop_id TEXT NOT NULL REFERENCES shop(id),
  item_id TEXT NOT NULL REFERENCES shop_item(id),
  qty INTEGER NOT NULL DEFAULT 1,
  total INTEGER NOT NULL,
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bounty (
  id TEXT PRIMARY KEY,
  poster_fish_id TEXT REFERENCES fish(id),
  title TEXT NOT NULL,
  desc TEXT NOT NULL DEFAULT '',
  reward INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',       -- open | taken | done | expired
  taker_fish_id TEXT REFERENCES fish(id),
  created_at INTEGER NOT NULL,
  claimed_at INTEGER
);

CREATE TABLE IF NOT EXISTS catch (
  id TEXT PRIMARY KEY,
  fish_id TEXT NOT NULL REFERENCES fish(id),
  item TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1,
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS turn (
  id TEXT PRIMARY KEY,
  fish_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  deadline REAL NOT NULL,
  packet_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',    -- pending | answered | closed
  answer TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turn_fish ON turn(fish_id, state);

CREATE TABLE IF NOT EXISTS event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fish_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  data_json TEXT NOT NULL,
  ts INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_event_fish ON event(fish_id, id);

-- ===== P2+ 占位（先建，方便后续分期） =====
CREATE TABLE IF NOT EXISTS venue (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT, config_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS game_session (id TEXT PRIMARY KEY, venue_id TEXT, game TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'waiting', pot INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, config_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS game_seat (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, fish_id TEXT NOT NULL, seat INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'seated');
CREATE TABLE IF NOT EXISTS paper (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, headline TEXT, body TEXT);
CREATE TABLE IF NOT EXISTS court_case (id TEXT PRIMARY KEY, kind TEXT, state TEXT, data_json TEXT NOT NULL DEFAULT '{}', ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS relationship (id INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT NOT NULL, b TEXT NOT NULL, kind TEXT, since INTEGER, UNIQUE(a,b,kind));
CREATE TABLE IF NOT EXISTS phone_message (id INTEGER PRIMARY KEY AUTOINCREMENT, from_fish TEXT, to_fish TEXT, text TEXT, ts INTEGER, read_at INTEGER);
CREATE TABLE IF NOT EXISTS visit (id INTEGER PRIMARY KEY AUTOINCREMENT, host TEXT, guest TEXT, place TEXT, dialogue_json TEXT, ts INTEGER);
CREATE TABLE IF NOT EXISTS moderation (id INTEGER PRIMARY KEY AUTOINCREMENT, fish_id TEXT, kind TEXT, detail TEXT, ts INTEGER);
