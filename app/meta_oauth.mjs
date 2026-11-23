/**
 * TrackGap — Meta OAuth (Facebook Login for Business).
 *
 * Doplnok k token-based pripojeniu v meta.mjs. Merchant klikne "Connect",
 * prihlasi sa a odsuhlasi pristup — ziadne kopirovanie tokenov.
 *
 * STAV (31.8.2026): v Development mode funguje na uctoch, kde ma pouzivatel
 * rolu na nasej Meta appke (Admin/Developer/Tester). Pre cudzich merchantov
 * treba Advanced Access -> Business Verification + App Review so screencastom.
 * Preto v UI ponukame OBE cesty a token ostava plne funkcny fallback.
 */
import crypto from "node:crypto";
import { db, encrypt, decrypt } from "./db.mjs";
import { readSecret } from "./secrets.mjs";

const GRAPH = "https://graph.facebook.com/v21.0";
const DIALOG = "https://www.facebook.com/v21.0/dialog/oauth";

/** ads_read staci na citanie Insights. Nic viac nepytame — zbytocne
 *  permissions su dokumentovany dovod zamietnutia App Review. */
const SCOPES = ["ads_read", "business_management"];

export function metaAppConfig() {
  return readSecret("meta.json");
}

export function isOAuthConfigured() {
  const c = metaAppConfig();
  return !!(c && c.app_id && c.app_secret);
}

export function metaAuthUrl(state, redirectUri) {
  const c = metaAppConfig();
  if (!c) throw new Error("Meta app not configured");
  const p = new URLSearchParams({
    client_id: c.app_id,
    redirect_uri: redirectUri,
    state,
    scope: SCOPES.join(","),
    response_type: "code",
  });
  return `${DIALOG}?${p}`;
}

export async function metaExchange(code, redirectUri) {
  const c = metaAppConfig();
  const p = new URLSearchParams({
    client_id: c.app_id,
    client_secret: c.app_secret,
    redirect_uri: redirectUri,
    code,
  });
  const r = await fetch(`${GRAPH}/oauth/access_token?${p}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j;                       // { access_token, expires_in }
}

/**
 * Kratkodoby token (~1-2 h) vymeni za dlhodoby (~60 dni).
 * Bez toho by merchantovi pripojenie prestalo fungovat po hodine.
 */
export async function longLivedToken(shortToken) {
  const c = metaAppConfig();
  const p = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: c.app_id,
    client_secret: c.app_secret,
    fb_exchange_token: shortToken,
  });
  const r = await fetch(`${GRAPH}/oauth/access_token?${p}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j;
}

/** Co token realne umoznuje — aby UI nehadalo. */
export async function inspectToken(token) {
  const c = metaAppConfig();
  const appToken = c ? `${c.app_id}|${c.app_secret}` : token;
  const r = await fetch(
    `${GRAPH}/debug_token?input_token=${encodeURIComponent(token)}`
    + `&access_token=${encodeURIComponent(appToken)}`);
  const j = await r.json();
  const d = j.data || {};
  return {
    valid: !!d.is_valid,
    type: d.type || null,
    scopes: d.scopes || [],
    expires_at: d.expires_at ? new Date(d.expires_at * 1000).toISOString() : null,
    can_read_ads: (d.scopes || []).includes("ads_read"),
  };
}

db.exec(`
CREATE TABLE IF NOT EXISTS meta_oauth (
  shop_id     INTEGER PRIMARY KEY REFERENCES shops(id),
  token_enc   TEXT NOT NULL,
  expires_at  TEXT,
  scopes      TEXT,
  fb_user_id  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Starsie DB tento stlpec nemaju. MUSI sa doplnit PRED vytvorenim indexu —
// inak `CREATE INDEX` na existujucej tabulke padne na "no such column".
try { db.exec("ALTER TABLE meta_oauth ADD COLUMN fb_user_id TEXT"); } catch { /* uz je */ }
db.exec("CREATE INDEX IF NOT EXISTS idx_meta_oauth_user ON meta_oauth(fb_user_id)");

export function saveOAuthToken(shopId, token, expiresIn, scopes, fbUserId = null) {
  const exp = expiresIn
    ? new Date(Date.now() + expiresIn * 1000).toISOString()
    : null;
  db.prepare(`INSERT INTO meta_oauth (shop_id, token_enc, expires_at, scopes, fb_user_id)
              VALUES (?,?,?,?,?)
              ON CONFLICT(shop_id) DO UPDATE SET
                token_enc = excluded.token_enc,
                expires_at = excluded.expires_at,
                scopes = excluded.scopes,
                fb_user_id = excluded.fb_user_id,
                created_at = datetime('now')`)
    .run(shopId, encrypt(token), exp, JSON.stringify(scopes || []), fbUserId);
}

/**
 * Odpoji LEN obchody, ktore pripojil dany Facebook pouzivatel.
 *
 * Predtym sa mazalo `SELECT shop_id FROM meta_oauth` bez podmienky — jeden
 * clovek, ktory odobral appke pristup na Facebooku, odpojil Metu VSETKYM
 * merchantom. Audit 31.8.2026, bod 2.
 */
export function disconnectByFbUser(fbUserId) {
  if (!fbUserId) return { disconnected: 0 };
  const rows = db.prepare(
    "SELECT shop_id FROM meta_oauth WHERE fb_user_id = ?").all(String(fbUserId));
  for (const r of rows) {
    db.prepare("DELETE FROM meta_oauth WHERE shop_id = ?").run(r.shop_id);
    try {
      db.prepare("UPDATE meta_config SET token_enc = NULL WHERE shop_id = ?")
        .run(r.shop_id);
    } catch { /* meta_config nemusi existovat */ }
  }
  return { disconnected: rows.length, shop_ids: rows.map((r) => r.shop_id) };
}

/** Kto (aky FB pouzivatel) pripojil tento obchod. */
export function fbUserForShop(shopId) {
  const r = db.prepare("SELECT fb_user_id FROM meta_oauth WHERE shop_id = ?")
    .get(shopId);
  return r?.fb_user_id || null;
}

export function oauthToken(shopId) {
  const r = db.prepare("SELECT * FROM meta_oauth WHERE shop_id = ?").get(shopId);
  if (!r) return null;
  // 7 dni pred expiraciou uz varujeme — merchant sa ma stihnut prepojit znova
  const expiring = r.expires_at
    && new Date(r.expires_at).getTime() - Date.now() < 7 * 86400_000;
  return {
    token: decrypt(r.token_enc),
    expires_at: r.expires_at,
    expiring_soon: !!expiring,
    scopes: JSON.parse(r.scopes || "[]"),
  };
}
