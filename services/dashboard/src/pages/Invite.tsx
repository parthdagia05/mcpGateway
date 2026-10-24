// The page behind an invite link (/invite/<token>): the new member picks a name and password.
// On success the gateway starts a session, so they land straight in the dashboard.

import { useState, type FormEvent } from "react";
import { useParams } from "react-router";
import { api } from "../api";
import { ErrorNotice } from "../components/ui";

export function Invite() {
  const { token = "" } = useParams();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.acceptInvite(token, name, password);
      window.location.href = "/keys"; // first thing a new member needs: their own API key
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div className="auth-box">
        <span className="brand">urumi<span className="slash">/</span>gateway<span className="cursor" /></span>
        <form className="panel" onSubmit={submit}>
          <div className="panel-body">
            <h1>Join your team</h1>
            <p>Pick a name and a password. Next you'll create your own API key.</p>
            <ErrorNotice error={error} />
            <label className="field">
              <span>your name</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus required maxLength={100} />
            </label>
            <label className="field">
              <span>password</span>
              <input className="input" type="password" autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required />
              <small>at least 8 characters</small>
            </label>
            <button className="btn primary" disabled={busy}>{busy ? "joining…" : "join →"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
