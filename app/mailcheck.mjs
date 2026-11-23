/**
 * TrackGap - checks whether the alert address CAN receive mail at all.
 *
 * WHY THIS EXISTS:
 * A merchant entered an address, `/alerts/setup` accepted it (a
 * `something@something.tld` regex is enough), Proton Bridge ACCEPTED the
 * message and the UI said "Saved - check your inbox". The onboarding step got
 * a green check mark. An hour and a half later a bounce arrived:
 *
 *   <app-review@example.com>: Domain example.com does not accept mail (nullMX)
 *
 * The bounce came to US, not to the merchant. From the app's point of view
 * everything was fine: onboarding complete, alerts "set up". Yet nothing
 * would ever be delivered to that address.
 *
 * This is the same class of failure the app detects for merchants (a silent
 * tracking outage), one level up: TrackGap would silently lose the ability
 * to speak up, and speaking up is the whole product. A dashboard nobody looks
 * at does not solve the problem (see alerts.mjs).
 *
 * We do not attempt SMTP ourselves (RCPT TO probe): most servers today accept
 * everything and reject only after acceptance, so it would give false
 * confidence. DNS, however, truthfully answers the one thing that can be
 * checked upfront: whether the domain ACCEPTS mail at all.
 */
import dns from "node:dns/promises";

/** Syntax. Deliberately looser than reality: strict RFC 5322 parsing would
 *  reject valid addresses, and we expect nothing more from syntax here. */
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Determines whether a domain accepts mail.
 *
 * Returns:
 *   { ok: true }                      - has MX or at least A/AAAA (implicit MX)
 *   { ok: false, reason, detail }     - the domain does not accept mail
 *   { ok: true, unknown: true }       - DNS failed for other reasons
 *
 * THE LAST CASE IS DELIBERATELY `ok`: a DNS outage on OUR side must not block
 * the merchant from setting up alerts. Better to accept an address we could
 * not verify than to reject a valid one.
 */
export async function checkMailDomain(email, { timeoutMs = 5000 } = {}) {
  if (!EMAIL_RE.test(email || "")) {
    return { ok: false, reason: "syntax", detail: "That does not look like an e-mail address." };
  }
  const domain = email.split("@").pop().toLowerCase();

  const withTimeout = (p) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error("dns timeout")), timeoutMs)),
  ]);

  try {
    const mx = await withTimeout(dns.resolveMx(domain));
    const usable = (mx || []).filter((r) => r.exchange && r.exchange !== ".");
    if (mx && mx.length && !usable.length) {
      // nullMX (RFC 7505): the domain EXPLICITLY states it accepts no mail.
      // This is exactly the example.com case.
      return {
        ok: false,
        reason: "null_mx",
        detail: `The domain ${domain} does not accept e-mail at all.`,
      };
    }
    if (usable.length) return { ok: true, mx: usable[0].exchange };
  } catch (e) {
    if (e.code === "ENOTFOUND" || e.code === "ENODATA") {
      // No MX means nothing yet: RFC 5321 allows delivery to the A record.
      try {
        const a = await withTimeout(dns.resolve4(domain));
        if (a?.length) return { ok: true, mx: null };
      } catch { /* try AAAA as well */ }
      try {
        const a6 = await withTimeout(dns.resolve6(domain));
        if (a6?.length) return { ok: true, mx: null };
      } catch { /* fall through below */ }
      if (e.code === "ENOTFOUND") {
        return {
          ok: false,
          reason: "no_domain",
          detail: `The domain ${domain} does not exist. Check it for typos.`,
        };
      }
      return {
        ok: false,
        reason: "no_mx",
        detail: `The domain ${domain} has no mail server, so nothing can be delivered there.`,
      };
    }
    return { ok: true, unknown: true, detail: e.message };
  }
  return { ok: true, unknown: true };
}
