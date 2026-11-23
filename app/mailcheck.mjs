/**
 * TrackGap — overenie, ci sa na adresu pre alerty DA vobec dorucit.
 *
 * PRECO TO VZNIKLO (1.9.2026, najdene v schranke):
 * Merchant zadal adresu, `/alerts/setup` ju vzal (staci mu regex `nieco@nieco.tld`),
 * Proton Bridge spravu PREVZAL a UI napisalo "Saved — check your inbox".
 * Onboarding krok dostal zelenu fajku. O hodinu a pol prisiel bounce:
 *
 *   <app-review@example.com>: Domain example.com does not accept mail (nullMX)
 *
 * Bounce prisiel NAM, nie merchantovi. Z pohladu appky bolo vsetko v poriadku:
 * onboarding dokonceny, alerty "nastavene". Pritom sa na tu adresu nikdy nic
 * nedoruci.
 *
 * To je ta ista trieda poruchy, ktoru appka riesi u merchanta — tichy vypadok
 * merania — len o poschodie vyssie: TrackGap by ticho prestal byt schopny
 * ozvat sa. A ozvat sa je cely produkt. Dashboard, na ktory sa nikto nepozera,
 * problem nevyriesi (alerts.mjs, prvy komentar).
 *
 * SMTP sa nesnazime robit sami (RCPT TO probe): vacsina serverov dnes prijme
 * vsetko a odmietne az po prevzati, takze by to dalo falosnu istotu. DNS ale
 * odpovie pravdivo na to jedine, co sa da overit dopredu: ci domena vobec
 * PRIJIMA postu.
 */
import dns from "node:dns/promises";

/** Syntax. Zamerne volnejsia nez realita — tvrde parsovanie RFC 5322 by
 *  odmietlo platne adresy, a od syntaxe si tu uz nic nesubujeme. */
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Zisti, ci domena prijima postu.
 *
 * Vracia:
 *   { ok: true }                      — ma MX alebo aspon A/AAAA (implicitne MX)
 *   { ok: false, reason, detail }     — domena postu neprijima
 *   { ok: true, unknown: true }       — DNS zlyhalo z inych dovodov
 *
 * POSLEDNY PRIPAD JE ZAMERNE `ok`: vypadok DNS na NASEJ strane nesmie
 * merchantovi zablokovat nastavenie alertov. Radsej prijmeme adresu, ktoru
 * sme nevedeli overit, nez by sme odmietli platnu.
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
      // nullMX (RFC 7505): domena VYSLOVNE hlasi, ze postu neprijima.
      // Presne tento pripad nas dostal — example.com.
      return {
        ok: false,
        reason: "null_mx",
        detail: `The domain ${domain} does not accept e-mail at all.`,
      };
    }
    if (usable.length) return { ok: true, mx: usable[0].exchange };
  } catch (e) {
    if (e.code === "ENOTFOUND" || e.code === "ENODATA") {
      // Ziadne MX este neznamena nic — RFC 5321 dovoluje dorucovat na A zaznam.
      try {
        const a = await withTimeout(dns.resolve4(domain));
        if (a?.length) return { ok: true, mx: null };
      } catch { /* skusime este AAAA */ }
      try {
        const a6 = await withTimeout(dns.resolve6(domain));
        if (a6?.length) return { ok: true, mx: null };
      } catch { /* padneme nizsie */ }
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
