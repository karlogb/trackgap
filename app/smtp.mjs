/**
 * TrackGap — minimalny SMTP klient.
 *
 * PRECO VLASTNY MODUL: povodny klient v alerts.mjs mal dve chyby, ktore by
 * sa prejavili az v produkcii, ked by uz na alerte zalezalo (31.8.2026):
 *
 *  1. NEROBIL STARTTLS. Proton Bridge na 127.0.0.1:1025 ho inzeruje
 *     (`250-STARTTLS`) a AUTH pred nim odmieta. Alert by teda nikdy neodisiel.
 *  2. Stav sa posuval na kazdom `data` evente, ktory konci CRLF. Viacriadkova
 *     odpoved (`250-PIPELINING\r\n250-8BITMIME\r\n...`) sa da rozdelit do
 *     viacerych TCP chunkov -> klient preskocil krok a poslal prikaz mimo
 *     poradia. Fungovalo to nahodne, podla toho, ako sa paket rozsekol.
 *
 * Teraz sa odpoved zbiera do buffra a za dokoncenu sa povazuje az riadok
 * v tvare `NNN<medzera>` — presne ako to definuje RFC 5321.
 */
import net from "node:net";
import tls from "node:tls";

const CRLF = "\r\n";

// SNI sa podla RFC 6066 nesmie nastavit na IP adresu (Node to hlasi ako
// DeprecationWarning). Na loopbacku ziadne SNI netreba.
const isIp = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":");
const sni = (h) => (isIp(h) ? undefined : h);

/** Precita jednu kompletnu SMTP odpoved zo socketu. */
function readReply(sock, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (d) => {
      buf += d.toString("utf8");
      // posledny UKONCENY riadok musi mat tvar "NNN " (medzera, nie pomlcka)
      const lines = buf.split(CRLF);
      const last = lines[lines.length - 1] === "" ? lines[lines.length - 2] : null;
      if (last && /^\d{3} /.test(last)) {
        cleanup();
        resolve({ code: parseInt(last.slice(0, 3), 10), text: buf.trim() });
      }
    };
    const onErr = (e) => { cleanup(); reject(e); };
    const onEnd = () => { cleanup(); reject(new Error("smtp: connection closed")); };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("smtp: timeout waiting for reply"));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      sock.removeListener("data", onData);
      sock.removeListener("error", onErr);
      sock.removeListener("end", onEnd);
    }

    sock.on("data", onData);
    sock.on("error", onErr);
    sock.on("end", onEnd);
  });
}

/**
 * Posle riadok a pocka na odpoved. `expect` je zoznam kodov, ktore su v poriadku;
 * cokolvek ine je chyba a vyhodi vynimku s celym textom od servera (bez neho
 * sa problemy s Bridge ladia velmi zle).
 */
async function cmd(sock, line, expect, timeoutMs, redact = false) {
  if (line !== null) sock.write(line + CRLF);
  const r = await readReply(sock, timeoutMs);
  if (!expect.includes(r.code)) {
    const what = redact ? "<redacted>" : line;
    throw new Error(`smtp: "${what}" -> ${r.text.slice(0, 200)}`);
  }
  return r;
}

/** RFC 5321: riadok zacinajuci bodkou sa v DATA musi zdvojit. */
function dotStuff(body) {
  return body.split(CRLF).map((l) => (l.startsWith(".") ? "." + l : l)).join(CRLF);
}

/**
 * Odosle jeden mail. Vracia { ok: true } alebo hodi vynimku.
 *
 * `cfg`: { host, port, user, pass, secure }  (secure = implicitne TLS, napr. 465)
 */
export async function sendMail(cfg, { from, to, subject, text, replyTo }) {
  const TIMEOUT = 30_000;
  const host = cfg.host || "127.0.0.1";
  const port = Number(cfg.port || 1025);

  let sock = cfg.secure
    ? tls.connect({ host, port, servername: sni(host), rejectUnauthorized: false })
    : net.createConnection({ host, port });

  sock.setTimeout(TIMEOUT);
  sock.on("timeout", () => sock.destroy(new Error("smtp: socket timeout")));

  try {
    await new Promise((resolve, reject) => {
      sock.once(cfg.secure ? "secureConnect" : "connect", resolve);
      sock.once("error", reject);
    });

    await cmd(sock, null, [220], TIMEOUT);                     // banner
    let greet = await cmd(sock, `EHLO ${cfg.helo || "localhost"}`, [250], TIMEOUT);

    // STARTTLS, ak ho server ponuka a este nie sme sifrovani.
    // Proton Bridge bez neho odmietne AUTH.
    if (!cfg.secure && /STARTTLS/i.test(greet.text)) {
      await cmd(sock, "STARTTLS", [220], TIMEOUT);
      const plain = sock;
      sock = tls.connect({
        socket: plain,
        servername: sni(host),
        // Bridge pouziva vlastny lokalny certifikat na loopbacku; retazec sa
        // overit neda a spojenie aj tak neopusti stroj.
        rejectUnauthorized: false,
      });
      sock.setTimeout(TIMEOUT);
      sock.on("timeout", () => sock.destroy(new Error("smtp: socket timeout")));
      await new Promise((resolve, reject) => {
        sock.once("secureConnect", resolve);
        sock.once("error", reject);
      });
      greet = await cmd(sock, `EHLO ${cfg.helo || "localhost"}`, [250], TIMEOUT);
    }

    if (cfg.user && cfg.pass) {
      if (/AUTH[ -=].*PLAIN/i.test(greet.text)) {
        const a = Buffer.from(`\0${cfg.user}\0${cfg.pass}`).toString("base64");
        await cmd(sock, `AUTH PLAIN ${a}`, [235], TIMEOUT, true);
      } else if (/AUTH[ -=].*LOGIN/i.test(greet.text)) {
        await cmd(sock, "AUTH LOGIN", [334], TIMEOUT);
        await cmd(sock, Buffer.from(cfg.user).toString("base64"), [334], TIMEOUT, true);
        await cmd(sock, Buffer.from(cfg.pass).toString("base64"), [235], TIMEOUT, true);
      } else {
        throw new Error("smtp: server neponuka AUTH PLAIN ani LOGIN");
      }
    }

    // Envelope sender musi byt adresa, ktoru ma ucet pravo pouzit — pri
    // Proton Bridge je to prihlasovacia adresa. Zobrazene "From" moze byt ine.
    const envelopeFrom = cfg.envelopeFrom || cfg.user;
    await cmd(sock, `MAIL FROM:<${envelopeFrom}>`, [250], TIMEOUT);
    await cmd(sock, `RCPT TO:<${to}>`, [250, 251], TIMEOUT);
    await cmd(sock, "DATA", [354], TIMEOUT);

    const headers = [
      `From: ${from}`,
      `To: ${to}`,
      replyTo ? `Reply-To: ${replyTo}` : null,
      `Subject: ${subject}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@${cfg.helo || "localhost"}>`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "Auto-Submitted: auto-generated",
    ].filter(Boolean).join(CRLF);

    sock.write(headers + CRLF + CRLF + dotStuff(text.replace(/\n/g, CRLF)) + CRLF);
    await cmd(sock, ".", [250], 60_000);
    try { await cmd(sock, "QUIT", [221], 5_000); } catch { /* nezaujima */ }
    return { ok: true };
  } finally {
    sock.destroy();
  }
}
