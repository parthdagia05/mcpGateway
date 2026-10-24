// Registered upstream MCP servers: live status, tools, and (admins) add / edit / disable / remove.
// Status is polled every 5s, so killing a server's Pod shows up here as "▼ down" without a reload.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api, type Me, type Server, type ServerInput } from "../api";
import { CopyField, Drawer, Empty, ErrorNotice, PageHead, ServerStatus, SkeletonRows, timeAgo, useTicker } from "../components/ui";

export function Servers({ me }: { me: Me }) {
  useTicker();
  const isAdmin = me.role === "admin";
  const servers = useQuery({ queryKey: ["servers"], queryFn: api.servers, refetchInterval: 5_000 });
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<Server | "new" | null>(null);

  const list = servers.data ?? [];
  const up = list.filter((s) => s.status === "connected");
  const toolCount = up.reduce((n, s) => n + s.tools.length, 0);

  const toggle = (id: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="page">
      <PageHead
        title="servers"
        actions={isAdmin && <button className="btn primary" onClick={() => setEditing("new")}>+ add server</button>}
      >
        Upstream MCP servers behind the gateway. Their tools are exposed as <code>server__tool</code> through one endpoint.
      </PageHead>

      <div className="summary">
        <span><b>{up.length}/{list.length}</b>up</span>
        <span><b>{toolCount}</b>tools exposed</span>
        <span><b>{list.filter((s) => s.status === "unreachable").length}</b>down</span>
        <span><b>{list.filter((s) => !s.enabled).length}</b>disabled</span>
      </div>

      <div className="panel" style={{ marginBottom: 20 }}>
        <div className="panel-body" style={{ padding: "10px 12px" }}>
          <CopyField value={me.mcpUrl} label="your MCP endpoint (use it with your API key from [api keys])" />
        </div>
      </div>

      <ErrorNotice error={servers.error} />
      {servers.isPending && <SkeletonRows rows={4} />}
      {servers.isSuccess && list.length === 0 && (
        <Empty title="No servers yet">{isAdmin ? "Add one with “+ add server”." : "An admin hasn't registered any servers."}</Empty>
      )}

      {list.map((s) => (
        <ServerCard key={s.id} server={s} open={open.has(s.id)} onToggle={() => toggle(s.id)} isAdmin={isAdmin} onEdit={() => setEditing(s)} />
      ))}

      {editing && <ServerForm server={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function ServerCard({ server: s, open, onToggle, isAdmin, onEdit }: { server: Server; open: boolean; onToggle: () => void; isAdmin: boolean; onEdit: () => void }) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["servers"] });
  const check = useMutation({ mutationFn: () => api.refreshServer(s.id), onSettled: refresh });
  const toggleEnabled = useMutation({ mutationFn: () => api.updateServer(s.id, { enabled: !s.enabled }), onSettled: refresh });
  const remove = useMutation({ mutationFn: () => api.deleteServer(s.id), onSettled: refresh });

  return (
    <div className={`server ${open ? "open" : ""} ${s.enabled ? "" : "is-off"}`}>
      <div className="server-row" onClick={onToggle} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onToggle()}>
        <span className="caret">▸</span>
        <span className="server-name">{s.name}</span>
        <ServerStatus status={s.status} />
        <span className="server-url">{s.url}</span>
        <span className="server-meta">
          <span>{s.status === "connected" ? `${s.tools.length} tools` : "—"}</span>
          <span>{s.hasCredential ? `auth:${s.authType}` : "no auth"}</span>
          <span title={s.checkedAt ?? ""}>checked {timeAgo(s.checkedAt)}</span>
        </span>
      </div>
      {s.status === "unreachable" && s.error && <div className="server-error">{s.error}</div>}

      {open && (
        <div className="server-detail">
          <div className="bar">
            <span className="facts">
              <span>auth: {s.authType === "none" ? "none" : s.authType === "bearer" ? "bearer token" : `header ${s.authHeader}`}{s.hasCredential && " (set, hidden)"}</span>
              <span>timeout: {s.timeoutMs / 1000}s</span>
            </span>
            {isAdmin && (
              <>
                <button className="btn sm" onClick={() => check.mutate()} disabled={check.isPending}>{check.isPending ? "checking…" : "check now"}</button>
                <button className="btn sm" onClick={onEdit}>edit</button>
                <button className="btn sm" onClick={() => toggleEnabled.mutate()} disabled={toggleEnabled.isPending}>{s.enabled ? "disable" : "enable"}</button>
                <button
                  className="btn sm danger"
                  disabled={remove.isPending}
                  onClick={() => confirm(`Remove "${s.name}"? Its tools disappear for everyone immediately.`) && remove.mutate()}
                >
                  remove
                </button>
              </>
            )}
          </div>
          <ErrorNotice error={check.error || toggleEnabled.error || remove.error} />
          {s.status !== "connected" ? (
            <div className="muted" style={{ color: "var(--text-dim)" }}>
              {s.status === "disabled" ? "Disabled: its tools are hidden from every client and the chat agent." : "No tools while the server is unreachable."}
            </div>
          ) : (
            s.tools.map((t) => (
              <div className="tool" key={t.name}>
                <code>{t.name}</code>
                <span title={t.description}>{t.description || "—"}</span>
                <ToolAccess serverId={s.id} tool={t} isAdmin={isAdmin} />
              </div>
            ))
          )}
          {s.skippedTools.length > 0 && (
            <div className="notice warn" style={{ marginTop: 10, marginBottom: 0 }}>
              <b>{s.skippedTools.length} tool(s) not exposed</b> because their names don't fit <code>[A-Za-z0-9_-]</code> ≤ 64 chars: {s.skippedTools.join(", ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Who may use one tool. Members see a lock on admin-only tools (they're hidden from their MCP tool list).
 * Admins click to switch between "members" and "admins only"; "default" means it follows the tool's own
 * MCP annotations (write/destructive tools → admins only), shown with no "*".
 */
function ToolAccess({ serverId, tool, isAdmin }: { serverId: number; tool: Server["tools"][number]; isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const set = useMutation({
    mutationFn: (minRole: "member" | "admin" | "default") => api.setToolPolicy(serverId, tool.tool, minRole),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["servers"] }),
  });
  const adminOnly = tool.minRole === "admin";
  const label = adminOnly ? "admins only" : "members";
  if (!isAdmin) return adminOnly ? <span className="tag amber access">admins only</span> : <span className="access" />;
  return (
    <span className="access">
      <button
        className={`tag ${adminOnly ? "amber" : "green"} access-toggle`}
        disabled={set.isPending}
        title={`Click to make it ${adminOnly ? "available to members" : "admins only"}`}
        onClick={() => set.mutate(adminOnly ? "member" : "admin")}
      >
        {label}{tool.overridden && " *"}
      </button>
      {tool.overridden && (
        <button className="btn ghost sm" title="Back to the default from the tool's annotations" disabled={set.isPending} onClick={() => set.mutate("default")}>
          reset
        </button>
      )}
    </span>
  );
}

/** Add or edit a server. The credential field is write-only: it never shows the stored value. */
function ServerForm({ server, onClose }: { server: Server | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(server?.name ?? "");
  const [url, setUrl] = useState(server?.url ?? "");
  const [authType, setAuthType] = useState<Server["authType"]>(server?.authType ?? "none");
  const [authHeader, setAuthHeader] = useState(server?.authHeader ?? "");
  const [credential, setCredential] = useState("");
  const [replaceCredential, setReplaceCredential] = useState(!server?.hasCredential);
  const [timeout, setTimeoutS] = useState(String((server?.timeoutMs ?? 15000) / 1000));
  const [enabled, setEnabled] = useState(server?.enabled ?? true);

  const save = useMutation({
    mutationFn: () => {
      const input: ServerInput = { name, url, authType, enabled, timeoutMs: Math.round(Number(timeout) * 1000) };
      if (authType === "header") input.authHeader = authHeader;
      if (authType === "none") input.credential = "";
      else if (replaceCredential) input.credential = credential;
      return server ? api.updateServer(server.id, input) : api.addServer(input);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["servers"] });
      onClose();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <Drawer
      title={server ? `edit ${server.name}` : "add server"}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" type="button" onClick={onClose}>cancel</button>
          <button className="btn primary" form="server-form" disabled={save.isPending}>{save.isPending ? "connecting…" : server ? "save" : "add server"}</button>
        </>
      }
    >
      <form id="server-form" onSubmit={submit}>
        <ErrorNotice error={save.error} />
        <label className="field">
          <span>name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="e.g. crm" required autoFocus={!server} />
          <small>Prefix for its tools: <code>{name || "name"}__tool</code>. Lowercase letters, digits and “-”.</small>
        </label>
        <label className="field">
          <span>url (streamable http)</span>
          <input className="input" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" required />
        </label>
        <div className="row">
          <label className="field">
            <span>auth</span>
            <select className="select" value={authType} onChange={(e) => setAuthType(e.target.value as Server["authType"])}>
              <option value="none">none</option>
              <option value="bearer">bearer token</option>
              <option value="header">custom header</option>
            </select>
          </label>
          <label className="field">
            <span>timeout (seconds)</span>
            <input className="input" type="number" min={1} max={120} value={timeout} onChange={(e) => setTimeoutS(e.target.value)} />
          </label>
        </div>
        {authType === "header" && (
          <label className="field">
            <span>header name</span>
            <input className="input" value={authHeader} onChange={(e) => setAuthHeader(e.target.value)} placeholder="X-API-Key" required />
          </label>
        )}
        {authType !== "none" && (
          <label className="field">
            <span>credential</span>
            {replaceCredential ? (
              <input className="input" type="password" autoComplete="off" value={credential} onChange={(e) => setCredential(e.target.value)} placeholder={authType === "bearer" ? "token" : "header value"} required={!server?.hasCredential} />
            ) : (
              <div className="copy">
                <code>•••••••••••• stored, encrypted</code>
                <button type="button" className="btn sm" onClick={() => setReplaceCredential(true)}>replace</button>
              </div>
            )}
            <small>Write-only. Stored encrypted on the gateway; never shown again, never sent to clients.</small>
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> enabled (tools visible to everyone)
        </label>
      </form>
    </Drawer>
  );
}
