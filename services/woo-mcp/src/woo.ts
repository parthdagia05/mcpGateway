// A tiny client for the WooCommerce REST API (v3).
//
// HOW WE AUTHENTICATE (and why it looks unusual):
// Inside the cluster we call WordPress over plain HTTP (http://urumi-wordpress). Over plain HTTP,
// WooCommerce refuses to accept the key + secret directly, because anyone sniffing the network could steal them.
// Instead it requires OAuth 1.0a "one-legged" signing:
//   - we send the consumer KEY, a timestamp, a random nonce, and a SIGNATURE in the query string
//   - the signature is an HMAC of the request (method + URL + params) made WITH the secret
//   - WooCommerce recomputes the same HMAC with its copy of the secret and compares
// So the secret itself never travels over the network, and a captured request can't be replayed
// (WooCommerce rejects a reused nonce, and timestamps older than 15 minutes).
//
// One catch: WooCommerce computes the signature against the store's PUBLIC home URL
// (e.g. http://store.localtest.me/wp-json/...), not the internal address we actually call.
// So we ask the store for its home URL once (GET /wp-json/) and sign against that.

import { createHmac, randomBytes } from "node:crypto";
import { config } from "./config.js";

/** Thrown for any failed store call. The message is safe to show to a user or model. */
export class WooError extends Error {}

type Query = Record<string, string | number | boolean | undefined>;

// RFC 3986 percent-encoding, which OAuth requires (encodeURIComponent leaves !'()* unencoded).
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

let signingBase: string | undefined; // e.g. "http://store.localtest.me", discovered once

/** The URL WooCommerce will use when it checks our signature: its home URL, always with http:// (we call it over http). */
async function getSigningBase(): Promise<string> {
  if (signingBase) return signingBase;
  const res = await fetchWithTimeout(`${config.storeUrl}/wp-json/`, { method: "GET" });
  if (!res.ok) throw new WooError(`Store is not answering correctly (GET /wp-json/ returned HTTP ${res.status})`);
  const info = (await res.json()) as { home?: string };
  if (!info.home) throw new WooError("Store did not report its home URL");
  const home = new URL(info.home);
  signingBase = `http://${home.host}${home.pathname.replace(/\/+$/, "")}`;
  return signingBase;
}

/** Adds oauth_* parameters (including the signature) to the query for one request. */
function signQuery(method: string, path: string, query: Query, base: string): URLSearchParams {
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(query)) if (v !== undefined) params[k] = String(v);

  params.oauth_consumer_key = config.consumerKey;
  params.oauth_timestamp = Math.floor(Date.now() / 1000).toString();
  params.oauth_nonce = randomBytes(16).toString("hex");
  params.oauth_signature_method = "HMAC-SHA256";

  // "Signature base string" = METHOD & encoded(URL) & encoded(sorted "key=value" pairs joined by &)
  const paramString = Object.keys(params)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(params[k])}`)
    .join("&");
  const baseString = [method.toUpperCase(), rfc3986(`${base}${path}`), rfc3986(paramString)].join("&");

  // WooCommerce's signing key is "<secret>&" (OAuth's consumer secret + empty token secret).
  params.oauth_signature = createHmac("sha256", `${config.consumerSecret}&`).update(baseString).digest("base64");
  return new URLSearchParams(params);
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(config.requestTimeoutMs) });
  } catch (err) {
    // Turn low-level network errors into a message a person (or the model) can act on.
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new WooError(`Store did not respond within ${config.requestTimeoutMs / 1000}s`);
    }
    throw new WooError(`Could not reach the store: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Calls one WooCommerce REST endpoint, e.g. woo("GET", "/orders", { status: "processing" }).
 * Returns the parsed JSON, or throws WooError with WooCommerce's own error message.
 */
export async function woo<T = unknown>(method: string, endpoint: string, query: Query = {}, body?: unknown): Promise<T> {
  const path = `/wp-json/wc/v3${endpoint}`;
  const qs = signQuery(method, path, query, await getSigningBase());

  const res = await fetchWithTimeout(`${config.storeUrl}${path}?${qs}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = (await res.json().catch(() => null)) as { message?: string } | null;
  if (!res.ok) {
    // WooCommerce errors look like { code, message, data: { status } }. Pass the message through.
    throw new WooError(`WooCommerce returned HTTP ${res.status}: ${data?.message ?? res.statusText}`);
  }
  return data as T;
}
