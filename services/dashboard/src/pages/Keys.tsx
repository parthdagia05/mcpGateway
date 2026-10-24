// API keys. Everyone manages their own; admins also see (and can revoke) everyone's.
// A new key is shown ONCE, together with ready-to-paste commands for Claude Code and Cursor.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api, type Me } from "../api";
import { CopyField, Empty, ErrorNotice, PageHead, SkeletonRows, day, timeAgo, useTicker } from "../components/ui";

export function Keys({ me }: { me: Me }) {
  useTicker();
  const isAdmin = me.role === "admin";
  const queryClient = useQueryClient();
  const [showAll, setShowAll] = useState(false);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ key: string; mcpUrl: string; name: string } | null>(null);

  const keys = useQuery({ queryKey: ["keys", showAll], queryFn: () => api.keys(showAll) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["keys"] });

  const create = useMutation({
    mutationFn: () => api.createKey(name.trim()),
    onSuccess: (res) => {
      setCreated({ key: res.key, mcpUrl: res.mcpUrl, name: name.trim() });
      setName("");
      void refresh();
    },
  });
  const revoke = useMutation({ mutationFn: (id: number) => api.revokeKey(id), onSettled: refresh });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) create.mutate();
  };

  const rows = keys.data ?? [];

  return (
    <div className="page">
      <PageHead title="api keys">
        Your personal keys for the gateway. Add the endpoint and a key to Claude Code, Cursor or MCP Inspector and you get
        the tools of every enabled server. Keys are stored hashed, so a lost key can't be shown again: revoke it and make a new one.
      </PageHead>

      {created && (
        <div className="reveal">
          <h3>Key “{created.name}” created. Copy it now: it won't be shown again.</h3>
          <p>Only a hash is stored on the gateway.</p>
          <CopyField value={created.key} label="api key" />
          <CopyField value={`claude mcp add --transport http urumi ${created.mcpUrl} --header "Authorization: Bearer ${created.key}"`} label="claude code" />
          <CopyField
            value={JSON.stringify({ mcpServers: { urumi: { url: created.mcpUrl, headers: { Authorization: `Bearer ${created.key}` } } } })}
            label="cursor (~/.cursor/mcp.json)"
          />
          <button className="btn sm" style={{ marginTop: 6 }} onClick={() => setCreated(null)}>done, I've saved it</button>
        </div>
      )}

      <form className="filters" onSubmit={submit}>
        <input className="input" placeholder="key name, e.g. claude-code-laptop" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} style={{ minWidth: 280 }} />
        <button className="btn primary" disabled={!name.trim() || create.isPending}>+ generate key</button>
        {isAdmin && (
          <label className="check" style={{ marginLeft: "auto" }}>
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> show everyone's keys
          </label>
        )}
      </form>

      <ErrorNotice error={keys.error || create.error || revoke.error} />
      {keys.isPending ? (
        <SkeletonRows />
      ) : rows.length === 0 ? (
        <Empty title="No keys yet">Generate one above to connect an MCP client.</Empty>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>name</th>
              <th>key</th>
              {showAll && <th>owner</th>}
              <th>created</th>
              <th>last used</th>
              <th>status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((k) => (
              <tr key={k.id}>
                <td>{k.name}</td>
                <td className="muted"><code>{k.prefix}…</code></td>
                {showAll && <td className="muted">{k.user_email}</td>}
                <td className="muted">{day(k.created_at)}</td>
                <td className="muted">{timeAgo(k.last_used_at)}</td>
                <td>{k.revoked_at ? <span className="tag red">revoked {timeAgo(k.revoked_at)}</span> : <span className="tag green">active</span>}</td>
                <td className="actions">
                  {!k.revoked_at && (
                    <button
                      className="btn sm danger"
                      disabled={revoke.isPending}
                      onClick={() => confirm(`Revoke “${k.name}”${showAll ? ` (${k.user_email})` : ""}? Its next call will be rejected.`) && revoke.mutate(k.id)}
                    >
                      revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
