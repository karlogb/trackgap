/**
 * Shared setup for `node --test`.
 *
 * Tests must not touch real secrets: TRACKGAP_SECRETS points to a
 * non-existent directory and the Shopify/Google config is built from dummy env.
 */
import os from "node:os";
import path from "node:path";

process.env.TRACKGAP_SECRETS ??= path.join(os.tmpdir(), "trackgap-no-secrets");
process.env.SHOPIFY_API_KEY ??= "test-client-id";
process.env.SHOPIFY_API_SECRET ??= "test-client-secret";
process.env.TRACKGAP_APP_URL ??= "https://trackgap.example.com";
process.env.GOOGLE_CLIENT_ID ??= "test-google-client-id";
process.env.GOOGLE_CLIENT_SECRET ??= "test-google-client-secret";
