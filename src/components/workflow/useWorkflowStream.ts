"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { WorkflowEvent, WorkflowState } from "@/lib/workflow/types";

export type StreamStatus = "connecting" | "live" | "reconnecting" | "idle";

export interface UseWorkflowStreamOptions {
  workflowId: string;
  /** Set to false during replay/catch-up to disable SSE connection */
  enabled: boolean;
  /** Last eventId from catch-up replay — SSE resumes from this cursor */
  initialCursor: string;
  /** Called for every SSE event (component handles dispatch to UI state) */
  onEvent: (event: WorkflowEvent) => void;
  /** Called when state is recovered from /state endpoint during reconnect */
  onStateRecovered?: (state: WorkflowState) => void;
}

/** Key under which a run's live streamed text is accumulated: `${agentId}::${ticketId}`.
 *  An agent dispatched N times gets N keys, so re-runs never concatenate into one blob. */
export function runKey(agentId: string, ticketId?: string): string {
  return `${agentId}::${ticketId || ""}`;
}

export interface UseWorkflowStreamReturn {
  streamStatus: StreamStatus;
  /** Live streamed text keyed by runKey(agentId, ticketId) — one entry per dispatch. */
  streamingText: Record<string, string>;
  clearStreamingText: (agentId: string) => void;
  lastEventTime: number;
}

export function useWorkflowStream({
  workflowId,
  enabled,
  initialCursor,
  onEvent,
  onStateRecovered,
}: UseWorkflowStreamOptions): UseWorkflowStreamReturn {
  const [streamStatus, setStreamStatus] = useState<StreamStatus>("idle");
  const [streamingText, setStreamingText] = useState<Record<string, string>>({});
  const [lastEventTime, setLastEventTime] = useState(0);

  // Stable refs to avoid stale closures and prevent re-triggering the effect
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const onStateRecoveredRef = useRef(onStateRecovered);
  onStateRecoveredRef.current = onStateRecovered;

  // Internal cursor — seeded from initialCursor, updated on every event
  const cursorRef = useRef(initialCursor);
  const initialCursorRef = useRef(initialCursor);

  // Update cursor seed when catch-up completes (enabled flips true with new cursor)
  if (enabled && initialCursor !== initialCursorRef.current) {
    cursorRef.current = initialCursor;
    initialCursorRef.current = initialCursor;
  }

  const eventSourceRef = useRef<EventSource | null>(null);

  const clearStreamingText = useCallback((agentId: string) => {
    setStreamingText((prev) => {
      const prefix = `${agentId}::`;
      const keys = Object.keys(prev).filter((k) => k === agentId || k.startsWith(prefix));
      if (keys.length === 0) return prev;
      const next = { ...prev };
      for (const k of keys) delete next[k];
      return next;
    });
  }, []);

  useEffect(() => {
    if (!enabled) {
      setStreamStatus("idle");
      return;
    }

    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempts = 0;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      const cursor = cursorRef.current;
      const url = cursor
        ? `/api/workflow/${workflowId}/stream?cursor=${encodeURIComponent(cursor)}`
        : `/api/workflow/${workflowId}/stream`;
      setStreamStatus("connecting");
      es = new EventSource(url);
      eventSourceRef.current = es;

      es.onopen = () => {
        reconnectAttempts = 0;
        setStreamStatus("live");
      };

      es.onmessage = (event) => {
        try {
          const data: WorkflowEvent = JSON.parse(event.data);
          setLastEventTime(Date.now());

          // Update internal cursor for reconnect resume
          if (data.eventId) {
            cursorRef.current = data.eventId;
          }

          // Accumulate streaming text per RUN (agentId + ticketId), so an agent
          // dispatched multiple times keeps each run's text separate.
          if (data.type === "agent_output" && data.agentId && data.chunk) {
            const key = runKey(data.agentId, data.ticketId);
            setStreamingText((prev) => ({
              ...prev,
              [key]: (prev[key] || "") + data.chunk,
            }));
          }

          // A new dispatch of the same ticket (convergence rounds, retries)
          // starts a fresh invocation — reset that run key's accumulator so the
          // new invocation's live text doesn't concatenate onto the old one.
          // The settled history is served by the agent-output segments.
          if (data.type === "agent_status" && data.status === "running" && data.agentId) {
            const key = runKey(data.agentId, data.ticketId);
            setStreamingText((prev) => {
              if (!(key in prev)) return prev;
              const next = { ...prev };
              delete next[key];
              return next;
            });
          }

          // Forward all events to component
          onEventRef.current(data);
        } catch {
          // skip malformed messages
        }
      };

      es.onerror = () => {
        es?.close();
        if (stopped) return;
        setStreamStatus("reconnecting");
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 15000);
        reconnectAttempts++;

        // Health check: fetch current state during reconnect
        fetch(`/api/workflow/${workflowId}/state`)
          .then((r) => r.json())
          .then((data) => {
            if (data && data.id) {
              onStateRecoveredRef.current?.(data);
            }
          })
          .catch(() => {});

        reconnectTimer = setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      stopped = true;
      es?.close();
      eventSourceRef.current = null;
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [workflowId, enabled]);

  return { streamStatus, streamingText, clearStreamingText, lastEventTime };
}
