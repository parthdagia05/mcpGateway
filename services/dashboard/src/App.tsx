// App shell: decides who you are (GET /api/auth/me), then shows either the login screen or the dashboard.
// Admin-only pages are hidden for members here, AND refused by the gateway (403) if called anyway:
// the UI is a convenience, the real check is on the server.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router";
import { api, ApiError, type Me } from "./api";
import { Audit } from "./pages/Audit";
import { Chat } from "./pages/Chat";
import { Invite } from "./pages/Invite";
import { Keys } from "./pages/Keys";
import { Login } from "./pages/Login";
import { Members } from "./pages/Members";
import { Servers } from "./pages/Servers";

export function App() {
  const location = useLocation();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, retry: false });

  // Public routes work without a session.
  if (location.pathname.startsWith("/invite/")) {
    return <Routes><Route path="/invite/:token" element={<Invite />} /></Routes>;
  }
  if (me.isPending) return <div className="auth"><span className="thinking">connecting</span></div>;
  if (me.error instanceof ApiError && me.error.status === 401) return <Login />;
  if (me.error) return <div className="auth"><div className="notice error">Can't reach the gateway: {me.error.message}</div></div>;

  return <Shell me={me.data} />;
}

const TABS = [
  { to: "/servers", label: "servers", key: "1" },
  { to: "/chat", label: "chat", key: "2" },
  { to: "/keys", label: "api keys", key: "3" },
  { to: "/audit", label: "audit", key: "4" },
  { to: "/members", label: "members", key: "5", adminOnly: true },
];

function Shell({ me }: { me: Me }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tabs = TABS.filter((t) => !t.adminOnly || me.role === "admin");

  // Number keys switch tabs (when you're not typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      const tab = tabs.find((t) => t.key === e.key);
      if (tab) navigate(tab.to);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabs, navigate]);

  const logout = async () => {
    await api.logout();
    queryClient.clear();
    window.location.href = "/";
  };

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">urumi<span className="slash">/</span>gateway<span className="cursor" /></span>
        <span className="spacer" />
        <span className="who"><b>{me.name || me.email}</b> · {me.email}</span>
        <span className="role">{me.role}</span>
        <button className="btn ghost sm" onClick={logout}>logout</button>
      </header>
      <nav className="tabs">
        {tabs.map((t) => (
          <NavLink key={t.to} to={t.to}>
            <span className="br">[</span>{t.label}<span className="br">]</span>
            <span className="key">{t.key}</span>
          </NavLink>
        ))}
      </nav>
      <main>
        <Routes>
          <Route path="/servers" element={<Servers me={me} />} />
          <Route path="/chat" element={<Chat me={me} />} />
          <Route path="/keys" element={<Keys me={me} />} />
          <Route path="/audit" element={<Audit me={me} />} />
          {me.role === "admin" && <Route path="/members" element={<Members me={me} />} />}
          <Route path="*" element={<Navigate to="/servers" replace />} />
        </Routes>
      </main>
    </div>
  );
}
