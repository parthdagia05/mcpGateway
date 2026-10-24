// Gateway entry point. One process, two faces:
//
//   /mcp      MCP endpoint for MCP clients (API key auth)           → mcp.ts
//   /api/*    REST API for the React dashboard (session cookie)     → api.ts
//   /healthz  liveness: the process is up
//   /readyz   readiness: the process is up AND Postgres answers (without the DB we can't check keys)
//
// Startup order: wait for Postgres → create tables → seed admin + servers → connect to upstreams → listen for changes → serve.

import express, { type NextFunction, type Request, type Response } from "express";
import { api } from "./api.js";
import { requireApiKey } from "./auth.js";
import { config } from "./config.js";
import { listenForServerChanges, migrate, pool, waitForDatabase } from "./db.js";
import { handleMcp } from "./mcp.js";
import { seed } from "./seed.js";
import { upstreams } from "./upstreams.js";

async function main() {
  await waitForDatabase();
  await migrate();
  await seed();
  await upstreams.start();
  // Another replica changed a server → reload ours too.
  await listenForServerChanges(() => void upstreams.reload());

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // behind the ingress controller
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.get("/readyz", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false, error: "database unreachable" });
    }
  });

  // MCP endpoint. GET/DELETE are part of Streamable HTTP too (server-initiated streams, session end);
  // in stateless mode the SDK answers them with "method not allowed", which is what clients expect.
  app.all("/mcp", requireApiKey, handleMcp);

  app.use("/api", api);

  // Last-resort error handler: log the details, give the client a generic message (no stack traces).
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: "Internal error" });
  });

  const server = app.listen(config.port, () => console.log(`gateway listening on :${config.port} (MCP at ${config.mcpUrl})`));

  process.on("SIGTERM", () => {
    console.log("SIGTERM received, shutting down");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}

main().catch((err) => {
  console.error("gateway failed to start:", err);
  process.exit(1);
});
