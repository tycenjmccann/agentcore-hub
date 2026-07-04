"use client";

/**
 * Workflow Manager chat drawer — a slide-over on the Workflow tab for talking to
 * the always-on PM agent about any workflow, run, or trend. Streams the harness
 * CHAT response from POST /api/workflow-manager/chat as SSE.
 *
 * conversationId persists in sessionStorage; the harness carries context across
 * sessions via its own memory, so we only ever send the newest message.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ClipboardCheck, X, Send, Loader2 } from "lucide-react";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { sseData } from "@/lib/sse";

interface Props {
  open: boolean;
  onClose: () => void;
  selectedWorkflowId?: string | null;
  /** Seeded when the user clicks "Ask about this run"; scopes the next message. */
  seedWorkflowId?: string | null;
}

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  tool?: string;
}

const QUICK_PROMPTS = [
  "What's our biggest bottleneck across recent runs?",
  "Compare our last two workflow runs.",
  "Which review gates cost the most time?",
];

function getConversationId(): string {
  const KEY = "wm-chat-conversation-id";
  let id = typeof window !== "undefined" ? sessionStorage.getItem(KEY) : null;
  if (!id) {
    id = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (typeof window !== "undefined") sessionStorage.setItem(KEY, id);
  }
  return id;
}

export default function WorkflowManagerChat({ open, onClose, selectedWorkflowId, seedWorkflowId }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const conversationIdRef = useRef<string>("");

  useEffect(() => {
    if (open && !conversationIdRef.current) conversationIdRef.current = getConversationId();
  }, [open]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, activeTool]);

  const send = useCallback(
    async (text: string, contextWorkflowId?: string | null) => {
      const trimmed = text.trim();
      if (!trimmed || streaming) return;
      setInput("");
      setMessages((m) => [...m, { role: "user", text: trimmed }, { role: "assistant", text: "" }]);
      setStreaming(true);
      setActiveTool(null);

      try {
        const res = await fetch("/api/workflow-manager/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId: conversationIdRef.current,
            message: trimmed,
            workflowId: contextWorkflowId || selectedWorkflowId || undefined,
          }),
        });
        if (!res.ok || !res.body) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }

        // Shared SSE frame reader + the app-wide harness event schema
        // ({type:"text"|"trace"|"done"|"error"}), same as the agent playground.
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
      }
    },
    [streaming, selectedWorkflowId],
  );

  // "Ask about this run" seeds a message scoped to the run.
  const seededRef = useRef<string | null>(null);
  useEffect(() => {
    if (open && seedWorkflowId && seedWorkflowId !== seededRef.current) {
      seededRef.current = seedWorkflowId;
      send(`Give me a quick read on workflow ${seedWorkflowId} — what went well and what didn't?`, seedWorkflowId);
    }
  }, [open, seedWorkflowId, send]);

  if (!open) return null;

  return (
    <div className="wmc-overlay" onClick={onClose}>
      <style>{CHAT_STYLES}</style>
      <div className="wmc-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="wmc-head">
          <ClipboardCheck size={16} className="wmc-head-icon" />
          <span className="wmc-head-title">Workflow Manager</span>
          {selectedWorkflowId && <span className="wmc-context">viewing {selectedWorkflowId}</span>}
          <button className="wmc-close" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="wmc-messages" ref={scrollRef}>
          {messages.length === 0 && (
            <div className="wmc-intro">
              <p>Ask about any workflow, run, bottleneck, or trend.</p>
              <div className="wmc-quick">
                {QUICK_PROMPTS.map((p) => (
                  <button key={p} className="wmc-quick-btn" onClick={() => send(p)} disabled={streaming}>{p}</button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`wmc-msg wmc-${m.role}`}>
              {m.role === "assistant" ? (
                m.text ? <MarkdownRenderer content={m.text} /> : (
                  <span className="wmc-thinking">
                    <Loader2 size={13} className="wmc-spin" />
                    {activeTool ? `Using ${activeTool}…` : "Thinking…"}
                  </span>
                )
              ) : (
                <span>{m.text}</span>
              )}
            </div>
          ))}
        </div>

        <form
          className="wmc-input-row"
          onSubmit={(e) => { e.preventDefault(); send(input); }}
        >
          <input
            className="wmc-input"
            placeholder="Ask the Workflow Manager…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={streaming}
          />
          <button className="wmc-send" type="submit" disabled={streaming || !input.trim()}>
            {streaming ? <Loader2 size={16} className="wmc-spin" /> : <Send size={16} />}
          </button>
        </form>
      </div>
    </div>
  );
}

const CHAT_STYLES = `
.wmc-overlay{position:fixed;inset:0;z-index:60;background:rgba(0,0,0,0.4);display:flex;justify-content:flex-end}
.wmc-drawer{width:min(440px,100vw);height:100%;display:flex;flex-direction:column;
  background:var(--pipeline-card,#18181b);border-left:1px solid var(--pipeline-border,#27272a);
  box-shadow:-8px 0 24px rgba(0,0,0,0.4);animation:wmcSlide .18s ease}
@keyframes wmcSlide{from{transform:translateX(30px);opacity:0}to{transform:translateX(0);opacity:1}}
.wmc-head{display:flex;align-items:center;gap:8px;padding:14px 16px;border-bottom:1px solid var(--pipeline-border,#27272a)}
.wmc-head-icon{color:#0ea5e9}
.wmc-head-title{font-weight:600;font-size:14px;color:var(--pipeline-text,#e4e4e7)}
.wmc-context{font-size:11px;color:var(--pipeline-text-3,#a1a1aa);background:rgba(255,255,255,0.05);
  padding:2px 8px;border-radius:6px}
.wmc-close{margin-left:auto;background:none;border:none;color:var(--pipeline-text-3,#a1a1aa);cursor:pointer;
  display:flex;padding:4px;border-radius:6px}
.wmc-close:hover{background:rgba(255,255,255,0.06);color:var(--pipeline-text,#e4e4e7)}
.wmc-messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px}
.wmc-intro{color:var(--pipeline-text-3,#a1a1aa);font-size:13px}
.wmc-quick{display:flex;flex-direction:column;gap:6px;margin-top:12px}
.wmc-quick-btn{text-align:left;padding:8px 10px;border-radius:8px;border:1px solid var(--pipeline-border,#27272a);
  background:rgba(255,255,255,0.02);color:var(--pipeline-text-2,#d4d4d8);cursor:pointer;font-size:12px}
.wmc-quick-btn:hover:not(:disabled){background:rgba(14,165,233,0.08);border-color:rgba(14,165,233,0.4)}
.wmc-msg{font-size:13px;line-height:1.5;max-width:100%}
.wmc-user{align-self:flex-end;background:rgba(14,165,233,0.12);border:1px solid rgba(14,165,233,0.3);
  color:var(--pipeline-text,#e4e4e7);padding:8px 12px;border-radius:12px 12px 2px 12px;max-width:85%}
.wmc-assistant{align-self:flex-start;color:var(--pipeline-text,#e4e4e7);max-width:100%}
.wmc-thinking{display:inline-flex;align-items:center;gap:7px;color:var(--pipeline-text-3,#a1a1aa);font-size:12px}
.wmc-spin{animation:wmcspin 1s linear infinite}
@keyframes wmcspin{to{transform:rotate(360deg)}}
.wmc-input-row{display:flex;gap:8px;padding:12px 16px;border-top:1px solid var(--pipeline-border,#27272a)}
.wmc-input{flex:1;background:var(--pipeline-bg,#0a0a0a);border:1px solid var(--pipeline-border,#3f3f46);
  border-radius:10px;color:var(--pipeline-text,#e4e4e7);padding:9px 12px;font-size:13px;outline:none}
.wmc-input:focus{border-color:rgba(14,165,233,0.6)}
.wmc-send{width:40px;border-radius:10px;border:1px solid rgba(14,165,233,0.5);background:rgba(14,165,233,0.12);
  color:#38bdf8;cursor:pointer;display:flex;align-items:center;justify-content:center}
.wmc-send:disabled{opacity:0.5;cursor:default}
.wmc-send:hover:not(:disabled){background:rgba(14,165,233,0.22)}
`;
