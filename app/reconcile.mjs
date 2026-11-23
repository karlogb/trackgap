/**
 * TrackGap — porovnavaci engine v2.
 *
 * Zmeny oproti v1 (po prvom behu na pilotnom obchode, 30.8.2026):
 *
 * 1. GHOST FILTER. v1 hlasil ako "ghost" aj objednavky mladsie nez 48 h, ktore
 *    su v obchode aj v GA4 — len sa nedostali do porovnavanej mnoziny.
 *    Teraz sa ghosty hladaju proti VSETKYM objednavkam, nielen zrelym.
 *
 * 2. SYSTEMATICKY ROZDIEL V SUMACH. Na pilotnom obchode bol kazdy rozdiel presne 2,99 EUR
 *    (postovne) — cize GA4 dostava trzbu bez dopravy. To NIE JE chyba merania,
 *    ale v1 to hlasil ako 14,9 % stratenych trzieb a zbytocne strasil.
 *    Teraz sa rozlisuje:
 *      - konstantny rozdiel na objednavku  -> doprava/poplatok, INFO
 *      - konstantny pomer (napr. 1/1,23)   -> DPH, INFO
 *      - nahodny rozptyl                   -> skutocny problem, NALEZ
 */

/**
 * Ako stara musi byt objednavka, nez ju porovname s GA4.
 *
 * GA4 udava az 48 h na uplnu konsolidaciu, ale realne su transakcie v API
 * do niekolkych minut. Karlo 31.8.2026: okno uplne vypnute, aby bolo vidiet
 * vysledok hned (screencast pre App Store review). Ak sa v produkcii ukaze,
 * ze cerstve objednavky generuju falosne "missing", vratit na 4 h cez
 * TRACKGAP_MIN_AGE_HOURS — kod to podporuje bez zasahu.
 */
const MIN_AGE_HOURS = Number(process.env.TRACKGAP_MIN_AGE_HOURS ?? 0);
const VAT_RATES = [1.10, 1.19, 1.20, 1.21, 1.22, 1.23, 1.25, 1.27];

/** Median — odolnejsi voci vychylkam nez priemer. */
function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Zisti, ktorej hodnote z objednavky zodpoveda to, co dorazilo do GA4.
 *
 * v1 hadala z rozdielu a na pilotnom obchode (postovne vzdy 2,99) to vyslo pekne.
 * Lenze doprava byva premenliva — kurier vs vydajne miesto, zdarma nad limit,
 * ine krajiny. Vtedy by v1 videla nahodny rozptyl a zbytocne strasila.
 *
 * v2 uz nehada: Shopify vracia subtotal, shipping a tax zvlast, tak sa GA4
 * hodnota porovna proti kazdemu kandidatovi a vyhra ten, ktory sedi najcastejsie.
 */
const CANDIDATES = [
  { key: "total",             label: "celá suma vrátane dopravy a DPH",
    fn: (o) => o.total },
  { key: "subtotal",          label: "value excludes shipping",
    fn: (o) => o.subtotal },
  { key: "total_minus_tax",   label: "value excludes VAT (shipping included)",
    fn: (o) => o.total - o.tax },
  { key: "subtotal_minus_tax",label: "value excludes shipping aj bez DPH",
    fn: (o) => o.subtotal - o.tax },
  { key: "total_minus_ship",  label: "value excludes shipping",
    fn: (o) => o.total - o.shipping },
];

export function analyseValueGap(pairs) {
  // pairs: [{order, ga4revenue}]
  const usable = pairs.filter((p) => p.ga4 > 0 && p.order.total > 0);
  if (usable.length < 3) return { kind: "unknown", confidence: 0 };

  // ktory kandidat sedi na najviac objednavok (tolerancia 1 cent)
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
            + "je v poriadku.",
      };
    }
    // sedi, ale na inu zlozku — systematicke, nie chyba
    const avgDiff = usable.reduce(
      (s, p) => s + (p.order.total - p.ga4), 0) / usable.length;
    return {
      kind: "partial_value",
      matched: best.key,
      confidence: +best.ratio.toFixed(2),
      avg_diff: +avgDiff.toFixed(2),
      note: `Do GA4 chodí ${best.label}. Celková suma objednávky je v priemere `
          + `o ${avgDiff.toFixed(2)} vyššia. Nie je to strata dát — ale reporty `
          + "in GA4 and in your store will never match until this is aligned.",
    };
  }

  // ziadny kandidat nesedi konzistentne -> pozri, ci aspon nie je konstantny pomer
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
        ? `Pomer súm sedí na DPH ${((vat - 1) * 100).toFixed(0)} %. Do GA4 `
          + "receives the price without VAT while your store reports it with VAT."
        : `Sumy sa líšia konštantným pomerom ${med.toFixed(3)}.`,
    };
  }

  // naozaj nekonzistentne
  const diffs = usable.map((p) => Math.abs(p.order.total - p.ga4));
  return {
    kind: "inconsistent",
    matched: best.key,
    best_ratio: +best.ratio.toFixed(2),
    median_diff: +median(diffs).toFixed(2),
    confidence: 1,
    note: "GA4 values do not consistently match any part of the order — "
        + "not the total, not the amount without shipping, not without VAT. "
        + "Revenue in GA4 is unreliable.",
  };
}

/**
 * Rozdeli chybajuce objednavky podla toho, KDE sa retazec pretrhol.
 *
 * Toto je jadro hodnoty produktu. Samotne "18 % objednaviek chyba v GA4"
 * merchantovi nepovie, co ma opravit. Vrstvy su tri:
 *
 *   Shopify (objednavka existuje) -> nas pixel (odislo z prehliadaca)
 *                                 -> GA4 (dorazilo do analytiky)
 *
 *   pixel ANO  + GA4 NIE  = event sa odpalil, ale do GA4 nedorazil.
 *                           Chyba je v GA4 tagu/konfiguracii alebo ho nieco
 *                           blokuje. `delivery_broken`
 *   pixel NIE  + GA4 NIE  = event sa vobec neodpalil. Chyba je na webe —
 *                           theme, consent banner, GTM trigger. `never_fired`
 *   pixel neaktivny       = objednavka je spred instalacie appky, alebo pixel
 *                           nebezi. Nevieme rozhodnut, NEHADAME. `unknown`
 *
 * `pixel.since` je cas prveho eventu od pixelu. Vsetko starsie pixel nikdy
 * nevidel, takze sa NESMIE ratat ako "never_fired" — inak by sme merchantovi
 * nahlasili poruchu, ktora neexistuje.
 */
function classifyMissing(missing, pixel) {
  const out = {
    never_fired: 0,        // pixel ani GA4 -> rozbity web/consent/trigger
    delivery_broken: 0,    // pixel ano, GA4 nie -> rozbite dorucenie do GA4
    before_pixel: 0,       // spred instalacie appky, neda sa posudit
    unknown: 0,            // pixel nebezi vobec
    never_fired_ids: [],
    delivery_broken_ids: [],
  };
  if (!pixel?.active) {
    out.unknown = missing.length;
    return out;
  }
  // SQLite datetime('now') je UTC bez zony — bez 'Z' by sa to citalo ako
  // lokalny cas a hranica by sa posunula o 2 h (CEST).
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
  // OPRAVA: ghosty proti VSETKYM objednavkam, nie len zrelym
  const allOrderIds = new Set(orders.map((o) => String(o.order_id)));

  const missing = ripe.filter((o) => !ga4Map.has(String(o.order_id)));
  const duplicates = ga4.filter((g) => (g.event_count || 1) > 1);
  const ghosts = ga4.filter(
    (g) => !allOrderIds.has(String(g.transaction_id))
        && !String(g.transaction_id).includes("(other)"),
  );
  const otherRows = ga4.filter((g) =>
    String(g.transaction_id).toLowerCase().includes("(other)"));

  // sparovane sumy — len objednavky, ktore su v oboch
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

  // Rozdelenie chybajucich podla PRICINY. Bez toho merchant nevie, ci ma
  // opravovat meranie, alebo ci je to len bezne odmietnutie cookies.
  //
  // POZOR: pocitame len AGREGAT. Ziadne osobne udaje, ziadne odosielanie —
  // objednavka bez suhlasu sa NIKDY nedoplna do GA4 ani inam.
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
    // percenta z porovnavanych objednavok
    consent_pct: ripe.length ? +((noConsent / ripe.length) * 100).toFixed(1) : 0,
    broken_pct: ripe.length ? +((real / ripe.length) * 100).toFixed(1) : 0,
  };

  const findings = [];
  // Kde presne sa retazec pretrhol — tretia vrstva merania.
  const layers = classifyMissing(missing, pixel);

  if (missing.length) {
    // skutocna hodnota chybajucich objednavok — konkurencia to odhaduje
    // z ad spendu, ktory si user zada rucne. My mame realne sumy zo Shopify.
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

  // Samostatny nalez pre kazdu z dvoch pricin — maju INU opravu, takze ich
  // merchant musi vidiet oddelene, nie ako jedno cislo "chyba 18 %".
  if (layers.delivery_broken > 0) {
    findings.push({
      type: "delivery_broken",
      severity: "high",
      count: layers.delivery_broken,
      detail: {
        order_numbers: layers.delivery_broken_ids,
        note: "These orders DID fire a purchase event in the browser, but GA4 "
            + "never recorded them. The event is leaving the browser and "
            + "getting lost on the way — check your GA4 tag configuration, "
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
            + "The problem is on the storefront — a broken thank-you page "
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

  // rozdiel v trzbach hlasime len ked NIE JE systematicky
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
    // systematicky rozdiel = informacia, nie poplach
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
            + "Exact matching is no longer possible — a BigQuery export "
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
      // tretia vrstva: kde sa retazec pretrhol
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
