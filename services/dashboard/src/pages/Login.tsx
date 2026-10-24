import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api } from "../api";
import { ErrorNotice } from "../components/ui";

export function Login() {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(email, password);
      await queryClient.invalidateQueries({ queryKey: ["me"] }); // App re-checks the session and shows the dashboard
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div className="auth-box">
        <span className="brand">urumi<span className="slash">/</span>gateway<span className="cursor" /></span>
        <form className="panel" onSubmit={submit}>
          <div className="panel-body">
            <h1>Sign in</h1>
            <p>One endpoint for every MCP server your team uses.</p>
            <ErrorNotice error={error} />
            <label className="field">
              <span>email</span>
              <input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
            </label>
            <label className="field">
              <span>password</span>
              <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </label>
            <button className="btn primary" disabled={busy}>{busy ? "signing in…" : "sign in →"}</button>
          </div>
        </form>
        <p className="auth-foot">No account? Ask an admin for an invite link.</p>
      </div>
    </div>
  );
}
