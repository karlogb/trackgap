/**
 * TrackGap — e-mailove alerty.
 *
 * Cely zmysel produktu je, ze sa ozve v DEN, ked sa tracking pokazi.
 * Dashboard, na ktory sa nikto nepozera, problem nevyriesi.
 *
 * Posielame LEN ked sa nieco zhorsilo oproti predoslym behom (monitor.mjs ->
 * detectRegressions). Denny sumar "vsetko je v poriadku" je cesta k tomu,
 * ze si merchant nastavi filter a alerty prestane citat.
 */
import fs from "node:fs";
import { db } from "./db.mjs";
import { pendingAlerts, markSent } from "./monitor.mjs";
import { smtpConfigPath, smtpConfigFromEnv, appUrl } from "./secrets.mjs";
import { sendMail as smtpSend } from "./smtp.mjs";

const FROM = process.env.TRACKGAP_MAIL_FROM || "TrackGap <alerts@example.com>";
const REPLY_TO = process.env.TRACKGAP_MAIL_REPLYTO || "support@example.com";

function smtpConfig() {
  const p = smtpConfigPath();
  const c = fs.existsSync(p)
    ? JSON.parse(fs.readFileSync(p, "utf8"))
    : smtpConfigFromEnv();
  if (!c) return null;
  return {
    host: c.host,
    port: c.smtp_port || 1025,
    user: c.user,
    pass: c.password,
    helo: new URL(appUrl()).hostname,
  };
}

/**
 * Odosle mail cez Proton Bridge.
 *
 * Samotny SMTP dialog zije v smtp.mjs — povodna verzia tu nerobila STARTTLS
 * (Bridge bez neho odmieta AUTH) a stav posuvala na kazdom TCP chunku, takze
 * pri viacriadkovej odpovedi poslala prikaz mimo poradia. Alert by teda
 * neodisiel prave vtedy, ked na nom najviac zalezi.
 */
async function sendMail({ to, subject, text }) {
  const cfg = smtpConfig();
  if (!cfg) throw new Error("no smtp config");
  return smtpSend(cfg, { from: FROM, replyTo: REPLY_TO, to, subject, text });
}

const SUBJECTS = {
  missing_spike: "Tracking gap opened on your store",
  ga4_silent: "Your analytics stopped recording orders",
  duplicates_new: "Duplicate conversions detected",
  value_broke: "Order values no longer match your analytics",
  pixel_silent: "TrackGap stopped receiving data from your store",
  access_lost: "TrackGap can no longer check your tracking",
};

/**
 * Zavaznost nalezu — urcuje predmet mailu, ked ich je viac naraz.
 * Ticho v GA4 a slepy pixel su vypadok merania; duplicity a rozdiel v sumach
 * su nepresnost. To prve treba riesit dnes.
 */
const SEVERITY = {
  // Najvyssia zavaznost vobec: pri strate pristupu appka NEVIE POVEDAT NIC.
  // Vypadok GA4 je zisteny problem; toto je slepota — kazdy dalsi nalez
  // v tom case chyba, lebo nema z coho vzniknut.
  access_lost: 6,
  ga4_silent: 5,
  pixel_silent: 4,
  missing_spike: 3,
  duplicates_new: 2,
  value_broke: 1,
};

function buildBody(shopDomain, alerts, summary) {
  const app = `${appUrl()}/app?shop=${encodeURIComponent(shopDomain)}`;
  const list = Array.isArray(alerts) ? alerts : [alerts];
  const lines = [];

  // STRATA PRISTUPU sa nesmie miesat s cislami z poslednej kontroly.
  // Tie su stare a appka uz nevie, ci este platia — ukazat ich vedla vety
  // "nevidime do tvojho obchodu" je priamy protiklad zmyslu tohto mailu.
  // Merchant ma dostat jednu vec: co ma kliknut, aby appka zase videla.
  const blind = list.find((a) => a.kind === "access_lost");
  if (blind) {
    return [
      blind.message,
      "",
      "Until this is fixed, TrackGap is NOT checking your tracking. If your",
      "analytics break in the meantime, we will not be able to warn you.",
      "",
      `Reconnect here: ${app}`,
      "",
      "—",
      "This is the only case where we email you about TrackGap itself",
      "rather than about your store.",
    ].join("\n");
  }

  // Viac nalezov = ocislovany zoznam. Jednu vec necislujeme, aby mail
  // s jedinym problemom nevyzeral ako report.
  if (list.length === 1) {
    lines.push(list[0].message);
  } else {
    lines.push(`We found ${list.length} problems with tracking on your store:`, "");
    list.forEach((a, i) => lines.push(`${i + 1}. ${a.message}`, ""));
  }

  lines.push(
    "",
    "Where things stand right now:",
    `  Orders compared:     ${summary?.orders_compared ?? "—"}`,
    `  Missing in GA4:      ${summary?.missing ?? "—"} (${summary?.missing_pct ?? "—"}%)`,
    `  Duplicates:          ${summary?.duplicates ?? "—"}`,
  );

  // Rozpad podla vrstiev je to najhodnotnejsie, co vieme povedat: hovori
  // merchantovi, CO ma opravit, nie len ze nieco nesedi.
  const nf = summary?.never_fired;
  const db_ = summary?.delivery_broken;
  if (nf || db_) {
    lines.push("", "Where the chain breaks:");
    if (db_) {
      lines.push(
        `  ${db_} order(s): the purchase event fired in the browser, but GA4`,
        "    never recorded it. Look at your GA4 tag and measurement ID.",
      );
    }
    if (nf) {
      lines.push(
        `  ${nf} order(s): no purchase event fired in the browser at all.`,
        "    Look at your thank-you page, consent banner or GTM trigger.",
      );
    }
  }

  lines.push(
    "",
    `Open TrackGap: ${app}`,
    "",
    "—",
    "You are getting this because tracking on your store changed for the worse.",
    "TrackGap does not send routine summaries — only real problems.",
  );
  return lines.join("\n");
}

/**
 * Odosle cakajuce alerty. Vola sa po kazdej kontrole.
 * Nikdy nehodi vynimku smerom von — zlyhany mail nesmie zhodit kontrolu.
 *
 * JEDEN MAIL NA OBCHOD: predtym sa posielal mail za KAZDY nalez, takze jedna
 * kontrola vedela poslat tri maily za sebou (overene 1.9.2026 na demo obchode:
 * `duplicates_new` a `value_broke` z jedneho behu = dva samostatne maily).
 * Merchant, ktoreho appka trikrat po sebe upozorni na to iste rano, si na nu
 * nastavi filter — a alert, kvoli ktoremu appka existuje, sa uz nikdy neprecita.
 */
export async function flushAlerts() {
  const pending = pendingAlerts();
  if (!pending.length) return { sent: 0 };

  // zoskupenie podla obchodu
  const byShop = new Map();
  for (const a of pending) {
    if (!byShop.has(a.shop_id)) byShop.set(a.shop_id, []);
    byShop.get(a.shop_id).push(a);
  }

  let sent = 0;
  for (const [shopId, group] of byShop) {
    const shop = db.prepare(
      "SELECT id, shop_domain, alert_email FROM shops WHERE id = ?").get(shopId);
    const to = shop?.alert_email;
    if (!to) {
      // bez adresy nie je kam poslat — oznac ako spracovane, nech sa nehromadi
      for (const a of group) markSent(a.id);
      continue;
    }

    // Odoslanie je dokaz, ze kanal nie je rozbity. NEHOVORIME `delivered`:
    // bounce chodi asynchronne a nam, takze v tomto bode vieme len to, ze
    // relay spravu prevzal. `sent` je presne to, co vieme — pomenovat to
    // `delivered` by bola presne ta domienka, ktora nas dostala.
    const markMail = (status, err) => db.prepare(
      "UPDATE shops SET alert_email_status=?, alert_email_error=? WHERE id=?")
      .run(status, err, shopId);

    const last = db.prepare(
      `SELECT missing, missing_pct, duplicates, orders AS orders_compared,
              never_fired, delivery_broken
       FROM check_history WHERE shop_id = ? ORDER BY ran_at DESC LIMIT 1`)
      .get(shopId);

    // Predmet urcuje NAJZAVAZNEJSI nalez, nie nahodne prvy z DB. Merchant vidi
    // v schranke len predmet — ma z neho poznat, ci je to porucha merania,
    // alebo len duplicity.
    const primary = [...group].sort(
      (a, b) => (SEVERITY[b.kind] ?? 0) - (SEVERITY[a.kind] ?? 0))[0];
    const subject = group.length === 1
      ? (SUBJECTS[primary.kind] || "TrackGap alert")
      : `${SUBJECTS[primary.kind] || "TrackGap alert"} (+${group.length - 1} more)`;

    try {
      await sendMail({
        to, subject, text: buildBody(shop.shop_domain, group, last),
      });
      for (const a of group) markSent(a.id);
      markMail("sent", null);
      sent += 1;
    } catch (e) {
      console.error(`alert mail failed (${shop.shop_domain}):`, e.message);
      // Zlyhany alert sa NESMIE oznacit ako odoslany — ostava pending a
      // skusi sa znova. Zaroven si to pamatame na obchode, aby to merchant
      // videl v UI: inak by appka mlcala a tvarila sa, ze mlci preto,
      // lebo je vsetko v poriadku.
      markMail("failed", String(e.message).slice(0, 300));
    }
  }
  return { sent };
}

export async function sendTest(shopDomain, to) {
  return sendMail({
    to,
    subject: "TrackGap — test alert",
    text: [
      `This is a test alert for ${shopDomain}.`,
      "",
      "If you are reading this, alerts are working. You will only hear from us",
      "when something about your tracking gets worse — not on a schedule.",
      "",
      `${appUrl()}/app?shop=${encodeURIComponent(shopDomain)}`,
    ].join("\n"),
  });
}
