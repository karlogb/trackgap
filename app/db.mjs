/**
 * TrackGap — databaza.
 *
 * SQLite lokalne na VPS. Disk NIE JE sifrovany (overene 30.8.2026: ext4, ziadny
 * LUKS), a Shopify pri protected customer data vyzaduje sifrovanie at rest.
 * Riesenie: citlive polia (access/refresh tokeny) sa sifruju v aplikacii cez
 * AES-256-GCM pred zapisom. Objednavky obsahuju LEN ID, sumu, cas a UTM —
 * ziadne meno, e-mail, adresu ani telefon (PCD Level 1, datova minimalizacia).
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

// `TRACKGAP_DB` umoznuje testom bezat nad vlastnym suborom. Bez toho by sa
// testy pisali do produkcnej DB — a keby ju niekto omylom spustil na serveri,
// zamiesal by merchantovi realne data.
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

-- PCD Level 1: ziadne osobne udaje
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

-- dedup prichadzajucich webhookov (X-Shopify-Webhook-Id)
CREATE TABLE IF NOT EXISTS webhook_log (
  webhook_id TEXT PRIMARY KEY,
  topic      TEXT,
  seen_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_webhook_seen ON webhook_log(seen_at);

-- identita z web pixelu: GA4 client_id + reklamne click ID
-- POZOR: definovane LEN tu. backfill.mjs a monitor.mjs uz vlastne CREATE TABLE
-- nemaju — dve definicie tej istej tabulky znamenali, ze schema zavisela od
-- poradia importov (audit 31.8.2026, bod 3).
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

-- Rezervacia objednavky pred odoslanim konverzie.
-- orders/create a orders/updated chodia sucasne; bez tohto zamku obidva presli
-- kontrolou a konverzia odisla dvakrat (overene naostro 31.8.2026).
CREATE TABLE IF NOT EXISTS backfill_locks (
  shop_id    INTEGER NOT NULL,
  order_id   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (shop_id, order_id)
);

-- pokusy o doplnenie konverzie (GA4 MP / Meta CAPI)
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

-- historia kontrol a cache vysledkov
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


-- co realne odislo z prehliadaca (nas web pixel)
CREATE TABLE IF NOT EXISTS pixel_events (
  shop_id    INTEGER NOT NULL REFERENCES shops(id),
  order_id   TEXT NOT NULL,
  event_type TEXT NOT NULL,
  fired_at   TEXT NOT NULL,
  PRIMARY KEY (shop_id, order_id, event_type)
);

-- co dorazilo do GA4 (tahane cez merchantov OAuth)
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
   * v2 — pixel_events ako plnohodnotna TRETIA VRSTVA merania.
   *
   * Povodna tabulka mala PK (shop_id, order_id, event_type) a NIKDY sa do nej
   * nezapisovalo — server ukladal `checkout_completed` len ako "identitu".
   * Tym padom sa nedalo odlisit "GA4 to nedostalo" od "nikdy to neodislo",
   * co je jediny dovod, preco vlastny pixel vobec mame.
   *
   * Problem povodneho PK: v okamihu `checkout_completed` casto NEPOZNAME
   * order_id (Shopify ho v evente nemusi vyplnit) — kotvou je vtedy
   * checkout_token a order_id sa doplni az z webhooku orders/create.
   *
   * Preto jedinecnost NESMIE stat na order_id: to sa casom meni z NULL na
   * hodnotu a kazdy opakovany event (keepalive retry, refresh dakovnej
   * stranky) by po doplneni vytvoril dalsi riadok a tvaril sa ako duplicita,
   * ktoru sme si sposobili sami. Kluc je preto stabilna kotva:
   * checkout_token, a az ked chyba, order_id.
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
   * v3 — historia si pamata aj rozpad podla vrstiev.
   *
   * Bez toho by e-mailovy alert vedel povedat len "chyba 18 %", ale nie
   * CO ma merchant opravit — a prave to je jediny dovod, preco vlastny pixel
   * mame. detectRegressions navyse potrebuje predoslu hodnotu, aby vedel
   * rozoznat NOVU poruchu od tej, ktora trva uz tyzden.
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
   * v4 — vseobecna cache pod vlastnym klucom.
   *
   * check_cache ma shop_id ako PRIMARY KEY a cudzi kluc na shops(id), takze
   * pojme presne jeden zaznam na obchod. Ads report je iny dotaz s inym
   * obdobim; napchat ho tam pod zapornym shop_id by znamenalo rozbity cudzi
   * kluc a kolize s kontrolou. Vlastna tabulka je cistejsia aj lacnejsia.
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
   * v5 — spojenie identity naprieč navstevou cez Shopify `clientId`.
   *
   * PRECO: pixel posiela identitu v dvoch kusoch, ktore sa doteraz nemali ako
   * stretnut (overene na zivom obchode 1.9.2026):
   *   - `page_viewed`        ma `_ga` client_id, ale este NEMA checkout token
   *   - `checkout_completed`  ma token, ale uz NEMA `_ga` cookie (checkout bezi
   *                           na inej domene, cookie sa tam necita)
   * Vysledok: objednavka mala zaznam bez `ga_client_id` a doplnenie konverzie
   * do GA4 sa nemalo o co oprieť — appka tvrdila "nie je co priradit", hoci
   * client_id sme videli o par minut skor.
   *
   * `event.clientId` zo Shopify je ten isty po celu navstevu vratane checkoutu,
   * takze sluzi ako spojka medzi tymi dvoma zaznamami.
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
   * v6 — appka si pamata, ze STRATILA PRISTUP.
   *
   * PRECO: doteraz sa zlyhanie autorizacie nikam nezapisalo. Ked obchodu
   * dobehol Shopify token (Shopify uz vydava len expirujuce) alebo merchant
   * odobral Google pristup, `runCheck` hodilo vynimku, scheduler ju zalogoval
   * a slo sa dalej. Navonok sa NESTALO NIC: ziadny alert, dashboard ukazoval
   * stary vysledok z cache ako keby bol aktualny.
   *
   * To je najhorsia mozna porucha prave pre tento produkt. Merchant si kupil
   * appku, ktora ma STRAZIT meranie; ked oslepne, MUSI to povedat nahlas.
   * Ticho sa na nerozoznanie podoba na "vsetko je v poriadku" — a presne
   * v tom case mu moze vypadnut tracking a nedozvie sa o tom.
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
   * v7 — stav dorucitelnosti adresy pre alerty.
   *
   * PRECO: `alert_email` sama o sebe hovori len to, ze merchant nieco zadal.
   * O tom, ci sa na tu adresu DA dorucit, appka nevedela nic — a bounce
   * chodi NAM, nie jemu (1.9.2026: `app-review@example.com`, nullMX).
   * Appka tak mohla mesiace tvrdit, ze alerty su nastavene, a pritom nemat
   * ako dat vediet o comkolvek. Cely produkt stoji na tom jedinom kanali.
   */
  {
    version: 7,
    run(d) {
      d.exec(`
        ALTER TABLE shops ADD COLUMN alert_email_status TEXT;
        ALTER TABLE shops ADD COLUMN alert_email_error  TEXT;
      `);
      // Adresy zadane pred touto migraciou nikto neoveril — nesmu vyzerat
      // ako potvrdene len preto, ze su starsie.
      d.exec(`UPDATE shops SET alert_email_status = 'unverified'
              WHERE alert_email IS NOT NULL`);
    },
  },

  /*
   * v8 — ROZLISENIE "este nenastavene" od "prestalo fungovat".
   *
   * Bez tohto stlpca sa oboje javilo rovnako: chybajuci Google refresh token.
   * Appka preto cerstvo nainstalovanemu obchodu tvrdila, ze "uz nevidi" do
   * Analytics a "ma znovu pripojit" ucet, ktory nikdy pripojeny nebol —
   * a zapisala si vlastnu poruchu, z ktorej po case dozrel poplasny e-mail
   * o strate pristupu, ktory nikdy neexistoval.
   *
   * `ga4_connected_at` je jediny spolahlivy dokaz, ze spojenie UZ RAZ islo.
   * Az potom je jeho zmiznutie porucha.
   */
  {
    version: 8,
    run(d) {
      d.exec("ALTER TABLE shops ADD COLUMN ga4_connected_at TEXT");
      // Obchody, ktore uz teraz maju refresh token, boli zjavne pripojene.
      // Cas nepozname spatne, takze zapiseme cas migracie — pouziva sa len
      // ako priznak "uz raz to islo", nie na meranie trvania.
      d.exec(`UPDATE shops SET ga4_connected_at = CURRENT_TIMESTAMP
              WHERE google_refresh_enc IS NOT NULL`);
      // Obchod, ktory Google nikdy nepripojil, nesmie zostat oznaceny za
      // poruchu — inak by mu z tejto migracie rovno vypadol alert.
      d.exec(`UPDATE shops SET access_broken_kind = NULL,
                               access_broken_since = NULL,
                               access_broken_detail = NULL
              WHERE access_broken_kind = 'google_auth'
                AND google_refresh_enc IS NULL`);
    },
  },

  /*
   * v9 — doplnenie dokazu o pripojeni pre obchody, ktorym token uz vyprsal.
   *
   * v8 oznacila len obchody s AKTIVNYM refresh tokenom. Lenze prave tie,
   * ktorym spojenie vypadlo, ho uz nemaju — a tie su na tom najhorsie:
   * appka by ich po v8 povazovala za "este nenastavene" a namiesto hlasenia
   * o strate pristupu by im ukazovala onboarding. Skutocna porucha by tak
   * zmizla z radaru.
   *
   * `ga4_property_id` je spolahlivy dokaz: vybrat property sa da az zo
   * zoznamu, ktory API vrati len pripojenemu uctu.
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
   * v10 — latest authenticated embedded-app session. Shopify can deliver an
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
   * v11 — Shopify billing state and per-charge terminal-event ledger.
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
 * Ulozi obchod aj s tokenom.
 *
 * Shopify uz vydava LEN expirujuce offline tokeny, takze si okrem samotneho
 * tokenu drzime aj refresh_token a cas expiracie. Bez toho by appka po
 * niekolkych hodinach ticho prestala fungovat (31.8.2026).
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
                -- Reautorizacia je nova instalacia tokenu: ak sme predtym
                -- hlasili stratu pristupu, uz neplati. Bez tohto by banner
                -- "Checks are paused" svietil aj po naprave az do dalsej
                -- kontroly — a merchant by nevedel, ci sa jeho klik chytil.
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

/** Token aj s informaciou, ci mu netreba obnovu. */
export function shopTokenInfo(domain) {
  const r = db.prepare(
    `SELECT access_token_enc, refresh_token_enc, token_expires_at
     FROM shops WHERE shop_domain = ?`).get(domain);
  if (!r?.access_token_enc) return null;
  // obnovujeme s rezervou 5 minut, nie az ked token dobehne
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
 * Zaznamena, ze appka STRATILA PRISTUP k zdroju dat.
 *
 * `since` sa nastavi len pri PRVOM zlyhani — aby sa dalo povedat "uz tri dni
 * nevidime do tvojho obchodu". Opakovane zlyhanie cas nepresuva, inak by
 * porucha vyzerala vzdy ako cerstva a nikdy by nedozrela na alert.
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

/** Pristup je opat v poriadku — zahodi zaznam o poruche. */
export function clearAccessBroken(shopId) {
  db.prepare(`UPDATE shops SET access_broken_kind = NULL,
                access_broken_since = NULL, access_broken_detail = NULL
              WHERE id = ? AND access_broken_kind IS NOT NULL`).run(shopId);
}
