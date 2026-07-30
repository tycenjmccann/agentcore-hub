"use client";

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import type {
  WorkflowState,
  WorkflowEvent,
  TicketStatus,
} from "@/lib/workflow/types";
import awsIcons from "@/lib/aws-icons.json";
import { getPipelinePhases, resolveToolIcon, getPhaseToolCount, type PipelinePhaseConfig } from "@/lib/pipeline-config";
import { DEFAULT_WORKFLOW_DEF_ID, getWorkflowDef } from "@/lib/workflow/workflow-defs";
import { Square, ClipboardCheck } from "lucide-react";
import AgentOutputPanel from "./AgentOutputPanel";
import S3ArtifactsModal from "./S3ArtifactsModal";
import CancelConfirmationModal from "./CancelConfirmationModal";
import TicketStatusBadge from "./TicketStatusBadge";
import TicketDetailModal from "./TicketDetailModal";
import WorkflowManagerPanel from "./WorkflowManagerPanel";
import { useWorkflowStream } from "./useWorkflowStream";

interface WorkflowBoardProps {
  workflowId: string;
  /** Opens the Workflow Manager chat drawer scoped to this run. */
  onAskManager?: (workflowId: string) => void;
}

// ─── Phase Order (derived from the running workflow's def) ───────────────────

// Map WorkflowPhase / agentPhase strings to index in the given pipeline phases.
function buildPhaseOrder(phases: PipelinePhaseConfig[]): Record<string, number> {
  const order: Record<string, number> = {};
  phases.forEach((phase, idx) => {
    order[phase.id] = idx;
    // Also map agentPhase if it differs from id (e.g. qa phase has agentPhase "verification")
    if (phase.agentPhase !== phase.id) {
      order[phase.agentPhase] = idx;
    }
  });
  // Special states. (No hardcoded "review" override — the loop above already
  // maps every phase id and agentPhase to its correct index per the running
  // workflow's def; legacy software-delivery-only override clobbered legal/sales.)
  order["complete"] = phases.length;
  order["error"] = -1;
  order["cancelled"] = -1;
  return order;
}

// ─── Replay helper: apply a single event to state (pure function) ───────────

function applyEventToState(s: WorkflowState, event: WorkflowEvent): WorkflowState {
  switch (event.type) {
    case "phase_change":
      return { ...s, phase: event.phase };
    case "agent_status": {
      const tasks = { ...s.agentTasks };
      if (tasks[event.agentId]) {
        // Never regress a completed agent back to running
        if (tasks[event.agentId].status === "complete") return s;
        tasks[event.agentId] = { ...tasks[event.agentId], status: event.status };
      } else {
        tasks[event.agentId] = { id: `task_${Date.now()}`, agentId: event.agentId, ticketId: event.ticketId || "", status: event.status, input: "" };
      }
      return { ...s, agentTasks: tasks };
    }
    case "agent_complete": {
      const tasks = { ...s.agentTasks };
      if (tasks[event.agentId]) {
        tasks[event.agentId] = {
          ...tasks[event.agentId],
          status: "complete",
          // Only overwrite output if the event actually has content (events often have empty/truncated output)
          output: event.output || tasks[event.agentId].output,
          branch: event.branch,
          commitSha: event.commitSha,
        };
      }
      return { ...s, agentTasks: tasks };
    }
    case "workflow_complete":
      return { ...s, phase: "complete" };
    case "ticket_update":
      return s;
    default:
      return s;
  }
}

// A one-line, human-readable label for a Workflow Manager board toast.
function managerPulseText(
  event: Extract<WorkflowEvent, { type: "manager_intervention" | "manager_escalation" }>
): string {
  if (event.type === "manager_escalation") {
    return `Workflow Manager escalated: ${event.message || "needs a human decision"}`;
  }
  const action = event.action || "acted";
  const label: Record<string, string> = {
    unstick: "unstuck a stalled ticket",
    retry: "retried a failed agent",
    comment: "commented on a ticket",
    escalate: "escalated an issue",
  };
  const what = label[action] || `ran "${action}"`;
  return `Workflow Manager ${what}${event.ticketId ? ` (${event.ticketId})` : ""}`;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function WorkflowBoard({ workflowId, onAskManager }: WorkflowBoardProps) {
  const [state, setState] = useState<WorkflowState | null>(null);

  // Phases + ordering are derived from the running workflow's definition so the
  // board reflects the actual workflow (e.g. social-media) instead of the
  // hardcoded software-delivery pipeline.
  const workflowDefId = state?.input?.workflowDefId;
  const pipelinePhases = useMemo(() => getPipelinePhases(workflowDefId), [workflowDefId]);
  const phaseOrder = useMemo(() => buildPhaseOrder(pipelinePhases), [pipelinePhases]);
  // Refs so stable useCallback event handlers always see the current def's phases/order.
  const pipelinePhasesRef = useRef(pipelinePhases);
  pipelinePhasesRef.current = pipelinePhases;
  const phaseOrderRef = useRef(phaseOrder);
  phaseOrderRef.current = phaseOrder;
  const [celebrating, setCelebrating] = useState(false);
  // Workflow Manager watchdog toggle for this run (default on).
  const [managerWatch, setManagerWatch] = useState(true);
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  // Full agent output fetched directly from DDB (independent of replay scrubber)
  const [agentFullOutput, setAgentFullOutput] = useState<Record<string, string>>({});
  // Tool flash state: maps "phaseId:iconKey" to a timeout so items flash when tools fire
  const [toolFlashes, setToolFlashes] = useState<Record<string, boolean>>({});
  const toolFlashTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const [activeConnector, setActiveConnector] = useState<number | null>(null);
  const [connectorPaths, setConnectorPaths] = useState<string[]>([]);
  // Skip-connectors: paths that jump over inactive phases (e.g., requirements → development when design is skipped)
  const [skipConnectors, setSkipConnectors] = useState<Array<{ d: string; fromIdx: number; toIdx: number }>>([]);
  const pipelineRef = useRef<HTMLDivElement>(null);

  // Replay state for completed workflows
  const [replayMode, setReplayMode] = useState(false);
  const [replayEvents, setReplayEvents] = useState<WorkflowEvent[]>([]);
  const [replayIndex, setReplayIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(3); // multiplier: 3x = 3 times real-time
  const replayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // DVR: "at live edge" means scrubber follows incoming events in real-time
  const [atLiveEdge, setAtLiveEdge] = useState(true);

  // Nudge pulse effect — hot pink full-screen flash during replay
  const [nudgePulse, setNudgePulse] = useState(false);
  // Workflow Manager intervention/escalation — sky toast on the board.
  const [managerPulse, setManagerPulse] = useState<string | null>(null);

  // Catch-up replay state for live/in-progress workflows
  const [catchingUp, setCatchingUp] = useState(false);
  const lastEventIdRef = useRef<string>("");
  const catchUpCompleteRef = useRef(false);

  // Preserve original DDB agent outputs (replay reconstructs state from events which lack full output)
  const originalOutputsRef = useRef<Record<string, string>>({});
  const agentTicketMapRef = useRef<Record<string, string>>({}); // agentId → ticketId, never cleared
  // Track whether the workflow was loaded as complete (from API) — survives replay reconstruction
  const wasLoadedCompleteRef = useRef(false);

  // Cancel workflow state
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [cancelLoading, setCancelLoading] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  // Ticket status map — seeded from fetch, updated via SSE
  const [ticketStatusMap, setTicketStatusMap] = useState<Record<string, { status: TicketStatus; title: string; updatedAt: string; assignee?: string }>>({});

  // Modal open state for future TicketDetailModal
  const [openTicketModal, setOpenTicketModal] = useState<{ ticketId: string; workflowId: string } | null>(null);

  const handleOpenTicketModal = useCallback((ticketId: string) => {
    setOpenTicketModal({ ticketId, workflowId });
  }, [workflowId]);

  // S3 Artifacts Modal state
  const [artifactsModal, setArtifactsModal] = useState<{ phaseId: string; phaseName: string } | null>(null);

  const handleCancelWorkflow = useCallback(async () => {
    setCancelLoading(true);
    setCancelError(null);
    try {
      const res = await fetch(`/api/workflow/${workflowId}/cancel`, { method: "POST" });
      if (res.ok) {
        setShowCancelModal(false);
        setState((s) => s ? { ...s, phase: "cancelled" } : s);
      } else if (res.status === 409) {
        setCancelError("Workflow is already in a terminal state.");
        setTimeout(() => setShowCancelModal(false), 2000);
      } else {
        const data = await res.json().catch(() => ({}));
        setCancelError(data.error || "Failed to cancel workflow. Please try again.");
      }
    } catch {
      setCancelError("Network error. Please check your connection and try again.");
    } finally {
      setCancelLoading(false);
    }
  }, [workflowId]);

  // Fetch initial state (once for replay, poll for live)
  useEffect(() => {
    let isFirstFetch = true;
    let interval: ReturnType<typeof setInterval> | null = null;

    const fetchState = () => {
      const ts = Date.now();
      fetch(`/api/workflow/${workflowId}/state?t=${ts}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((data) => {
          if (data && data.id) {
            // agentTasks normalization (ticket-keyed → agent-keyed) is handled
            // by the API in /api/workflow/[id]/state/route.ts — no client re-keying needed.
            // Only set state from poll if NOT in replay mode and not catching up
            if (!replayMode && !catchingUp) setState(data);
            if (isFirstFetch) {
              // Capture original DDB agent outputs before replay overwrites state
              if (data.agentTasks) {
                const outputs: Record<string, string> = {};
                for (const task of Object.values(data.agentTasks) as Array<{ agentId?: string; output?: string; ticketId?: string }>) {
                  if (task.agentId && task.output) {
                    outputs[task.agentId] = task.output;
                  }
                  if (task.agentId && task.ticketId) {
                    agentTicketMapRef.current[task.agentId] = task.ticketId;
                  }
                }
                originalOutputsRef.current = outputs;
              }
              if (data.phase === "complete") {
                // Completed workflow → show final state, replay available on demand
                wasLoadedCompleteRef.current = true;
                setReplayMode(true);
                if (interval) { clearInterval(interval); interval = null; }
                // Pre-fetch full output for all completed agents so panel opens instantly
                for (const task of Object.values(data.agentTasks) as Array<{ agentId?: string; status?: string }>) {
                  if (task.agentId && task.status === "complete") {
                    fetch(`/api/workflow/${workflowId}/agent-output?agentId=${task.agentId}`)
                      .then((r) => r.json())
                      .then((d) => { if (d.output) setAgentFullOutput((prev) => ({ ...prev, [task.agentId!]: d.output })); })
                      .catch(() => {});
                  }
                }
                fetch(`/api/workflow/${workflowId}/events`)
                  .then((r) => r.json())
                  .then((evData) => {
                    if (evData.events?.length) {
                      setReplayEvents(evData.events);
                      // Start at the END so user sees completed state immediately
                      setReplayIndex(evData.events.length - 1);
                    }
                  })
                  .catch(() => {});
              } else {
                // Live workflow → catch-up replay then transition to SSE
                setCatchingUp(true);
                if (interval) { clearInterval(interval); interval = null; }
                fetch(`/api/workflow/${workflowId}/events`)
                  .then((r) => r.json())
                  .then((evData) => {
                    if (evData.events?.length) {
                      // Store the last eventId so SSE can start from there
                      const lastEv = evData.events[evData.events.length - 1];
                      lastEventIdRef.current = lastEv.eventId || "";
                      setReplayMode(true);
                      setReplayEvents(evData.events);
                      // Catch-up uses uniform spacing (3s / eventCount) — no speed calc needed
                      setPlaybackSpeed(1);
                      setIsPlaying(true);

                      // Seed last activity timestamp and last event per agent from historical events.
                      // This ensures stuck detection works immediately on page load for stale agents.
                      const lastPerAgent: Record<string, { event: string; timestamp: number; tool?: string }> = {};
                      for (const ev of evData.events) {
                        if (!ev.agentId) continue;
                        const ts = ev.timestamp ? new Date(ev.timestamp).getTime() : 0;
                        if (ev.type === "tool_use") {
                          const displayName = (ev.toolName || "").replace(/___/g, " → ").replace(/_/g, " ");
                          lastPerAgent[ev.agentId] = { event: `Tool: ${displayName}`, timestamp: ts, tool: ev.toolName };
                        } else if (ev.type === "agent_output") {
                          lastPerAgent[ev.agentId] = { event: "Streaming text...", timestamp: ts, tool: lastPerAgent[ev.agentId]?.tool };
                        } else if (ev.type === "agent_status" || ev.type === "agent_complete") {
                          lastPerAgent[ev.agentId] = { event: `Agent ${ev.status || "complete"}`, timestamp: ts, tool: lastPerAgent[ev.agentId]?.tool };
                        }
                      }
                      // Find the most recent event across all running agents
                      const runningAgents = Object.entries(data.agentTasks || {})
                        .filter(([, t]) => (t as { status?: string }).status === "running")
                        .map(([, t]) => (t as { agentId?: string }).agentId || "");
                      let latestTs = 0;
                      const eventMap: Record<string, string> = {};
                      for (const agentId of runningAgents) {
                        if (lastPerAgent[agentId]) {
                          eventMap[agentId] = lastPerAgent[agentId].event;
                          if (lastPerAgent[agentId].tool) {
                            lastToolPerAgentRef.current[agentId] = lastPerAgent[agentId].tool!;
                          }
                          if (lastPerAgent[agentId].timestamp > latestTs) {
                            latestTs = lastPerAgent[agentId].timestamp;
                          }
                        }
                      }
                      if (Object.keys(eventMap).length > 0) {
                        setLastEventPerAgent((prev) => ({ ...prev, ...eventMap }));
                      }
                      // Seed lastActivityRef from actual event timestamps (not page load time)
                      if (latestTs > 0) {
                        lastActivityRef.current = latestTs;
                      }
                    } else {
                      // No historical events — go straight to live
                      setCatchingUp(false);
                    }
                  })
                  .catch(() => { setCatchingUp(false); });
              }
            }
            isFirstFetch = false;
          }
        })
        .catch(() => {});
    };

    fetchState();
    // Only poll for live workflows (will be stopped if replay/catch-up kicks in)
    interval = setInterval(fetchState, 3000);
    return () => { if (interval) clearInterval(interval); };
  }, [workflowId]);

  // Fetch ticket statuses — re-fetches when agentTasks change (new tickets appear)
  const agentTaskKeys = state?.agentTasks ? Object.keys(state.agentTasks).sort().join(",") : "";
  useEffect(() => {
    const fetchTickets = () => {
      fetch(`/api/workflow/${workflowId}/tickets`)
        .then((r) => r.json())
        .then((data) => {
          if (data.tickets && Array.isArray(data.tickets)) {
            const map: Record<string, { status: TicketStatus; title: string; updatedAt: string; assignee?: string }> = {};
            for (const ticket of data.tickets) {
              const id = ticket.ticketId || ticket.id;
              map[id] = {
                status: ticket.status,
                title: ticket.title || ticket.summary || id,
                updatedAt: ticket.updatedAt || new Date().toISOString(),
                assignee: ticket.assignee,
              };
            }
            // Override with DDB agentTasks — Jira search index can lag behind actual status
            if (state?.agentTasks) {
              for (const task of Object.values(state.agentTasks) as Array<{ ticketId?: string; status?: string }>) {
                if (task.ticketId && task.status === "complete" && map[task.ticketId] && map[task.ticketId].status !== "done") {
                  map[task.ticketId] = { ...map[task.ticketId], status: "done" };
                }
              }
            }
            setTicketStatusMap(map);
          }
        })
        .catch(() => {});
    };
    fetchTickets();
    // Poll every 15s while workflow is active (no SSE ticket_update events yet)
    const isActive = state?.phase && state.phase !== "complete";
    if (!isActive) return;
    const interval = setInterval(fetchTickets, 15_000);
    return () => clearInterval(interval);
  }, [workflowId, agentTaskKeys, state?.phase]);


  // Live-poll agent output while panel is open and agent is running
  useEffect(() => {
    if (!expandedAgent || !state) return;
    const agentTask = Object.values(state.agentTasks).find((t) => t.agentId === expandedAgent);
    if (!agentTask || agentTask.status === "complete" || agentTask.status === "error") return;

    const poll = () => {
      fetch(`/api/workflow/${workflowId}/agent-output?agentId=${expandedAgent}`)
        .then((r) => r.json())
        .then((d) => {
          if (d.output) {
            setAgentFullOutput((prev) => ({ ...prev, [expandedAgent]: d.output }));
          }
        })
        .catch(() => {});
    };

    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, [expandedAgent, state?.agentTasks, workflowId]);

  // Replay playback timer — uses real timestamps for natural pacing
  // Only re-runs when isPlaying or playbackSpeed changes (not on every replayIndex tick)
  const replayIndexRef = useRef(replayIndex);
  replayIndexRef.current = replayIndex;

  useEffect(() => {
    if (!isPlaying || replayEvents.length === 0) return;
    let stopped = false;

    const scheduleNext = () => {
      const currentIdx = replayIndexRef.current;
      if (stopped || currentIdx >= replayEvents.length - 1) {
        if (!stopped) {
          setIsPlaying(false);
          // If catching up, transition to live SSE
          if (catchingUp) {
            catchUpCompleteRef.current = true;
            setCatchingUp(false);
            setReplayMode(false);
          }
        }
        return;
      }
      if (catchingUp) {
        // Catch-up: always finish in 3 seconds.
        // Few events → slow ticks (one event per tick, spread over 3s)
        // Many events → fast ticks (batch events per 16ms frame)
        const TARGET_MS = 3000;
        const MIN_TICK = 16; // browser frame budget
        const tickDelay = Math.max(MIN_TICK, TARGET_MS / replayEvents.length);
        const eventsPerTick = tickDelay <= MIN_TICK
          ? Math.max(1, Math.round(replayEvents.length / (TARGET_MS / MIN_TICK)))
          : 1;
        if (currentIdx === 0) console.log(`[catch-up] ${replayEvents.length} events, ${eventsPerTick}/tick @ ${tickDelay.toFixed(0)}ms, ~3s total`);

        replayTimerRef.current = setTimeout(() => {
          if (stopped) return;
          const nextIdx = Math.min(replayIndexRef.current + eventsPerTick, replayEvents.length - 1);
          setReplayIndex(nextIdx);
          scheduleNext();
        }, tickDelay);
      } else {
        // Normal replay: timestamp-based with playback speed
        const currentTs = new Date(replayEvents[currentIdx].timestamp || 0).getTime();
        const nextTs = new Date(replayEvents[currentIdx + 1].timestamp || 0).getTime();
        const realDelay = Math.max(0, nextTs - currentTs);
        const delay = Math.min(2000, Math.max(50, realDelay / playbackSpeed));

        replayTimerRef.current = setTimeout(() => {
          if (stopped) return;
          setReplayIndex(replayIndexRef.current + 1);
          scheduleNext();
        }, delay);
      }
    };

    scheduleNext();
    return () => {
      stopped = true;
      if (replayTimerRef.current) clearTimeout(replayTimerRef.current);
    };
  }, [isPlaying, playbackSpeed, replayEvents, catchingUp]);

  // Fire visual effects for the current replay event (without touching state)
  // Tracks the highest phase index that has been animated, to fire connectors on first entry
  const replayPhaseHighWaterRef = useRef(0);
  const fireReplayVisuals = useCallback((event: WorkflowEvent) => {
    if (event.type === "phase_change") {
      const newPhaseIndex = phaseOrderRef.current[event.phase] ?? -1;
      if (newPhaseIndex > 0 && newPhaseIndex > replayPhaseHighWaterRef.current) {
        replayPhaseHighWaterRef.current = newPhaseIndex;
        setActiveConnector(newPhaseIndex - 1);
        setTimeout(() => setActiveConnector(null), 1200);
      }
    } else if (event.type === "agent_status" && event.status === "running") {
      // If an agent starts in a new phase we haven't animated yet, fire the connector
      const agentPhaseIdx = pipelinePhasesRef.current.findIndex((p) =>
        p.agents.some((a) => a.agentId === event.agentId)
      );
      if (agentPhaseIdx > 0 && agentPhaseIdx > replayPhaseHighWaterRef.current) {
        replayPhaseHighWaterRef.current = agentPhaseIdx;
        setActiveConnector(agentPhaseIdx - 1);
        setTimeout(() => setActiveConnector(null), 1200);
      }
    } else if (event.type === "tool_use") {
      const resolved = resolveToolIcon(event.toolName);
      if (resolved) {
        const agentPhase = pipelinePhasesRef.current.find((p) => p.agents.some((a) => a.agentId === event.agentId));
        if (agentPhase) {
          const flashKey = `${agentPhase.id}:${resolved.icon}`;
          setToolFlashes((prev) => ({ ...prev, [flashKey]: true }));
          if (toolFlashTimers.current[flashKey]) clearTimeout(toolFlashTimers.current[flashKey]);
          toolFlashTimers.current[flashKey] = setTimeout(() => {
            setToolFlashes((prev) => ({ ...prev, [flashKey]: false }));
          }, 1600);
        }
      }
    } else if (event.type === "nudge") {
      // Hot pink full-screen pulse for nudge events
      setNudgePulse(true);
      setTimeout(() => setNudgePulse(false), 1500);
    } else if (event.type === "manager_intervention" || event.type === "manager_escalation") {
      // Sky pulse + toast when the Workflow Manager acts on this run.
      setManagerPulse(managerPulseText(event));
      setTimeout(() => setManagerPulse(null), 4000);
    }
  }, []);

  // Apply events up to replayIndex when it changes
  // Runs in replay mode OR when user scrubs back during live (DVR)
  useEffect(() => {
    if (replayEvents.length === 0) return;
    // In live mode at the live edge, state is driven by handleEvent — skip reconstruction
    if (!replayMode && atLiveEdge) return;
    // If scrubber is at the very end, just set phase to "complete" directly
    // This avoids any reconstruction race that could flash a non-complete state
    const atEnd = replayIndex >= replayEvents.length - 1;
    // Reconstruct state from scratch up to replayIndex
    setState((baseState) => {
      if (!baseState) return baseState;
      // Intake is always "done" in replay — no events exist for it.
      // Start at "requirements" since the first DDB event is already a requirements agent.
      let s: WorkflowState = { ...baseState, phase: "requirements", agentTasks: {} };
      for (let i = 0; i <= replayIndex && i < replayEvents.length; i++) {
        s = applyEventToState(s, replayEvents[i]);
      }
      // If at end and workflow was loaded as complete, force phase to "complete"
      // (handles race conditions and missing workflow_complete events)
      if (atEnd && wasLoadedCompleteRef.current) {
        s.phase = "complete";
      }
      // Merge DDB outputs into replay state (events don't carry output text)
      const savedOutputs = originalOutputsRef.current;
      for (const [agentId, output] of Object.entries(savedOutputs)) {
        if (s.agentTasks[agentId] && !s.agentTasks[agentId].output) {
          s.agentTasks[agentId] = { ...s.agentTasks[agentId], output };
        }
      }
      return s;
    });
    // Fire visual effects for just the current event
    if (replayIndex < replayEvents.length) {
      fireReplayVisuals(replayEvents[replayIndex]);
    }
  }, [replayIndex, replayMode, replayEvents, atLiveEdge, fireReplayVisuals]);


  // Seek to a specific position
  const seekTo = useCallback((index: number) => {
    const target = Math.max(0, Math.min(index, replayEvents.length - 1));
    // Reset high-water mark when seeking backward so connectors re-fire
    if (target < replayIndexRef.current) {
      replayPhaseHighWaterRef.current = 0;
    }
    setReplayIndex(target);
    // DVR: track if user is at the live edge
    setAtLiveEdge(target >= replayEvents.length - 1);
  }, [replayEvents.length]);

  // DVR: snap to live edge
  const snapToLive = useCallback(() => {
    setReplayIndex(replayEvents.length - 1);
    setAtLiveEdge(true);
    setIsPlaying(false);
  }, [replayEvents.length]);

  // Start/stop replay
  const togglePlay = useCallback(() => {
    if (replayIndex >= replayEvents.length - 1) {
      // If at end, restart from beginning
      replayPhaseHighWaterRef.current = 0;
      setReplayIndex(0);
      setIsPlaying(true);
    } else {
      setIsPlaying((p) => !p);
    }
  }, [replayIndex, replayEvents.length]);

  // Use a ref to avoid stale closure for atLiveEdge in handleEvent
  const atLiveEdgeRef = useRef(atLiveEdge);
  atLiveEdgeRef.current = atLiveEdge;

  const handleEvent = useCallback((event: WorkflowEvent) => {
    // DVR: always append to timeline so scrubber can access history.
    // Set replayIndex to align with new length (not prev+1) so the counter
    // stays consistent when starting from an empty timeline (no catch-up).
    setReplayEvents((prev) => {
      const next = [...prev, event];
      if (atLiveEdgeRef.current) {
        setReplayIndex(next.length - 1);
      }
      return next;
    });

    switch (event.type) {
      case "phase_change": {
        const newPhaseIndex = phaseOrderRef.current[event.phase] ?? -1;
        // Animate the connector FROM the previous phase TO the new phase
        if (newPhaseIndex > 0) {
          const connectorIndex = newPhaseIndex - 1;
          setActiveConnector(connectorIndex);
          setTimeout(() => setActiveConnector(null), 1200);
        }
        setState((s) => s ? { ...s, phase: event.phase } : s);
        break;
      }
      case "agent_status":
        // If an agent starts running in a phase beyond current, animate the connector
        if (event.status === "running") {
          const agentPhase = pipelinePhasesRef.current.findIndex((p) =>
            p.agents.some((a) => a.agentId === event.agentId)
          );
          if (agentPhase > 0 && activeConnector === null) {
            setState((s) => {
              const curIdx = s ? (phaseOrderRef.current[s.phase] ?? -1) : -1;
              if (agentPhase > curIdx) {
                setActiveConnector(agentPhase - 1);
                setTimeout(() => setActiveConnector(null), 1200);
              }
              return s;
            });
          }
        }
        if (event.ticketId) {
          agentTicketMapRef.current[event.agentId] = event.ticketId;
        }
        setState((s) => {
          if (!s) return s;
          const tasks = { ...s.agentTasks };
          if (tasks[event.agentId]) {
            // Never regress a completed agent back to running (late/duplicate events)
            if (tasks[event.agentId].status === "complete") return s;
            tasks[event.agentId] = { ...tasks[event.agentId], status: event.status };
          } else {
            tasks[event.agentId] = {
              id: `task_${Date.now()}`,
              agentId: event.agentId,
              ticketId: event.ticketId || "",
              status: event.status,
              input: "",
            };
          }
          return { ...s, agentTasks: tasks };
        });
        if (event.agentId) {
          setLastEventPerAgent((prev) => ({ ...prev, [event.agentId]: `Agent ${event.status}` }));
        }
        break;
      case "agent_output":
        // streamingText accumulation handled by useWorkflowStream hook
        setLastEventPerAgent((prev) => ({ ...prev, [event.agentId]: "Streaming text..." }));
        break;
      case "tool_use": {
        // Track last tool per agent for tiered stale detection
        if (event.agentId && event.toolName) {
          lastToolPerAgentRef.current[event.agentId] = event.toolName;
          const displayName = event.toolName.replace(/___/g, " → ").replace(/_/g, " ");
          setLastEventPerAgent((prev) => ({ ...prev, [event.agentId]: `Tool: ${displayName}` }));
        }
        // Flash the corresponding icon/item in the pipeline
        const resolved = resolveToolIcon(event.toolName);
        if (resolved) {
          // Find which phase this agent belongs to
          const agentPhase = pipelinePhasesRef.current.find((p) =>
            p.agents.some((a) => a.agentId === event.agentId)
          );
          if (agentPhase) {
            const flashKey = `${agentPhase.id}:${resolved.icon}`;
            // Set flash active
            setToolFlashes((prev) => ({ ...prev, [flashKey]: true }));
            // Clear any existing timer for this key
            if (toolFlashTimers.current[flashKey]) {
              clearTimeout(toolFlashTimers.current[flashKey]);
            }
            // Auto-clear after 1600ms
            toolFlashTimers.current[flashKey] = setTimeout(() => {
              setToolFlashes((prev) => ({ ...prev, [flashKey]: false }));
            }, 1600);
          }
        }
        break;
      }
      case "agent_complete":
        setState((s) => {
          if (!s) return s;
          const tasks = { ...s.agentTasks };
          const key = tasks[event.agentId]
            ? event.agentId
            : Object.keys(tasks).find((k) => tasks[k].agentId === event.agentId);
          if (key) {
            // Preserve accumulated streaming text — only use event.output if it's longer
            const existingOutput = tasks[key].output || "";
            const newOutput = event.output || "";
            tasks[key] = {
              ...tasks[key],
              status: "complete",
              output: newOutput.length > existingOutput.length ? newOutput : existingOutput,
              branch: event.branch,
              commitSha: event.commitSha,
            };
          }
          return { ...s, agentTasks: tasks };
        });
        // Don't delete streamingText — it may be the best source until API fetch completes
        break;
      case "workflow_complete":
        setState((s) => s ? { ...s, phase: "complete" } : s);
        setCelebrating(true);
        setTimeout(() => setCelebrating(false), 1300);
        break;
      case "ticket_update":
        setTicketStatusMap((prev) => ({
          ...prev,
          [event.ticketId]: {
            status: event.status,
            title: prev[event.ticketId]?.title || event.ticketId,
            updatedAt: event.timestamp || new Date().toISOString(),
            // ticket_update carries no assignee — preserve the stored one so the
            // pending-review banner still matches human:* gates on live updates.
            assignee: prev[event.ticketId]?.assignee,
          },
        }));
        break;
      case "ticket_created":
        setTicketStatusMap((prev) => ({
          ...prev,
          [event.ticket.id]: {
            status: event.ticket.status,
            title: event.ticket.title,
            updatedAt: event.ticket.updatedAt || event.timestamp || new Date().toISOString(),
            // Carry assignee so a human:* gate lights the banner immediately,
            // not only on the next /tickets poll.
            assignee: event.ticket.assignee,
          },
        }));
        // Wire the agent → ticket mapping so the badge renders on the agent's slot
        // immediately, before the agent is invoked and emits its own agent_status event.
        if (event.ticket.assignee) {
          agentTicketMapRef.current[event.ticket.assignee] = event.ticket.id;
          // Seed agentTasks with a "pending" entry so the slot picks up the ticketId
          // without waiting for invocation. Status will transition via agent_status events.
          setState((s) => {
            if (!s) return s;
            if (s.agentTasks[event.ticket.assignee!]) return s;
            return {
              ...s,
              agentTasks: {
                ...s.agentTasks,
                [event.ticket.assignee!]: {
                  id: `task_${Date.now()}`,
                  agentId: event.ticket.assignee!,
                  ticketId: event.ticket.id,
                  status: "pending",
                  input: "",
                },
              },
            };
          });
        }
        break;
      case "nudge":
        // Live nudge pulse — matches fireReplayVisuals so a nudge surfaces as it
        // happens, not only on replay scrub.
        setNudgePulse(true);
        setTimeout(() => setNudgePulse(false), 1500);
        break;
      case "manager_intervention":
      case "manager_escalation":
        // Sky pulse + toast the moment the Workflow Manager unsticks/retries/
        // comments/escalates a live run (previously only fired in replay).
        setManagerPulse(managerPulseText(event));
        setTimeout(() => setManagerPulse(null), 4000);
        break;
      default:
        break;
    }
  }, [activeConnector]);

  // SSE connection — managed by useWorkflowStream hook (must be after handleEvent definition)
  const { streamStatus, streamingText } = useWorkflowStream({
    workflowId,
    enabled: !replayMode && !catchingUp,
    initialCursor: lastEventIdRef.current,
    onEvent: handleEvent,
    onStateRecovered: (data) => { if (data && data.id) setState(data); },
  });

  // Animate connector dot — exact same logic as demo HTML animateConnector()
  const animateConnectorDot = useCallback((connectorIndex: number, duration = 900) => {
    const svg = pipelineRef.current?.querySelector(".pipeline-connectors") as SVGSVGElement | null;
    if (!svg) return;
    const path = svg.querySelector(`#connector-path-${connectorIndex}`) as SVGPathElement | null;
    const dot = svg.querySelector(`circle[data-connector="${connectorIndex}"]`) as SVGCircleElement | null;
    if (!path || !dot) return;
    const pathLen = path.getTotalLength();
    if (pathLen === 0) return;
    path.classList.add("active");
    const startT = performance.now();
    dot.style.opacity = "1";
    function tick(now: number) {
      const t = Math.min((now - startT) / duration, 1);
      // Ease-in-out quadratic (same as demo)
      const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
      const pt = path!.getPointAtLength(ease * pathLen);
      dot!.setAttribute("cx", String(pt.x));
      dot!.setAttribute("cy", String(pt.y));
      // Fade in first 5%, fade out last 10% (same as demo)
      dot!.style.opacity = t < 0.05 ? String(t / 0.05) : t > 0.9 ? String((1 - t) / 0.1) : "1";
      if (t < 1) {
        requestAnimationFrame(tick);
      } else {
        dot!.style.opacity = "0";
        path!.classList.remove("active");
      }
    }
    requestAnimationFrame(tick);
  }, []);

  // Derive visual states from workflow state
  const currentPhaseIndex = state ? (phaseOrder[state.phase] ?? -1) : -1;
  const isComplete = state?.phase === "complete";
  const isSettled = isComplete && !celebrating;

  // Trigger connector animation when activeConnector changes
  useEffect(() => {
    if (activeConnector !== null) {
      animateConnectorDot(activeConnector, 900);
    }
  }, [activeConnector, animateConnectorDot]);

  // On initial load of a live workflow, animate completed connectors
  const hasAnimatedRef = useRef(false);
  useEffect(() => {
    if (replayMode || hasAnimatedRef.current || currentPhaseIndex <= 0 || connectorPaths.length === 0) return;
    hasAnimatedRef.current = true;
    for (let i = 0; i < currentPhaseIndex && i < connectorPaths.length; i++) {
      setTimeout(() => animateConnectorDot(i, 800), i * 400);
    }
  }, [replayMode, currentPhaseIndex, connectorPaths, animateConnectorDot]);

  // On replay start, animate the intake→requirements connector (hardcoded since intake has no DDB events)
  const hasPlayedIntakeRef = useRef(false);
  useEffect(() => {
    if (!replayMode || replayEvents.length === 0 || hasPlayedIntakeRef.current) return;
    if (connectorPaths.length > 0) {
      hasPlayedIntakeRef.current = true;
      setTimeout(() => animateConnectorDot(0, 700), 300);
    }
  }, [replayMode, replayEvents, connectorPaths, animateConnectorDot]);

  // ─── Auto-Nudge: if workflow active, no agent running, idle >60s → auto-fix stuck tickets ───
  const lastActivityRef = useRef<number>(Date.now());
  const nudgeFiredRef = useRef<string>(""); // tracks workflowId+phase to avoid repeat nudges
  const [isStale, setIsStale] = useState(false);
  // Track last tool called per agent — used for tiered stale thresholds
  const lastToolPerAgentRef = useRef<Record<string, string>>({});
  // Track last event description per agent — displayed in panel footer
  const [lastEventPerAgent, setLastEventPerAgent] = useState<Record<string, string>>({});
  // Manual override: user can click status dot to force-mark an agent as stuck
  const [manualStaleAgents, setManualStaleAgents] = useState<Set<string>>(new Set());
  // Track total streaming length to detect NEW content (not just presence of old keys)
  // Initialize to -1 as sentinel: first effect run seeds the baseline without resetting activity
  const prevStreamingLenRef = useRef(-1);
  // Update activity timestamp only on ACTUAL new streaming (not just status="running" in DDB)
  // A dead agent still has status="running" and stale keys in streamingText.
  useEffect(() => {
    if (!state || state.phase === "complete" || state.phase === "error") return;
    const totalLen = Object.values(streamingText).reduce((sum, t) => sum + t.length, 0);
    // First run: seed baseline from whatever is already in streamingText (stale content from dead agent)
    if (prevStreamingLenRef.current === -1) {
      prevStreamingLenRef.current = totalLen;
      return;
    }
    if (totalLen > prevStreamingLenRef.current) {
      prevStreamingLenRef.current = totalLen;
      lastActivityRef.current = Date.now();
      // Reset nudge flag when activity resumes (new phase or agent started)
      nudgeFiredRef.current = "";
      if (isStale) setIsStale(false);
      if (manualStaleAgents.size > 0) setManualStaleAgents(new Set());
    }
  }, [state, streamingText, isStale, manualStaleAgents]);

  // Load the Workflow Manager watch flag for this run.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/workflow/${workflowId}/watch`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d && typeof d.watch === "boolean") setManagerWatch(d.watch); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [workflowId]);

  const toggleManagerWatch = useCallback(async () => {
    const next = !managerWatch;
    setManagerWatch(next); // optimistic
    try {
      const res = await fetch(`/api/workflow/${workflowId}/watch`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ watch: next }),
      });
      if (!res.ok) setManagerWatch(!next); // revert on failure
    } catch {
      setManagerWatch(!next);
    }
  }, [managerWatch, workflowId]);

  useEffect(() => {
    if (!state || state.phase === "complete" || state.phase === "error" || replayMode) return;
    const check = setInterval(() => {
      const idle = Date.now() - lastActivityRef.current;
      const hasRunning = Object.values(state.agentTasks || {}).some(
        (t) => t.status === "running" || t.status === "waiting_response"
      );
      const nudgeKey = `${workflowId}:${state.phase}`;

      // Tiered stale threshold based on last tool called:
      // - claude_code: 12 min (600s timeout + 120s buffer) — it goes dark for the full run
      // - anything else: 3 min — normal tools return in seconds
      const runningAgents = Object.entries(state.agentTasks || {})
        .filter(([, t]) => t.status === "running" || t.status === "waiting_response")
        .map(([key]) => key);
      const anyInClaudeCode = runningAgents.some(
        (id) => lastToolPerAgentRef.current[id] === "claude_code"
      );
      const staleThreshold = anyInClaudeCode ? 1_020_000 : 180_000; // 17 min (15 min timeout + 2 min buffer) vs 3 min

      if (hasRunning && idle > staleThreshold && !isStale) {
        setIsStale(true);
      }

      // Fire nudge if:
      // 1. No agent is currently running (impossible stuck state — e.g. blocked with no blockers)
      // 2. OR idle for >90s (agent accepted but timed out / crashed without completing)
      const shouldNudge = (!hasRunning || idle > 90_000) && nudgeFiredRef.current !== nudgeKey;

      if (shouldNudge) {
        nudgeFiredRef.current = nudgeKey;
        fetch(`/api/workflow/${workflowId}/nudge`, { method: "POST" })
          .then((r) => r.json())
          .then((data) => {
            if (data.nudged?.length > 0) {
              console.log(`[auto-nudge] Fixed ${data.nudged.length} ticket(s):`, data.nudged);
              setNudgePulse(true);
              setTimeout(() => setNudgePulse(false), 1500);
            }
          })
          .catch(() => {});
      }
    }, 15_000); // check every 15s
    return () => clearInterval(check);
  }, [workflowId, state?.phase, replayMode, isStale]);

  // Measure element positions and compute connector paths:
  // FROM: last output/trigger item (right edge) of phase[i]
  // TO: agent-box (left edge) of phase[i+1]
  // Also computes skip-connectors for phases that jump over inactive phases.
  useEffect(() => {
    const canvas = pipelineRef.current;
    if (!canvas) return;
    const timer = setTimeout(() => {
      const canvasRect = canvas.getBoundingClientRect();
      const phases = canvas.querySelectorAll(".phase");
      const paths: string[] = [];

      // Helper: compute bezier path between two elements
      const computePath = (fromEl: Element, toEl: Element): string => {
        const fromRect = fromEl.getBoundingClientRect();
        const toRect = toEl.getBoundingClientRect();
        const fromX = fromRect.right - canvasRect.left;
        const fromY = fromRect.top + fromRect.height / 2 - canvasRect.top;
        const toX = toRect.left - canvasRect.left;
        const toY = toRect.top + toRect.height / 2 - canvasRect.top;
        const dx = toX - fromX;
        const dy = toY - fromY;
        if (Math.abs(dx) > Math.abs(dy) * 0.8) {
          const cpx = dx * 0.4;
          return `M ${fromX} ${fromY} C ${fromX + cpx} ${fromY}, ${toX - cpx} ${toY}, ${toX} ${toY}`;
        } else {
          const cpy = dy * 0.4;
          return `M ${fromX} ${fromY} C ${fromX} ${fromY + cpy}, ${toX} ${toY - cpy}, ${toX} ${toY}`;
        }
      };

      // Standard adjacent connectors
      for (let i = 0; i < phases.length - 1; i++) {
        const fromPhase = phases[i];
        const toPhase = phases[i + 1];
        if (!fromPhase || !toPhase) { paths.push(""); continue; }
        const fromItems = fromPhase.querySelectorAll(".work-area .item");
        const fromEl = fromItems[fromItems.length - 1];
        const toEl = toPhase.querySelector(".agent-box");
        if (!fromEl || !toEl) { paths.push(""); continue; }
        paths.push(computePath(fromEl, toEl));
      }
      setConnectorPaths(paths);

      // Skip-connectors: when phase[i] is done/active and phase[i+1] is inactive,
      // find the next non-inactive phase and draw a direct connector.
      const skips: Array<{ d: string; fromIdx: number; toIdx: number }> = [];
      for (let i = 0; i < phases.length - 1; i++) {
        const fromStatus = getPhaseStatus(i);
        const nextStatus = getPhaseStatus(i + 1);
        if (fromStatus !== "inactive" && nextStatus === "inactive") {
          // Find next non-inactive phase after the gap
          for (let j = i + 2; j < phases.length; j++) {
            const jStatus = getPhaseStatus(j);
            if (jStatus !== "inactive") {
              const fromPhase = phases[i];
              const toPhase = phases[j];
              if (!fromPhase || !toPhase) break;
              const fromItems = fromPhase.querySelectorAll(".work-area .item");
              const fromEl = fromItems[fromItems.length - 1];
              const toEl = toPhase.querySelector(".agent-box");
              if (!fromEl || !toEl) break;
              skips.push({ d: computePath(fromEl, toEl), fromIdx: i, toIdx: j });
              break;
            }
          }
        }
      }
      setSkipConnectors(skips);
    }, 150);
    return () => clearTimeout(timer);
  // ticketStatusMap is included so connectors re-measure when an inline review
  // card appears/disappears (it shifts the phase's .item elements).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.phase, celebrating, state?.agentTasks, ticketStatusMap]);

  // Derive phase status from ticket data (agent task statuses)
  const getPhaseStatus = (phaseIndex: number): "inactive" | "active" | "done" => {
    if (!state) return "inactive";
    const phase = pipelinePhases[phaseIndex];
    if (!phase) return "inactive";

    // Intake phase (no agents) — done once any agent task exists
    if (phase.agents.length === 0) {
      return Object.keys(state.agentTasks).length > 0 ? "done" : "inactive";
    }

    const tasks = phase.agents.map((a) => state.agentTasks[a.agentId]).filter(Boolean);
    if (tasks.length === 0) return "inactive";

    // Active = at least one agent is running/waiting
    const hasRunning = tasks.some(
      (t) => t.status === "running" || t.status === "waiting_response"
    );
    if (hasRunning) return "active";

    // Done = all agents that have tasks are complete
    const allComplete = tasks.every((t) => t.status === "complete");
    if (allComplete) return "done";

    // Has tasks but none running and not all complete = inactive (pending)
    return "inactive";
  };

  const getPhaseClass = (phaseIndex: number) => {
    const status = getPhaseStatus(phaseIndex);
    if (isSettled) {
      // Only show settled state for phases that actually had activity
      return status !== "inactive" ? "active done settled" : "";
    }
    if (isComplete) {
      return status !== "inactive" ? "active done" : "";
    }
    if (status === "active") return "active";
    if (status === "done") return "active done";
    return "";
  };

  const getBoxClass = (phaseIndex: number) => {
    const status = getPhaseStatus(phaseIndex);
    if (isSettled) {
      return status !== "inactive" ? "done settled" : "";
    }
    if (isComplete) {
      return status !== "inactive" ? "done" : "";
    }
    if (status === "active") return "awake";
    if (status === "done") return "done";
    return "";
  };

  const getItemClass = (phaseIndex: number): string => {
    if (!state) return "";
    const status = getPhaseStatus(phaseIndex);
    if (isSettled) return status !== "inactive" ? "done settled" : "";
    if (isComplete) return status !== "inactive" ? "done" : "";
    if (status === "active") return "active-glow";
    if (status === "done") return "done";
    return "";
  };

  if (!state) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-secondary">Loading pipeline...</div>
      </div>
    );
  }

  // Human-review gates currently awaiting a person: tickets parked in_review
  // with a human:* assignee. Rendered as a small card inside the phase the gate
  // guards (def.reviewGates.afterPhase → pipeline phase id), so the signal is
  // local to the step. Any gate we can't map to a visible phase falls back to a
  // top banner so it's never hidden.
  const reviewGates = getWorkflowDef(workflowDefId).reviewGates || [];
  const pendingReviews = Object.entries(ticketStatusMap)
    .filter(([, t]) => t.status === "in_review" && (t.assignee || "").startsWith("human:"))
    .map(([ticketId, t]) => {
      const who = (t.assignee || "").slice("human:".length);
      const initials = who
        .split(/[\s._-]+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((p) => p[0]?.toUpperCase() || "")
        .join("") || "?";
      // Map the gate ticket → the phase it guards. Match the gate config whose
      // name appears in the ticket title (the agent names the ticket after the
      // gate, e.g. "Design Review"); fall back to the first gate's afterPhase.
      const title = t.title || "";
      const gate =
        reviewGates.find((g) => g.name && title.toLowerCase().includes(g.name.toLowerCase())) ||
        (reviewGates.length === 1 ? reviewGates[0] : undefined);
      const phaseId = gate
        ? pipelinePhases.find((p) => p.agentPhase === gate.afterPhase || p.id === gate.afterPhase)?.id
        : undefined;
      return { ticketId, title: t.title, reviewer: who, initials, phaseId };
    });
  const unplacedReviews = pendingReviews.filter((r) => !r.phaseId);

  return (
    <div className={celebrating ? "celebrate-wrapper" : ""}>
      <style dangerouslySetInnerHTML={{ __html: PIPELINE_STYLES + REVIEW_BANNER_STYLES }} />

      {/* Nudge pulse overlay — hot pink full-screen flash during replay */}
      {nudgePulse && (
        <div className="nudge-pulse-overlay" />
      )}

      {/* Workflow Manager toast — surfaces watch-mode interventions/escalations */}
      {managerPulse && (
        <div className="wm-pulse-toast" role="status">
          <ClipboardCheck className="w-4 h-4" />
          <span>{managerPulse}</span>
        </div>
      )}

      {/* Fallback top banner — only for gates we couldn't place on a phase card. */}
      {unplacedReviews.length > 0 && (
        <div className="review-banner" role="status">
          {unplacedReviews.map((r) => (
            <button
              key={r.ticketId}
              className="review-banner-item"
              onClick={() => handleOpenTicketModal(r.ticketId)}
              title={`Open ${r.ticketId} to approve or request changes`}
            >
              <span className="review-avatar" aria-hidden>{r.initials}</span>
              <span className="review-banner-text">
                <span className="review-banner-label">Pending human review</span>
                <span className="review-banner-detail">{r.title} · {r.reviewer} · {r.ticketId}</span>
              </span>
              <span className="review-banner-cta">Review →</span>
            </button>
          ))}
        </div>
      )}

      <div className="pipeline-viz">
        {/* Top bar: scrubber left, status right */}
        <div className="pipeline-top-bar">
          {replayEvents.length > 0 && (
            <div className="replay-bar">
              {catchingUp ? (
                <>
                  <span className="catching-up-indicator">Catching up...</span>
                  <input
                    type="range"
                    className="replay-scrubber"
                    min={0}
                    max={replayEvents.length - 1}
                    value={replayIndex}
                    readOnly
                  />
                  <span className="replay-counter">{replayIndex + 1} / {replayEvents.length}</span>
                </>
              ) : (
                <>
                  <button className="replay-btn" onClick={togglePlay} title={isPlaying ? "Pause" : "Replay"}>
                    {isPlaying ? "⏸" : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-9-9"/><polyline points="21 3 21 9 15 9"/><polygon points="10 8 16 12 10 16" fill="currentColor" stroke="none"/></svg>}
                  </button>
                  <input
                    type="range"
                    className="replay-scrubber"
                    min={0}
                    max={replayEvents.length - 1}
                    value={replayIndex}
                    onChange={(e) => seekTo(Number(e.target.value))}
                  />
                  <span className="replay-counter">{replayIndex + 1} / {replayEvents.length}</span>
                  {!atLiveEdge && !isComplete && (
                    <button className="live-btn" onClick={snapToLive} title="Jump to live">LIVE</button>
                  )}
                  {isComplete ? (
                    <select
                      className="replay-speed"
                      value={playbackSpeed}
                      onChange={(e) => setPlaybackSpeed(Number(e.target.value))}
                    >
                      <option value={1}>1x (real-time)</option>
                      <option value={3}>3x</option>
                      <option value={5}>5x</option>
                      <option value={10}>10x</option>
                      <option value={20}>20x</option>
                      <option value={50}>50x</option>
                    </select>
                  ) : (
                    <span className={`flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded ${
                      streamStatus === "live" ? "text-green-400" :
                      streamStatus === "reconnecting" ? "text-yellow-400" :
                      streamStatus === "connecting" ? "text-blue-400" : "text-zinc-500"
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${
                        streamStatus === "live" ? "bg-green-400 animate-pulse" :
                        streamStatus === "reconnecting" ? "bg-yellow-400 animate-pulse" :
                        streamStatus === "connecting" ? "bg-blue-400 animate-pulse" : "bg-zinc-500"
                      }`} />
                      {streamStatus === "live" ? "Live" :
                       streamStatus === "reconnecting" ? "Reconnecting..." :
                       streamStatus === "connecting" ? "Connecting..." : "Idle"}
                    </span>
                  )}
                </>
              )}
            </div>
          )}

          <div className={`pipeline-status-header ${isComplete ? "settled" : ""} ${state.phase === "cancelled" ? "cancelled" : ""}`}>
            {isComplete ? "Complete" : state.phase === "cancelled" ? "Cancelled" : state.phase === "error" ? "Error" : `In Progress: ${pipelinePhases[currentPhaseIndex]?.name || state.phase}`}
          </div>


          {/* Manager watch toggle + Cancel — only for active (non-terminal) workflows */}
          {state && state.phase !== "complete" && state.phase !== "error" && state.phase !== "cancelled" && (
            <button
              onClick={toggleManagerWatch}
              className={`shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium border transition-all duration-150 ${
                managerWatch
                  ? "border-sky-500/50 text-sky-400 bg-sky-500/10 hover:bg-sky-500/20"
                  : "border-zinc-600/50 text-zinc-500 hover:text-zinc-400 hover:border-zinc-500/60"
              }`}
              title={managerWatch ? "Workflow Manager is watching this run — click to disable" : "Workflow Manager watch is off — click to enable"}
              aria-pressed={managerWatch}
            >
              <ClipboardCheck className="w-3.5 h-3.5" />
              <span className="hidden md:inline">{managerWatch ? "Manager watching" : "Manager off"}</span>
            </button>
          )}
          {state && state.phase !== "complete" && state.phase !== "error" && state.phase !== "cancelled" && (
            <button
              onClick={() => { setCancelError(null); setShowCancelModal(true); }}
              disabled={cancelLoading}
              className="shrink-0 ml-2 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium border border-red-500/40 text-red-400 hover:border-red-500/60 hover:bg-red-500/10 hover:text-red-300 active:border-red-500/80 active:bg-red-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150"
              aria-label="Cancel workflow"
              title="Cancel workflow"
            >
              <Square className="w-3.5 h-3.5 fill-current" />
              <span className="hidden md:inline">Cancel</span>
            </button>
          )}
        </div>

        {/* Canvas */}
        <div className="pipeline-canvas" ref={pipelineRef}>
          {/* SVG Connectors */}
          <svg className="pipeline-connectors">
            <defs>
              <linearGradient id="flowGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#0ea5e9" stopOpacity={0.2} />
                <stop offset="50%" stopColor="#0ea5e9" stopOpacity={0.9} />
                <stop offset="100%" stopColor="#0ea5e9" stopOpacity={0.2} />
              </linearGradient>
              <filter id="pathGlow" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="3" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
              <filter id="dotGlow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="4" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            {connectorPaths.map((d, i) => {
              if (!d) return null;
              // Connector i goes from phase[i] to phase[i+1]
              const fromStatus = getPhaseStatus(i);
              const toStatus = getPhaseStatus(i + 1);
              // Show connector only if both source and destination phases had activity
              const showConnector = (fromStatus !== "inactive" && toStatus !== "inactive");
              // Active = leads to the currently-active phase (cyan glow)
              const isActiveConnector = !isComplete && !isSettled && toStatus === "active";
              // Done = both sides are done, no longer the live edge (green, dimmed)
              const isDoneConnector = (isComplete || isSettled || (fromStatus === "done" && toStatus === "done")) && !isActiveConnector;
              const pathId = `connector-path-${i}`;
              return (
                <g key={`connector-${i}`}>
                  <path
                    id={pathId}
                    className={`flow-path ${showConnector ? "show" : ""} ${isActiveConnector ? "active" : ""} ${isDoneConnector ? "done" : ""} ${isSettled ? "settled" : ""}`}
                    d={d}
                  />
                  <circle className="flow-dot" r="5" data-connector={i} style={{ opacity: 0 }} />
                </g>
              );
            })}
            {/* Skip-connectors: jump over inactive/skipped phases */}
            {skipConnectors.map((skip, i) => {
              const fromStatus = getPhaseStatus(skip.fromIdx);
              const toStatus = getPhaseStatus(skip.toIdx);
              const showSkip = fromStatus !== "inactive" && toStatus !== "inactive";
              const isActiveSkip = !isComplete && !isSettled && toStatus === "active";
              const isDoneSkip = !isComplete && !isSettled && fromStatus === "done" && toStatus === "done";
              return (
                <g key={`skip-connector-${i}`}>
                  <path
                    className={`flow-path ${showSkip ? "show" : ""} ${isActiveSkip ? "active" : ""} ${isDoneSkip ? "done" : ""} ${isSettled ? "settled" : ""}`}
                    d={skip.d}
                  />
                </g>
              );
            })}
          </svg>

          {/* Pipeline phases */}
          <div className="pipeline-phases">
            {pipelinePhases.map((phase, idx) => (
              <div
                key={phase.id}
                className={`phase ${getPhaseClass(idx)}`}
              >
                <div className={`agent-box ${getBoxClass(idx)}`}>
                  <div className="phase-num">PHASE {phase.num}</div>
                  <div className="phase-name">{phase.name}</div>

                  <div className="card-meta">
                    <div className="meta-row">{phase.typeLabel}</div>
                  </div>

                  {phase.models.length > 0 && (
                    <div className="card-models">
                      {phase.models.map((model, i) => (
                        <div key={i} className="model-row">{model}</div>
                      ))}
                    </div>
                  )}

                  <div className="card-stats">
                    <div className="stat-row">{getPhaseToolCount(phase.id, workflowDefId || DEFAULT_WORKFLOW_DEF_ID)} Tools</div>
                    <div className="stat-row">{phase.skills.length} Skills</div>
                  </div>

                  <div className="card-eval">
                    Evaluations: {phase.evaluationsEnabled ? (
                      <span className="eval-active">Active <span className="eval-dot active">●</span></span>
                    ) : (
                      <span className="eval-inactive">Inactive <span className="eval-dot inactive">○</span></span>
                    )}
                  </div>
                </div>

                {/* Work area */}
                <div className="work-area">
                  {/* Pending human-review gate(s) for THIS phase — local signal. */}
                  {pendingReviews.filter((r) => r.phaseId === phase.id).map((r) => (
                    <button
                      key={r.ticketId}
                      className="review-inline"
                      onClick={() => handleOpenTicketModal(r.ticketId)}
                      title={`Open ${r.ticketId} to approve or request changes`}
                    >
                      <span className="review-avatar sm" aria-hidden>{r.initials}</span>
                      <span className="review-inline-text">
                        <span className="review-inline-label">Pending review</span>
                        <span className="review-inline-detail">{r.reviewer} · {r.ticketId}</span>
                      </span>
                      <span className="review-inline-cta">Review →</span>
                    </button>
                  ))}

                  {/* Agents */}
                  {phase.type === "agent" && phase.agents.length > 0 && (() => {
                    return (
                      <>
                        <div className="sec-label">Agents ({phase.agents.length})</div>
                        {phase.agents.map((agent) => {
                          const agentTask = state?.agentTasks[agent.agentId];
                          const isAgentStale = (isStale || manualStaleAgents.has(agent.agentId)) && agentTask && (agentTask.status === "running" || agentTask.status === "waiting_response");
                          const agentItemClass = agentTask
                            ? isAgentStale
                              ? "error"
                              : agentTask.status === "running" || agentTask.status === "waiting_response"
                              ? "working"
                              : agentTask.status === "complete"
                              ? "done"
                              : agentTask.status === "error"
                              ? "error"
                              : getItemClass(idx)
                            : getItemClass(idx);
                          return (
                            <div
                              key={agent.agentId}
                              className={`item ${isSettled ? "done settled" : agentItemClass} cursor-pointer`}
                              onClick={() => {
                                const targetAgent = expandedAgent === agent.agentId ? null : agent.agentId;
                                setExpandedAgent(targetAgent);
                                if (targetAgent) {
                                  fetch(`/api/workflow/${workflowId}/agent-output?agentId=${targetAgent}`)
                                    .then((r) => r.json())
                                    .then((data) => {
                                      if (data.output) {
                                        setAgentFullOutput((prev) => ({ ...prev, [targetAgent]: data.output }));
                                      }
                                    })
                                    .catch(() => {});
                                }
                              }}
                            >
                              <img className="svc-icon" src={awsIcons.agentcore} alt="AC" />
                              <span className="item-label">{agent.displayName}</span>
                              <span className="flex-shrink-0 flex items-center gap-2" style={{ marginLeft: 'auto' }}>
                                {(() => {
                                  const tid = agentTicketMapRef.current[agent.agentId] || agentTask?.ticketId;
                                  if (!tid) return null;
                                  const ticketInfo = ticketStatusMap[tid];
                                  // Derive status from agentTask when ticketStatusMap hasn't caught up
                                  // (Jira JQL indexing lag, or before the 15s /tickets poll fires)
                                  const derivedStatus: TicketStatus | null = agentTask
                                    ? agentTask.status === "complete" ? "done"
                                    : agentTask.status === "running" || agentTask.status === "waiting_response" ? "in_progress"
                                    : agentTask.status === "error" ? "blocked"
                                    : agentTask.status === "pending" ? "todo"
                                    : null
                                    : null;
                                  const status = ticketInfo?.status || derivedStatus;
                                  if (!status) return null;
                                  return (
                                    <span className="flex" onClick={(e) => { e.stopPropagation(); handleOpenTicketModal(tid); }}>
                                      <TicketStatusBadge
                                        status={status}
                                        ticketId={tid}
                                        ticketTitle={ticketInfo?.title}
                                      />
                                    </span>
                                  );
                                })()}
                                <span
                                  className="item-status cursor-pointer"
                                  title="Click to mark agent as stuck"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (agentTask && (agentTask.status === "running" || agentTask.status === "waiting_response")) {
                                      if (window.confirm(`Mark "${agent.displayName}" as stuck?\n\nThis will flag the agent as unresponsive and show recovery options.`)) {
                                        setManualStaleAgents((prev) => new Set([...prev, agent.agentId]));
                                        // Also expand this agent's panel immediately
                                        setExpandedAgent(agent.agentId);
                                        fetch(`/api/workflow/${workflowId}/agent-output?agentId=${agent.agentId}`)
                                          .then((r) => r.json())
                                          .then((data) => { if (data.output) setAgentFullOutput((prev) => ({ ...prev, [agent.agentId]: data.output })); })
                                          .catch(() => {});
                                      }
                                    }
                                  }}
                                />
                              </span>
                            </div>
                          );
                        })}
                      </>
                    );
                  })()}

                  {/* Tools */}
                  {phase.tools.length > 0 && (
                    <>
                      <div className="sec-label">{phase.id === "intake" ? "User Actions" : "Tools"}</div>
                      {phase.tools.map((tool, i) => {
                        const iconKey = tool.icon || tool.dot || "ext";
                        const isFlashing = toolFlashes[`${phase.id}:${iconKey}`];
                        const itemClass = isFlashing ? "trigger" : getItemClass(idx);
                        return (
                          <div key={i} className={`item ${itemClass}`}>
                            {tool.icon ? (
                              <img className="svc-icon" src={(awsIcons as Record<string, string>)[tool.icon]} alt={tool.icon} />
                            ) : (
                              <span className={`item-dot ${tool.dot || "ext"}`} />
                            )}
                            <span className="item-label">{tool.label}</span>
                            <span className="item-status" />
                          </div>
                        );
                      })}
                    </>
                  )}

                  {/* Skills */}
                  {phase.skills.length > 0 && (
                    <>
                      <div className="sec-label">Skills</div>
                      {phase.skills.map((skill, i) => {
                        const isSkillFlashing = toolFlashes[`${phase.id}:skill`];
                        const itemClass = isSkillFlashing ? "trigger" : getItemClass(idx);
                        return (
                          <div key={i} className={`item ${itemClass}`}>
                            <span className="item-dot skill" />
                            <span className="item-label">{skill}</span>
                            <span className="item-status" />
                          </div>
                        );
                      })}
                    </>
                  )}

                  {/* Outputs */}
                  {phase.outputs.length > 0 && (
                    <>
                      <div className="sec-label">{phase.id === "intake" ? "Trigger" : "Output"}</div>
                      {phase.outputs.map((out, i) => {
                        const outIconKey = out.icon || out.dot || "ext";
                        const isOutFlashing = toolFlashes[`${phase.id}:${outIconKey}`];
                        const itemClass = isOutFlashing ? "trigger" : getItemClass(idx);
                        const isS3Output = out.icon === "s3";
                        return (
                          <div
                            key={i}
                            className={`item ${itemClass}${isS3Output ? " clickable" : ""}`}
                            onClick={isS3Output ? () => setArtifactsModal({ phaseId: phase.id, phaseName: phase.name }) : undefined}
                            style={isS3Output ? { cursor: "pointer" } : undefined}
                            title={isS3Output ? "View S3 artifacts" : undefined}
                          >
                            {out.icon ? (
                              <img className="svc-icon" src={(awsIcons as Record<string, string>)[out.icon]} alt={out.icon} />
                            ) : (
                              <span className={`item-dot ${out.dot || "ext"}`} />
                            )}
                            <span className="item-label">{out.label}</span>
                            <span className="item-status" />
                          </div>
                        );
                      })}
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Workflow Manager — per-run analysis (terminal runs only) */}
        {(state.phase === "complete" || state.phase === "cancelled" || state.phase === "error") && (
          <WorkflowManagerPanel workflowId={workflowId} onAskAboutRun={onAskManager} />
        )}

        {/* Agent Output Pop-Out Card */}
        <AgentOutputPanel
          isOpen={!!expandedAgent}
          onClose={() => {
            // Clear manual stale override for this agent when closing the modal
            if (expandedAgent && manualStaleAgents.has(expandedAgent)) {
              setManualStaleAgents((prev) => {
                const next = new Set(prev);
                next.delete(expandedAgent);
                return next;
              });
              // Also reset global isStale if no other manual overrides remain
              if (manualStaleAgents.size <= 1) setIsStale(false);
            }
            setExpandedAgent(null);
          }}
          isStale={(isStale || (!!expandedAgent && manualStaleAgents.has(expandedAgent))) && !!expandedAgent && (Object.values(state.agentTasks).find((t) => t.agentId === expandedAgent)?.status === "running")}
          workflowId={workflowId}
          lastToolName={expandedAgent ? lastToolPerAgentRef.current[expandedAgent] : undefined}
          lastEvent={expandedAgent ? lastEventPerAgent[expandedAgent] : undefined}
          lastActivityTime={lastActivityRef.current}
          staleThreshold={expandedAgent && lastToolPerAgentRef.current[expandedAgent] === "claude_code" ? 1_020_000 : 180_000}
          onRestart={() => {
            setIsStale(false);
            if (expandedAgent) {
              setManualStaleAgents((prev) => {
                const next = new Set(prev);
                next.delete(expandedAgent);
                return next;
              });
            }
            lastActivityRef.current = Date.now();
          }}
          task={expandedAgent ? {
            id: `task_${expandedAgent}`,
            agentId: expandedAgent,
            ticketId: Object.values(state.agentTasks).find((t) => t.agentId === expandedAgent)?.ticketId || "",
            status: Object.values(state.agentTasks).find((t) => t.agentId === expandedAgent)?.status || "running",
            input: "",
            output: (() => {
              const agentTask = Object.values(state.agentTasks).find((t) => t.agentId === expandedAgent);
              const isRunning = agentTask?.status === "running" || agentTask?.status === "waiting_response";
              const live = streamingText[expandedAgent] || "";
              const polled = agentFullOutput[expandedAgent] || "";
              // For running agents, prefer whichever is longer (live SSE vs polled full output)
              if (isRunning) return live.length >= polled.length ? live : polled;
              // For completed/idle agents, prefer polled (final) output
              return polled || live || agentTask?.output || originalOutputsRef.current[expandedAgent] || "";
            })(),
            branch: Object.values(state.agentTasks).find((t) => t.agentId === expandedAgent)?.branch,
          } : null}
        />

        {/* S3 Artifacts Modal — phase click shows all workflow artifacts */}
        <S3ArtifactsModal
          isOpen={!!artifactsModal}
          onClose={() => setArtifactsModal(null)}
          agentId=""
          agentName="Workflow"
          workflowId={workflowId}
        />

        {/* Cancel Confirmation Modal */}
        <CancelConfirmationModal
          isOpen={showCancelModal}
          onClose={() => setShowCancelModal(false)}
          onConfirm={handleCancelWorkflow}
          isLoading={cancelLoading}
          error={cancelError}
        />
        {openTicketModal && (
          <TicketDetailModal
            ticketId={openTicketModal.ticketId}
            workflowId={openTicketModal.workflowId}
            isOpen={true}
            onClose={() => setOpenTicketModal(null)}
          />
        )}
      </div>
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
// Shared base colors (--pl-bg, --pl-card, --pl-border, --pl-text, --pl-text-2/3/4)
// are derived from --pipeline-* variables defined in pipeline.css, so they
// automatically track light/dark theme. Only pipeline-viz-specific tokens are
// duplicated here.

const REVIEW_BANNER_STYLES = `
.review-banner{display:flex;flex-direction:column;gap:8px;margin:0 0 16px}
.review-banner-item{display:flex;align-items:center;gap:12px;width:100%;text-align:left;cursor:pointer;
  padding:12px 14px;border-radius:12px;border:1px solid rgba(14,165,233,0.45);
  background:rgba(14,165,233,0.08);color:var(--pipeline-text,#e2e8f0);
  animation:reviewGlow 2s ease-in-out infinite;transition:background .15s ease}
.review-banner-item:hover{background:rgba(14,165,233,0.16)}
@keyframes reviewGlow{0%,100%{box-shadow:0 0 0 0 rgba(14,165,233,0.0)}50%{box-shadow:0 0 0 4px rgba(14,165,233,0.18)}}
.review-avatar{flex-shrink:0;width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;
  font-size:12px;font-weight:700;letter-spacing:.5px;color:#fff;background:linear-gradient(135deg,#0ea5e9,#6366f1);
  animation:avatarPulse 2s ease-in-out infinite}
@keyframes avatarPulse{0%,100%{box-shadow:0 0 0 0 rgba(14,165,233,0.5)}50%{box-shadow:0 0 0 6px rgba(14,165,233,0)}}
.review-banner-text{display:flex;flex-direction:column;min-width:0;flex:1}
.review-banner-label{font-size:13px;font-weight:600;color:#38bdf8}
.review-banner-detail{font-size:12px;color:var(--pipeline-text-muted,#94a3b8);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.review-banner-cta{flex-shrink:0;font-size:12px;font-weight:600;color:#38bdf8}
.review-avatar.sm{width:26px;height:26px;font-size:10px}
/* Inline per-phase review card — sits in the phase work-area above Agents */
.review-inline{display:flex;align-items:center;gap:8px;width:100%;text-align:left;cursor:pointer;
  padding:7px 9px;margin-bottom:5px;border-radius:9px;border:1px solid rgba(14,165,233,0.5);
  background:rgba(14,165,233,0.10);color:var(--pipeline-text,#e2e8f0);
  animation:reviewGlow 2s ease-in-out infinite;transition:background .15s ease}
.review-inline:hover{background:rgba(14,165,233,0.18)}
.review-inline-text{display:flex;flex-direction:column;min-width:0;flex:1}
.review-inline-label{font-size:11px;font-weight:700;color:#38bdf8;line-height:1.2}
.review-inline-detail{font-size:10px;color:var(--pipeline-text-muted,#94a3b8);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.review-inline-cta{flex-shrink:0;font-size:10px;font-weight:600;color:#38bdf8}
`;

export const PIPELINE_STYLES = `
:root{--pl-bg:var(--pipeline-bg);--pl-card:var(--pipeline-card-bg);--pl-item-bg:rgba(26,35,50,0.4);--pl-border:var(--pipeline-border);--pl-border-strong:#334155;--pl-text:var(--pipeline-text);--pl-text-strong:#ffffff;--pl-text-2:var(--pipeline-text-secondary);--pl-text-3:var(--pipeline-text-muted);--pl-text-4:var(--pipeline-text-dim);--pl-dim-inactive:0.35;--pl-dim-done:0.8;--pl-active-bg:rgba(14,165,233,0.06);--pl-active-border:rgba(14,165,233,0.25);--pl-hover-bg:rgba(14,165,233,0.09);--pl-working-bg:rgba(14,165,233,0.05);--pl-item-active-label:#cbd5e1;--pl-flow-show:0.6}
[data-theme="light"]{--pl-item-bg:rgba(148,163,184,0.13);--pl-border-strong:#cbd5e1;--pl-text-strong:#0f172a;--pl-dim-inactive:0.55;--pl-dim-done:0.9;--pl-active-bg:rgba(14,165,233,0.14);--pl-active-border:rgba(14,165,233,0.5);--pl-hover-bg:rgba(14,165,233,0.18);--pl-working-bg:rgba(14,165,233,0.12);--pl-item-active-label:#0f172a;--pl-flow-show:0.85}
.pipeline-viz{display:flex;flex-direction:column;align-items:flex-start;min-height:100vh;overflow-x:auto;padding:14px 20px;background:var(--pl-bg);color:var(--pl-text);font-family:"Segoe UI",system-ui,sans-serif}
.pipeline-title{display:none}
.pipeline-subtitle{display:none}
@keyframes shimmer{to{background-position:200% center}}

.pipeline-top-bar{display:flex;align-items:center;width:1720px;margin-bottom:10px;position:relative;margin-inline:auto}
.pipeline-status-header{position:absolute;left:50%;transform:translateX(-50%);font-size:16px;font-weight:700;color:var(--color-text-primary);letter-spacing:0.5px;text-transform:capitalize;transition:color .4s;white-space:nowrap}
.pipeline-status-header.settled{color:#f97316;animation:settledHeaderGlow 6s ease-in-out infinite}
.pipeline-status-header.cancelled{color:#f59e0b}

.pipeline-canvas{position:relative;width:1720px;min-height:840px;margin-inline:auto}
.pipeline-connectors{position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:10}
.flow-path{fill:none;stroke:var(--pl-border);stroke-width:2;stroke-linecap:round;opacity:0;transition:opacity .5s,stroke .5s}
.flow-path.show{opacity:var(--pl-flow-show);stroke:#22c55e;stroke-width:2;filter:none}
.flow-path.show.done{opacity:0.5;stroke:#22c55e80;stroke-width:2;filter:none}
.flow-path.active{stroke:#0ea5e9;stroke-width:3;filter:url(#pathGlow);opacity:1}
.flow-path.animating{stroke:#0ea5e9;stroke-width:3;opacity:1;filter:url(#pathGlow)}
.flow-dot{fill:#0ea5e9;filter:url(#dotGlow)}

.pipeline-phases{display:flex;align-items:flex-start;gap:44px;position:relative;z-index:2}

.phase{display:flex;flex-direction:column;align-items:center;width:290px;opacity:var(--pl-dim-inactive);transition:opacity .5s,transform .4s;transform:translateY(6px)}
.phase.active{opacity:1;transform:translateY(0)}
.phase.done{opacity:var(--pl-dim-done);transform:translateY(0)}

.agent-box{width:100%;border-radius:11px;padding:12px 14px;text-align:center;transition:all .4s;background:var(--pl-card);border:2px solid var(--pl-border)}
.agent-box.awake{border-color:#0ea5e9;box-shadow:0 0 20px rgba(14,165,233,.3)}
.agent-box.done{border-color:#22c55e50;box-shadow:0 0 8px rgba(34,197,94,.1)}
.agent-box .phase-num{font-size:12px;color:var(--pl-text-2);letter-spacing:2px;text-transform:uppercase;font-weight:600}
.agent-box .phase-name{font-size:24px;font-weight:700;color:var(--pl-text-strong);margin-top:2px;margin-bottom:10px}
.card-meta{margin-bottom:8px}
.card-meta .meta-row{font-size:11px;color:var(--pl-text-2);line-height:1.6}
.card-models{margin-bottom:8px;padding:6px 0;border-top:1px solid var(--pl-border)}
.card-models .model-row{font-size:11px;color:#c084fc;line-height:1.6;font-weight:500}
.card-stats{margin-bottom:8px}
.card-stats .stat-row{font-size:11px;color:var(--pl-text-2);line-height:1.6}
.card-eval{font-size:11px;color:var(--pl-text-3);padding-top:6px;border-top:1px solid var(--pl-border)}
.eval-active{color:#22c55e;font-weight:500}
.eval-inactive{color:var(--pl-text-3)}
.eval-dot{margin-left:4px}
.eval-dot.active{color:#22c55e}
.eval-dot.inactive{color:var(--pl-text-4)}

.work-area{width:100%;margin-top:8px;display:flex;flex-direction:column;gap:3px}
.sec-label{font-size:7px;color:var(--pl-text-4);letter-spacing:1.5px;text-transform:uppercase;margin-top:6px;margin-bottom:2px;padding-left:3px}

.item{display:flex;align-items:center;gap:5px;padding:5px 7px;border-radius:6px;border:1px solid transparent;background:var(--pl-item-bg);transition:all .3s;position:relative}
.item.clickable:hover{border-color:#0ea5e960;background:var(--pl-hover-bg);transform:translateY(-1px)}
.item.active{border-color:var(--pl-active-border);background:var(--pl-active-bg)}
.item.active .item-label{color:var(--pl-text)}
.item.done{border-color:#22c55e20;opacity:0.7}
.item.done .item-status{background:#22c55e}
.item.trigger{border-color:#f97316;background:#f9731610;animation:pulse .6s}
@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.02)}}
@keyframes agentPulse{0%{border-color:#0ea5e960;box-shadow:0 0 8px rgba(14,165,233,.3)}50%{border-color:#0ea5e9;box-shadow:0 0 16px rgba(14,165,233,.5)}100%{border-color:#0ea5e960;box-shadow:0 0 8px rgba(14,165,233,.3)}}
.item.active-glow{border-color:var(--pl-active-border);background:var(--pl-active-bg);box-shadow:0 0 6px rgba(14,165,233,.15)}
.item.active-glow .item-label{color:var(--pl-item-active-label)}
.item.active-glow .item-status{background:#0ea5e980}
.item.working{border-color:#0ea5e960;background:var(--pl-working-bg);animation:agentPulse 1s ease-in-out infinite}
.item.working .item-label{color:var(--pl-text)}
.item.working .item-status{background:#0ea5e9;box-shadow:0 0 5px #0ea5e9}

@keyframes errorPulse{0%{border-color:#ef444460;box-shadow:0 0 8px rgba(239,68,68,.3)}50%{border-color:#ef4444;box-shadow:0 0 16px rgba(239,68,68,.5)}100%{border-color:#ef444460;box-shadow:0 0 8px rgba(239,68,68,.3)}}
.item.error{border-color:#ef444460;background:#ef444408;animation:errorPulse 2s ease-in-out infinite}
.item.error .item-label{color:#fca5a5}
.item.error .item-status{background:#ef4444;box-shadow:0 0 5px #ef4444}

.svc-icon{width:16px;height:16px;border-radius:2px;object-fit:contain;flex-shrink:0}
.item-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.item-dot.skill{background:#a855f7}
.item-dot.ext{background:var(--pl-text-3)}

.item-label{font-size:10px;font-weight:500;color:var(--pl-text-2);line-height:1.15;transition:color .3s}
.item.active .item-label{color:var(--pl-text)}
.item-status{width:6px;height:6px;border-radius:50%;background:var(--pl-border);margin-left:auto;flex-shrink:0;transition:background .3s}
.item.active .item-status{background:#0ea5e9;box-shadow:0 0 5px #0ea5e9}


@keyframes celebrateBurst{0%{border-color:#f97316;box-shadow:0 0 30px rgba(255,255,255,.6)}100%{border-color:#22c55e50;box-shadow:0 0 8px rgba(34,197,94,.1)}}
@keyframes celebrateItemBurst{0%{border-color:#f97316;background:#f9731618}100%{border-color:#f9731640;background:#f9731608}}
@keyframes celebrateStatusBurst{0%{background:#f97316;box-shadow:0 0 8px #fbbf24}100%{background:#22c55e;box-shadow:0 0 4px rgba(34,197,94,.3)}}
@keyframes celebrateConnector{0%{stroke:#f97316;opacity:.8}100%{stroke:#22c55e80;opacity:.4}}
.celebrate-wrapper .agent-box.done{animation:celebrateBurst 1.2s ease-out forwards}
.celebrate-wrapper .item.done{animation:celebrateItemBurst 1.2s ease-out forwards}
.celebrate-wrapper .item.done .item-status{animation:celebrateStatusBurst 1.2s ease-out forwards}
.celebrate-wrapper .flow-path.show{animation:celebrateConnector 1.2s ease-out forwards}
.celebrate-wrapper .pipeline-status-header{color:#f97316}
.celebrate-wrapper .pipeline-title{background:linear-gradient(90deg,#f97316,#fbbf24,#f97316);background-size:200% auto;-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.celebrate-wrapper .phase.done{opacity:1}

/* Settled state — completed workflow loaded from history */
@keyframes settledGlow{0%,100%{border-color:#f97316;box-shadow:0 0 14px rgba(249,115,22,.25)}50%{border-color:#fb923c;box-shadow:0 0 24px rgba(249,115,22,.45)}}
@keyframes settledItemGlow{0%,100%{border-color:#f9731640;background:#f9731610;box-shadow:0 0 4px rgba(249,115,22,.1)}50%{border-color:#f9731670;background:#f9731618;box-shadow:0 0 8px rgba(249,115,22,.2)}}
@keyframes settledDotGlow{0%,100%{box-shadow:0 0 4px #f97316}50%{box-shadow:0 0 8px #f97316,0 0 12px rgba(249,115,22,.4)}}
@keyframes settledPathGlow{0%,100%{opacity:.6;filter:url(#pathGlow)}50%{opacity:.9;filter:url(#pathGlow) brightness(1.2)}}
@keyframes settledHeaderGlow{0%,100%{text-shadow:0 0 8px rgba(249,115,22,.2)}50%{text-shadow:0 0 16px rgba(249,115,22,.4)}}
.phase.settled{opacity:1}
.agent-box.done.settled{animation:settledGlow 6s ease-in-out infinite;border-color:#f97316}
.item.done.settled{animation:settledItemGlow 6s ease-in-out infinite;opacity:1;border-color:#f9731650}
.item.done.settled .item-status{background:#f97316;animation:settledDotGlow 6s ease-in-out infinite}
.item.done.settled .item-label{color:var(--pl-text)}
.item.done.settled .item-dot{background:#f97316;animation:settledDotGlow 6s ease-in-out infinite}
.item.done.settled .svc-icon{filter:drop-shadow(0 0 3px rgba(249,115,22,.3))}
.flow-path.show.settled{stroke:#f97316;opacity:.7;stroke-width:2.5;animation:settledPathGlow 6s ease-in-out infinite}

.replay-bar{display:flex;align-items:center;gap:10px;padding:6px 12px;background:var(--pl-card);border:1px solid var(--pl-border);border-radius:8px;position:relative;z-index:20}
.replay-btn{background:none;border:1px solid var(--pl-border-strong);color:var(--pl-text);font-size:14px;width:32px;height:32px;border-radius:6px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s}
.replay-btn:hover{border-color:#0ea5e9;background:#0ea5e920}
.replay-scrubber{flex:1;height:4px;-webkit-appearance:none;appearance:none;background:var(--pl-border-strong);border-radius:2px;cursor:pointer;outline:none}
.replay-scrubber::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:#0ea5e9;cursor:pointer;box-shadow:0 0 6px rgba(14,165,233,.5)}
.replay-scrubber::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:#0ea5e9;cursor:pointer;border:none}
.replay-counter{font-size:11px;color:var(--pl-text-3);font-family:"JetBrains Mono",monospace;min-width:80px;text-align:center}
.replay-speed{background:var(--pl-bg);border:1px solid var(--pl-border-strong);color:var(--pl-text);font-size:11px;padding:4px 8px;border-radius:4px;cursor:pointer}
.replay-speed:hover{border-color:#0ea5e9}
.live-btn{display:flex;align-items:center;gap:4px;background:#ef4444;color:#fff;font-size:10px;font-weight:700;letter-spacing:0.5px;padding:4px 10px;border-radius:4px;border:none;cursor:pointer;animation:livePulse 1.5s ease-in-out infinite}
.live-btn::before{content:"";width:6px;height:6px;border-radius:50%;background:#fff;animation:liveDot 1.5s ease-in-out infinite}
@keyframes livePulse{0%,100%{opacity:1}50%{opacity:0.7}}
@keyframes liveDot{0%,100%{opacity:1}50%{opacity:0.4}}
.catching-up-indicator{font-size:12px;color:#0ea5e9;font-weight:500;letter-spacing:0.5px;animation:catchUpPulse 1.2s ease-in-out infinite}
@keyframes catchUpPulse{0%,100%{opacity:1}50%{opacity:0.5}}

.agent-output-panel{margin-top:16px;width:100%;max-width:1720px;background:var(--pl-card);border:1px solid var(--pl-border);border-radius:8px;overflow:hidden}
.agent-output-header{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:var(--pl-bg);border-bottom:1px solid var(--pl-border);font-size:11px;color:var(--pl-text-2);letter-spacing:1px;text-transform:uppercase}
.agent-output-close{background:none;border:none;color:var(--pl-text-3);font-size:14px;cursor:pointer;padding:2px 6px}
.agent-output-close:hover{color:var(--pl-text)}
.agent-output-body{padding:12px;font-size:12px;color:var(--pl-text-2);white-space:pre-wrap;max-height:300px;overflow-y:auto;font-family:"JetBrains Mono",monospace;line-height:1.5}

.nudge-pulse-overlay{position:fixed;inset:0;z-index:9999;pointer-events:none;animation:nudgePulse 1.5s ease-out forwards}
@keyframes nudgePulse{0%{background:rgba(236,72,153,0.35);box-shadow:inset 0 0 120px rgba(236,72,153,0.6)}30%{background:rgba(236,72,153,0.15);box-shadow:inset 0 0 60px rgba(236,72,153,0.3)}100%{background:transparent;box-shadow:none}}
.wm-pulse-toast{position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;align-items:center;gap:8px;max-width:min(560px,90vw);padding:10px 16px;border-radius:10px;background:rgba(14,165,233,0.14);border:1px solid rgba(14,165,233,0.5);color:#7dd3fc;font-size:13px;font-weight:500;box-shadow:0 8px 24px rgba(0,0,0,0.4);animation:wmToast 4s ease-out forwards}
@keyframes wmToast{0%{opacity:0;transform:translate(-50%,-12px)}8%{opacity:1;transform:translate(-50%,0)}90%{opacity:1}100%{opacity:0}}
`;
