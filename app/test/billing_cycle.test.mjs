/**
 * Rocny fakturacny cyklus.
 *
 * Kriticke je spatne citanie nazvu predplatneho: Shopify nam v
 * activeSubscriptions nevracia interval, takze cyklus poznat len z nazvu.
 * Ak sa rozbije parsovanie, merchantovi spadne plan na free hoci plati.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  PLANS, BILLING_CYCLES, cyclePrice, subscriptionName, parseSubscriptionName,
  createSubscription,
} from "../billing.mjs";

test("rocna cena je 10x mesacna, teda dva mesiace zadarmo", () => {
  assert.equal(cyclePrice("starter", "annual"), 190);
  assert.equal(cyclePrice("growth", "annual"), 490);
  assert.equal(cyclePrice("pro", "annual"), 990);
});

test("mesacny cyklus nemeni cenu ani nazov", () => {
  for (const id of Object.keys(PLANS)) {
    assert.equal(cyclePrice(id, "monthly"), PLANS[id].price);
    assert.equal(subscriptionName(id, "monthly"), `TrackGap ${PLANS[id].name}`);
  }
});

test("free je zadarmo v oboch cykloch", () => {
  assert.equal(cyclePrice("free", "monthly"), 0);
  assert.equal(cyclePrice("free", "annual"), 0);
});

test("nazov predplatneho sa da spatne rozlozit na plan a cyklus", () => {
  for (const planId of Object.keys(PLANS)) {
    for (const cycleId of Object.keys(BILLING_CYCLES)) {
      const name = subscriptionName(planId, cycleId);
      assert.deepEqual(parseSubscriptionName(name), { plan: planId, cycle: cycleId });
    }
  }
});

test("uz beziace mesacne predplatne sa po deployi neprepadne na free", () => {
  // presne retazce, ktore su dnes ulozene u Shopify
  assert.deepEqual(parseSubscriptionName("TrackGap Starter"),
                   { plan: "starter", cycle: "monthly" });
  assert.deepEqual(parseSubscriptionName("TrackGap Pro"),
                   { plan: "pro", cycle: "monthly" });
});

test("neznamy nazov skonci na free, nie na vynimke", () => {
  assert.deepEqual(parseSubscriptionName("Some Other App Plan"),
                   { plan: "free", cycle: "monthly" });
});

test("neznamy cyklus je chyba, nie ticho mesacny", () => {
  assert.throws(() => cyclePrice("starter", "weekly"), /unknown billing cycle/);
});

test("zmena plateneho planu nerusi povodny plan pred schvalenim", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    return {
      async json() {
        return {
          data: {
            currentAppInstallation: { activeSubscriptions: [] },
            appSubscriptionCreate: {
              userErrors: [],
              confirmationUrl: "https://admin.shopify.com/approve/test",
              appSubscription: { id: "gid://shopify/AppSubscription/new", status: "PENDING" },
            },
          },
        };
      },
    };
  };

  try {
    const result = await createSubscription(
      "billing-test.myshopify.com", "test-token", "growth", true, "monthly",
    );
    assert.equal(result.confirmationUrl, "https://admin.shopify.com/approve/test");
    assert.equal(calls.length, 1, "Shopify replacement must be one create mutation");
    assert.match(calls[0].query, /replacementBehavior:\s*APPLY_IMMEDIATELY/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("subscription webhook order cannot overwrite an approved replacement", async () => {
  const { reconcileSubscriptionUpdate } = await import("../billing.mjs");
  let current = {
    id: "starter", cycle: "monthly", status: "ACTIVE",
    charge_id: "gid://shopify/AppSubscription/old",
    event_at: "2026-09-22T10:00:00.000Z",
  };
  const terminal = new Map();
  const deps = {
    read: () => current,
    save: (_shop, plan, chargeId, status, cycle, eventAt) => {
      current = {
        id: plan, cycle, status, charge_id: chargeId,
        event_at: eventAt ?? current.event_at,
      };
    },
    terminalFor: (chargeId) => terminal.get(chargeId) || null,
    recordTerminal: (chargeId, status, eventAt) => {
      const previous = terminal.get(chargeId);
      if (!previous || eventAt > previous.event_at) {
        terminal.set(chargeId, { status, event_at: eventAt });
      }
    },
  };

  // Declining a pending replacement must leave the old paid plan untouched.
  await reconcileSubscriptionUpdate(
    "billing-test.myshopify.com", null,
    {
      admin_graphql_api_id: "gid://shopify/AppSubscription/declined",
      name: "TrackGap Growth",
      status: "DECLINED",
    },
    deps,
  );
  assert.equal(current.id, "starter");
  assert.equal(current.charge_id, "gid://shopify/AppSubscription/old");

  await reconcileSubscriptionUpdate(
    "billing-test.myshopify.com", null,
    {
      admin_graphql_api_id: "gid://shopify/AppSubscription/new",
      name: "TrackGap Growth",
      status: "ACTIVE",
      triggered_at: "2026-09-22T12:00:00.000Z",
    },
    deps,
  );
  await reconcileSubscriptionUpdate(
    "billing-test.myshopify.com", null,
    {
      admin_graphql_api_id: "gid://shopify/AppSubscription/old",
      name: "TrackGap Starter",
      status: "CANCELLED",
      triggered_at: "2026-09-22T12:00:01.000Z",
    },
    deps,
  );
  // A retried ACTIVE delivery for the old charge must not restore it.
  await reconcileSubscriptionUpdate(
    "billing-test.myshopify.com", null,
    {
      admin_graphql_api_id: "gid://shopify/AppSubscription/old",
      name: "TrackGap Starter",
      status: "ACTIVE",
      triggered_at: "2026-09-22T11:00:00.000Z",
    },
    deps,
  );

  assert.deepEqual(current, {
    id: "growth", cycle: "monthly", status: "ACTIVE",
    charge_id: "gid://shopify/AppSubscription/new",
    event_at: "2026-09-22T12:00:00.000Z",
  });

  // Shopify can deliver CANCELLED-old first even when its trigger timestamp is
  // later than ACTIVE-new. The terminal watermark is per charge, not shop-wide.
  current = {
    id: "starter", cycle: "monthly", status: "ACTIVE",
    charge_id: "gid://shopify/AppSubscription/old",
    event_at: "2026-09-22T10:00:00.000Z",
  };
  terminal.clear();
  await reconcileSubscriptionUpdate(
    "billing-test.myshopify.com", null,
    {
      admin_graphql_api_id: "gid://shopify/AppSubscription/old",
      name: "TrackGap Starter",
      status: "CANCELLED",
      triggered_at: "2026-09-22T13:00:00.000Z",
    },
    deps,
  );
  await reconcileSubscriptionUpdate(
    "billing-test.myshopify.com", null,
    {
      admin_graphql_api_id: "gid://shopify/AppSubscription/new",
      name: "TrackGap Growth",
      status: "ACTIVE",
      triggered_at: "2026-09-22T12:00:00.000Z",
    },
    deps,
  );
  assert.equal(current.id, "growth");
  assert.equal(current.charge_id, "gid://shopify/AppSubscription/new");

  // Uninstall clears the charge but preserves its ACTIVE watermark. A retried
  // ACTIVE delivery from before uninstall must not restore paid entitlement.
  current = {
    id: "free", cycle: "monthly", status: "CANCELLED",
    charge_id: null,
    event_at: "2026-09-22T12:00:00.000Z",
  };
  terminal.clear();
  await reconcileSubscriptionUpdate(
    "billing-test.myshopify.com", null,
    {
      admin_graphql_api_id: "gid://shopify/AppSubscription/new",
      name: "TrackGap Growth",
      status: "ACTIVE",
      triggered_at: "2026-09-22T12:00:00.000Z",
    },
    deps,
  );
  assert.equal(current.id, "free");
  assert.equal(current.charge_id, null);
});

test("billing callback accepts only the subscription it requested", async () => {
  const { subscriptionMatchesExpected } = await import("../billing.mjs");
  const oldPlan = { plan: "starter", cycle: "monthly", status: "ACTIVE" };
  const newPlan = { plan: "growth", cycle: "monthly", status: "ACTIVE" };
  assert.equal(subscriptionMatchesExpected(oldPlan, "growth", "monthly"), false);
  assert.equal(subscriptionMatchesExpected(newPlan, "growth", "monthly"), true);
  assert.equal(subscriptionMatchesExpected(newPlan, "growth", "annual"), false);
});

test("billing callback retries transient old subscription snapshots", async () => {
  const { waitForExpectedSubscription } = await import("../billing.mjs");
  const snapshots = [
    { plan: "starter", cycle: "monthly", status: "ACTIVE" },
    { plan: "free", cycle: "monthly", status: "NONE" },
    {
      plan: "growth", cycle: "monthly", status: "ACTIVE",
      charge_id: "gid://shopify/AppSubscription/new",
    },
  ];
  let calls = 0;
  const result = await waitForExpectedSubscription(
    "billing-test.myshopify.com", "token", "growth", "monthly",
    {
      attempts: 3,
      delayMs: 0,
      verify: async () => snapshots[calls++],
      sleep: async () => {},
    },
  );
  assert.equal(calls, 3);
  assert.equal(result.charge_id, "gid://shopify/AppSubscription/new");
});

test("billing callback state is scoped, tamper-proof and short-lived", async () => {
  const { createBillingState, verifyBillingState } = await import("../billing.mjs");
  const now = Date.parse("2026-09-23T12:00:00.000Z");
  const state = createBillingState(
    "billing-test.myshopify.com", "growth", "monthly", now,
  );
  assert.equal(
    verifyBillingState(
      state, "billing-test.myshopify.com", "growth", "monthly", now + 1000,
    ),
    true,
  );
  assert.equal(
    verifyBillingState(
      state, "billing-test.myshopify.com", "pro", "monthly", now + 1000,
    ),
    false,
  );
  assert.equal(
    verifyBillingState(
      `${state.slice(0, -1)}x`, "billing-test.myshopify.com", "growth", "monthly", now + 1000,
    ),
    false,
  );
  assert.equal(
    verifyBillingState(
      state, "billing-test.myshopify.com", "growth", "monthly", now + 16 * 60_000,
    ),
    false,
  );
});
