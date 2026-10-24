// Small shared building blocks, so every page looks and behaves the same.

import { useEffect, useState, type ReactNode } from "react";

/** "4s ago", "3m ago", "2h ago", "Oct 24" */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** 24h time with seconds, e.g. 15:04:09, for log-like tables. */
export const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour12: false });
export const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** Re-renders every few seconds so relative times ("4s ago") stay fresh without refetching. */
export function useTicker(ms = 5000) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

export function PageHead({ title, children, actions }: { title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1><span className="hash">#</span>{title}</h1>
        {children && <p>{children}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export function ServerStatus({ status }: { status: "connected" | "unreachable" | "disabled" | "pending" }) {
  const map = {
    connected: ["up", "▲ up"],
    unreachable: ["down", "▼ down"],
    disabled: ["off", "■ off"],
    pending: ["pending", "◌ checking"],
  } as const;
  const [cls, label] = map[status];
  return <span className={`status ${cls}`}>{label}</span>;
}

/** Shows a value once with a copy button (API keys, invite links, commands). */
export function CopyField({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      {label && <div className="copy-label">{label}</div>}
      <div className="copy">
        <code>{value}</code>
        <button
          type="button"
          className="btn sm"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "copied ✓" : "copy"}
        </button>
      </div>
    </>
  );
}

export function Drawer({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="overlay" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <button className="btn ghost sm" onClick={onClose} aria-label="Close">esc</button>
        </header>
        <div className="drawer-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </aside>
    </>
  );
}

export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="notice error">{error instanceof Error ? error.message : String(error)}</div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <b>{title}</b>
      {children}
    </div>
  );
}

export function SkeletonRows({ rows = 3 }: { rows?: number }) {
  return (
    <div style={{ display: "grid", gap: 14, padding: "8px 0" }}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ width: `${88 - i * 14}%` }} />
      ))}
    </div>
  );
}
