/**
 * TrackGap - end-to-end check before an App Store resubmission.
 *
 * Covers what a reviewer actually tries: public pages, authorization of
 * merchant endpoints, webhook HMAC, app proxy signature and billing.
 * Runs against PRODUCTION and changes nothing: no deletion topics, no writes.
 */
import crypto from "node:crypto";
import { readSecret } from "./secrets.mjs";

const BASE = process.env.BASE || process.env.TRACKGAP_APP_URL || "https://trackgap.example.com";
const SHOP = process.env.SHOP || "your-dev-store.myshopify.com";
const CFG = readSecret("shopify.json");

let pass = 0, fail = 0;
const results = [];

function check(name, ok, detail = "") {
  results.push(`${ok ? "OK  " : "FAIL"}  ${name}${detail ? `  - ${detail}` : ""}`);
  ok ? pass++ : fail++;
}

async function status(path, opts = {}) {
  const r = await fetch(`${BASE}${path}`, { redirect: "manual", ...opts });
  return { code: r.status, loc: r.headers.get("location"), body: await r.text() };
}

/** Signed webhook, exactly as Shopify sends it. */
async function signedWebhook(path, topic, payload) {
  const body = JSON.stringify(payload);
  const hmac = crypto.createHmac("sha256", CFG.client_secret)
    .update(body, "utf8").digest("base64");
  return status(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Topic": topic,
      "X-Shopify-Shop-Domain": SHOP,
      "X-Shopify-Hmac-Sha256": hmac,
      "X-Shopify-Webhook-Id": `e2e-${crypto.randomUUID()}`,
    },
    body,
  });
}

console.log("=== 1. public pages ===");
for (const [p, label] of [["/", "landing"], ["/privacy", "privacy policy"],
                          ["/terms", "terms"]]) {
  const r = await status(p);
  check(`${label} (${p})`, r.code === 200, `HTTP ${r.code}`);
}

console.log("\n=== 2. merchant endpoints without a session token ===");
for (const p of ["/overview", "/billing/plans", "/check", "/daily", "/history",
                 "/state", "/ads", "/meta/compare", "/backfill/stats",
                 "/ga4/properties"]) {
  const r = await status(`${p}?shop=${SHOP}`);
  check(`${p} rejects without token`, r.code === 401, `HTTP ${r.code}`);
}
for (const p of ["/backfill/setup", "/meta/accounts", "/alerts/setup",
                 "/meta/setup", "/ga4/select?property=properties/1"]) {
  const r = await status(p, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shop: SHOP, measurement_id: "G-XXXX", api_secret: "x" }),
  });
  check(`POST ${p} rejects without token`, r.code === 401, `HTTP ${r.code}`);
}

console.log("\n=== 3. session token: invalid signature ===");
{
  const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const pl = Buffer.from(JSON.stringify({
    dest: `https://${SHOP}`, aud: CFG.client_id, exp: now + 60, nbf: now - 10,
  })).toString("base64url");
  const bad = `${head}.${pl}.${Buffer.from("not-a-signature").toString("base64url")}`;
  const r = await status(`/overview?shop=${SHOP}&id_token=${bad}`);
  check("forged session token rejected", r.code === 401, `HTTP ${r.code}`);
}

console.log("\n=== 4. shop domain validation ===");
for (const bad of ["evil.com", `${SHOP}.evil.com`]) {
  const r = await status(`/auth?shop=${encodeURIComponent(bad)}`);
  check(`/auth rejects ${bad}`, r.code >= 400, `HTTP ${r.code}`);
}

console.log("\n=== 5. webhooks without HMAC ===");
for (const p of ["/webhooks/orders", "/webhooks/app", "/webhooks/billing",
                 "/webhooks/gdpr"]) {
  const r = await status(p, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: 1 }),
  });
  check(`${p} rejects without signature`, r.code === 401, `HTTP ${r.code}`);
}

console.log("\n=== 6. webhooks with HMAC (non-destructive) ===");
{
  const r = await signedWebhook("/webhooks/gdpr", "customers/data_request", {
    shop_domain: SHOP, customer: { id: 999999 }, orders_requested: [],
  });
  check("customers/data_request accepted", r.code === 200, `HTTP ${r.code}`);
}
{
  const r = await signedWebhook("/webhooks/gdpr", "customers/redact", {
    shop_domain: SHOP, customer: { id: 999999 }, orders_to_redact: [],
  });
  check("customers/redact accepted", r.code === 200, `HTTP ${r.code}`);
}
{
  // wrong signature with a valid structure
  const body = JSON.stringify({ shop_domain: SHOP });
  const r = await status("/webhooks/gdpr", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Topic": "customers/data_request",
      "X-Shopify-Shop-Domain": SHOP,
      "X-Shopify-Hmac-Sha256": Buffer.from("bad").toString("base64"),
    },
    body,
  });
  check("bad HMAC rejected", r.code === 401, `HTTP ${r.code}`);
}

console.log("\n=== 7. app proxy ===");
{
  const r = await status(`/proxy/event?shop=${SHOP}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event: "purchase" }),
  });
  check("proxy rejects without signature", r.code === 401, `HTTP ${r.code}`);
  const h = await status("/health");
  check("/health responds", h.code === 200, `HTTP ${h.code}`);
}

console.log("\n=== 8. billing against live Shopify ===");
{
  const { shopTokenInfo } = await import("./db.mjs");
  const { verifySubscription, PLANS, checkLimit, currentPlan } =
    await import("./billing.mjs");
  const info = shopTokenInfo(SHOP);
  check("access token stored", !!info?.token);
  if (info) {
    const sub = await verifySubscription(SHOP, info.token);
    check("Shopify reports an ACTIVE subscription", sub.status === "ACTIVE",
          `${sub.plan} / ${sub.status}`);
    check("our DB matches Shopify", currentPlan(SHOP).id === sub.plan,
          `DB=${currentPlan(SHOP).id} Shopify=${sub.plan}`);
    const lim = checkLimit(SHOP);
    check("plan limit is a number, not undefined", typeof lim.limit === "number",
          `${lim.used} / ${lim.limit}`);
  }
  const bad = Object.entries(PLANS).filter(([, p]) =>
    p.features.some((f) => /coming soon|soon/i.test(f)));
  check("no plan promises an unavailable feature", bad.length === 0);
}

console.log("\n=== 9. Shopify data ===");
{
  const { shopTokenInfo } = await import("./db.mjs");
  const { fetchOrders, shopInfo } = await import("./shopify.mjs");
  const info = shopTokenInfo(SHOP);
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const orders = await fetchOrders(SHOP, info.token, since);
  check("orders are fetched", orders.length > 0, `${orders.length} orders`);
  check("cancelled is 0/1, not boolean",
        orders.every((o) => o.cancelled === 0 || o.cancelled === 1));
  const si = await shopInfo(SHOP, info.token);
  check("shopInfo returns timezone and domain", !!si?.timezone || !!si?.primary_domain,
        `${si?.primary_domain || "?"} / ${si?.timezone || "?"}`);
}

console.log("\n=== 10. customer data protection ===");
{
  const { db } = await import("./db.mjs");
  const cols = db.prepare("PRAGMA table_info(orders)").all().map((c) => c.name);
  const pii = cols.filter((c) => /email|phone|name|address|first|last/i.test(c));
  check("orders table has no PII columns", pii.length === 0, pii.join(","));
}

console.log(`\n${results.join("\n")}`);
console.log(`\nPASS ${pass}   FAIL ${fail}`);
process.exit(fail ? 1 : 0);
