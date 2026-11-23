/**
 * TrackGap — Shopify Billing.
 *
 * Shopify ZAKAZUJE vlastnu platobnu branu pre App Store appky — vsetko musi
 * ist cez ich Billing API. Preto tu nie je Stripe ani Paddle.
 *
 * Model: recurring subscription s trial. Ceny su nizsie nez Untracked
 * ($29/$79/$199) zamerne — vstupujeme neskor a potrebujeme prve recenzie.
 *
 * Limity su na POCET OBJEDNAVOK za mesiac, nie na trzby obchodu: objednavky
 * su aj nas skutocny naklad (Shopify API volania + GA4 kvota).
 *
 * Fakturacny cyklus: mesacny (EVERY_30_DAYS) alebo rocny (ANNUAL) s dvoma
 * mesiacmi zadarmo. Rocny plati merchant dopredu — kym appka nema recenzie,
 * je to jediny sposob, ako znizit churn v prvom roku.
 */
import crypto from "node:crypto";
import { db, encrypt, decrypt } from "./db.mjs";
import { gql, config } from "./shopify.mjs";

export const PLANS = {
  free: {
    id: "free", name: "Free", price: 0, orders: 300, trial: 0,
    features: ["Weekly check", "GA4 comparison", "Missing order list"],
  },
  starter: {
    id: "starter", name: "Starter", price: 19, orders: 2000, trial: 7,
    features: ["Daily checks", "Email alerts", "Conversion recovery"],
  },
  // Ziadne "coming soon" v platenych planoch — predavat funkciu, ktora
  // neexistuje, je dovod na zamietnutie pri App Store review (31.8.2026).
  growth: {
    id: "growth", name: "Growth", price: 49, orders: 10000, trial: 7,
    features: ["Everything in Starter", "Meta comparison",
               "90-day history", "Value gap analysis"],
  },
  pro: {
    id: "pro", name: "Pro", price: 99, orders: null, trial: 7,
    features: ["Everything in Growth", "Unlimited orders",
               "Multiple stores", "Priority support"],
  },
};

/**
 * Rocny cyklus: 10x mesacna cena, teda dva mesiace zadarmo. Shopify uctuje
 * celu sumu naraz pri potvrdeni.
 */
export const BILLING_CYCLES = {
  monthly: { id: "monthly", interval: "EVERY_30_DAYS", months: 1, label: "month" },
  annual:  { id: "annual",  interval: "ANNUAL",        months: 10, label: "year" },
};

/** Cena za dany plan a cyklus. Free zostava 0 v oboch. */
export function cyclePrice(planId, cycleId = "monthly") {
  const plan = PLANS[planId];
  const cycle = BILLING_CYCLES[cycleId];
  if (!plan) throw new Error(`unknown plan: ${planId}`);
  if (!cycle) throw new Error(`unknown billing cycle: ${cycleId}`);
  return plan.price * cycle.months;
}

/**
 * Nazov predplatneho u Shopify. Mesacny si drzi povodny tvar ("TrackGap
 * Starter"), aby sa uz beziacim merchantom plan po deployi nerozpadol na free.
 */
export function subscriptionName(planId, cycleId = "monthly") {
  const plan = PLANS[planId];
  if (!plan) throw new Error(`unknown plan: ${planId}`);
  return cycleId === "annual"
    ? `TrackGap ${plan.name} Annual`
    : `TrackGap ${plan.name}`;
}

/** Spatny rozklad nazvu z Shopify na { plan, cycle }. */
export function parseSubscriptionName(name) {
  for (const cycleId of ["annual", "monthly"]) {
    for (const planId of Object.keys(PLANS)) {
      if (name === subscriptionName(planId, cycleId)) return { plan: planId, cycle: cycleId };
    }
  }
  return { plan: "free", cycle: "monthly" };
}

const BILLING_STATE_TTL_MS = 15 * 60_000;

export function createBillingState(shop, plan, cycle, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({
    shop, plan, cycle, exp: now + BILLING_STATE_TTL_MS,
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", config.client_secret)
    .update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyBillingState(state, shop, plan, cycle, now = Date.now()) {
  if (typeof state !== "string") return false;
  const [payload, signature, extra] = state.split(".");
  if (!payload || !signature || extra) return false;
  const expected = crypto.createHmac("sha256", config.client_secret)
    .update(payload).digest();
  let given;
  try { given = Buffer.from(signature, "base64url"); } catch { return false; }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return false;
  let claims;
  try { claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); }
  catch { return false; }
  return claims.shop === shop
    && claims.plan === plan
    && claims.cycle === cycle
    && Number.isFinite(claims.exp)
    && claims.exp >= now
    && claims.exp <= now + BILLING_STATE_TTL_MS;
}

const CREATE_SUB = `
mutation Create($name: String!, $price: Decimal!, $trial: Int!,
                $interval: AppPricingInterval!, $return: URL!, $test: Boolean!) {
  appSubscriptionCreate(
    name: $name
    returnUrl: $return
    replacementBehavior: APPLY_IMMEDIATELY
    test: $test
    trialDays: $trial
    lineItems: [{
      plan: {
        appRecurringPricingDetails: {
          price: { amount: $price, currencyCode: USD }
          interval: $interval
        }
      }
    }]
  ) {
    userErrors { field message }
    confirmationUrl
    appSubscription { id status }
  }
}`;

const CANCEL_SUB = `
mutation Cancel($id: ID!) {
  appSubscriptionCancel(id: $id) {
    userErrors { field message }
    appSubscription { id status }
  }
}`;

/**
 * Zrusi aktivne predplatne u Shopify.
 *
 * Bez toho downgrade na free len prepisal plan v nasej DB a merchantovi sa
 * dalej strhavalo — appka ho povazovala za free, Shopify za platiaceho.
 * Audit 31.8.2026, bod 7.
 */
export async function cancelSubscription(shop, token) {
  const active = await verifySubscription(shop, token);
  if (!active.charge_id) return { cancelled: false, reason: "no active subscription" };
  const d = await gql(shop, token, CANCEL_SUB, { id: active.charge_id });
  const errs = d.appSubscriptionCancel?.userErrors || [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
  return {
    cancelled: true,
    id: active.charge_id,
    status: d.appSubscriptionCancel?.appSubscription?.status || null,
  };
}

/**
 * Vytvori predplatne. Vrati URL, kam treba merchanta presmerovat —
 * bez jeho potvrdenia v Shopify admine sa nic nestrhne.
 */
export async function createSubscription(shop, token, planId, isTest = false,
                                         cycleId = "monthly") {
  const plan = PLANS[planId];
  if (!plan) throw new Error(`unknown plan: ${planId}`);
  const cycle = BILLING_CYCLES[cycleId];
  if (!cycle) throw new Error(`unknown billing cycle: ${cycleId}`);

  if (plan.price === 0) {
    // downgrade na free MUSI zrusit platene predplatne u Shopify
    let cancelled = null;
    try {
      cancelled = await cancelSubscription(shop, token);
    } catch (e) {
      // radsej zlyhat nahlas, nez tvrdit merchantovi ze je na free
      // a nechat Shopify uctovat dalej
      throw new Error(`Could not cancel the paid subscription: ${e.message}`);
    }
    setPlan(shop, "free", null, "ACTIVE", "monthly");
    return { free: true, cancelled };
  }

  // Shopify keeps the current subscription active until the merchant approves
  // the replacement. Cancelling here would turn a declined plan change into an
  // unintended downgrade to Free. replacementBehavior handles the swap and
  // proration atomically after approval.
  const state = createBillingState(shop, planId, cycleId);
  const d = await gql(shop, token, CREATE_SUB, {
    // Nazov nesie aj cyklus — verifySubscription z neho spatne cita, co
    // merchant realne plati. Shopify nam interval v odpovedi nevracia.
    name: subscriptionName(planId, cycleId),
    price: String(cyclePrice(planId, cycleId)),
    trial: plan.trial,
    interval: cycle.interval,
    return: `${config.app_url}/billing/callback?shop=${encodeURIComponent(shop)}`
          + `&plan=${planId}&cycle=${cycleId}&state=${encodeURIComponent(state)}`,
    test: isTest,
  });

  const r = d.appSubscriptionCreate;
  if (r.userErrors?.length) {
    throw new Error(r.userErrors.map((e) => e.message).join("; "));
  }
  return {
    confirmationUrl: r.confirmationUrl,
    subscriptionId: r.appSubscription?.id,
    cycle: cycleId,
    price: cyclePrice(planId, cycleId),
  };
}

const ACTIVE_SUBS = `{
  currentAppInstallation {
    activeSubscriptions { id name status currentPeriodEnd trialDays }
  }
}`;

/** Overi u Shopify, co merchant naozaj plati — nie co je v nasej DB. */
export async function verifySubscription(shop, token) {
  const d = await gql(shop, token, ACTIVE_SUBS);
  const subs = d.currentAppInstallation?.activeSubscriptions || [];
  const active = subs.find((s) => s.status === "ACTIVE");
  if (!active) return { plan: "free", cycle: "monthly", status: "NONE" };

  const { plan: planId, cycle } = parseSubscriptionName(active.name);
  return {
    plan: planId,
    cycle,
    status: active.status,
    charge_id: active.id,
    period_end: active.currentPeriodEnd,
  };
}

export function subscriptionMatchesExpected(real, planId, cycleId) {
  return !!real
    && real.status === "ACTIVE"
    && real.plan === planId
    && real.cycle === cycleId;
}

export async function waitForExpectedSubscription(
  shop, token, planId, cycleId, deps = {},
) {
  const verify = deps.verify || verifySubscription;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const attempts = deps.attempts || 4;
  const delayMs = deps.delayMs ?? 250;
  let real = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    real = await verify(shop, token);
    if (subscriptionMatchesExpected(real, planId, cycleId)) return real;
    if (attempt + 1 < attempts) await sleep(delayMs);
  }
  return real;
}

/**
 * Apply app_subscriptions/update deterministically from the event itself.
 * Shopify sends CANCELLED for the old charge and ACTIVE for its replacement,
 * with no ordering guarantee. ACTIVE always installs its own id; a terminal
 * event can clear access only when it refers to the id currently stored.
 */
export async function reconcileSubscriptionUpdate(shop, _token, eventSub = {}, deps = {}) {
  const save = deps.save || setPlan;
  const read = deps.read || currentPlan;
  const terminalFor = deps.terminalFor || ((chargeId) => db.prepare(
    "SELECT status, event_at FROM subscription_terminal_events WHERE charge_id=?",
  ).get(chargeId));
  const recordTerminal = deps.recordTerminal || ((chargeId, status, eventAt) => {
    db.prepare(`INSERT INTO subscription_terminal_events (charge_id, status, event_at)
      VALUES (?,?,?)
      ON CONFLICT(charge_id) DO UPDATE SET
        status=excluded.status, event_at=excluded.event_at
      WHERE excluded.event_at > subscription_terminal_events.event_at`)
      .run(chargeId, status, eventAt);
  });
  const status = String(eventSub.status || "").toUpperCase();
  const eventId = eventSub.admin_graphql_api_id || eventSub.id || null;
  const eventMs = Date.parse(eventSub.triggered_at || eventSub.updated_at || "");
  const eventAt = Number.isFinite(eventMs) ? new Date(eventMs).toISOString() : null;
  const current = read(shop);
  const currentMs = Date.parse(current.event_at || "");

  if (status === "ACTIVE" && eventId) {
    const terminal = terminalFor(eventId);
    const terminalMs = Date.parse(terminal?.event_at || "");
    if (Number.isFinite(terminalMs)
        && (!Number.isFinite(eventMs) || eventMs <= terminalMs)) {
      return { ...current, ignored: true };
    }
    const staleCurrent = current.charge_id !== eventId
      && Number.isFinite(currentMs)
      && (!Number.isFinite(eventMs) || eventMs <= currentMs);
    if (staleCurrent) return { ...current, ignored: true };
    const parsed = parseSubscriptionName(eventSub.name || "");
    // Never turn an unknown active Shopify charge into local Free access.
    if (parsed.plan === "free") return { ...current, ignored: true };
    save(shop, parsed.plan, eventId, status, parsed.cycle, eventAt);
    return {
      ...PLANS[parsed.plan], cycle: parsed.cycle, status,
      charge_id: eventId, event_at: eventAt,
    };
  }

  if (status && status !== "ACTIVE" && eventId) {
    const terminalAt = eventAt || new Date().toISOString();
    recordTerminal(eventId, status, terminalAt);
    if (current.charge_id === eventId) {
      // Preserve the ACTIVE event watermark. The terminal timestamp is scoped
      // to this charge in the ledger and must not reject a replacement charge.
      save(shop, "free", null, status, "monthly", null);
      return {
        plan: "free", cycle: "monthly", status, charge_id: null,
        event_at: current.event_at || null,
      };
    }
  }
  return { ...current, ignored: true };
}

export function setPlan(shopDomain, planId, chargeId, status, cycle = "monthly",
                        eventAt = null) {
  const s = db.prepare("SELECT id FROM shops WHERE shop_domain=?").get(shopDomain);
  if (!s) return;
  db.transaction(() => {
    db.prepare(`INSERT INTO subscriptions
                  (shop_id, plan, charge_id, status, cycle, event_at, updated_at)
                VALUES (?,?,?,?,?,?,datetime('now'))
                ON CONFLICT(shop_id) DO UPDATE SET
                  plan = excluded.plan, charge_id = excluded.charge_id,
                  status = excluded.status, cycle = excluded.cycle,
                  event_at = COALESCE(excluded.event_at, subscriptions.event_at),
                  updated_at = datetime('now')`)
      .run(s.id, planId, chargeId, status, cycle, eventAt);
    db.prepare("UPDATE shops SET plan=? WHERE id=?").run(planId, s.id);
  })();
}

export function currentPlan(shopDomain) {
  const r = db.prepare(
    `SELECT sub.plan, sub.status, sub.charge_id, sub.cycle, sub.event_at
     FROM subscriptions sub
     JOIN shops s ON s.id = sub.shop_id WHERE s.shop_domain = ?`).get(shopDomain);
  const planId = r?.plan || "free";
  const cycle = r?.cycle || "monthly";
  return {
    ...PLANS[planId],
    cycle,
    billed: cyclePrice(planId, cycle),
    status: r?.status || "NONE",
    charge_id: r?.charge_id,
    event_at: r?.event_at || null,
  };
}

/**
 * Kontrola limitu. Nezablokuje merchanta uprostred mesiaca — len oznami,
 * ze prekrocil plan. Tvrde zablokovanie sluzby, za ktoru uz zaplatil,
 * by bolo dovodom na zlu recenziu.
 */
export function checkLimit(shopDomain) {
  const plan = currentPlan(shopDomain);
  if (plan.orders === null) return { ok: true, unlimited: true };

  const s = db.prepare("SELECT id FROM shops WHERE shop_domain=?").get(shopDomain);
  // Obchod este nemame v DB (prva poziadavka pred token exchange). Limit aj tak
  // vratime — inak UI ukaze "0 of undefined", co reviewer aj videl (10.9.2026).
  if (!s) {
    return { ok: true, used: 0, limit: plan.orders, plan: plan.id, pct: 0,
             message: null };
  }
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM orders
     WHERE shop_id = ? AND created_at >= date('now','start of month')`).get(s.id);

  const used = row?.n || 0;
  return {
    ok: used <= plan.orders,
    used,
    limit: plan.orders,
    plan: plan.id,
    pct: Math.round((used / plan.orders) * 100),
    message: used > plan.orders
      ? `You are over the ${plan.name} limit (${used} of ${plan.orders} orders `
        + "this month). Checks keep running — upgrade when convenient."
      : null,
  };
}
