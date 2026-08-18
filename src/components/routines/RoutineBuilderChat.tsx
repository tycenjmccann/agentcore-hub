"use client";

/**
 * Routine Builder chat drawer — slide-over on the Routines tab for setting up a
 * scheduled routine conversationally. Describe the routine ("every Monday pull my
 * Facebook ad performance, analyze it, draft a content plan, create tickets") and
 * the harness designs the workflow, writes any new persona blueprints, and saves
 * the routine + its schedule.
 *
 * Streams the harness response from POST /api/routines/chat as SSE — same shared
 * frame reader + harness event schema as the Workflow Manager chat.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarClock, X, Send, Loader2 } from "lucide-react";
import { MarkdownRenderer } from "../workflow/MarkdownRenderer";
import { sseData } from "@/lib/sse";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called when a turn completes so the parent can refresh the routines list. */
  onTurnComplete?: () => void;
}

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

const QUICK_PROMPTS = [
  "Every Monday 9am: pull my Facebook ad performance, analyze it, draft a content plan, and create tickets to act on it.",
  "Weekly dead-code sweep on my repo — find unused code and open a PR removing it.",
  "Every night: run a refactor pass on the backend repo and open a PR with the cleanups.",
];

function getConversationId(): string {
  const KEY = "rt-chat-conversation-id";
  let id = typeof window !== "undefined" ? sessionStorage.getItem(KEY) : null;
  if (!id) {
    id = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (typeof window !== "undefined") sessionStorage.setItem(KEY, id);
  }
  return id;
}

export default function RoutineBuilderChat({ open, onClose, onTurnComplete }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [step, setStep] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const conversationIdRef = useRef<string>("");
  const startedAtRef = useRef(0);

  useEffect(() => {
    if (open && !conversationIdRef.current) conversationIdRef.current = getConversationId();
  }, [open]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, activeTool, elapsed]);

  useEffect(() => {
    if (!streaming) return;
    const t = setInterval(() => setElapsed(Math.round((Date.now() - startedAtRef.current) / 1000)), 1000);
    return () => clearInterval(t);
  }, [streaming]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || streaming) return;
      setInput("");
      setMessages((m) => [...m, { role: "user", text: trimmed }, { role: "assistant", text: "" }]);
      setStreaming(true);
      setActiveTool(null);
      setStep(0);
      setElapsed(0);
      startedAtRef.current = Date.now();

      try {
        const res = await fetch("/api/routines/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationId: conversationIdRef.current, message: trimmed }),
        });
        if (!res.ok || !res.body) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }

        for await (const data of sseData(res.body)) {
          let payload: { type?: string; content?: string; name?: string };
          try {
            payload = JSON.parse(data);
          } catch {
            continue;
          }
          if (payload.type === "text" && payload.content) {
            setActiveTool(null);
            setMessages((m) => {
              const next = [...m];
              next[next.length - 1] = { role: "assistant", text: next[next.length - 1].text + payload.content };
              return next;
            });
          } else if (payload.type === "trace" && payload.name) {
            setActiveTool(payload.name);
            setStep((s) => s + 1);
          } else if (payload.type === "error") {
            setMessages((m) => {
              const next = [...m];
              next[next.length - 1] = { role: "assistant", text: `${next[next.length - 1].text}\n\n_Error: ${payload.content}_` };
              return next;
            });
          }
        }
      } catch (err) {
        setMessages((m) => {
          const next = [...m];
          next[next.length - 1] = { role: "assistant", text: `_Error: ${err instanceof Error ? err.message : "failed"}_` };
          return next;
        });
      } finally {
        setStreaming(false);
        setActiveTool(null);
        // The harness may have just saved a routine — refresh the list.
        onTurnComplete?.();
      }
    },
    [streaming, onTurnComplete],
  );

  if (!open) return null;

  return (
    <div className="rbc-overlay" onClick={onClose}>
      <style>{CHAT_STYLES}</style>
      <div className="rbc-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="rbc-head">
          <CalendarClock size={16} className="rbc-head-icon" />
          <span className="rbc-head-title">Routine Builder</span>
          <button className="rbc-close" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="rbc-messages" ref={scrollRef}>
          {messages.length === 0 && (
            <div className="rbc-intro">
              <p>Describe a routine you want to run on a schedule — who does it, what it does, and how often. I&apos;ll design the workflow and set up the schedule.</p>
              <div className="rbc-quick">
                {QUICK_PROMPTS.map((p) => (
                  <button key={p} className="rbc-quick-btn" onClick={() => send(p)} disabled={streaming}>{p}</button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`rbc-msg rbc-${m.role}`}>
              {m.role === "assistant" ? (
                m.text ? <MarkdownRenderer content={m.text} /> : (
                  <span className="rbc-thinking">
                    <Loader2 size={13} className="rbc-spin" />
                    {activeTool ? `Using ${activeTool}` : "Thinking"}
                    {step > 0 && <span className="rbc-thinking-meta">step {step}</span>}
                    {elapsed > 0 && <span className="rbc-thinking-meta">{elapsed}s</span>}
                  </span>
                )
              ) : (
                <span>{m.text}</span>
              )}
            </div>
          ))}
        </div>

        <form className="rbc-input-row" onSubmit={(e) => { e.preventDefault(); send(input); }}>
          <input
            className="rbc-input"
            placeholder="Describe your routine…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={streaming}
          />
          <button className="rbc-send" type="submit" disabled={streaming || !input.trim()}>
            {streaming ? <Loader2 size={16} className="rbc-spin" /> : <Send size={16} />}
          </button>
        </form>
      </div>
    </div>
  );
}

const CHAT_STYLES = `
.rbc-overlay{position:fixed;inset:0;z-index:60;background:rgba(0,0,0,0.4);display:flex;justify-content:flex-end}
.rbc-drawer{width:min(460px,100vw);height:100%;display:flex;flex-direction:column;
  background:var(--pipeline-card,#18181b);border-left:1px solid var(--pipeline-border,#27272a);
  box-shadow:-8px 0 24px rgba(0,0,0,0.4);animation:rbcSlide .18s ease}
@keyframes rbcSlide{from{transform:translateX(30px);opacity:0}to{transform:translateX(0);opacity:1}}
.rbc-head{display:flex;align-items:center;gap:8px;padding:14px 16px;border-bottom:1px solid var(--pipeline-border,#27272a)}
.rbc-head-icon{color:var(--color-brand-500)}
.rbc-head-title{font-weight:600;font-size:14px;color:var(--pipeline-text,#e4e4e7)}
.rbc-close{margin-left:auto;background:none;border:none;color:var(--pipeline-text-3,#a1a1aa);cursor:pointer;
  display:flex;padding:4px;border-radius:6px}
.rbc-close:hover{background:rgba(255,255,255,0.06);color:var(--pipeline-text,#e4e4e7)}
.rbc-messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px}
.rbc-intro{color:var(--pipeline-text-3,#a1a1aa);font-size:13px}
.rbc-quick{display:flex;flex-direction:column;gap:6px;margin-top:12px}
.rbc-quick-btn{text-align:left;padding:8px 10px;border-radius:8px;border:1px solid var(--pipeline-border,#27272a);
  background:rgba(255,255,255,0.02);color:var(--pipeline-text-2,#d4d4d8);cursor:pointer;font-size:12px}
.rbc-quick-btn:hover:not(:disabled){background:color-mix(in srgb,var(--color-brand-500) 8%,transparent);border-color:color-mix(in srgb,var(--color-brand-500) 40%,transparent)}
.rbc-msg{font-size:13px;line-height:1.5;max-width:100%}
.rbc-user{align-self:flex-end;background:color-mix(in srgb,var(--color-brand-500) 12%,transparent);border:1px solid color-mix(in srgb,var(--color-brand-500) 30%,transparent);
  color:var(--pipeline-text,#e4e4e7);padding:8px 12px;border-radius:12px 12px 2px 12px;max-width:85%}
.rbc-assistant{align-self:flex-start;color:var(--pipeline-text,#e4e4e7);max-width:100%}
.rbc-thinking{display:inline-flex;align-items:center;gap:7px;color:var(--pipeline-text-3,#a1a1aa);font-size:12px}
.rbc-thinking-meta{font-variant-numeric:tabular-nums;font-size:11px;padding:1px 6px;border-radius:5px;
  background:rgba(255,255,255,0.05);color:var(--pipeline-text-3,#a1a1aa)}
.rbc-spin{animation:rbcspin 1s linear infinite}
@keyframes rbcspin{to{transform:rotate(360deg)}}
.rbc-input-row{display:flex;gap:8px;padding:12px 16px;border-top:1px solid var(--pipeline-border,#27272a)}
.rbc-input{flex:1;background:var(--pipeline-bg,#0a0a0a);border:1px solid var(--pipeline-border,#3f3f46);
  border-radius:10px;color:var(--pipeline-text,#e4e4e7);padding:9px 12px;font-size:13px;outline:none}
.rbc-input:focus{border-color:color-mix(in srgb,var(--color-brand-500) 60%,transparent)}
.rbc-send{width:40px;border-radius:10px;border:1px solid color-mix(in srgb,var(--color-brand-500) 50%,transparent);background:color-mix(in srgb,var(--color-brand-500) 12%,transparent);
  color:var(--color-brand-400);cursor:pointer;display:flex;align-items:center;justify-content:center}
.rbc-send:disabled{opacity:0.5;cursor:default}
.rbc-send:hover:not(:disabled){background:color-mix(in srgb,var(--color-brand-500) 22%,transparent)}
`;
