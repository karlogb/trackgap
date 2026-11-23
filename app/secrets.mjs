/**
 * TrackGap - configuration secrets.
 *
 * Two sources, in this order:
 *   1. JSON files in the TRACKGAP_SECRETS directory (default: ../.secrets next to app/)
 *      shopify.json, google.json, meta.json, smtp.json
 *   2. environment variables (see .env.example in the repository root)
 *
 * Secret paths live in one place so that moving to another server does not
 * break half of the integrations.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const SECRETS_DIR = process.env.TRACKGAP_SECRETS
  || path.join(APP_DIR, "..", ".secrets");

const env = (k) => (process.env[k] && process.env[k].trim()) || undefined;

/** Public URL of the app (without a trailing slash). */
export function appUrl() {
  return (env("TRACKGAP_APP_URL") || "https://trackgap.example.com").replace(/\/+$/, "");
}

/** Equivalent of the JSON files, built from environment variables. */
const FROM_ENV = {
  "shopify.json": () => env("SHOPIFY_API_KEY") && env("SHOPIFY_API_SECRET") && {
    client_id: env("SHOPIFY_API_KEY"),
    client_secret: env("SHOPIFY_API_SECRET"),
    app_url: appUrl(),
    scopes: env("SHOPIFY_SCOPES")
      || "read_orders,read_pixels,write_pixels,read_customer_events",
  },
  "google.json": () => env("GOOGLE_CLIENT_ID") && env("GOOGLE_CLIENT_SECRET") && {
    client_id: env("GOOGLE_CLIENT_ID"),
    client_secret: env("GOOGLE_CLIENT_SECRET"),
    token_uri: "https://oauth2.googleapis.com/token",
    redirect_uri: `${appUrl()}/ga4/callback`,
  },
  "meta.json": () => env("META_APP_ID") && env("META_APP_SECRET") && {
    app_id: env("META_APP_ID"),
    app_secret: env("META_APP_SECRET"),
    redirect_uri: `${appUrl()}/meta/callback`,
  },
};

export function secretPath(name) {
  return path.join(SECRETS_DIR, name);
}

/** Loads a secret from a file or env; returns null if it is not found anywhere. */
export function readSecret(name) {
  const p = secretPath(name);
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  return FROM_ENV[name]?.() || null;
}

/**
 * Path to the SMTP config (JSON: host, smtp_port, user, password).
 * If the file does not exist, alerts.mjs uses the SMTP_* env variables.
 */
export function smtpConfigPath() {
  if (process.env.TRACKGAP_SMTP_CONFIG) return process.env.TRACKGAP_SMTP_CONFIG;
  return secretPath("smtp.json");
}

/** SMTP config from env (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD). */
export function smtpConfigFromEnv() {
  if (!env("SMTP_HOST")) return null;
  return {
    host: env("SMTP_HOST"),
    smtp_port: Number(env("SMTP_PORT") || 587),
    user: env("SMTP_USER"),
    password: env("SMTP_PASSWORD"),
  };
}
