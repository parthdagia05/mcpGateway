// All settings come from environment variables, which Kubernetes fills from the Helm chart:
// plain settings from the Deployment's env, the API key from the "urumi-woo-api" Secret.
// Nothing secret is ever written in this source code.

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    // Fail fast at startup with a clear message, instead of failing on the first tool call.
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),

  // Where we SEND requests: the WordPress Service inside the cluster, e.g. http://urumi-wordpress
  storeUrl: required("WOO_STORE_URL").replace(/\/+$/, ""),

  // WooCommerce REST API key (registered in WooCommerce by the store's setup Job).
  consumerKey: required("WOO_CONSUMER_KEY"),
  consumerSecret: required("WOO_CONSUMER_SECRET"),

  // How long we wait for the store before giving up and returning a clear error.
  requestTimeoutMs: Number(process.env.WOO_TIMEOUT_MS ?? 10_000),

  // Used to work out what "today" means for list_orders (e.g. Asia/Kolkata).
  timezone: process.env.STORE_TIMEZONE ?? "UTC",

  // Optional bearer token callers must send. The gateway holds it as this server's "upstream credential",
  // so team members use the tools without ever seeing it. Empty = no token required.
  authToken: process.env.MCP_AUTH_TOKEN ?? "",
};
