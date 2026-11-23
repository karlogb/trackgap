/**
 * TrackGap - database.
 *
 * Local SQLite on the VPS. The disk is NOT encrypted (ext4, no LUKS), and
 * Shopify requires encryption at rest for protected customer data.
 * Solution: sensitive fields (access/refresh tokens) are encrypted in the
 * application with AES-256-GCM before writing. Orders contain ONLY the ID,
 * amount, time and UTM: no name, e-mail, address or phone (PCD Level 1,
 * data minimisation).
 */
import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.TRACKGAP_DATA
  || path.join(path.dirname(new URL(import.meta.url).pathname), "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

const KEY_FILE = path.join(DATA_DIR, ".enc_key");
if (!fs.existsSync(KEY_FILE)) {
  fs.writeFileSync(KEY_FILE, crypto.randomBytes(32), { mode: 0o600 });
}
const KEY = fs.readFileSync(KEY_FILE);

export function encrypt(plain) {
  if (plain == null) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}

export function decrypt(blob) {
  if (blob == null) return null;
  const raw = Buffer.from(blob, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", KEY, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}

// `TRACKGAP_DB` lets tests run against their own file. Without it tests
// would write into the production DB, and if someone ran them on the server
// by mistake they would mix into real merchant data.
export const db = new Database(
  process.env.TRACKGAP_DB || path.join(DATA_DIR, "trackgap.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS shops (
  id                   INTEGER PRIMARY KEY,
  shop_domain          TEXT UNIQUE NOT NULL,
  access_token_enc     TEXT,
  plan                 TEXT NOT NULL DEFAULT 'free',
  installed_at         TEXT NOT NULL DEFAULT (datetime('now')),
  uninstalled_at       TEXT,
  ga4_property_id      TEXT,
  google_refresh_enc   TEXT,
  timezone             TEXT,
  currency             TEXT,
  last_sync_at         TEXT,
  mp_measurement_id    TEXT,
  mp_api_secret_enc    TEXT,
  backfill_enabled     INTEGER DEFAULT 0,
  alert_email          TEXT,
  primary_domain       TEXT,
  shop_name            TEXT,
  refresh_token_enc    TEXT,
  token_expires_at     TEXT
);

-- PCD Level 1: no personal data
CREATE TABLE IF NOT EXISTS orders (
  shop_id          INTEGER NOT NULL REFERENCES shops(id),
  order_id         TEXT NOT NULL,
  order_number     TEXT,
  total            REAL,
  currency         TEXT,
  created_at       TEXT,
  landing_site     TEXT,
  referring_site   TEXT,
  utm_source       TEXT,
  utm_medium       TEXT,
  utm_campaign     TEXT,
  subtotal         REAL,
  shipping         REAL,
  tax              REAL,
  discounts        REAL,
  cancelled        INTEGER DEFAULT 0,
  financial_status TEXT,
  PRIMARY KEY (shop_id, order_id)
);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(shop_id, created_at);

-- dedup of incoming webhooks (X-Shopify-Webhook-Id)
CREATE TABLE IF NOT EXISTS webhook_log (
  webhook_id TEXT PRIMARY KEY,
  topic      TEXT,
  seen_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_webhook_seen ON webhook_log(seen_at);

-- identity from the web pixel: GA4 client_id + ad click IDs
-- NOTE: defined ONLY here. backfill.mjs and monitor.mjs no longer have their
-- own CREATE TABLE; two definitions of the same table meant the schema
-- depended on import order.
CREATE TABLE IF NOT EXISTS identities (
  shop_id        INTEGER NOT NULL REFERENCES shops(id),
  checkout_token TEXT,
  order_id       TEXT,
  ga_client_id   TEXT,
  ga_session_id  TEXT,
  gclid          TEXT,
  fbclid         TEXT,
  consent        TEXT,
  seen_at        TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (shop_id, checkout_token)
);
CREATE INDEX IF NOT EXISTS idx_ident_order ON identities(shop_id, order_id);
CREATE INDEX IF NOT EXISTS idx_identities_seen ON identities(seen_at);

-- Reserves an order before its conversion is sent.
-- orders/create and orders/updated arrive simultaneously; without this lock both
-- passed the check and the conversion was sent twice.
CREATE TABLE IF NOT EXISTS backfill_locks (
  shop_id    INTEGER NOT NULL,
  order_id   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (shop_id, order_id)
);

-- conversion backfill attempts (GA4 MP / Meta CAPI)
CREATE TABLE IF NOT EXISTS backfills (
  id         INTEGER PRIMARY KEY,
  shop_id    INTEGER NOT NULL REFERENCES shops(id),
  order_id   TEXT NOT NULL,
  status     TEXT NOT NULL,          -- sent | skipped | failed
  reason     TEXT,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_backfills_shop ON backfills(shop_id, created_at);
CREATE INDEX IF NOT EXISTS idx_backfills_order ON backfills(shop_id, order_id);

-- check history and result cache
CREATE TABLE IF NOT EXISTS check_history (
  id           INTEGER PRIMARY KEY,
  shop_id      INTEGER NOT NULL REFERENCES shops(id),
  ran_at       TEXT NOT NULL DEFAULT (datetime('now')),
  orders       INTEGER,
  ga4          INTEGER,
  missing      INTEGER,
  missing_pct  REAL,
  duplicates   INTEGER,
  payload      TEXT
);
CREATE INDEX IF NOT EXISTS idx_check_history ON check_history(shop_id, ran_at);

CREATE TABLE IF NOT EXISTS check_cache (
  shop_id    INTEGER PRIMARY KEY REFERENCES shops(id),
  payload    TEXT,
  cached_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS alerts (
  id         INTEGER PRIMARY KEY,
  shop_id    INTEGER NOT NULL REFERENCES shops(id),
  kind       TEXT NOT NULL,
  message    TEXT,
  sent_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_alerts_pending ON alerts(shop_id, sent_at);


-- what actually left the browser (our web pixel)
CREATE TABLE IF NOT EXISTS pixel_events (
  shop_id    INTEGER NOT NULL REFERENCES shops(id),
  order_id   TEXT NOT NULL,
  event_type TEXT NOT NULL,
  fired_at   TEXT NOT NULL,
  PRIMARY KEY (shop_id, order_id, event_type)
);

-- what reached GA4 (fetched via the merchant's OAuth)
CREATE TABLE IF NOT EXISTS ga4_events (
  shop_id        INTEGER NOT NULL REFERENCES shops(id),
  transaction_id TEXT NOT NULL,
  revenue        REAL,
  event_count    INTEGER DEFAULT 1,
  date           TEXT,
  source         TEXT,
  medium         TEXT,
  PRIMARY KEY (shop_id, transaction_id)
);

CREATE TABLE IF NOT EXISTS findings (
  id          INTEGER PRIMARY KEY,
  shop_id     INTEGER NOT NULL REFERENCES shops(id),
  type        TEXT NOT NULL,      -- missing | duplicate | revenue_gap | ghost
  severity    TEXT NOT NULL,      -- low | medium | high
  count       INTEGER,
  detail      TEXT,               -- JSON: order_ids, ciselne udaje
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_findings_shop ON findings(shop_id, detected_at);

CREATE TABLE IF NOT EXISTS sessions (
  id      TEXT PRIMARY KEY,
  shop    TEXT NOT NULL,
  state   TEXT,
  is_online INTEGER DEFAULT 0,
  scope   TEXT,
  expires TEXT,
  access_token_enc TEXT,
  user_id TEXT
);

-- Queue for GDPR data requests. Shopify only acknowledges the webhook; the
-- prepared export must then be delivered to the merchant through the
-- operator's privacy-request process.
CREATE TABLE IF NOT EXISTS privacy_requests (
  id          INTEGER PRIMARY KEY,
  request_id  TEXT UNIQUE,
  shop_id     INTEGER NOT NULL REFERENCES shops(id),
  topic       TEXT NOT NULL,
  order_ids   TEXT,
  export_json TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_privacy_pending
  ON privacy_requests(completed_at, created_at);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Versioned, transactional home for every future schema change. Version 1 is
// the current consolidated baseline created above; later releases append a
// migration instead of relying on hand-run ALTER TABLE statements.
const migrations = [
  { version: 1, run() {} },

  /**
   * v2 - pixel_events as a full THIRD MEASUREMENT LAYER.
   *
   * The original table had PK (shop_id, order_id, event_type) and was NEVER
   * written to: the server stored `checkout_completed` only as an "identity".
   * So it was impossible to tell "GA4 did not receive it" from "it never left
   * the browser", which is the whole reason we have our own pixel.
   *
   * Problem with the original PK: at `checkout_completed` time we often do NOT
   * know the order_id (Shopify may leave it empty in the event); the anchor is
   * then checkout_token and order_id is filled in later from the
   * orders/create webhook.
   *
   * So uniqueness must NOT rely on order_id: it changes from NULL to a value
   * over time, and every repeated event (keepalive retry, thank-you page
   * refresh) would create another row after the fill-in and look like a
   * self-inflicted duplicate. The key is therefore a stable anchor:
   * checkout_token, and order_id only when it is missing.
   */
  {
    version: 2,
    run(d) {
      d.exec(`
        CREATE TABLE pixel_events_v2 (
          id             INTEGER PRIMARY KEY,
          shop_id        INTEGER NOT NULL REFERENCES shops(id),
          checkout_token TEXT,
          order_id       TEXT,
          event_type     TEXT NOT NULL,
          total          REAL,
          currency       TEXT,
          consent        TEXT,
          fired_at       TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO pixel_events_v2 (shop_id, order_id, event_type, fired_at)
          SELECT shop_id, order_id, event_type, fired_at FROM pixel_events;
        DROP TABLE pixel_events;
        ALTER TABLE pixel_events_v2 RENAME TO pixel_events;
        CREATE UNIQUE INDEX idx_pixel_unique ON pixel_events(
          shop_id, event_type, COALESCE(checkout_token, order_id, ''));
        CREATE INDEX idx_pixel_order ON pixel_events(shop_id, order_id);
        CREATE INDEX idx_pixel_token ON pixel_events(shop_id, checkout_token);
        CREATE INDEX idx_pixel_fired ON pixel_events(shop_id, fired_at);
      `);
    },
  },

  /**
   * v3 - history also stores the per-layer breakdown.
   *
   * Without it an e-mail alert could only say "18 % missing", but not WHAT the
   * merchant should fix, which is the whole reason we have our own pixel.
   * detectRegressions also needs the previous value to tell a NEW failure
   * from one that has lasted a week.
   */
  {
    version: 3,
    run(d) {
      d.exec(`
        ALTER TABLE check_history ADD COLUMN never_fired INTEGER;
        ALTER TABLE check_history ADD COLUMN delivery_broken INTEGER;
        ALTER TABLE check_history ADD COLUMN pixel_active INTEGER;
      `);
    },
  },

  /**
   * v4 - generic cache under its own key.
   *
   * check_cache has shop_id as PRIMARY KEY and a foreign key to shops(id), so
   * it holds exactly one record per store. The Ads report is a different query
   * with a different period; storing it there under a negative shop_id would
   * break the foreign key and collide with the check. A separate table is
   * cleaner and cheaper.
   */
  {
    version: 4,
    run(d) {
      d.exec(`
        CREATE TABLE kv_cache (
          cache_key  TEXT PRIMARY KEY,
          shop_id    INTEGER NOT NULL REFERENCES shops(id),
          payload    TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_kv_shop ON kv_cache(shop_id);
      `);
    },
  },

  /**
   * v5 - linking identity across a visit via the Shopify `clientId`.
   *
   * WHY: the pixel sends identity in two pieces that previously had no way
   * to meet:
   *   - `page_viewed`        has the `_ga` client_id but NO checkout token yet
   *   - `checkout_completed`  has the token but NO `_ga` cookie (checkout runs
   *                           on another domain where the cookie is not read)
   * Result: the order had a record without `ga_client_id` and the GA4
   * conversion backfill had nothing to rely on; the app claimed "nothing to
   * attribute" although the client_id had been seen minutes earlier.
   *
   * The Shopify `event.clientId` stays the same for the whole visit including
   * checkout, so it links the two records.
   */
  {
    version: 5,
    run(d) {
      d.exec(`
        ALTER TABLE identities ADD COLUMN shopify_client_id TEXT;
        CREATE INDEX idx_ident_sfcid ON identities(shop_id, shopify_client_id);
      `);
    },
  },

  /**
   * v6 - the app remembers that it LOST ACCESS.
   *
   * WHY: previously an authorization failure was not recorded anywhere. When a
   * store's Shopify token expired (Shopify only issues expiring tokens now) or
   * the merchant revoked Google access, `runCheck` threw, the scheduler logged
   * it and moved on. Outwardly NOTHING HAPPENED: no alert, and the dashboard
   * showed a stale cached result as if it were current.
   *
   * That is the worst possible failure for this product. The merchant bought
   * an app that is supposed to WATCH their tracking; when it goes blind it
   * MUST say so. Silence is indistinguishable from "all is well", and that is
   * exactly when tracking can break without anyone noticing.
   */
  {
    version: 6,
    run(d) {
      d.exec(`
        ALTER TABLE shops ADD COLUMN access_broken_kind   TEXT;
        ALTER TABLE shops ADD COLUMN access_broken_since  TEXT;
        ALTER TABLE shops ADD COLUMN access_broken_detail TEXT;
      `);
    },
  },
  /**
   * v7 - deliverability status of the alert address.
   *
   * WHY: `alert_email` by itself only says the merchant entered something.
   * The app knew nothing about whether mail CAN be delivered there, and
   * bounces come to US, not to the merchant (e.g. a nullMX domain). The app
   * could claim for months that alerts were set up while having no way to
   * notify anyone. The whole product depends on that single channel.
   */
  {
    version: 7,
    run(d) {
      d.exec(`
        ALTER TABLE shops ADD COLUMN alert_email_status TEXT;
        ALTER TABLE shops ADD COLUMN alert_email_error  TEXT;
      `);
      // Addresses entered before this migration were never verified; they
      // must not look confirmed just because they are older.
      d.exec(`UPDATE shops SET alert_email_status = 'unverified'
              WHERE alert_email IS NOT NULL`);
    },
  },

  /*
   * v8 - DISTINGUISHING "not set up yet" from "stopped working".
   *
   * Without this column both looked the same: a missing Google refresh token.
   * The app therefore told a freshly installed store that it "can no longer
   * see" Analytics and should "reconnect" an account that was never
   * connected, and recorded its own failure, which eventually turned into an
   * alarm e-mail about lost access that never existed.
   *
   * `ga4_connected_at` is the only reliable proof that the connection has
   * worked AT LEAST ONCE. Only then is its disappearance a failure.
   */
  {
    version: 8,
    run(d) {
      d.exec("ALTER TABLE shops ADD COLUMN ga4_connected_at TEXT");
      // Stores that already have a refresh token were clearly connected.
      // We do not know the time retroactively, so we store the migration time;
      // it is only used as an "it worked once" flag, not to measure duration.
      d.exec(`UPDATE shops SET ga4_connected_at = CURRENT_TIMESTAMP
              WHERE google_refresh_enc IS NOT NULL`);
      // A store that never connected Google must not stay flagged as failing;
      // otherwise this migration alone would trigger an alert for it.
      d.exec(`UPDATE shops SET access_broken_kind = NULL,
                               access_broken_since = NULL,
                               access_broken_detail = NULL
              WHERE access_broken_kind = 'google_auth'
                AND google_refresh_enc IS NULL`);
    },
  },

  /*
   * v9 - backfilling proof of connection for stores whose token has expired.
   *
   * v8 only flagged stores with an ACTIVE refresh token. But the stores whose
   * connection dropped no longer have one, and they are the worst off: after
   * v8 the app would treat them as "not set up yet" and show onboarding
   * instead of reporting lost access. A real failure would vanish from view.
   *
   * `ga4_property_id` is reliable proof: a property can only be picked from a
   * list the API returns to a connected account.
   */
  {
    version: 9,
    run(d) {
      d.exec(`UPDATE shops SET ga4_connected_at = CURRENT_TIMESTAMP
              WHERE ga4_connected_at IS NULL
                AND ga4_property_id IS NOT NULL`);
    },
  },

  /*
   * v10 - latest authenticated embedded-app session. Shopify can deliver an
   * uninstall after the merchant already reinstalled; this timestamp separates
   * the old installation generation without changing installed_at semantics.
   */
  {
    version: 10,
    run(d) {
      d.exec("ALTER TABLE shops ADD COLUMN session_seen_at TEXT");
    },
  },

  /*
   * v11 - Shopify billing state and per-charge terminal-event ledger.
   * Explicit column detection means only the known legacy shape is tolerated;
   * lock/I/O/corruption errors still abort startup instead of being swallowed.
   */
  {
    version: 11,
    run(d) {
      d.exec(`CREATE TABLE IF NOT EXISTS subscriptions (
        shop_id       INTEGER PRIMARY KEY REFERENCES shops(id),
        plan          TEXT NOT NULL DEFAULT 'free',
        charge_id     TEXT,
        status        TEXT,
        trial_ends_on TEXT,
        updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
        cycle         TEXT NOT NULL DEFAULT 'monthly',
        event_at      TEXT
      )`);
      const columns = new Set(
        d.prepare("PRAGMA table_info(subscriptions)").all().map((row) => row.name),
      );
      if (!columns.has("cycle")) {
        d.exec("ALTER TABLE subscriptions ADD COLUMN cycle TEXT NOT NULL DEFAULT 'monthly'");
      }
      if (!columns.has("event_at")) {
        d.exec("ALTER TABLE subscriptions ADD COLUMN event_at TEXT");
      }
      d.exec(`UPDATE subscriptions
              SET event_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)
              WHERE charge_id IS NOT NULL AND event_at IS NULL`);
      d.exec(`CREATE TABLE IF NOT EXISTS subscription_terminal_events (
        charge_id TEXT PRIMARY KEY,
        status    TEXT NOT NULL,
        event_at  TEXT NOT NULL
      )`);
    },
  },
];
for (const migration of migrations) {
  const done = db.prepare(
    "SELECT 1 FROM schema_migrations WHERE version=?",
  ).get(migration.version);
  if (done) continue;
  db.transaction(() => {
    migration.run(db);
    db.prepare("INSERT INTO schema_migrations(version) VALUES (?)")
      .run(migration.version);
  })();
}

/**
 * Saves the store together with its token.
 *
 * Shopify now issues ONLY expiring offline tokens, so besides the token
 * itself we keep the refresh_token and expiry time. Without them the app
 * would silently stop working after a few hours.
 */
export function upsertShop(domain, token, refreshToken = null, expiresIn = null,
                           installationSeen = false) {
  const expiresAt = expiresIn
    ? new Date(Date.now() + expiresIn * 1000).toISOString()
    : null;
  const seenAt = installationSeen ? new Date().toISOString() : null;
  db.prepare(`INSERT INTO shops
                (shop_domain, access_token_enc, refresh_token_enc, token_expires_at,
                 session_seen_at)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(shop_domain) DO UPDATE SET
                access_token_enc  = excluded.access_token_enc,
                refresh_token_enc = COALESCE(excluded.refresh_token_enc,
                                             shops.refresh_token_enc),
                token_expires_at  = excluded.token_expires_at,
                session_seen_at   = COALESCE(excluded.session_seen_at,
                                             shops.session_seen_at),
                uninstalled_at    = NULL,
                -- Reauthorization installs a new token: if we previously
                -- reported lost access, it no longer applies. Without this the
                -- "Checks are paused" banner would stay on after the fix until
                -- the next check, and the merchant would not know it worked.
                access_broken_kind   = NULL,
                access_broken_since  = NULL,
                access_broken_detail = NULL`)
    .run(domain, encrypt(token),
         refreshToken ? encrypt(refreshToken) : null,
         expiresAt, seenAt);
  return db.prepare("SELECT * FROM shops WHERE shop_domain = ?").get(domain);
}

/** Record the newest authenticated embedded-app session for generation checks. */
export function markShopSessionSeen(domain, seenAt = new Date().toISOString()) {
  const ms = Date.parse(seenAt);
  if (!Number.isFinite(ms)) return false;
  const normalized = new Date(ms).toISOString();
  const result = db.prepare(`UPDATE shops SET session_seen_at = ?
    WHERE shop_domain = ?
      AND (session_seen_at IS NULL OR session_seen_at < ?)`)
    .run(normalized, domain, normalized);
  return result.changes > 0;
}

/** True when an uninstall delivery belongs to an older installation generation. */
export function isStaleUninstall(domain, triggeredAt) {
  if (!triggeredAt) return false;
  const row = db.prepare(
    "SELECT installed_at, session_seen_at FROM shops WHERE shop_domain = ?",
  ).get(domain);
  if (!row) return false;
  const normalize = (value) => {
    if (!value) return NaN;
    return Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  };
  const barriers = [normalize(row.installed_at), normalize(row.session_seen_at)]
    .filter(Number.isFinite);
  const barrierMs = barriers.length ? Math.max(...barriers) : NaN;
  const triggeredMs = Date.parse(triggeredAt);
  return Number.isFinite(triggeredMs) && Number.isFinite(barrierMs)
    && triggeredMs < barrierMs;
}

export function shopToken(domain) {
  const r = db.prepare("SELECT access_token_enc FROM shops WHERE shop_domain = ?")
    .get(domain);
  return r?.access_token_enc ? decrypt(r.access_token_enc) : null;
}

/** Token plus whether it needs refreshing. */
export function shopTokenInfo(domain) {
  const r = db.prepare(
    `SELECT access_token_enc, refresh_token_enc, token_expires_at
     FROM shops WHERE shop_domain = ?`).get(domain);
  if (!r?.access_token_enc) return null;
  // refresh with a 5-minute margin, not only once the token has expired
  const expired = r.token_expires_at
    && new Date(r.token_expires_at).getTime() - Date.now() < 5 * 60_000;
  return {
    token: decrypt(r.access_token_enc),
    refresh: r.refresh_token_enc ? decrypt(r.refresh_token_enc) : null,
    expires_at: r.token_expires_at,
    needs_refresh: !!expired,
  };
}

/**
 * Records that the app LOST ACCESS to a data source.
 *
 * `since` is set only on the FIRST failure so we can say "we have not been
 * able to see your store for three days". Repeated failures do not move it;
 * otherwise the failure would always look fresh and never mature into an alert.
 */
export function markAccessBroken(shopId, kind, detail) {
  db.prepare(`UPDATE shops SET
                access_broken_kind   = ?,
                access_broken_detail = ?,
                access_broken_since  = COALESCE(
                  CASE WHEN access_broken_kind = ? THEN access_broken_since END,
                  datetime('now'))
              WHERE id = ?`)
    .run(kind, detail ? String(detail).slice(0, 300) : null, kind, shopId);
}

/** Access is fine again: drops the failure record. */
export function clearAccessBroken(shopId) {
  db.prepare(`UPDATE shops SET access_broken_kind = NULL,
                access_broken_since = NULL, access_broken_detail = NULL
              WHERE id = ? AND access_broken_kind IS NOT NULL`).run(shopId);
}
