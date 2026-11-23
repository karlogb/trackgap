/**
 * TrackGap - reconciliation engine v2.
 *
 * Changes from v1:
 *
 * 1. GHOST FILTER. v1 also reported orders younger than 48 h as "ghosts",
 *    although they existed both in the store and in GA4; they just were not
 *    in the compared set. Ghosts are now matched against ALL orders, not only
 *    mature ones.
 *
 * 2. SYSTEMATIC VALUE DIFFERENCES. In testing, every difference was exactly
 *    2.99 EUR (shipping), i.e. GA4 received revenue without shipping. That is
 *    NOT a tracking error, but v1 reported it as 14.9 % lost revenue and
 *    raised a false alarm. Now we distinguish:
 *      - constant difference per order  -> shipping/fee, INFO
 *      - constant ratio (e.g. 1/1.23)    -> VAT, INFO
 *      - random spread                   -> real problem, FINDING
 */

/**
 * How old an order must be before it is compared with GA4.
 *
 * GA4 states up to 48 h for full consolidation, but in practice transactions
 * show up in the API within minutes. The window is disabled by default so
 * results are visible immediately. If fresh orders start producing false
 * "missing" results, set TRACKGAP_MIN_AGE_HOURS (e.g. 4); no code change needed.
 */
const MIN_AGE_HOURS = Number(process.env.TRACKGAP_MIN_AGE_HOURS ?? 0);
const VAT_RATES = [1.10, 1.19, 1.20, 1.21, 1.22, 1.23, 1.25, 1.27];

/** Median: more robust to outliers than the mean. */
function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Determines which order value matches what arrived in GA4.
 *
 * v1 guessed from the difference, which worked while shipping was always the
 * same. But shipping varies (courier vs pickup point, free above a threshold,
 * other countries), and v1 would then see a random spread and raise a false
 * alarm.
 *
 * v2 no longer guesses: Shopify returns subtotal, shipping and tax
 * separately, so the GA4 value is compared against each candidate and the
 * one that matches most often wins.
 */
const CANDIDATES = [
  { key: "total",             label: "value is the full total incl. shipping and VAT",
    fn: (o) => o.total },
  { key: "subtotal",          label: "value excludes shipping",
    fn: (o) => o.subtotal },
  { key: "total_minus_tax",   label: "value excludes VAT (shipping included)",
    fn: (o) => o.total - o.tax },
  { key: "subtotal_minus_tax",label: "value excludes shipping and VAT",
    fn: (o) => o.subtotal - o.tax },
  { key: "total_minus_ship",  label: "value excludes shipping",
    fn: (o) => o.total - o.shipping },
];

export function analyseValueGap(pairs) {
  // pairs: [{order, ga4revenue}]
  const usable = pairs.filter((p) => p.ga4 > 0 && p.order.total > 0);
  if (usable.length < 3) return { kind: "unknown", confidence: 0 };

  // which candidate matches the most orders (1 cent tolerance)
  const scored = CANDIDATES.map((c) => {
    let hits = 0;
    for (const p of usable) {
      const v = c.fn(p.order);
      if (Number.isFinite(v) && Math.abs(v - p.ga4) <= 0.011) hits++;
    }
    return { ...c, hits, ratio: hits / usable.length };
  }).sort((a, b) => b.hits - a.hits);

  const best = scored[0];

  if (best.ratio >= 0.85) {
    if (best.key === "total") {
      return {
        kind: "match",
        matched: best.key,
        confidence: +best.ratio.toFixed(2),
        note: "GA4 values match the full order total. Revenue reporting "
            + "is fine.",
      };
    }
    // matches, but a different component: systematic, not an error
    const avgDiff = usable.reduce(
      (s, p) => s + (p.order.total - p.ga4), 0) / usable.length;
    return {
      kind: "partial_value",
      matched: best.key,
      confidence: +best.ratio.toFixed(2),
      avg_diff: +avgDiff.toFixed(2),
      note: `GA4 does not receive the full order total (${best.label}). The order total is on average `
          + `${avgDiff.toFixed(2)} higher. This is not data loss, but reports `
          + "in GA4 and in your store will never match until this is aligned.",
    };
  }

  // no candidate matches consistently -> check for at least a constant ratio
  const ratios = usable.map((p) => p.order.total / p.ga4);
  const med = median(ratios);
  const sameRatio = ratios.filter((r) => Math.abs(r - med) < 0.01).length;
  if (sameRatio / usable.length >= 0.8 && Math.abs(med - 1) > 0.02) {
    const vat = VAT_RATES.find((v) => Math.abs(med - v) < 0.015);
    return {
      kind: vat ? "vat" : "fixed_ratio",
      ratio: +med.toFixed(4),
      vat_rate: vat ? +((vat - 1) * 100).toFixed(0) : null,
      confidence: +(sameRatio / usable.length).toFixed(2),
      note: vat
        ? `The amount ratio matches ${((vat - 1) * 100).toFixed(0)} % VAT. GA4 `
          + "receives the price without VAT while your store reports it with VAT."
        : `Amounts differ by a constant ratio of ${med.toFixed(3)}.`,
    };
  }

  // genuinely inconsistent
  const diffs = usable.map((p) => Math.abs(p.order.total - p.ga4));
  return {
    kind: "inconsistent",
    matched: best.key,
    best_ratio: +best.ratio.toFixed(2),
    median_diff: +median(diffs).toFixed(2),
    confidence: 1,
    note: "GA4 values do not consistently match any part of the order - "
        + "not the total, not the amount without shipping, not without VAT. "
        + "Revenue in GA4 is unreliable.",
  };
}

/**
 * Splits missing orders by WHERE the chain broke.
 *
 * This is the core of the product's value. "18 % of orders are missing in
 * GA4" alone does not tell the merchant what to fix. There are three layers:
 *
 *   Shopify (order exists) -> our pixel (left the browser)
 *                          -> GA4 (reached analytics)
 *
 *   pixel YES + GA4 NO   = the event fired but never reached GA4.
 *                          The GA4 tag/configuration is broken or something
 *                          blocks it. `delivery_broken`
 *   pixel NO  + GA4 NO   = the event never fired. The problem is on the site:
 *                          theme, consent banner, GTM trigger. `never_fired`
 *   pixel inactive       = the order predates the app install, or the pixel
 *                          is not running. We cannot tell, so we DO NOT GUESS.
 *                          `unknown`
 *
 * `pixel.since` is the time of the first pixel event. The pixel never saw
 * anything older, so it must NOT count as "never_fired"; otherwise we would
 * report a failure to the merchant that does not exist.
 */
function classifyMissing(missing, pixel) {
  const out = {
    never_fired: 0,        // neither pixel nor GA4 -> broken site/consent/trigger
    delivery_broken: 0,    // pixel yes, GA4 no -> broken delivery to GA4
    before_pixel: 0,       // before the app was installed, cannot be judged
    unknown: 0,            // pixel not running at all
    never_fired_ids: [],
    delivery_broken_ids: [],
  };
  if (!pixel?.active) {
    out.unknown = missing.length;
    return out;
  }
  // SQLite datetime('now') is UTC without a zone; without 'Z' it would be read
  // as local time and the boundary would shift by 2 h (CEST).
  const since = pixel.since
    ? new Date(pixel.since.replace(" ", "T") + "Z").getTime()
    : null;
  for (const o of missing) {
    const created = new Date(o.created_at).getTime();
    if (since && created < since) { out.before_pixel += 1; continue; }
    if (pixel.purchased?.has(String(o.order_id))) {
      out.delivery_broken += 1;
      if (out.delivery_broken_ids.length < 50) {
        out.delivery_broken_ids.push(o.order_number || o.order_id);
      }
    } else {
      out.never_fired += 1;
      if (out.never_fired_ids.length < 50) {
        out.never_fired_ids.push(o.order_number || o.order_id);
      }
    }
  }
  return out;
}

export function reconcile(orders, ga4, identityFor = null, pixel = null) {
  const cutoff = new Date(Date.now() - MIN_AGE_HOURS * 3600_000);

  const ripe = orders.filter((o) => new Date(o.created_at) < cutoff);
  const skipped = orders.length - ripe.length;

  const ga4Map = new Map(ga4.map((g) => [String(g.transaction_id), g]));
  // FIX: ghosts are checked against ALL orders, not only mature ones
  const allOrderIds = new Set(orders.map((o) => String(o.order_id)));

  const missing = ripe.filter((o) => !ga4Map.has(String(o.order_id)));
  const duplicates = ga4.filter((g) => (g.event_count || 1) > 1);
  const ghosts = ga4.filter(
    (g) => !allOrderIds.has(String(g.transaction_id))
        && !String(g.transaction_id).includes("(other)"),
  );
  const otherRows = ga4.filter((g) =>
    String(g.transaction_id).toLowerCase().includes("(other)"));

  // matched amounts: only orders present in both
  const pairs = [];
  for (const o of ripe) {
    const g = ga4Map.get(String(o.order_id));
    if (g) pairs.push({ order: o, ga4: g.revenue || 0 });
  }
  const valueGap = analyseValueGap(pairs);

  const revOrders = ripe.reduce((s, o) => s + (o.total || 0), 0);
  const revGa4 = ga4.reduce((s, g) => s + (g.revenue || 0), 0);
  const revGapPct = revOrders ? ((revOrders - revGa4) / revOrders) * 100 : 0;

  const bySource = {};
  for (const o of missing) {
    const k = o.utm_source || o.referring_site || "(direct)";
    bySource[k] = (bySource[k] || 0) + 1;
  }
  const missingPct = ripe.length ? (missing.length / ripe.length) * 100 : 0;

  // Split missing orders by CAUSE. Without this the merchant cannot tell
  // whether to fix tracking or whether it is just ordinary cookie refusal.
  //
  // NOTE: we only compute an AGGREGATE. No personal data, nothing is sent;
  // an order without consent is NEVER backfilled to GA4 or anywhere else.
  let noConsent = 0;
  let noIdentity = 0;
  let real = 0;
  for (const o of missing) {
    const id = identityFor?.(o.order_id);
    const c = id?.consent || (id?.consent_denied ? "denied" : null);
    if (c === "denied") noConsent += 1;
    else if (!id?.ga_client_id) noIdentity += 1;
    else real += 1;
  }
  const breakdown = {
    consent_declined: noConsent,
    no_identity: noIdentity,
    tracking_broken: real,
    // percentages of compared orders
    consent_pct: ripe.length ? +((noConsent / ripe.length) * 100).toFixed(1) : 0,
    broken_pct: ripe.length ? +((real / ripe.length) * 100).toFixed(1) : 0,
  };

  const findings = [];
  // Where exactly the chain broke: the third measurement layer.
  const layers = classifyMissing(missing, pixel);

  if (missing.length) {
    // actual value of the missing orders, taken from real Shopify amounts
    // rather than estimated from manually entered ad spend
    const lostRevenue = missing.reduce((s, o) => s + (o.total || 0), 0);
    findings.push({
      type: "missing",
      severity: missingPct > 20 ? "high" : missingPct > 5 ? "medium" : "low",
      count: missing.length,
      detail: {
        pct: +missingPct.toFixed(1),
        lost_revenue: +lostRevenue.toFixed(2),
        breakdown,
        layers,
        order_numbers: missing.slice(0, 50).map((o) => o.order_number || o.order_id),
        by_source: bySource,
      },
    });
  }

  // A separate finding for each of the two causes: they have DIFFERENT fixes,
  // so the merchant must see them separately, not as one "18 % missing" number.
  if (layers.delivery_broken > 0) {
    findings.push({
      type: "delivery_broken",
      severity: "high",
      count: layers.delivery_broken,
      detail: {
        order_numbers: layers.delivery_broken_ids,
        note: "These orders DID fire a purchase event in the browser, but GA4 "
            + "never recorded them. The event is leaving the browser and "
            + "getting lost on the way - check your GA4 tag configuration, "
            + "the measurement ID it sends to, and anything blocking the "
            + "request.",
      },
    });
  }
  if (layers.never_fired > 0) {
    findings.push({
      type: "never_fired",
      severity: "high",
      count: layers.never_fired,
      detail: {
        order_numbers: layers.never_fired_ids,
        note: "No purchase event fired in the browser at all for these orders. "
            + "The problem is on the storefront - a broken thank-you page "
            + "trigger, a consent banner blocking the tag, or a GTM rule that "
            + "never matches.",
      },
    });
  }

  if (duplicates.length) {
    findings.push({
      type: "duplicate",
      severity: duplicates.length > ripe.length * 0.05 ? "high" : "medium",
      count: duplicates.length,
      detail: {
        transaction_ids: duplicates.slice(0, 50).map((d) => d.transaction_id),
      },
    });
  }
  if (ghosts.length) {
    findings.push({
      type: "ghost",
      severity: "low",
      count: ghosts.length,
      detail: {
        transaction_ids: ghosts.slice(0, 50).map((g) => g.transaction_id),
        note: "Transactions in GA4 with no matching order in your store. "
            + "Usually these are orders older than the reporting window, "
            + "or cancelled orders.",
      },
    });
  }

  // a revenue gap is reported only when it is NOT systematic
  if (valueGap.kind === "inconsistent" && Math.abs(revGapPct) > 10) {
    findings.push({
      type: "revenue_gap",
      severity: Math.abs(revGapPct) > 25 ? "high" : "medium",
      count: 1,
      detail: {
        pct: +revGapPct.toFixed(1),
        revenue_orders: +revOrders.toFixed(2),
        revenue_ga4: +revGa4.toFixed(2),
        note: valueGap.note,
      },
    });
  } else if (valueGap.kind !== "unknown" && valueGap.kind !== "inconsistent"
             && valueGap.kind !== "match") {
    // systematic difference = information, not an alarm
    findings.push({
      type: "value_note",
      severity: "info",
      count: pairs.length,
      detail: {
        kind: valueGap.kind,
        matched: valueGap.matched ?? null,
        avg_diff: valueGap.avg_diff ?? null,
        ratio: valueGap.ratio ?? null,
        vat_rate: valueGap.vat_rate ?? null,
        confidence: valueGap.confidence,
        note: valueGap.note,
        revenue_orders: +revOrders.toFixed(2),
        revenue_ga4: +revGa4.toFixed(2),
      },
    });
  }

  if (otherRows.length) {
    findings.push({
      type: "cardinality",
      severity: "high",
      count: otherRows.length,
      detail: {
        note: "GA4 has started aggregating transactions into '(other)'. "
            + "Exact matching is no longer possible - a BigQuery export "
            + "is required.",
      },
    });
  }

  return {
    summary: {
      orders_total: orders.length,
      orders_compared: ripe.length,
      orders_too_recent: skipped,
      ga4_transactions: ga4.length,
      missing: missing.length,
      missing_pct: +missingPct.toFixed(1),
      duplicates: duplicates.length,
      ghosts: ghosts.length,
      revenue_gap_pct: +revGapPct.toFixed(1),
      value_gap_kind: valueGap.kind,
      // third layer: where the chain broke
      never_fired: layers.never_fired,
      delivery_broken: layers.delivery_broken,
      pixel_active: !!pixel?.active,
    },
    breakdown,
    layers,
    value_gap: valueGap,
    findings,
  };
}
