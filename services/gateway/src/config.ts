// Gateway settings, all from environment variables (filled by the Helm chart from values + Secrets).
// No secret is ever written in this source code.

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

/** One upstream to register automatically on the very first start (see seed.ts). */
export type SeedServer = {
  name: string;
  url: string;
  authType?: "none" | "bearer" | "header";
  authHeader?: string;
  /** Name of an env var holding the credential, so the value itself comes from a Secret, not from values.yaml. */
  secretEnv?: string;
};

export const config = {
  port: Number(process.env.PORT ?? 3000),

  databaseUrl: required("DATABASE_URL"),

  // 32-byte key (base64) used to encrypt upstream credentials before they are stored in Postgres.
  encryptionKey: Buffer.from(required("ENCRYPTION_KEY"), "base64"),

  // First admin account, created on first start if no users exist yet.
  bootstrapAdminEmail: process.env.BOOTSTRAP_ADMIN_EMAIL ?? "admin@urumi.local",
  bootstrapAdminPassword: required("BOOTSTRAP_ADMIN_PASSWORD"),

  // Upstreams registered on first start (JSON list of SeedServer). Only ever applied once.
  seedServers: JSON.parse(process.env.SEED_SERVERS ?? "[]") as SeedServer[],

  // Public URL of the dashboard (used to build invite links) and of the MCP endpoint (shown to users).
  dashboardUrl: process.env.DASHBOARD_URL ?? "http://dashboard.localtest.me",
  mcpUrl: process.env.MCP_PUBLIC_URL ?? "http://gateway.localtest.me/mcp",

  // How often every upstream is re-checked (status + tool list), and default per-call timeout.
  refreshIntervalMs: Number(process.env.REFRESH_INTERVAL_MS ?? 15_000),
  defaultTimeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS ?? 15_000),

  // Set to "true" when served over HTTPS so session cookies get the Secure flag.
  secureCookies: process.env.SECURE_COOKIES === "true",

  // Chat agent. Empty key = chat is switched off, everything else still works.
  //   provider "openai": any OpenAI-compatible API (Groq by default); "gemini": Google Gemini.
  llmProvider: (process.env.LLM_PROVIDER ?? "openai") as "openai" | "gemini",
  llmBaseUrl: process.env.LLM_BASE_URL ?? "https://api.groq.com/openai/v1",
  llmModel: process.env.LLM_MODEL ?? "openai/gpt-oss-120b",
  llmApiKey: process.env.LLM_API_KEY ?? "",

  // Shown to the chat model as "the current time", so "today" means the same day as in the store.
  timezone: process.env.TIMEZONE ?? "UTC",
};

if (config.encryptionKey.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes, base64-encoded");
