// Team members (admins only): invite by email (one-time link), change role, remove.
// Removing someone deletes their sessions and API keys; their audit history stays.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api, type Me, type Role } from "../api";
import { CopyField, ErrorNotice, PageHead, SkeletonRows, day } from "../components/ui";

export function Members({ me }: { me: Me }) {
  const queryClient = useQueryClient();
  const members = useQuery({ queryKey: ["members"], queryFn: api.members });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["members"] });

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [invite, setInvite] = useState<{ email: string; url: string } | null>(null);

  const send = useMutation({
    mutationFn: () => api.invite(email.trim(), role),
    onSuccess: (res) => {
      setInvite({ email: email.trim(), url: res.inviteUrl });
      setEmail("");
      void refresh();
    },
  });
  const changeRole = useMutation({ mutationFn: ({ id, role }: { id: number; role: Role }) => api.setRole(id, role), onSettled: refresh });
  const remove = useMutation({ mutationFn: (id: number) => api.removeMember(id), onSettled: refresh });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    send.mutate();
  };

  return (
    <div className="page">
      <PageHead title="members">
        Admins manage servers and members. Members use the tools and manage their own API keys.
      </PageHead>

      {invite && (
        <div className="reveal">
          <h3>Invite for {invite.email} created</h3>
          <p>Send them this link. It works once and expires in 7 days.</p>
          <CopyField value={invite.url} />
          <button className="btn sm" onClick={() => setInvite(null)}>done</button>
        </div>
      )}

      <form className="filters" onSubmit={submit}>
        <input className="input" type="email" placeholder="teammate@company.com" value={email} onChange={(e) => setEmail(e.target.value)} required style={{ minWidth: 280 }} />
        <select className="select" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          <option value="member">member</option>
          <option value="admin">admin</option>
        </select>
        <button className="btn primary" disabled={send.isPending}>+ invite</button>
      </form>

      <ErrorNotice error={members.error || send.error || changeRole.error || remove.error} />
      {members.isPending ? (
        <SkeletonRows />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>name</th>
              <th>email</th>
              <th>role</th>
              <th>status</th>
              <th className="num">active keys</th>
              <th>joined</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(members.data ?? []).map((m) => {
              const isMe = m.id === me.id;
              return (
                <tr key={m.id}>
                  <td>{m.name || <span style={{ color: "var(--text-dim)" }}>—</span>}{isMe && <span className="tag" style={{ marginLeft: 8 }}>you</span>}</td>
                  <td className="muted">{m.email}</td>
                  <td>
                    <select
                      className="select"
                      style={{ height: 24, width: "auto", fontSize: 12 }}
                      value={m.role}
                      disabled={isMe || changeRole.isPending}
                      onChange={(e) => changeRole.mutate({ id: m.id, role: e.target.value as Role })}
                    >
                      <option value="member">member</option>
                      <option value="admin">admin</option>
                    </select>
                  </td>
                  <td>{m.status === "active" ? <span className="tag green">active</span> : <span className="tag amber">invited</span>}</td>
                  <td className="num muted">{m.active_keys}</td>
                  <td className="muted">{day(m.created_at)}</td>
                  <td className="actions">
                    {!isMe && (
                      <button
                        className="btn sm danger"
                        disabled={remove.isPending}
                        onClick={() => confirm(`Remove ${m.email}? Their sessions and API keys stop working immediately.`) && remove.mutate(m.id)}
                      >
                        remove
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
