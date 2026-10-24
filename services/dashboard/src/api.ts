// Every call the dashboard makes to the gateway's REST API (/api/*), with the shapes it returns.
//
// The browser authenticates with the HttpOnly session cookie the gateway set at login; JavaScript never
// sees it. No API keys or upstream credentials are ever stored in the browser.

export type Role = "admin" | "member";
export type Me = { id: number; email: string; name: string; role: Role; mcpUrl: string; chatEnabled: boolean };

export type Server = {
  id: number;
  name: string;
  url: string;
  authType: "none" | "bearer" | "header";
  authHeader: string | null;
  hasCredential: boolean;        // the credential itself is never sent to the browser
  enabled: boolean;
  timeoutMs: number;
  status: "connected" | "unreachable" | "disabled";
  error: string | null;
  checkedAt: string | null;
  skippedTools: string[];
  tools: { name: string; tool: string; description: string; minRole: Role; overridden: boolean }[];
};

export type ServerInput = {
  name?: string;
  url?: string;
  authType?: Server["authType"];
  authHeader?: string;
  credential?: string;           // omitted = keep, "" = remove, text = replace
  enabled?: boolean;
  timeoutMs?: number;
};

export type Member = { id: number; email: string; name: string; role: Role; created_at: string; status: "active" | "invited"; active_keys: number };
export type ApiKey = { id: number; name: string; prefix: string; created_at: string; last_used_at: string | null; revoked_at: string | null; user_email: string };
export type AuditRow = {
  id: number; ts: string; user_email: string | null; source: "mcp" | "chat"; server_name: string | null; tool: string;
  duration_ms: number | null; outcome: "success" | "tool_error" | "error" | "denied"; error: string | null;
};
export type ChatMessage = { role: "user" | "assistant"; text: string };
export type ToolCall = { tool: string; args: Record<string, unknown>; ok: boolean; result: string; durationMs: number };

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `Request failed (HTTP ${res.status})`, res.status);
  return data as T;
}

export const api = {
  me: () => request<Me>("GET", "/auth/me"),
  login: (email: string, password: string) => request<{ ok: true }>("POST", "/auth/login", { email, password }),
  logout: () => request<{ ok: true }>("POST", "/auth/logout"),
  acceptInvite: (token: string, name: string, password: string) => request<{ ok: true }>("POST", "/auth/accept-invite", { token, name, password }),

  servers: () => request<Server[]>("GET", "/servers"),
  addServer: (input: ServerInput) => request<Server>("POST", "/servers", input),
  updateServer: (id: number, input: ServerInput) => request<Server>("PATCH", `/servers/${id}`, input),
  deleteServer: (id: number) => request<{ ok: true }>("DELETE", `/servers/${id}`),
  refreshServer: (id: number) => request<Server>("POST", `/servers/${id}/refresh`),
  setToolPolicy: (id: number, tool: string, minRole: Role | "default") =>
    request<Server>("POST", `/servers/${id}/tools/${encodeURIComponent(tool)}/policy`, { minRole }),

  members: () => request<Member[]>("GET", "/users"),
  invite: (email: string, role: Role) => request<{ inviteUrl: string }>("POST", "/users/invite", { email, role }),
  setRole: (id: number, role: Role) => request<{ ok: true }>("PATCH", `/users/${id}`, { role }),
  removeMember: (id: number) => request<{ ok: true }>("DELETE", `/users/${id}`),

  keys: (all = false) => request<ApiKey[]>("GET", `/keys${all ? "?all=1" : ""}`),
  createKey: (name: string) => request<{ key: string; prefix: string; mcpUrl: string }>("POST", "/keys", { name }),
  revokeKey: (id: number) => request<{ ok: true }>("POST", `/keys/${id}/revoke`),

  audit: (filters: Record<string, string>) => request<AuditRow[]>("GET", `/audit?${new URLSearchParams({ limit: "300", ...filters })}`),

  chat: (messages: ChatMessage[]) => request<{ reply: string; toolCalls: ToolCall[] }>("POST", "/chat", { messages }),
};
