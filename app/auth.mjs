/**
 * TrackGap — overenie session tokenu (Shopify App Bridge).
 *
 * PRECO: pred touto opravou kazdy endpoint veril holemu `?shop=` parametru.
 * Ktokolvek, kto poznal .myshopify.com domenu obchodu, si mohol cez
 * /backfill/setup prepisat Measurement ID a presmerovat cudzie konverzie do
 * vlastnej GA4 property. Overene 31.8.2026 jednym curl prikazom.
 *
 * Shopify embedded appky posielaju pri kazdom volani JWT (session token),
 * podpisany client secretom. Domenu obchodu berieme Z TOKENU, nikdy z URL.
 *
 * Je to zaroven tvrda poziadavka App Store review — testuju to.
 */
import crypto from "node:crypto";
import { config } from "./shopify.mjs";

const b64u = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/**
 * Overi JWT a vrati domenu obchodu, alebo null.
 * Kontroluje podpis, expiraciu, aud (nasa appka) aj dest (domena obchodu).
 */
export function verifySessionToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [head, payload, sig] = parts;

  // podpis — HS256 client secretom
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
  // 10 s tolerancia na rozdiel hodin medzi Shopify a nami
  if (typeof claims.exp !== "number" || claims.exp < now - 10) return null;
  if (typeof claims.nbf === "number" && claims.nbf > now + 10) return null;

  // token musi byt vystaveny PRE NASU appku
  if (claims.aud !== config.client_id) return null;

  // dest je domena obchodu: https://xyz.myshopify.com
  const dest = String(claims.dest || "");
  const m = dest.match(/^https:\/\/([a-z0-9][a-z0-9-]*\.myshopify\.com)$/i);
  if (!m) return null;

  return m[1].toLowerCase();
}

/**
 * Domena obchodu pre tuto poziadavku — JEDINY dovreryhodny zdroj.
 *
 * Poradie:
 *  1. Authorization: Bearer <session token>   (embedded UI)
 *  2. ?id_token=...                            (prvy load pred App Bridge)
 *
 * `?shop=` sa NEPOUZIVA na autorizaciu. Sluzi uz len na to, aby appka vedela,
 * ktoremu obchodu ponuknut instalaciu.
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
 * Rovnaka logika ako `authenticatedShop()`, ale vracia SAMOTNY overeny token,
 * nie domenu. Potrebuje ho token exchange, ktory ten JWT posiela Shopify ako
 * `subject_token`.
 *
 * Vraciame len token, ktory presiel `verifySessionToken()` — neoverene JWT sa
 * Shopify posielat nesmie.
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
 * Vyvojarska poistka: ak je TRACKGAP_DEV_SHOP nastavene, povolime volania bez
 * tokenu pre TENTO JEDEN obchod. Sluzi na lokalne testovanie cez curl.
 * V produkcii premenna nie je nastavena a nic sa neobchadza.
 */
export function devShopOverride(url) {
  // Tvrda poistka: v produkcii sa tato cesta NESMIE dat zapnut ani omylom
  // nastavenou premennou. Je to jediny sposob, ako obist session token,
  // takze nesmie zavisiet len na tom, ze premenna "nie je nastavena".
  if (process.env.NODE_ENV === "production") return null;
  const dev = process.env.TRACKGAP_DEV_SHOP;
  if (!dev) return null;
  const asked = url.searchParams.get("shop");
  return asked === dev ? dev : null;
}
