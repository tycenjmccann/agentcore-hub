"use client";

/**
 * Idle persona chat, inside the agent modal (TEAM-4498).
 *
 * The mailbox composer above this one interrupts an agent mid-turn; this one is
 * its opposite — a read-only conversation with a persona that has STOPPED, for
 * asking what it did and why. Exactly one of the two is ever usable, because the
 * modal gates them on inverse halves of the same predicate
 * (`isStaleEligibleStatus`), and the route re-checks idleness server-side and
 * answers 409 `agent_active` if the agent picked up work between render and send.
 *
 * Prior turns come from the persona's own memory session, so a reply survives a
 * modal close, a reload, and a different browser.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { MessageSquare, Send } from "lucide-react";
import { sseData } from "@/lib/sse";
import { extractChatTurns, type ChatTurn } from "@/lib/workflow/persona-chat";
import { MarkdownRenderer } from "./MarkdownRenderer";

interface AgentIdleChatProps {
  workflowId: string;
  agentId: string;
  /** False while the agent holds a live task — composer renders disabled. */
  isIdle: boolean;
  /** Modal visibility: history loads on open, not on mount. */
  isOpen: boolean;
}

export function AgentIdleChat({ workflowId, agentId, isIdle, isOpen }: AgentIdleChatProps) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  /** Set when the server says the agent went active — composer locks until it idles again. */
  const [serverBusy, setServerBusy] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);

  // The modal stays mounted across agent switches: never carry a transcript or a
  // half-typed question from one persona to the next.
  useEffect(() => {
    setTurns([]);
    setInput("");
    setServerBusy(false);
  }, [workflowId, agentId]);

  useEffect(() => {
    if (isIdle) setServerBusy(false);
  }, [isIdle]);

  // Prior chat turns, replayed from persona memory. Entirely best-effort: the
  // composer works whether or not memory answers (the agent may have no memory
  // resource, or never have been dispatched in this run).
  useEffect(() => {
    if (!isOpen || !workflowId || !agentId) return;
    let cancelled = false;
    (async () => {
      try {
        const meta = await fetch(
          `/api/workflow/${encodeURIComponent(workflowId)}/agent-chat?agentId=${encodeURIComponent(agentId)}`
        );
        if (!meta.ok) return;
        const { sessionId } = (await meta.json()) as { sessionId?: string | null };
        if (cancelled || !sessionId) return;
        const params = new URLSearchParams({
          agent_id: agentId,
          session_id: sessionId,
          actor_id: agentId,
        });
        const res = await fetch(`/api/agentcore/memory/events?${params}`);
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { messages?: { role?: string; content?: string }[] };
        const history = extractChatTurns(data.messages);
        // A reply that arrived while we were fetching wins — never clobber it.
        if (!cancelled && history.length) setTurns(prev => (prev.length ? prev : history));
      } catch {
        /* no history is a normal state, not an error worth showing */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, workflowId, agentId]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [turns]);

  const send = useCallback(async () => {
    const message = input.trim();
    if (!message || streaming || !isIdle || serverBusy) return;
    setInput("");
    setTurns(prev => [...prev, { role: "user", text: message }, { role: "assistant", text: "" }]);
    setStreaming(true);

    const appendToReply = (chunk: string) =>
      setTurns(prev => {
        const next = [...prev];
        const last = next[next.length - 1];
        next[next.length - 1] = { role: "assistant", text: last.text + chunk };
        return next;
      });

    try {
      const res = await fetch(`/api/workflow/${encodeURIComponent(workflowId)}/agent-chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId, message }),
      });
      if (res.status === 409) {
        setServerBusy(true);
        appendToReply("_This agent just started working — chat again when it is idle._");
        return;
      }
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        appendToReply(`_${body.error || `Request failed (${res.status})`}_`);
        return;
      }
      // Same frame schema as every other streaming surface in the app.
      for await (const frame of sseData(res.body)) {
        let payload: { type?: string; content?: string };
        try {
          payload = JSON.parse(frame);
        } catch {
          continue;
        }
        if (payload.type === "text" && payload.content) appendToReply(payload.content);
        else if (payload.type === "error") appendToReply(`\n\n_${payload.content || "Error"}_`);
      }
    } catch {
      appendToReply("_The reply was interrupted._");
    } finally {
      setStreaming(false);
    }
  }, [input, streaming, isIdle, serverBusy, workflowId, agentId]);

  const disabled = !isIdle || serverBusy || streaming;

  return (
    <div
      className="border-t"
      style={{ borderColor: "var(--pipeline-border)", background: "rgba(15, 15, 20, 0.6)" }}
      data-testid="agent-idle-chat"
    >
      {turns.length > 0 && (
        <div
          ref={transcriptRef}
          className="px-4 py-2 max-h-48 overflow-y-auto flex flex-col gap-2"
          data-testid="agent-idle-chat-transcript"
        >
          {turns.map((turn, i) => (
            <div key={i} className="text-xs" style={{ color: "var(--pipeline-text)" }}>
              <span
                className="font-medium mr-1.5"
                style={{ color: turn.role === "user" ? "#a5b4fc" : "#4ade80" }}
              >
                {turn.role === "user" ? "You" : "Agent"}
              </span>
              {turn.role === "user" ? (
                <span style={{ whiteSpace: "pre-wrap" }}>{turn.text}</span>
              ) : (
                <MarkdownRenderer content={turn.text || (streaming ? "…" : "")} />
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 px-4 py-2">
        <MessageSquare size={14} style={{ color: "var(--pipeline-text-muted)" }} aria-hidden="true" />
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          disabled={disabled}
          placeholder={
            isIdle && !serverBusy
              ? "Ask this agent about its work…"
              : "Chat is available when the agent is idle."
          }
          maxLength={4000}
          className="flex-1 bg-transparent text-sm outline-none px-2 py-1.5 rounded border disabled:opacity-50"
          style={{ color: "var(--pipeline-text)", borderColor: "rgba(74, 222, 128, 0.25)" }}
          aria-label="Ask this agent a question"
          data-testid="agent-idle-chat-input"
        />
        <button
          onClick={send}
          disabled={disabled || !input.trim()}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded transition-colors disabled:opacity-40"
          style={{
            background: "rgba(34, 197, 94, 0.15)",
            color: "#4ade80",
            border: "1px solid rgba(34, 197, 94, 0.3)",
          }}
          type="button"
          data-testid="agent-idle-chat-send"
        >
          <Send size={13} aria-hidden="true" />
          {streaming ? "Thinking…" : "Ask"}
        </button>
      </div>
    </div>
  );
}
