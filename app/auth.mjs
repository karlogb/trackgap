/**
 * TrackGap - session token verification (Shopify App Bridge).
 *
 * WHY: before this, every endpoint trusted a bare `?shop=` parameter. Anyone
 * who knew a store's .myshopify.com domain could use /backfill/setup to
 * overwrite the Measurement ID and redirect that store's conversions into
 * their own GA4 property.
 *
 * Shopify embedded apps send a JWT (session token) with every call, signed
 * with the client secret. The store domain is taken FROM THE TOKEN, never
 * from the URL.
 *
 * This is also a hard App Store review requirement.
 */
import crypto from "node:crypto";
import { config } from "./shopify.mjs";

const b64u = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/**
 * Verifies the JWT and returns the store domain, or null.
 * Checks the signature, expiry, aud (our app) and dest (store domain).
 */
export function verifySessionToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [head, payload, sig] = parts;

  // signature: HS256 with the client secret
  const expected = crypto
    .createHmac("sha256", config.client_secret)
    .update(`${head}.${payload}`)
    .digest();
  let given;
  try {
    given = b64u(sig);
  } catch {
    return null;
  }
  if (given.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(given, expected)) return null;

  let claims;
  try {
    claims = JSON.parse(b64u(payload).toString("utf8"));
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  // 10 s tolerance for clock skew between Shopify and us
  if (typeof claims.exp !== "number" || claims.exp < now - 10) return null;
  if (typeof claims.nbf === "number" && claims.nbf > now + 10) return null;

  // the token must be issued FOR OUR app
  if (claims.aud !== config.client_id) return null;

  // dest is the store domain: https://xyz.myshopify.com
  const dest = String(claims.dest || "");
  const m = dest.match(/^https:\/\/([a-z0-9][a-z0-9-]*\.myshopify\.com)$/i);
  if (!m) return null;

  return m[1].toLowerCase();
}

/**
 * Store domain for this request: the ONLY trusted source.
 *
 * Order:
 *  1. Authorization: Bearer <session token>   (embedded UI)
 *  2. ?id_token=...                            (first load before App Bridge)
 *
 * `?shop=` is NOT used for authorization. It only tells the app which store
 * to offer installation to.
 */
export function authenticatedShop(req, url) {
  const hdr = req.headers.authorization || "";
  if (hdr.startsWith("Bearer ")) {
    const shop = verifySessionToken(hdr.slice(7).trim());
    if (shop) return shop;
  }
  const idToken = url.searchParams.get("id_token");
  if (idToken) {
    const shop = verifySessionToken(idToken);
    if (shop) return shop;
  }
  return null;
}

/**
 * Same logic as `authenticatedShop()`, but returns the verified token itself,
 * not the domain. Token exchange needs it, since it sends that JWT to Shopify
 * as `subject_token`.
 *
 * Only tokens that passed `verifySessionToken()` are returned; an unverified
 * JWT must never be sent to Shopify.
 */
export function sessionTokenFrom(req, url) {
  const hdr = req.headers.authorization || "";
  if (hdr.startsWith("Bearer ")) {
    const t = hdr.slice(7).trim();
    if (verifySessionToken(t)) return t;
  }
  const idToken = url.searchParams.get("id_token");
  if (idToken && verifySessionToken(idToken)) return idToken;
  return null;
}

/**
 * Developer escape hatch: if TRACKGAP_DEV_SHOP is set, calls without a token
 * are allowed for THIS ONE store. Used for local testing with curl.
 * In production the variable is not set and nothing is bypassed.
 */
export function devShopOverride(url) {
  // Hard guard: in production this path must NOT be enabled, not even by an
  // accidentally set variable. It is the only way to bypass the session
  // token, so it must not rely solely on the variable "not being set".
  if (process.env.NODE_ENV === "production") return null;
  const dev = process.env.TRACKGAP_DEV_SHOP;
  if (!dev) return null;
  const asked = url.searchParams.get("shop");
  return asked === dev ? dev : null;
}
