// First-start setup, so a fresh install is usable without clicking anything:
//   1. If there are no users yet, create the bootstrap admin (password from a Kubernetes Secret).
//   2. The first time ever, register the upstream servers listed in SEED_SERVERS
//      (WooCommerce first, so admins "see the WooCommerce MCP server already registered").
// Step 2 runs only once (remembered in the meta table), so a server an admin deleted doesn't come back on restart.
// An advisory lock makes this safe when several gateway replicas start at the same moment.

import { config } from "./config.js";
import { pool } from "./db.js";
import { encrypt, hashPassword } from "./security.js";

export async function seed() {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(424243)");

    const { rows: users } = await client.query("SELECT count(*)::int AS n FROM users");
    if (users[0].n === 0) {
      await client.query("INSERT INTO users (email, name, role, password_hash) VALUES ($1, 'Admin', 'admin', $2)", [
        config.bootstrapAdminEmail.toLowerCase(),
        await hashPassword(config.bootstrapAdminPassword),
      ]);
      console.log(`created bootstrap admin ${config.bootstrapAdminEmail}`);
    }

    const { rows: seeded } = await client.query("SELECT 1 FROM meta WHERE key = 'servers_seeded'");
    if (!seeded[0]) {
      for (const s of config.seedServers) {
        const secret = s.secretEnv ? process.env[s.secretEnv] : undefined;
        if (s.secretEnv && !secret) console.warn(`seed server ${s.name}: env ${s.secretEnv} is empty, registering without a credential`);
        await client.query(
          `INSERT INTO servers (name, url, auth_type, auth_header, auth_secret_enc, timeout_ms)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (name) DO NOTHING`,
          [s.name, s.url, secret ? (s.authType ?? "bearer") : "none", s.authHeader ?? null, secret ? encrypt(secret) : null, config.defaultTimeoutMs],
        );
        console.log(`registered seed server ${s.name} → ${s.url}`);
      }
      await client.query("INSERT INTO meta (key, value) VALUES ('servers_seeded', now()::text)");
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(424243)").catch(() => {});
    client.release();
  }
}
