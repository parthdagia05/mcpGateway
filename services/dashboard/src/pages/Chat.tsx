// Chat with the agent. It answers by calling the gateway's tools AS YOU, so every call it makes shows up
// in the audit log under your name. Each tool call is shown as an expandable line (arguments + result).
//
// The conversation lives in this browser tab (sessionStorage); the server keeps no chat state.

import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type ChatMessage, type Me, type ToolCall } from "../api";

type Turn =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[] }
  | { role: "error"; text: string };

const STORAGE_KEY = "urumi.chat";

// Models like to write narrow no-break spaces and non-breaking hyphens, which our fonts don't contain
// (they'd render in a fallback font). Swap them for their plain equivalents.
const tidy = (text: string) => text.replace(/[\u00A0\u2007\u202F]/g, " ").replace(/[\u2010\u2011]/g, "-");
const SUGGESTIONS = [
  "What orders came in today?",
  "List the 5 newest products with their prices.",
  "Create a product called “Masala Chai Tin” priced at 249.",
  "Mark the most recent order as completed.",
  "Add up the totals of today's orders using the get-sum tool.",
];

function load(): Turn[] {
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function Chat({ me }: { me: Me }) {
  const [turns, setTurns] = useState<Turn[]>(load);
  const [draft, setDraft] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(turns));
    } catch { /* storage full or blocked: the chat still works, it just won't survive a reload */ }
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns]);

  const send = useMutation({
    mutationFn: (history: ChatMessage[]) => api.chat(history),
    onSuccess: (res) => setTurns((t) => [...t, { role: "assistant", text: tidy(res.reply), toolCalls: res.toolCalls }]),
    onError: (err) => setTurns((t) => [...t, { role: "error", text: err.message }]),
  });

  const ask = (text: string) => {
    const question = text.trim();
    if (!question || send.isPending) return;
    const next: Turn[] = [...turns, { role: "user", text: question }];
    setTurns(next);
    setDraft("");
    // Only the text of earlier turns goes back to the server (errors are left out).
    const history = next.filter((t) => t.role !== "error").map((t) => ({ role: t.role, text: t.text }) as ChatMessage);
    send.mutate(history.slice(-20));
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    ask(draft);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      ask(draft);
    }
  };

  if (!me.chatEnabled) {
    return (
      <div className="page">
        <div className="notice warn">
          <b>Chat is switched off.</b> An operator needs to create the <code>urumi-llm</code> Secret with an LLM API key (see README).
        </div>
      </div>
    );
  }

  return (
    <div className="chat">
      <div className="transcript">
        {turns.length === 0 && (
          <div className="turn">
            <div className="who">agent</div>
            <div className="answer">
              <p>Ask about the store or anything the connected servers can do. I call their tools as <b>{me.email}</b>, and every call lands in the audit log under your name.</p>
            </div>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => ask(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}

        {turns.map((t, i) =>
          t.role === "user" ? (
            <div className="turn user" key={i}>
              <div className="who">you</div>
              <div className="prompt">{t.text}</div>
            </div>
          ) : (
            <div className="turn" key={i}>
              <div className="who">agent</div>
              {t.role === "assistant" && t.toolCalls.length > 0 && <ToolCalls calls={t.toolCalls} />}
              {t.role === "error" ? (
                <div className="answer error">✗ {t.text}</div>
              ) : (
                <div className="answer">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: (props) => <a {...props} target="_blank" rel="noreferrer" /> }}>
                    {t.text}
                  </ReactMarkdown>
                </div>
              )}
            </div>
          ),
        )}

        {send.isPending && (
          <div className="turn">
            <div className="who">agent</div>
            <div className="thinking">calling tools</div>
          </div>
        )}
        <div ref={bottom} />
      </div>

      <div className="composer">
        <form onSubmit={onSubmit}>
          <span className="caret">›</span>
          <textarea
            ref={input}
            rows={1}
            value={draft}
            placeholder="ask something… e.g. what orders came in today?"
            onChange={(e) => {
              setDraft(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${e.target.scrollHeight}px`;
            }}
            onKeyDown={onKeyDown}
            autoFocus
          />
          <button className="btn primary sm" disabled={!draft.trim() || send.isPending}>send ↵</button>
        </form>
        <div className="hint">
          <span>enter to send · shift+enter for a new line</span>
          {turns.length > 0 && (
            <button className="btn ghost sm" style={{ marginLeft: "auto", height: 18 }} onClick={() => { setTurns([]); input.current?.focus(); }}>
              clear conversation
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ToolCalls({ calls }: { calls: ToolCall[] }) {
  return (
    <div className="calls">
      {calls.map((c, i) => (
        <details className="call" key={i}>
          <summary>
            <span className="arrow">→</span>
            <span className="name">{c.tool}</span>
            <span className="args">{JSON.stringify(c.args)}</span>
            <span className={c.ok ? "ok" : "bad"}>{c.ok ? "✓" : "✗"}</span>
            <span className="ms">{c.durationMs}ms</span>
          </summary>
          <pre>{`args   ${JSON.stringify(c.args, null, 2)}\n\nresult ${c.result}`}</pre>
        </details>
      ))}
    </div>
  );
}
