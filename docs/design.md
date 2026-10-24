# System design and tradeoffs

## Components

| Component | Runs as | Responsibility |
|---|---|---|
| **wordpress** | Deployment (1), PVC for `/var/www/html` | Storefront and WooCommerce. Public through Ingress. |
| **mariadb** | StatefulSet (1), PVC | Store database. Internal only. |
| **store-setup** | Helm hook Job (post-install/upgrade) | Installs WordPress and WooCommerce, enables COD, sets permalinks, creates the shop pages and registers the REST API key for woo-mcp. Each step checks first, so it's safe to rerun. |
| **woo-mcp** | Deployment, stateless | My MCP server: 5 tools over Streamable HTTP, talks to WooCommerce's REST API. Internal only, and it requires a bearer token that only the gateway has. |
| **everything-mcp** | Deployment (1) | The official MCP reference server, used as a second in-cluster upstream. No Secrets mounted, no outbound network at all. |
| **deepwiki** | external | A public remote MCP server, the third upstream (registered by URL). |
| **gateway** | Deployment (2), stateless | The MCP endpoint `/mcp`, the dashboard's REST API `/api`, the chat agent, users, keys, roles and audit. |
| **postgres** | StatefulSet (1), PVC | Gateway data: users, sessions, API key hashes, servers (encrypted credentials), audit log. Internal only. |
| **dashboard** | Deployment, nginx (non-root) | Static React app. Same hostname as `/api`, so there's no CORS and the session cookie just works. |

Everything is in one namespace, `urumi`, installed by one umbrella chart with a subchart per component. One `helm upgrade` or `helm rollback` covers the whole system, and the local vs prod differences live in two values files.

## Architecture choices

- **TypeScript and the official MCP SDK** for both woo-mcp and the gateway. The SDK has a client and a server for Streamable HTTP, which the gateway needs both of.
- **The gateway is one process with two faces.** The MCP server on `/mcp` is built with the SDK's low-level `Server`, because the tool list is dynamic. The upstream manager holds one SDK `Client` per registered server. Keeping the REST API and chat in the same process means one auth model and one audit choke point.
- **Stateless MCP endpoint.** The gateway issues no `Mcp-Session-Id`, and every request carries its API key. Any replica can answer any request, which is why it runs 2 replicas without sticky sessions. Its upstream connections are per replica; they're cheap and rebuilt on demand.
- **Postgres** rather than SQLite, so more than one replica can share state. `LISTEN/NOTIFY` tells every replica to reload when an admin changes a server.
- **woo-mcp talks to the WooCommerce REST API** (not the DB, not WP-CLI). It goes through WooCommerce's own logic, stays stable across versions, and uses a limited, revocable key. Over in-cluster HTTP WooCommerce requires OAuth 1.0a signing, so the consumer secret never crosses the network.
- **The chat agent runs inside the gateway** and calls `upstreams.callTool(name, args, user, "chat")`: exactly the same routing, timeout and audit path as `/mcp`. It never talks to an upstream directly and needs no API key.
- **The LLM provider is configuration.** Any OpenAI-compatible API (Groq's free tier by default) or Gemini, chosen in Helm values. The key lives in a Secret created by hand.

## How a tool call travels

Example: Claude Code calls `woocommerce__list_orders` with `{"period":"today"}`.

1. **Client → Traefik → gateway:** `POST http://gateway.localtest.me/mcp` with `Authorization: Bearer mgw_…`, carrying a JSON-RPC `tools/call`. Traefik routes it by host to a gateway Pod.
2. **Gateway: who is this?** `requireApiKey` hashes the key with SHA-256 and looks it up with its user. It's rejected if unknown or revoked; a revoked key is still audited as `denied`.
3. **Gateway: routing.** It splits the name at the first `__` into server `woocommerce` and tool `list_orders`. It checks that the server exists, is enabled and is connected, and that it really has this tool. Otherwise it returns a tool error that explains why.
4. **Gateway → woo-mcp:** the call goes out on the gateway's existing MCP client connection to `http://urumi-woo-mcp:3000/mcp`, with **woo-mcp's own bearer token** (decrypted from Postgres in memory) and a per-server timeout (15s). The user's key is not forwarded.
5. **woo-mcp → WordPress:** `GET http://urumi-wordpress/wp-json/wc/v3/orders?after=…&dates_are_gmt=true&oauth_…&oauth_signature=…` (OAuth 1.0a, HMAC-SHA256). "Today" is computed in the store's timezone.
6. **WordPress → MariaDB → back:** WooCommerce queries MariaDB. woo-mcp trims the result to the useful fields and returns it as an MCP text result.
7. **Gateway → client:** the gateway writes an audit row (user, `mcp`, server, tool, duration, outcome) and returns the upstream's result unchanged.

The NetworkPolicies allow exactly these hops: Traefik → gateway → woo-mcp → wordpress → mariadb.

## Tool aggregation and name collisions

- **Every tool is exposed as `<server>__<tool>`.** Server names are unique, lowercase `[a-z][a-z0-9-]`, and can't contain `__`. So the first `__` always splits a name correctly, and two servers can both have an `echo` tool (`everything__echo`, `other__echo`).
- **Names must fit LLM tool-name rules.** Exposed names must match `[A-Za-z0-9_-]{1,64}`, which both OpenAI-style APIs and Gemini accept. A tool that doesn't fit is **skipped and listed on the server's card** rather than silently renamed, because a renamed tool would be confusing to call.
- **Descriptions get a `[server]` prefix** and are cut to 1024 characters. The chat agent cuts them further, to 300.
- **`tools/list` merges** the cached tool lists of every enabled, connected server. The cache is refreshed every 15s, and immediately when a server is added, edited, enabled or disabled.

## Failure handling

- **Every network step has a timeout:** connect, `tools/list` and `tools/call`, 15s by default and configurable per server. When a call times out, the SDK sends a cancel notification upstream, and the caller gets *"… did not answer within 15s, so the call was cancelled."*
- **Servers are checked independently and in parallel** (`Promise.allSettled`), so a slow or dead server never delays listing or calls to the others.
- **A call that fails at the connection level** marks that server `unreachable` straight away (its tools disappear from `tools/list`) and starts a reconnect. A background check every 15s reconnects it once it's back. If an upstream restarted and forgot our session, the gateway retries once with a fresh connection.
- **Errors are tool errors in plain words** (`isError: true`), never hangs or stack traces: "connection refused (is the server running?)", "host name could not be resolved", "server is disabled by an admin", "no tool called X". The dashboard shows the same reason next to `▼ down`.
- **The gateway waits for Postgres at startup** instead of crash-looping. Its readiness probe checks Postgres; liveness only checks the process. No liveness probe in the system checks a dependency, so a database blip can't cause a restart storm.

## The chat agent's tool loop

1. The browser sends the conversation (text only) to `POST /api/chat` with the session cookie, so the gateway knows the user.
2. The gateway sends the conversation plus the merged tool list, converted to the provider's function format, to the LLM.
3. If the model asks for tools, the gateway runs them (in parallel) through `upstreams.callTool` **as that user**, appends the results, and asks again.
4. The loop stops when the model answers in text, or after 8 rounds. The reply includes every tool call (name, args, ok, duration) for the UI.
5. On a free-tier rate limit (HTTP 429), the agent waits as long as the API asks (up to 30s) and retries.

## Kubernetes: public vs internal

| Reachable from outside (Ingress via Traefik) | Internal only |
|---|---|
| `store.<domain>` → wordpress | woo-mcp, everything-mcp |
| `dashboard.<domain>` → dashboard, `/api` → gateway | mariadb, postgres |
| `gateway.<domain>/mcp` → gateway | |

Three layers enforce this:

1. **Only those three hostnames have Ingress rules.** Everything else is a `ClusterIP` Service, which can't be reached from outside the cluster.
2. **A default-deny ingress NetworkPolicy for the namespace**, plus one narrow allow rule per component:
   - gateway ← Traefik
   - woo-mcp and everything-mcp ← gateway only
   - wordpress ← Traefik and woo-mcp
   - mariadb ← wordpress and the setup Job
   - postgres ← gateway
3. **Egress limits on the untrusted and sensitive Pods:**
   - woo-mcp may reach only DNS and WordPress.
   - everything-mcp may reach nothing.
   - The gateway may reach DNS, Postgres, the two in-cluster MCP servers, and the internet on 443 only, excluding private ranges and `169.254.0.0/16`.

k3s ships a network policy controller, so these are actually enforced, locally too.

Every workload has readiness and liveness probes plus requests and limits. Containers run non-root with a read-only root filesystem and all capabilities dropped. The exception is WordPress: the official Apache image binds port 80 as root, then runs PHP as `www-data`.

## Secrets

| Secret | Holds | Used by |
|---|---|---|
| `urumi-store` | MariaDB root and user passwords, WP admin password | mariadb, wordpress, setup Job |
| `urumi-woo-api` | WooCommerce REST consumer key and secret | setup Job (registers it), woo-mcp |
| `urumi-woo-mcp-token` | Bearer token woo-mcp requires | woo-mcp, gateway (seeds it, encrypted, as the upstream credential) |
| `urumi-gateway` | Postgres password, AES-256 encryption key, bootstrap admin password | postgres, gateway |
| `urumi-llm` | LLM API key (created by hand) | gateway |

- **The first four are generated by Helm on the first install.** Helm reads them back with `lookup` on every upgrade, because MariaDB and Postgres bake the password into their data on first start, and a changed Secret would lock the apps out.
- **They're marked `helm.sh/resource-policy: keep`**, like the PVCs.
- **Each Pod only gets the keys it needs** through `secretKeyRef`. woo-mcp, for example, can't read the database passwords.

## What changes for production

The chart is the same. `values-prod.yaml` overrides only:

| | Local (`values-local.yaml`) | VPS (`values-prod.yaml`) |
|---|---|---|
| **DNS / hosts** | `*.localtest.me` → 127.0.0.1, k3d maps port 80 | `store.`, `dashboard.`, `gateway.<domain>` A records → VPS IP (or `nip.io`) |
| **Ingress** | Traefik (built into k3d) | Traefik (built into k3s), same `ingressClassName` |
| **TLS** | off | cert-manager + Let's Encrypt via `global.ingressAnnotations`; `scheme: https` makes site URLs, invite links and the MCP URL https, and turns on Secure cookies |
| **Images** | built locally, `k3d image import` | `ghcr.io/…` (`make push`), or imported into k3s containerd |
| **Storage class** | `local-path` | `local-path` (k3s) with bigger volumes; a cloud block-storage class if available |
| **Secrets** | generated by Helm, kept | same; the LLM key is created by hand. For a team I'd move to Sealed Secrets or External Secrets so they can live in Git safely |
| **Replicas / resources** | gateway ×2 | gateway ×2, woo-mcp ×2, more memory for MariaDB and WordPress |

## Tradeoffs I made

- **One namespace for everything.** It's simpler and fits one Helm release; label-based NetworkPolicies give the isolation. A multi-store setup would use a namespace per store.
- **Tool lists are cached and polled every 15s**, rather than relying on `listChanged` notifications. That's simpler and works with every upstream, but a newly added upstream tool can take up to 15s to show up.
- **Upstream calls aren't retried automatically**, because a retried `create_product` could create two products. Only connection setup and listing are retried.
- **One MariaDB and one Postgres replica, with no backups.** That's fine for the assignment; production would add backups or a managed database.
- **API keys are hashed with SHA-256, not a slow hash.** The keys are 32 random bytes, so they can't be guessed, and a fast lookup by hash keeps per-request auth cheap. Passwords use scrypt.
- **Members can see every enabled server's tools.** Per-role tool permissions (stand-out item 2) aren't implemented.
