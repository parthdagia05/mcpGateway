// The audit log: every tool call, from MCP clients and the chat agent alike.
// Admins see everyone's calls; members only their own (enforced by the gateway, not just hidden here).
// "live" polls every 3s so calls show up while you demo them.

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type AuditRow, type Me } from "../api";
import { Empty, ErrorNotice, PageHead, SkeletonRows, clock, day } from "../components/ui";

const OUTCOME_TAG: Record<AuditRow["outcome"], string> = {
  success: "green",
  tool_error: "amber",
  error: "red",
  denied: "red",
};

export function Audit({ me }: { me: Me }) {
  const isAdmin = me.role === "admin";
  const [live, setLive] = useState(true);
  const [user, setUser] = useState("");
  const [server, setServer] = useState("");
  const [outcome, setOutcome] = useState("");

  const filters: Record<string, string> = {};
  if (user) filters.user = user;
  if (server) filters.server = server;
  if (outcome) filters.outcome = outcome;

  const audit = useQuery({ queryKey: ["audit", filters], queryFn: () => api.audit(filters), refetchInterval: live ? 3_000 : false });
  // Options for the filter dropdowns, from an unfiltered view of what's in the log.
  const all = useQuery({ queryKey: ["audit-options"], queryFn: () => api.audit({}), staleTime: 15_000 });
  const users = [...new Set((all.data ?? []).map((r) => r.user_email).filter(Boolean))] as string[];
  const servers = [...new Set((all.data ?? []).map((r) => r.server_name).filter(Boolean))] as string[];

  const rows = audit.data ?? [];
  const failures = rows.filter((r) => r.outcome !== "success").length;

  return (
    <div className="page">
      <PageHead title="audit">
        Every tool call through the gateway: who, which server and tool, when, how long, and the outcome.
        {!isAdmin && " You're seeing your own calls."}
      </PageHead>

      <div className="filters">
        {isAdmin && (
          <select className="select" value={user} onChange={(e) => setUser(e.target.value)}>
            <option value="">all users</option>
            {users.map((u) => <option key={u}>{u}</option>)}
          </select>
        )}
        <select className="select" value={server} onChange={(e) => setServer(e.target.value)}>
          <option value="">all servers</option>
          {servers.map((s) => <option key={s}>{s}</option>)}
        </select>
        <select className="select" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
          <option value="">all outcomes</option>
          <option value="success">success</option>
          <option value="tool_error">tool_error</option>
          <option value="error">error</option>
          <option value="denied">denied</option>
        </select>
        <span style={{ color: "var(--text-dim)", marginLeft: 8 }}>{rows.length} calls · {failures} not successful</span>
        <button className={`btn ghost sm live ${live ? "on" : ""}`} style={{ marginLeft: "auto" }} onClick={() => setLive((l) => !l)}>
          <span className="dot" /> {live ? "live" : "paused"}
        </button>
      </div>

      <ErrorNotice error={audit.error} />
      {audit.isPending ? (
        <SkeletonRows rows={6} />
      ) : rows.length === 0 ? (
        <Empty title="No calls yet">Tool calls from MCP clients and the chat agent appear here.</Empty>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>time</th>
              <th>user</th>
              <th>via</th>
              <th>server</th>
              <th>tool</th>
              <th className="num">duration</th>
              <th>outcome</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="muted" title={new Date(r.ts).toString()}>
                  <span style={{ color: "var(--text-dim)" }}>{day(r.ts)} </span>{clock(r.ts)}
                </td>
                <td>{r.user_email ?? "—"}</td>
                <td><span className={`tag ${r.source === "chat" ? "cyan" : ""}`}>{r.source}</span></td>
                <td className="muted">{r.server_name ?? "—"}</td>
                <td>
                  <code>{r.tool}</code>
                  {r.error && <span className="err-text" title={r.error}>{r.error}</span>}
                </td>
                <td className="num muted">{r.duration_ms == null ? "—" : r.duration_ms >= 1000 ? `${(r.duration_ms / 1000).toFixed(1)}s` : `${r.duration_ms}ms`}</td>
                <td><span className={`tag ${OUTCOME_TAG[r.outcome]}`}>{r.outcome}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
