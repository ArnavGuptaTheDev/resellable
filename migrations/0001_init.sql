-- Resellable initial schema.
-- Times are unix epoch milliseconds. Money is integer minor units (paise).
-- Nothing is hard-deleted from deals, offers, messages, deal_stock_moves.
-- Items and bundles are soft-hidden via status.

-- ---------------------------------------------------------------- access

-- Role is NOT stored here. Effective role is computed on every request:
-- superuser if the email is in SUPERUSER_EMAILS, else allowlist.role.
CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT,
  avatar_url    TEXT,
  disabled      INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  payment_note  TEXT,                         -- seller's "how to pay", e.g. UPI ID
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

-- Superusers come only from SUPERUSER_EMAILS, never from this table.
CREATE TABLE allowlist (
  email      TEXT PRIMARY KEY COLLATE NOCASE,
  role       TEXT NOT NULL CHECK (role IN ('seller', 'buyer')),
  invited_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id_hash    TEXT PRIMARY KEY,                -- hex sha256 of the cookie token
  user_id    INTEGER NOT NULL REFERENCES users(id),
  csrf_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expires ON sessions(expires_at);

-- ---------------------------------------------------------------- catalog

CREATE TABLE items (
  id            INTEGER PRIMARY KEY,
  seller_id     INTEGER NOT NULL REFERENCES users(id),
  title         TEXT NOT NULL DEFAULT '',      -- '' allowed while status = 'draft'
  description   TEXT,
  category      TEXT,
  tags          TEXT NOT NULL DEFAULT '',      -- normalized, comma-separated
  condition     TEXT NOT NULL DEFAULT 'new' CHECK (condition IN ('new', 'used', 'for_parts')),
  quantity      INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  price         INTEGER CHECK (price IS NULL OR price >= 0),   -- NULL = make an offer
  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'listed', 'hidden', 'sold_out')),
  -- 1 when status was set to sold_out automatically by stock reaching 0 at
  -- agreement; a cancel that restores stock flips such items back to listed.
  sold_out_auto INTEGER NOT NULL DEFAULT 0 CHECK (sold_out_auto IN (0, 1)),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX items_seller_status ON items(seller_id, status, updated_at);
CREATE INDEX items_status_updated ON items(status, updated_at);
CREATE INDEX items_category ON items(category COLLATE NOCASE);

CREATE VIRTUAL TABLE items_fts USING fts5(
  title, description, tags,
  content = 'items', content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER items_fts_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, title, description, tags)
  VALUES (new.id, new.title, new.description, new.tags);
END;

CREATE TRIGGER items_fts_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, description, tags)
  VALUES ('delete', old.id, old.title, old.description, old.tags);
END;

-- Only re-index when searchable text changes (not on every stock update).
CREATE TRIGGER items_fts_au AFTER UPDATE OF title, description, tags ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, description, tags)
  VALUES ('delete', old.id, old.title, old.description, old.tags);
  INSERT INTO items_fts(rowid, title, description, tags)
  VALUES (new.id, new.title, new.description, new.tags);
END;

CREATE TABLE item_photos (
  id         INTEGER PRIMARY KEY,
  item_id    INTEGER NOT NULL REFERENCES items(id),
  r2_key     TEXT NOT NULL,
  thumb_key  TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX item_photos_item ON item_photos(item_id, sort_order);

-- Quantity 1 uses items.price. Tiers are only allowed when items.price is
-- not NULL (enforced in the API).
CREATE TABLE item_price_tiers (
  item_id    INTEGER NOT NULL REFERENCES items(id),
  min_qty    INTEGER NOT NULL CHECK (min_qty >= 2),
  unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
  PRIMARY KEY (item_id, min_qty)
);

-- percent_off is only allowed when every component item has a price
-- (enforced in the API); otherwise the bundle must be fixed-price.
CREATE TABLE bundles (
  id             INTEGER PRIMARY KEY,
  seller_id      INTEGER NOT NULL REFERENCES users(id),
  title          TEXT NOT NULL,
  description    TEXT,
  cover_photo_id INTEGER REFERENCES item_photos(id),
  pricing_mode   TEXT NOT NULL CHECK (pricing_mode IN ('fixed', 'percent_off')),
  fixed_price    INTEGER CHECK (fixed_price IS NULL OR fixed_price >= 0),
  percent_off    INTEGER CHECK (percent_off IS NULL OR percent_off BETWEEN 0 AND 100),
  status         TEXT NOT NULL DEFAULT 'listed' CHECK (status IN ('listed', 'hidden')),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  CHECK ((pricing_mode = 'fixed' AND fixed_price IS NOT NULL)
      OR (pricing_mode = 'percent_off' AND percent_off IS NOT NULL))
);
CREATE INDEX bundles_seller ON bundles(seller_id, status);

CREATE TABLE bundle_items (
  bundle_id INTEGER NOT NULL REFERENCES bundles(id),
  item_id   INTEGER NOT NULL REFERENCES items(id),
  quantity  INTEGER NOT NULL CHECK (quantity >= 1),
  PRIMARY KEY (bundle_id, item_id)
);
CREATE INDEX bundle_items_item ON bundle_items(item_id);

-- ---------------------------------------------------------------- deals

CREATE TABLE deals (
  id                INTEGER PRIMARY KEY,
  buyer_id          INTEGER NOT NULL REFERENCES users(id),
  seller_id         INTEGER NOT NULL REFERENCES users(id),
  status            TEXT NOT NULL CHECK (status IN (
                      'cart', 'submitted', 'negotiating', 'agreed',
                      'paid', 'fulfilled', 'completed', 'cancelled')),
  live_offer_id     INTEGER REFERENCES offers(id),  -- NULL after a cart edit voids it
  agreed_total      INTEGER,
  agree_token       TEXT,                           -- random per accept; guards the stock batch
  fulfilment_method TEXT CHECK (fulfilment_method IN ('shipping', 'pickup')),
  fulfilment_notes  TEXT,
  last_activity_at  INTEGER NOT NULL,
  last_activity_by  INTEGER REFERENCES users(id),
  buyer_seen_at     INTEGER NOT NULL DEFAULT 0,
  seller_seen_at    INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  CHECK (buyer_id <> seller_id)
);
CREATE UNIQUE INDEX deals_one_open_cart ON deals(buyer_id, seller_id) WHERE status = 'cart';
CREATE INDEX deals_buyer ON deals(buyer_id, last_activity_at);
CREATE INDEX deals_seller ON deals(seller_id, last_activity_at);

CREATE TABLE deal_lines (
  id                  INTEGER PRIMARY KEY,
  deal_id             INTEGER NOT NULL REFERENCES deals(id),
  item_id             INTEGER REFERENCES items(id),
  bundle_id           INTEGER REFERENCES bundles(id),
  quantity            INTEGER NOT NULL CHECK (quantity >= 1),
  list_unit_price     INTEGER,      -- snapshot incl. tier pricing; NULL = item had no price
  proposed_unit_price INTEGER,      -- buyer's price; required when list_unit_price IS NULL
  removed_at          INTEGER,      -- soft removal
  removed_by          INTEGER REFERENCES users(id),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  CHECK ((item_id IS NULL) <> (bundle_id IS NULL)),
  CHECK (list_unit_price IS NOT NULL OR proposed_unit_price IS NOT NULL)
);
CREATE INDEX deal_lines_deal ON deal_lines(deal_id);

-- Immutable. The live offer is deals.live_offer_id.
CREATE TABLE offers (
  id         INTEGER PRIMARY KEY,
  deal_id    INTEGER NOT NULL REFERENCES deals(id),
  made_by    INTEGER NOT NULL REFERENCES users(id),
  amount     INTEGER NOT NULL CHECK (amount >= 0),
  message    TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX offers_deal ON offers(deal_id, created_at);

-- Immutable.
CREATE TABLE messages (
  id         INTEGER PRIMARY KEY,
  deal_id    INTEGER NOT NULL REFERENCES deals(id),
  author_id  INTEGER NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX messages_deal ON messages(deal_id, created_at);

-- Status changes, cart edits, offer voids, fulfilment updates.
CREATE TABLE deal_events (
  id         INTEGER PRIMARY KEY,
  deal_id    INTEGER NOT NULL REFERENCES deals(id),
  actor_id   INTEGER REFERENCES users(id),
  kind       TEXT NOT NULL,     -- status | line_added | line_changed | line_removed | offer_voided | fulfilment
  data       TEXT NOT NULL DEFAULT '{}',   -- JSON
  created_at INTEGER NOT NULL
);
CREATE INDEX deal_events_deal ON deal_events(deal_id, created_at);

-- Exact stock taken at agreement, one row per (line, item). Bundle lines are
-- expanded into components as they were at that moment. Agreed deals show
-- bundle contents from here, and cancel restores stock from here (never from
-- the current bundle_items).
CREATE TABLE deal_stock_moves (
  id           INTEGER PRIMARY KEY,
  deal_id      INTEGER NOT NULL REFERENCES deals(id),
  deal_line_id INTEGER NOT NULL REFERENCES deal_lines(id),
  bundle_id    INTEGER REFERENCES bundles(id),   -- set when the line is a bundle
  item_id      INTEGER NOT NULL REFERENCES items(id),
  per_unit_qty INTEGER NOT NULL CHECK (per_unit_qty >= 1),  -- component qty per bundle; 1 for item lines
  quantity     INTEGER NOT NULL CHECK (quantity >= 1),      -- units taken = line qty × per_unit_qty
  created_at   INTEGER NOT NULL,
  restored_at  INTEGER                            -- set when a cancel puts the stock back
);
CREATE INDEX deal_stock_moves_deal ON deal_stock_moves(deal_id);
