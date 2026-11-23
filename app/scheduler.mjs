/**
 * TrackGap — planovac pravidelnych kontrol.
 *
 * PRECO: bez toho sa kontrola spustila LEN ked merchant otvoril dashboard.
 * Slub produktu ("ozveme sa v den, ked sa tracking pokazi") aj platene plany
 * ("Daily checks", "Email alerts") boli teda nesplnitelne — merchant, ktory
 * prestal chodit do appky, nedostal nic. Prave vtedy je alert najpotrebnejsi.
 * Audit 31.8.2026, bod 4.
 *
 * Kadencia podla planu:
 *   free    tyzdenne
 *   ostatne denne
 *
 * Bezi v tom istom procese ako server (jeden obchod = par HTTP volani denne,
 * na samostatny worker to zatial nie je).
 */
import { db } from "./db.mjs";
import { PLANS } from "./billing.mjs";
import { flushAlerts } from "./alerts.mjs";
import { saveAlerts } from "./monitor.mjs";

/**
 * Ako dlho tolerujeme stratu pristupu, nez o nej napiseme merchantovi.
 *
 * Nie hned pri prvom zlyhani: kratky vypadok Shopify/Google API alebo nasho
 * servera by inak vygeneroval mail o "strate pristupu", ktora sa o hodinu
 * sama opravi. Falosny poplach z monitorovacej appky je drahsi nez hodinove
 * meskanie — po nom uz merchant dalsi mail neberie vazne.
 */
const ACCESS_GRACE_H = Number(process.env.TRACKGAP_ACCESS_GRACE_H ?? 6);

const HOUR = 3600_000;
const TICK_MS = 30 * 60_000;        // ako casto sa pozerame, ci nieco nedozrelo

/**
 * Hodina (v case obchodu), kedy ma bezat denna kontrola.
 *
 * PRECO FIXNA HODINA: bez nej sa kadencia pocitala od posledneho behu, takze
 * cas kontroly kazdy den driftoval a alert mohol prist o 3:00 rano. Merchant
 * ma dostat mail rano, ked s tym vie nieco spravit, a hlavne az ked ma GA4
 * predosly den spracovany.
 */
const DAILY_HOUR = Number(process.env.TRACKGAP_DAILY_HOUR ?? 7);

/**
 * Kolko hodin uz musi ubehnut od posledneho behu, aby sa spustil dalsi.
 * Braní tomu, aby sa kontrola v okne DAILY_HOUR spustila viackrat.
 */
const MIN_GAP_H = 20;

/** Lokalna hodina v casovej zone obchodu (fallback: cas servera). */
function localHour(tz) {
  try {
    return Number(new Intl.DateTimeFormat("en-GB", {
      timeZone: tz || "UTC", hour: "numeric", hour12: false,
    }).format(new Date()));
  } catch {
    return new Date().getHours();
  }
}

/** Ako casto ma bezat kontrola pre dany plan, v hodinach. */
function cadenceHours(plan) {
  return plan === "free" ? 24 * 7 : 24;
}

/**
 * Obchody, ktorym uz uplynula kadencia.
 *
 * Berieme len tie, ktore uz raz BOLI nastavene (maju vybranu GA4 property) —
 * inak niet co porovnavat.
 *
 * ZAMERNE tu NEFILTRUJEME na pritomnost tokenov. Predtym tu bolo
 * `access_token_enc IS NOT NULL AND google_refresh_enc IS NOT NULL`, cize
 * obchod, ktoremu prave zmizol pristup, z planovaca ticho VYPADOL. Prestal
 * byt kontrolovany a zaroven nemal ako vzniknut alert — appka o svojej
 * slepote nemala ako povedat. Nechame ich prejst, `runCheck` zlyha s
 * AccessError a merchant dostane mail (1.9.2026).
 */
function dueShops() {
  const rows = db.prepare(`
    SELECT s.shop_domain, s.plan, s.id, s.timezone,
           (SELECT MAX(ran_at) FROM check_history h WHERE h.shop_id = s.id) AS last_run
    FROM shops s
    WHERE s.uninstalled_at IS NULL
      AND s.ga4_property_id IS NOT NULL
  `).all();

  const now = Date.now();
  return rows.filter((r) => {
    if (!r.last_run) return true;                 // este nikdy nebezalo
    const age = now - new Date(r.last_run.replace(" ", "T") + "Z").getTime();

    // Bezpecnostna poistka: ked kontrola nebezala vyrazne dlhsie, nez ma
    // (server bol dole, obchod bol bez GA4), spusti sa bez ohladu na hodinu.
    if (age >= cadenceHours(r.plan) * HOUR + 12 * HOUR) return true;

    // Kadencia planu plati vzdy — free ma tyzdennu, nie dennu kontrolu.
    // Odpocitava sa mala rezerva, aby beh o 7:00 nebol o par minut "prilis
    // skoro" a neodsunul sa o cely den (resp. tyzden).
    if (age < cadenceHours(r.plan) * HOUR - 2 * HOUR) return false;
    if (age < MIN_GAP_H * HOUR) return false;

    // v ramci dna cakame na urcenu hodinu v case OBCHODU
    return localHour(r.timezone) === DAILY_HOUR;
  });
}

let running = false;

/**
 * Ked appka stratila pristup a trva to uz dlhsie nez ACCESS_GRACE_H,
 * vytvor alert — appka musi POVEDAT, ze prestala strazit.
 *
 * Text sa lisi podla toho, kto to vie opravit a ako: Shopify pristup sa
 * obnovi otvorenim appky v admine, Google pripojenim uctu v nastaveniach.
 * Vseobecne "nastala chyba" by merchanta nikam neposunulo.
 */
export function raiseAccessAlert(shopId) {
  const s = db.prepare(
    `SELECT access_broken_kind AS kind, access_broken_since AS since,
            ga4_connected_at, google_refresh_enc
     FROM shops WHERE id = ?`).get(shopId);
  if (!s?.kind || !s.since) return;

  // Obchod, ktory Google nikdy nepripojil, nemal co stratit. Poslat mu
  // "prestali sme strazit tvoje meranie" je falosny poplach z monitorovacej
  // appky — a po nom uz merchant ziadny dalsi mail nevezme vazne.
  if (s.kind === "google_auth" && !s.ga4_connected_at && !s.google_refresh_enc) {
    return;
  }

  const age = Date.now() - new Date(s.since.replace(" ", "T") + "Z").getTime();
  if (age < ACCESS_GRACE_H * HOUR) return;

  const message = s.kind === "google_auth"
    ? "TrackGap has lost access to your Google Analytics, so it has stopped "
      + "checking your tracking. This usually happens when the Google account "
      + "connection is revoked or expires. Reconnect Google to resume."
    : "TrackGap has lost access to your Shopify orders, so it has stopped "
      + "checking your tracking. Open the app from your Shopify admin to "
      + "reauthorize it.";

  // saveAlerts sam odfiltruje opakovanie toho isteho druhu do 24 h, takze
  // trvala porucha posle jeden mail denne, nie jeden na kazdy tick.
  saveAlerts(shopId, [{ kind: "access_lost", message }]);
}

/**
 * Jeden prechod. Chyba jedneho obchodu nesmie zastavit ostatne — kazdy
 * je vo vlastnom try/catch.
 */
export async function runScheduledChecks(runCheck) {
  if (running) return { skipped: "already running" };
  running = true;
  const done = [];
  try {
    for (const shop of dueShops()) {
      try {
        const row = db.prepare("SELECT * FROM shops WHERE id = ?").get(shop.id);
        const r = await runCheck(row);
        done.push({
          shop: shop.shop_domain,
          missing: r?.summary?.missing ?? null,
          pct: r?.summary?.missing_pct ?? null,
        });
      } catch (e) {
        console.error(`scheduled check failed (${shop.shop_domain}):`, e.message);
        done.push({ shop: shop.shop_domain, error: e.message });
        // Zlyhanie kontroly sa nesmie skoncit len zapisom do logu. Prave
        // preto appka doteraz oslepla potichu: vynimka sa zalogovala, cyklus
        // sa krutil dalej a merchant zil v presvedceni, ze je strazeny.
        raiseAccessAlert(shop.id);
      }
    }
    if (done.length) {
      // alerty az po vsetkych kontrolach, nech ide jeden mail na obchod
      await flushAlerts().catch((e) =>
        console.error("flushAlerts:", e.message));
    }
  } finally {
    running = false;
  }
  return { checked: done.length, done };
}

/** Uprace stare zaznamy — inak rastu donekonecna. */
export function pruneOldRows() {
  const stmts = [
    "DELETE FROM webhook_log WHERE seen_at < datetime('now','-7 days')",
    "DELETE FROM identities WHERE seen_at < datetime('now','-30 days')",
    "DELETE FROM orders WHERE created_at < datetime('now','-90 days')",
    `DELETE FROM ga4_events
     WHERE date(substr(date,1,4)||'-'||substr(date,5,2)||'-'||substr(date,7,2))
           < date('now','-90 days')`,
    "DELETE FROM pixel_events WHERE fired_at < datetime('now','-90 days')",
    "DELETE FROM check_history WHERE ran_at < datetime('now','-12 months')",
    "DELETE FROM backfills WHERE created_at < datetime('now','-12 months')",
    "DELETE FROM findings WHERE detected_at < datetime('now','-12 months')",
    // Ads report je len cache; po dni je bezcenny a len zabera miesto.
    "DELETE FROM kv_cache WHERE created_at < datetime('now','-1 day')",
  ];
  let total = 0;
  for (const s of stmts) {
    try { total += db.prepare(s).run().changes; } catch { /* tabulka moze chybat */ }
  }
  return total;
}

export function startScheduler(runCheck) {
  const tick = async () => {
    try {
      const r = await runScheduledChecks(runCheck);
      if (r.checked) console.log(`scheduler: ${r.checked} kontrol`);
    } catch (e) {
      console.error("scheduler tick:", e.message);
    }
  };

  // prvy beh o minutu po starte — nech restart nespusti vsetko naraz
  setTimeout(tick, 60_000);
  const t1 = setInterval(tick, TICK_MS);

  const t2 = setInterval(() => {
    const n = pruneOldRows();
    if (n) console.log(`scheduler: uprataných ${n} starých riadkov`);
  }, 24 * HOUR);

  // nech interval nedrzi proces pri zivote pri vypinani
  t1.unref?.();
  t2.unref?.();
  console.log(`scheduler: spusteny (tick ${TICK_MS / 60000} min)`);
}
