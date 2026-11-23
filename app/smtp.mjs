/**
 * TrackGap - minimal SMTP client.
 *
 * WHY A CUSTOM MODULE: the original client in alerts.mjs had two bugs that
 * would only show up in production, once an alert actually mattered:
 *
 *  1. It did NOT do STARTTLS. Proton Bridge on 127.0.0.1:1025 advertises it
 *     (`250-STARTTLS`) and refuses AUTH before it. The alert would never be sent.
 *  2. State advanced on every `data` event ending in CRLF. A multi-line
 *     reply (`250-PIPELINING\r\n250-8BITMIME\r\n...`) can be split across
 *     several TCP chunks -> the client skipped a step and sent a command out
 *     of order. Whether it worked depended on how the packet was split.
 *
 * Now the reply is collected in a buffer and considered complete only at a
 * line of the form `NNN<space>`, exactly as RFC 5321 defines it.
 */
import net from "node:net";
import tls from "node:tls";

const CRLF = "\r\n";

// Per RFC 6066, SNI must not be set to an IP address (Node reports it as a
// DeprecationWarning). No SNI is needed on loopback.
const isIp = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":");
const sni = (h) => (isIp(h) ? undefined : h);

/** Reads one complete SMTP reply from the socket. */
function readReply(sock, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (d) => {
      buf += d.toString("utf8");
      // the last COMPLETE line must have the form "NNN " (space, not hyphen)
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
 * Sends a line and waits for the reply. `expect` lists acceptable codes;
 * anything else is an error and throws with the full server text (without it
 * Bridge problems are very hard to debug).
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

/** RFC 5321: a line starting with a dot must be doubled in DATA. */
function dotStuff(body) {
  return body.split(CRLF).map((l) => (l.startsWith(".") ? "." + l : l)).join(CRLF);
}

/**
 * Sends one mail. Returns { ok: true } or throws.
 *
 * `cfg`: { host, port, user, pass, secure }  (secure = implicit TLS, e.g. 465)
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

    // STARTTLS if the server offers it and we are not encrypted yet.
    // Proton Bridge refuses AUTH without it.
    if (!cfg.secure && /STARTTLS/i.test(greet.text)) {
      await cmd(sock, "STARTTLS", [220], TIMEOUT);
      const plain = sock;
      sock = tls.connect({
        socket: plain,
        servername: sni(host),
        // Bridge uses its own local certificate on loopback; the chain cannot
        // be verified and the connection never leaves the machine anyway.
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
        throw new Error("smtp: server offers neither AUTH PLAIN nor LOGIN");
      }
    }

    // The envelope sender must be an address the account may use; for
    // Proton Bridge it is the login address. The displayed "From" can differ.
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
    try { await cmd(sock, "QUIT", [221], 5_000); } catch { /* ignored */ }
    return { ok: true };
  } finally {
    sock.destroy();
  }
}
