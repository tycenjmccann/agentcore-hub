"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import type {
  WorkflowState,
  WorkflowEvent,
  WorkflowPhase,
  AgentTaskStatus,
} from "@/lib/workflow/types";

interface UsePipelineSSEOptions {
  workflowId: string;
  onEvent?: (event: WorkflowEvent) => void;
}

interface UsePipelineSSEResult {
  state: WorkflowState | null;
  isConnected: boolean;
  isLoading: boolean;
  error: string | null;
}

/**
 * Custom hook that manages the SSE lifecycle for pipeline visualization.
 *
 * CRITICAL BEHAVIOR:
 * 1. On mount: fetch full state immediately (no animation replay)
 * 2. Derive visual state from data snapshot
 * 3. Open SSE for live updates going forward
 * 4. On disconnect: exponential backoff reconnect
 * 5. On reconnect: re-fetch full state (instant render, no replay)
 */
export function usePipelineSSE({
  workflowId,
  onEvent,
}: UsePipelineSSEOptions): UsePipelineSSEResult {
  const [state, setState] = useState<WorkflowState | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const eventSourceRef = useRef<EventSource | null>(null);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pollingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const mountedRef = useRef(true);
  const onEventRef = useRef(onEvent);

  // Keep onEvent ref current without triggering re-effects
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  // Fetch full state from API
  const fetchState = useCallback(async () => {
    try {
      const res = await fetch(`/api/workflow/${workflowId}/state`);
      if (!res.ok) {
        throw new Error(`Failed to fetch state: ${res.status}`);
      }
      const data: WorkflowState = await res.json();
      if (mountedRef.current) {
        setState(data);
        setError(null);
        setIsLoading(false);
      }
      return data;
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : "Failed to fetch state");
        setIsLoading(false);
      }
      return null;
    }
  }, [workflowId]);

  // Apply an SSE event to the local state
  const applyEvent = useCallback((event: WorkflowEvent) => {
    setState((prev) => {
      if (!prev) return prev;
      const next = { ...prev };

      // agentTasks may be keyed by ticketId (TEAM-xxx) rather than agentId.
      // Resolve the actual map key for a given agentId.
      const findTaskKey = (agentId: string): string | null => {
        // Direct match first (key IS the agentId)
        if (next.agentTasks[agentId]) return agentId;
        // Search by agentId field inside task values (keyed by ticketId)
        for (const [key, task] of Object.entries(next.agentTasks)) {
          if (task.agentId === agentId) return key;
        }
        return null;
      };

      switch (event.type) {
        case "phase_change":
          next.phase = event.phase;
          break;

        case "agent_status": {
          const key = findTaskKey(event.agentId);
          if (key) {
            next.agentTasks = {
              ...next.agentTasks,
              [key]: {
                ...next.agentTasks[key],
                status: event.status,
              },
            };
          }
          break;
        }

        case "agent_output": {
          const key = findTaskKey(event.agentId);
          if (key) {
            const existing = next.agentTasks[key].output || "";
            next.agentTasks = {
              ...next.agentTasks,
              [key]: {
                ...next.agentTasks[key],
                output: existing + event.chunk,
              },
            };
          }
          break;
        }

        case "agent_complete": {
          const key = findTaskKey(event.agentId);
          if (key) {
            const existingOutput = next.agentTasks[key].output || "";
            next.agentTasks = {
              ...next.agentTasks,
              [key]: {
                ...next.agentTasks[key],
                status: "complete" as AgentTaskStatus,
                output: event.output || existingOutput,
                branch: event.branch,
                commitSha: event.commitSha,
                completedAt: new Date().toISOString(),
              },
            };
          }
          break;
        }

        case "workflow_complete":
          next.phase = "complete" as WorkflowPhase;
          next.completedAt = new Date().toISOString();
          break;

        case "error": {
          const key = event.agentId ? findTaskKey(event.agentId) : null;
          if (key) {
            next.agentTasks = {
              ...next.agentTasks,
              [key]: {
                ...next.agentTasks[key],
                status: "error" as AgentTaskStatus,
                error: event.error,
              },
            };
          } else {
            next.phase = "error" as WorkflowPhase;
            next.error = event.error;
          }
          break;
        }

        default:
          break;
      }

      return next;
    });

    onEventRef.current?.(event);
  }, []);

  // Exponential backoff reconnect
  const scheduleReconnect = useCallback(() => {
    const maxRetries = 10;
    if (retryCountRef.current >= maxRetries) {
      // Fall back to polling
      if (!pollingTimerRef.current) {
        pollingTimerRef.current = setInterval(() => {
          if (mountedRef.current) {
            fetchState();
          }
        }, 3000);
      }
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, retryCountRef.current), 30000);
    retryCountRef.current += 1;

    retryTimerRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      // Re-fetch state on reconnect (instant render)
      fetchState();
      connectSSE();
    }, delay);
  }, [fetchState]);

  // Connect SSE stream
  const connectSSE = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const es = new EventSource(`/api/workflow/${workflowId}/stream`);
    eventSourceRef.current = es;

    es.onopen = () => {
      if (mountedRef.current) {
        setIsConnected(true);
        setError(null);
        retryCountRef.current = 0;
        // Clear polling if active
        if (pollingTimerRef.current) {
          clearInterval(pollingTimerRef.current);
          pollingTimerRef.current = null;
        }
      }
    };

    es.onmessage = (event) => {
      if (!mountedRef.current) return;
      try {
        const parsed: WorkflowEvent = JSON.parse(event.data);
        applyEvent(parsed);
      } catch {
        // Ignore malformed events (heartbeats, etc.)
      }
    };

    es.onerror = () => {
      if (!mountedRef.current) return;
      es.close();
      setIsConnected(false);
      scheduleReconnect();
    };
  }, [workflowId, applyEvent, scheduleReconnect]);

  // Initialize on mount
  useEffect(() => {
    mountedRef.current = true;

    const init = async () => {
      await fetchState();
      connectSSE();
    };

    init();

    return () => {
      mountedRef.current = false;
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
      }
      if (pollingTimerRef.current) {
        clearInterval(pollingTimerRef.current);
      }
    };
  }, [fetchState, connectSSE]);

  return { state, isConnected, isLoading, error };
}
