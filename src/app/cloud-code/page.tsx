"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Plus, Cloud, Send, Trash2, GitBranch, Loader2, Radio, MessageSquare, TerminalSquare, Settings, Upload, Check, ArrowDown, Github, Square, FileBox } from "lucide-react";
import dynamic from "next/dynamic";
import { sseData } from "@/lib/sse";
import { MarkdownRenderer } from "@/components/workflow/MarkdownRenderer";
import { CliBadge, CliMark, CLI_BRAND } from "@/components/cloud-code/CliBrand";

// xterm touches the DOM/window — load only in the browser.
const ShellTerminal = dynamic(() => import("@/components/cloud-code/ShellTerminal"), { ssr: false });
const ArtifactsPanel = dynamic(() => import("@/components/cloud-code/ArtifactsPanel"), { ssr: false });
const VoiceButton = dynamic(() => import("@/components/cloud-code/VoiceButton"), { ssr: false });
import { PullCommandButton } from "@/components/cloud-code/PullCommandButton";
import type {
  CloudCodeSession,
  CloudCodeSessionSummary,
  CloudCodeCli,
  CloudCodeTurn,
  SessionWarmth,
} from "@/lib/cloud-code/types";

// One in-flight turn per session. The chat used to hold a single `sending`/
// abort/inflight set, so a turn's streamed deltas were written to whatever
// session was on screen — switch chats mid-stream and the other reply bled into
// the wrong window. Now every turn-scoped value is keyed by sessionId: sessions
// stream independently and you can fire a new turn in one while another runs.
interface LiveTurnCtrl {
  base: number;          // turn count before this turn — recovery's ready threshold
  prompt: string;        // handed to /stop so a killed turn still persists
  displayPrompt?: string;
  acc: string;           // accumulated agent text so far (for /stop)
  abort: AbortController;
  stopped: boolean;      // Stop pressed → skip the drop-recovery path
  streamStarted: boolean; // SSE body began → a drop is recoverable, not a pre-run fail
}

const WARMTH_DOT: Record<SessionWarmth, string> = {
  warm: "bg-green-400 shadow-[0_0_0_3px_rgba(34,197,94,0.15)]",
  idle: "bg-amber-400/70",
  cold: "bg-[var(--color-text-muted)]",
};

export default function CloudCodePage() {
  const [sessions, setSessions] = useState<CloudCodeSessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [active, setActive] = useState<CloudCodeSession | null>(null);
  const [draft, setDraft] = useState("");
  // Sessions with a turn currently running (drives per-session composer/Stop/
  // typing UI + the "don't double-fire" guard). A Set so many sessions can run
  // at once; state (not a ref) so the UI re-renders as turns start/finish.
  const [sendingIds, setSendingIds] = useState<Set<string>>(() => new Set());
  const [stoppingIds, setStoppingIds] = useState<Set<string>>(() => new Set());
  // Per-session in-flight turn control (abort handle, stop flag, partial text).
  // Keyed by sessionId so a turn is never confused with another session's.
  const liveCtrl = useRef<Map<string, LiveTurnCtrl>>(new Map());
  // Per-session live/optimistic turns while a turn streams. The render overlays
  // the SELECTED session's entry onto `active`; deltas only ever mutate their
  // own session's array, so switching chats can't cross streams. Bumping
  // liveNonce forces a re-render when a map entry mutates (refs don't trigger
  // React on their own).
  const liveTurns = useRef<Map<string, CloudCodeTurn[]>>(new Map());
  const [liveNonce, setLiveNonce] = useState(0);
  const bumpLive = useCallback(() => setLiveNonce((n) => n + 1), []);
  // Sessions whose live overlay holds an error the server WON'T have: an
  // in-stream `error` frame appends "⚠ …" to the partial agent text client-side,
  // but the route persists only the partial (no marker), so overlay and server
  // can end up the SAME length. Length-based reconciliation would then drop the
  // ⚠ on switch-back; this set makes the selection effect prefer the overlay.
  const liveError = useRef<Set<string>>(new Set());
  // Sessions whose stream dropped and are polling for the persisted reply. Kept
  // separate from sendingIds because the turn's `finally` clears sending, but the
  // session must STAY busy (block a resend, hold its overlay) until recovery
  // resolves — else a resend clobbers the pending overlay and the still-armed
  // recovery later deletes the resend's overlay too.
  const [recoveringIds, setRecoveringIds] = useState<Set<string>>(() => new Set());
  const setSendingFor = useCallback((sid: string, on: boolean) => {
    setSendingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(sid); else next.delete(sid);
      return next;
    });
  }, []);
  const setStoppingFor = useCallback((sid: string, on: boolean) => {
    setStoppingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(sid); else next.delete(sid);
      return next;
    });
  }, []);
  const setRecoveringFor = useCallback((sid: string, on: boolean) => {
    setRecoveringIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(sid); else next.delete(sid);
      return next;
    });
  }, []);
  const [showNew, setShowNew] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [view, setView] = useState<"chat" | "terminal" | "artifacts">("chat");
  const [sessionsOpen, setSessionsOpen] = useState(false); // mobile session drawer
  const streamEnd = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // True while the mic is recording/locked, so the composer keeps the mic mounted
  // even once dictated text fills the draft (otherwise send would swap in).
  const [voiceActive, setVoiceActive] = useState(false);
  // Auto-scroll follows the bottom WHILE you're already there; if you scroll up
  // to read, it stops yanking you down and shows a "jump to latest" pill instead.
  const [stuck, setStuck] = useState(true);

  // Set while a turn's stream dropped before its reply was recovered (mobile
  // background/lock, refresh). The server finishes + persists the turn
  // regardless; we re-sync from it while the tab is visible until the reply
  // lands. Bumping recoverNonce (re-)arms the polling effect even when the tab
  // never lost focus.
  const pendingRecover = useRef<Map<string, { baseCount: number }>>(new Map());
  const [recoverNonce, setRecoverNonce] = useState(0);

  const fetchSessions = useCallback(async () => {
    const res = await fetch("/api/cloud-code/sessions");
    if (!res.ok) return;
    const data = await res.json();
    setSessions(data.sessions || []);
  }, []);

  // Drop a session's overlay AND its error flag together — the flag must never
  // outlive the overlay it describes, or it would force-adopt a later turn's.
  const dropOverlay = useCallback((sid: string) => {
    liveTurns.current.delete(sid);
    liveError.current.delete(sid);
  }, []);

  // Pull the server's authoritative turns for a session and adopt them ONLY once
  // the agent reply has actually been persisted (server has ≥ baseCount+2 turns,
  // last is the agent's). Returns whether it adopted — so callers can keep
  // optimistic turns (incl. the user's message) until the real reply is ready,
  // instead of clobbering them with a not-yet-written server state.
  const recoverActiveTurn = useCallback(async (sid: string, baseCount: number): Promise<boolean> => {
    try {
      const r = await fetch(`/api/cloud-code/sessions/${sid}`);
      if (!r.ok) return false;
      const d = await r.json();
      const turns = d?.session?.turns;
      if (!Array.isArray(turns) || turns.length < baseCount + 2) return false;
      if (turns[turns.length - 1]?.role !== "agent") return false;
      // Server is now authoritative for this session — drop the live overlay so
      // the recovered turns (not the stale optimistic ones) render.
      dropOverlay(sid);
      bumpLive();
      setActive((prev) => (prev && prev.sessionId === sid ? d.session : prev));
      return true;
    } catch {
      return false;
    }
  }, [bumpLive, dropOverlay]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  // Deep link: /cloud-code?session=<id>[&view=terminal] selects it (the "port to
  // cloud" handoff link opens straight into the ported session, on any device).
  // deepViewRef records a one-time view override so the select effect below
  // doesn't snap it back to chat.
  const deepViewRef = useRef<"chat" | "terminal" | "artifacts" | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const id = q.get("session");
    if (id) {
      if (q.get("view") === "terminal") deepViewRef.current = "terminal";
      setSelectedId(id);
    }
    // GitHub App connect/disconnect bounces back here with ?github=<status>.
    const gh = q.get("github");
    if (gh) {
      const msgs: Record<string, string> = {
        connected: "GitHub connected — private repos clone with short-lived tokens",
        disconnected: "GitHub disconnected",
        cancelled: "GitHub connection cancelled",
        not_configured: "GitHub App isn't set up yet — ask your operator",
        forbidden: "Only an admin can create the GitHub App",
        state_mismatch: "GitHub connection couldn't be verified — start from Connect and try again",
        ownership_unverified: "Couldn't confirm you own that GitHub installation — start from Connect and try again",
        oauth_required: "GitHub App is missing OAuth credentials — your operator must add them first",
        error: "GitHub connection failed — try again",
        app_error: "Couldn't create the GitHub App — try again",
      };
      flash(msgs[gh] || "GitHub");
      q.delete("github");
      const qs = q.toString();
      window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tracks which session's pending seed we've already auto-fired, so opening a
  // ported session runs its first turn exactly once.
  const seededRef = useRef<string | null>(null);

  // Load full session when selected. The view is restored from the session's
  // own defaultView (set at port time) so a sidebar tap reopens it the right
  // way; a deep-link &view= is a one-time override that wins if present.
  useEffect(() => {
    if (!selectedId) {
      setActive(null);
      return;
    }
    const override = deepViewRef.current;
    deepViewRef.current = null;
    fetch(`/api/cloud-code/sessions/${selectedId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        const server = d.session as CloudCodeSession;
        // If a turn is still streaming OR recovering a dropped stream in this
        // session, its live overlay is the source of truth — don't clobber it
        // with the (staler) server turns; the stream loop / recovery poll owns
        // clearing it. If a turn COMPLETED while we were away, its overlay was
        // kept (persist may still be in flight): adopt whichever has more turns,
        // then clear it.
        const overlay = liveTurns.current.get(server.sessionId);
        const busy = sendingIds.has(server.sessionId) || recoveringIds.has(server.sessionId);
        if (overlay && !busy) {
          // Adopt the overlay if it has more turns OR carries an in-stream error
          // the server never persisted (same length, but the ⚠ marker only lives
          // in the overlay). Otherwise the server is authoritative.
          if (overlay.length > server.turns.length || liveError.current.has(server.sessionId)) {
            server.turns = overlay;
          }
          dropOverlay(server.sessionId);
          bumpLive();
        }
        setActive(server);
        setView(override ?? server.defaultView ?? "chat");
      })
      .catch(() => {});
    // sendingIds/recoveringIds/bumpLive intentionally omitted — this effect must
    // run on selection change only, not when a background turn's flags flip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // Live mirror of the on-screen session id, readable inside async turn loops
  // without the stale `active` closure (a turn started in A must know when the
  // user has since switched to B — e.g. to not steal focus back to A's input).
  const activeIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeIdRef.current = active?.sessionId ?? null;
  }, [active?.sessionId]);

  // Stick-to-bottom: only follow new content if the user is already near the
  // bottom. Track that on scroll (threshold absorbs sub-pixel rounding).
  const onStreamScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setStuck(nearBottom);
  }, []);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    streamEnd.current?.scrollIntoView({ behavior });
    setStuck(true);
  }, []);

  // Turns to render for the on-screen session: its live overlay while a turn
  // streams (optimistic user msg + growing agent reply), else the persisted
  // turns. Keying the overlay by sessionId is what keeps a background session's
  // stream out of this view. liveNonce forces recompute as the overlay mutates.
  const displayTurns = useMemo(() => {
    if (!active) return [];
    const live = liveTurns.current.get(active.sessionId);
    return live ?? active.turns;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, liveNonce]);
  // "Busy" = actively streaming OR recovering a dropped turn. Both block a
  // resend and keep the composer in its working state.
  const activeSending = active
    ? sendingIds.has(active.sessionId) || recoveringIds.has(active.sessionId)
    : false;
  const activeStopping = active ? stoppingIds.has(active.sessionId) : false;

  // New turn / streamed text / spinner → follow only while stuck. Switching
  // sessions snaps to the bottom instantly (you want the latest, no animation).
  const lastText = displayTurns[displayTurns.length - 1]?.text;
  useEffect(() => {
    if (stuck) streamEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [displayTurns.length, lastText, activeSending, stuck]);

  useEffect(() => {
    scrollToLatest("auto");
  }, [active?.sessionId, scrollToLatest]);

  // Auto-grow the input from 1 line up to ~6, then it scrolls internally. Reset
  // to scrollHeight on every change (incl. after send clears the draft).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 152)}px`; // ~6 lines
  }, [draft]);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  };

  const createSession = async (cli: CloudCodeCli, repo: string) => {
    const res = await fetch("/api/cloud-code/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cli, repo: repo || undefined }),
    });
    if (!res.ok) {
      flash("Failed to create session");
      return;
    }
    const { session } = await res.json();
    setShowNew(false);
    await fetchSessions();
    setSelectedId(session.sessionId);
  };

  const send = async () => {
    if (!active || !draft.trim() || activeSending || activeStopping) return;
    const prompt = draft.trim();
    setDraft("");
    await runTurn(prompt);
  };

  // Mutate a session's live-turn overlay in place, then bump the render nonce.
  // Only the turn that owns `sid` ever calls this for its own session, so two
  // concurrent turns never touch each other's array.
  const patchLive = useCallback((sid: string, fn: (turns: CloudCodeTurn[]) => CloudCodeTurn[]) => {
    const cur = liveTurns.current.get(sid) ?? [];
    liveTurns.current.set(sid, fn(cur));
    bumpLive();
  }, [bumpLive]);

  // The actual turn (shared by manual send + the auto-fired port seed).
  // `displayAs` overrides the user-bubble text — used for the ported seed, whose
  // real prompt is a huge transcript we don't want to render in the chat.
  const runTurn = async (prompt: string, displayAs?: string) => {
    if (!active || !prompt) return;
    const sid = active.sessionId; // bind the turn to THIS session
    // One turn per session (not one globally) — a turn already running in THIS
    // session blocks a resend, but other sessions are free to run concurrently.
    // A session still recovering a dropped turn also counts as busy: resending
    // now would clobber the pending overlay and confuse the armed recovery.
    if (sendingIds.has(sid) || recoveringIds.has(sid)) return;
    // Turn count before this turn — the server will hold baseCount+2 (user +
    // agent) once it persists, which is how recovery knows the reply is ready.
    // Seed from the overlay when one exists (a just-completed reply the selection
    // effect hasn't reconciled yet), else the persisted turns — i.e. exactly what
    // displayTurns renders.
    const baseTurns = liveTurns.current.get(sid) ?? active.turns;
    const baseCount = baseTurns.length;
    // Optimistic user message → into the overlay for THIS session only.
    const userTurn: CloudCodeTurn = { role: "user", text: displayAs ?? prompt, at: new Date().toISOString() };
    liveTurns.current.set(sid, [...baseTurns, userTurn]);
    bumpLive();
    const abort = new AbortController();
    const ctrl: LiveTurnCtrl = {
      base: baseCount,
      prompt,
      displayPrompt: displayAs,
      acc: "",
      abort,
      stopped: false,
      streamStarted: false,
    };
    liveCtrl.current.set(sid, ctrl);
    setSendingFor(sid, true);
    try {
      // Both CLIs stream (SSE): claude token deltas, codex per-step frames.
      const res = await fetch(`/api/cloud-code/sessions/${sid}/message?stream=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(displayAs ? { prompt, displayPrompt: displayAs } : { prompt }),
        signal: abort.signal,
      });

      if (res.body && res.headers.get("content-type")?.includes("event-stream")) {
        ctrl.streamStarted = true;
        // Empty agent turn to grow — appended to THIS session's overlay.
        patchLive(sid, (turns) => [...turns, { role: "agent", text: "", at: new Date().toISOString() }]);
        let acc = "";
        // sseData handles the byte/frame plumbing; we own the {type:text|done|error} schema.
        for await (const data of sseData(res.body)) {
          let obj: { type?: string; text?: string; response?: string; error?: string };
          try { obj = JSON.parse(data); } catch { continue; }
          if (obj.type === "text") acc += obj.text || "";
          else if (obj.type === "done") acc = obj.response || acc;
          else if (obj.type === "error") { acc += `\n⚠ ${obj.error}`; liveError.current.add(sid); }
          ctrl.acc = acc; // mirror for Stop → persist partial
          patchLive(sid, (turns) => {
            const next = turns.slice();
            const last = next[next.length - 1];
            next[next.length - 1] = { role: "agent", text: acc, at: last?.at ?? new Date().toISOString() };
            return next;
          });
        }
        // Turn complete. If the user is still on this session, adopt the finished
        // overlay as its turns and drop the overlay (no flicker — displayTurns
        // falls back to active.turns). If they've switched away, KEEP the
        // completed overlay: the server persist runs concurrently with this
        // completion, so a switch-back fetch could momentarily race ahead of the
        // write and show the session without its reply. The selection effect
        // reconciles the overlay against the server and clears it once caught up.
        const finalTurns = liveTurns.current.get(sid) ?? baseTurns;
        if (activeIdRef.current === sid) {
          setActive((s) => (s && s.sessionId === sid ? { ...s, turns: finalTurns } : s));
          dropOverlay(sid);
        }
        bumpLive();
        fetchSessions();
      } else {
        // Buffered fallback. A proxy timeout answers with a PLAINTEXT body, not
        // JSON — parse defensively so the user sees a readable timeout.
        const raw = await res.text();
        let data: { error?: string; session?: CloudCodeSession } = {};
        try { data = JSON.parse(raw); } catch { /* non-JSON proxy/error body */ }
        if (!res.ok) {
          throw new Error(
            data.error ||
              (res.status === 502 || res.status === 504
                ? "The turn ran longer than the gateway allows. It may still be running — reopen the session in a moment to see the reply."
                : `Turn failed (${res.status})`)
          );
        }
        if (data.session) {
          const server = data.session;
          setActive((s) => (s && s.sessionId === sid ? server : s));
        }
        dropOverlay(sid);
        bumpLive();
        fetchSessions();
      }
    } catch (err) {
      if (ctrl.stopped) {
        // Deliberate Stop — NOT a dropped stream. The /stop route killed the
        // turn AND persisted the interrupted turn server-side; stopTurn() adopts
        // that authoritative session. Don't run the drop-recovery path.
      } else if (ctrl.streamStarted) {
        // The stream dropped after starting — most often a phone backgrounding/
        // locking mid-turn. The server keeps running the turn and persists the
        // reply regardless, so don't strand a dead "Network Error" bubble: try to
        // recover the finished reply now, and if it isn't written yet, arm a
        // re-sync (recoverNonce) that polls while the tab is visible.
        const recovered = await recoverActiveTurn(sid, baseCount);
        if (!recovered) {
          pendingRecover.current.set(sid, { baseCount });
          setRecoveringFor(sid, true); // stay busy until the reply lands
          setRecoverNonce((n) => n + 1);
          flash("Reconnecting — your reply is still coming.");
          fetchSessions();
        }
      } else {
        // Turn failed at the transport (no stream to drop). A gateway timeout
        // (502/504) doesn't stop the server — the turn keeps running and
        // persists its reply — so try recovery first, exactly like the
        // stream-drop path, before surfacing an error. A genuine pre-run failure
        // (config/CLI exit) won't have the extra turns, so recovery no-ops and
        // we fall through to the visible error.
        const recovered = await recoverActiveTurn(sid, baseCount);
        if (recovered) {
          fetchSessions();
        } else if (/gateway allows|502|504/.test((err as Error).message)) {
          pendingRecover.current.set(sid, { baseCount });
          setRecoveringFor(sid, true);
          setRecoverNonce((n) => n + 1);
          flash("Still working — your reply is on its way.");
          fetchSessions();
        } else {
          // Genuine pre-run failure (config / CLI error). Surface it in the
          // session's overlay so it appears in the right chat — nothing is
          // persisted server-side, so this overlay is the only record of it.
          flash((err as Error).message);
          patchLive(sid, (turns) => [...turns, { role: "agent", text: `⚠ ${(err as Error).message}`, at: new Date().toISOString() }]);
          liveError.current.add(sid);
          if (activeIdRef.current === sid) {
            // Still on this session — fold the overlay into `active` and clear it.
            const errTurns = liveTurns.current.get(sid);
            if (errTurns) setActive((s) => (s && s.sessionId === sid ? { ...s, turns: errTurns } : s));
            dropOverlay(sid);
            bumpLive();
          }
          // Switched away → KEEP the overlay (like the completion path); the
          // selection effect adopts it on switch-back.
        }
      }
    } finally {
      liveCtrl.current.delete(sid);
      setSendingFor(sid, false);
      // Only steal focus back if the user is still looking at this session.
      if (activeIdRef.current === sid) requestAnimationFrame(() => inputRef.current?.focus());
    }
  };

  // Stop the turn running in `sid` (defaults to the on-screen session): tell the
  // runtime to tear down the microVM (kills the in-flight CLI) and persist the
  // interrupted turn so it survives reload. Keyed by session so the Stop button
  // only ever halts the chat you're looking at, never a background turn.
  const stopTurn = async (sid?: string) => {
    const target = sid ?? active?.sessionId;
    if (!target) return;
    const ctrl = liveCtrl.current.get(target);
    if (!ctrl || !sendingIds.has(target) || stoppingIds.has(target)) return;
    setStoppingFor(target, true);
    const { prompt, displayPrompt, acc } = ctrl;
    try {
      const res = await fetch(`/api/cloud-code/sessions/${target}/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, displayPrompt, partial: acc }),
      }).catch(() => null);
      // The endpoint returns 200 even on { stopped: false, error }. ONLY abort
      // the local stream when the stop actually succeeded — otherwise the turn
      // is still running server-side, so leave it attached for the normal
      // recovery/error path and surface the failure instead of hiding it.
      const data = res && res.ok ? await res.json().catch(() => null) : null;
      if (data?.stopped) {
        ctrl.stopped = true;
        if (data.session) {
          const server = data.session as CloudCodeSession;
          setActive((s) => (s && s.sessionId === target ? server : s));
        }
        // Server is authoritative now — drop the live overlay for this session.
        dropOverlay(target);
        bumpLive();
        // Abort the local stream so runTurn's loop unwinds into the stopped branch.
        ctrl.abort.abort();
        fetchSessions();
      } else {
        flash(data?.error ? `Couldn't stop: ${data.error}` : "Couldn't stop the turn — still running.");
      }
    } finally {
      setStoppingFor(target, false);
    }
  };

  // Re-sync a dropped turn. Two triggers: tab refocus/visibility (mobile reopen)
  // AND a poll while the tab is already visible — the drop can happen with the
  // tab in the foreground, so we can't wait on a future focus event. Re-armed by
  // recoverNonce; gives up after a bounded window so a turn that truly never
  // persists doesn't poll forever.
  useEffect(() => {
    if (pendingRecover.current.size === 0) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + 10 * 60_000; // match the runtime's ~max turn

    const finish = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", attempt);
      window.removeEventListener("focus", attempt);
    };

    async function attempt() {
      if (stopped || pendingRecover.current.size === 0) return finish();
      if (document.visibilityState !== "visible") return; // resume on next focus
      // Poll every session with a dropped turn — each recovers independently.
      for (const [sid, { baseCount }] of Array.from(pendingRecover.current.entries())) {
        if (await recoverActiveTurn(sid, baseCount)) {
          pendingRecover.current.delete(sid);
          setRecoveringFor(sid, false); // reply landed → session free again
          fetchSessions();
        }
      }
      if (pendingRecover.current.size === 0) return finish();
      if (Date.now() > deadline) {
        for (const sid of Array.from(pendingRecover.current.keys())) setRecoveringFor(sid, false);
        pendingRecover.current.clear();
        flash("Couldn't reconnect — reopen the session to see the latest.");
        return finish();
      }
      timer = setTimeout(attempt, 4000);
    }

    document.addEventListener("visibilitychange", attempt);
    window.addEventListener("focus", attempt);
    attempt();
    return finish;
  }, [recoverNonce, recoverActiveTurn, fetchSessions, setRecoveringFor]);

  const remove = async (id: string) => {
    await fetch(`/api/cloud-code/sessions/${id}`, { method: "DELETE" });
    if (selectedId === id) setSelectedId(null);
    fetchSessions();
  };

  // Ported session: when one with a pendingSeed loads, fire it once as the
  // first turn (clone → checkout branch → resume from the laptop context). The
  // server clears pendingSeed when the turn persists, so a refresh won't re-run.
  useEffect(() => {
    if (!active?.pendingSeed) return;
    if (active.turns.length > 0) return; // already started
    if (view !== "chat") return; // terminal does its own resume; artifacts isn't a turn surface
    if (seededRef.current === active.sessionId) return;
    seededRef.current = active.sessionId;
    const seed = active.pendingSeed;
    // Clear locally so the input/UI doesn't treat it as still-pending.
    setActive((s) => (s ? { ...s, pendingSeed: undefined } : s));
    const label = active.branch
      ? `↪ Resuming laptop session on \`${active.branch}\` — continue from here.`
      : "↪ Resuming laptop session — continue from here.";
    runTurn(seed, label);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.sessionId, active?.pendingSeed, view]);

  return (
    <div className="flex h-[calc(100vh-56px)] h-[calc(100dvh-56px)] -m-4 md:-m-6 relative overflow-hidden">
      {/* Mobile backdrop for the session drawer */}
      {sessionsOpen && (
        <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={() => setSessionsOpen(false)} aria-hidden="true" />
      )}
      {/* Sidebar — session history. Off-canvas drawer on mobile, in-flow on desktop. */}
      <aside className={`fixed md:static z-40 top-0 left-0 h-full w-72 bg-surface-1 md:bg-[var(--color-bg-secondary)] border-r border-[var(--color-border)] flex flex-col flex-shrink-0 transition-transform duration-300 ${sessionsOpen ? "translate-x-0 shadow-2xl" : "-translate-x-full md:translate-x-0"}`}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
          <span className="text-sm font-semibold flex items-center gap-2">
            <Cloud className="w-4 h-4 text-brand-400" /> Cloud Code
          </span>
          <button
            onClick={() => setShowNew(true)}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-brand-600 text-white text-xs font-semibold hover:bg-brand-500 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" /> New
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-2">
          {sessions.length === 0 && (
            <p className="text-xs text-[var(--color-text-muted)] text-center mt-6 px-3">
              No sessions yet. Start one — it runs in the cloud and resumes from any device.
            </p>
          )}
          {sessions.map((s) => (
            <div
              key={s.sessionId}
              data-testid="cc-session-row"
              onClick={() => { setSelectedId(s.sessionId); setSessionsOpen(false); }}
              className={`group px-2.5 py-2 rounded-lg mb-1 cursor-pointer border ${
                selectedId === s.sessionId
                  ? "bg-brand-600/15 border-brand-500/30"
                  : "border-transparent hover:bg-[var(--color-bg-tertiary)]"
              }`}
            >
              <div className="flex items-center gap-2">
                {/* A turn running/recovering in this session shows a spinner in
                    place of the warmth dot — visible even from another chat. */}
                {sendingIds.has(s.sessionId) || recoveringIds.has(s.sessionId) ? (
                  <Loader2 className="w-2.5 h-2.5 flex-shrink-0 animate-spin text-brand-400" aria-label="Turn running" />
                ) : (
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${WARMTH_DOT[s.warmth]}`} />
                )}
                {/* Surface this session opens in — terminal vs chat. */}
                {s.defaultView === "terminal" ? (
                  <TerminalSquare className="w-3.5 h-3.5 flex-shrink-0 text-brand-300" aria-label="Terminal session" />
                ) : (
                  <MessageSquare className="w-3.5 h-3.5 flex-shrink-0 text-[var(--color-text-muted)]" aria-label="Chat session" />
                )}
                <span className="text-[13px] font-medium truncate flex-1">{s.title}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(s.sessionId);
                  }}
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-red-500/20 text-[var(--color-text-muted)] hover:text-red-400 transition-all"
                  title="Delete session"
                  aria-label={`Delete session: ${s.title}`}
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
              <div className="flex items-center gap-2 mt-1 pl-4 text-[10.5px] text-[var(--color-text-muted)]">
                <CliBadge cli={s.cli} className="text-[10px]" />
                {s.repo && <span className="truncate">{s.repo.split("/").slice(-2).join("/")}</span>}
              </div>
            </div>
          ))}
        </div>

        <button
          onClick={() => setShowConfig(true)}
          className="flex items-center gap-2 px-4 py-2 border-t border-[var(--color-border)] text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
        >
          <Settings className="w-3.5 h-3.5" /> My CLI config (MCP, skills, agents)
        </button>
        <div className="px-4 py-2.5 border-t border-[var(--color-border)] text-[11px] text-[var(--color-text-muted)] flex items-center gap-2">
          <Cloud className="w-3 h-3" /> Sessions run on AgentCore — close the lid, resume anywhere
        </div>
      </aside>

      {/* Main — chat. min-h-0 so the inner stream (not the panel) is what scrolls. */}
      <main className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Mobile-only bar: open the session drawer + quick New. Pinned (shrink-0)
            so it stays reachable — never scrolls away with the chat. */}
        <div className="md:hidden flex-shrink-0 flex items-center justify-between px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
          <button
            onClick={() => setSessionsOpen(true)}
            className="flex items-center gap-1.5 text-xs font-medium text-[var(--color-text-secondary)]"
          >
            <Cloud className="w-4 h-4 text-brand-400" /> Sessions
          </button>
          <button
            onClick={() => setShowNew(true)}
            className="flex items-center gap-1 px-2 py-1 rounded-lg bg-brand-600 text-white text-xs font-semibold"
          >
            <Plus className="w-3.5 h-3.5" /> New
          </button>
        </div>
        {!active ? (
          <div className="flex flex-col items-center justify-center h-full text-center p-8">
            <div className="w-16 h-16 rounded-full bg-brand-600/10 flex items-center justify-center mb-4">
              <Cloud className="w-7 h-7 text-brand-400" />
            </div>
            <h3 className="text-lg font-semibold mb-2">A coding agent that lives in the cloud</h3>
            <p className="text-sm text-[var(--color-text-muted)] max-w-md mb-4">
              Give it a repo and a task. It clones, codes, builds, and opens a PR — server-side.
              Close your laptop; pick the same session back up from any device.
            </p>
            <button
              onClick={() => setShowNew(true)}
              data-testid="cc-new-session"
              className="px-4 py-2 bg-brand-600 text-white text-sm font-medium rounded-lg hover:bg-brand-500 transition-colors"
            >
              New session
            </button>
          </div>
        ) : (
          <>
            <div className="flex-shrink-0 px-3 md:px-5 py-3 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="font-semibold text-[13.5px] truncate">{active.title}</div>
                <div className="text-[11px] text-[var(--color-text-muted)] font-mono flex items-center gap-2">
                  <CliBadge cli={active.cli} />
                  {active.repo && (
                    <span className="flex items-center gap-1">
                      <GitBranch className="w-3 h-3" /> {active.repo}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
              {/* Pull-to-laptop command (claude only — pull resumes via --resume). */}
              {active.cli === "claude" && (
                <PullCommandButton sessionId={active.sessionId} className="hidden sm:flex" />
              )}
              {/* Chat ⇄ Terminal ⇄ Artifacts toggle */}
              <div className="flex items-center rounded-lg border border-[var(--color-border)] overflow-hidden">
                <button
                  onClick={() => setView("chat")}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors ${
                    view === "chat"
                      ? "bg-brand-600/15 text-brand-300"
                      : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)]"
                  }`}
                >
                  <MessageSquare className="w-3.5 h-3.5" /> Chat
                </button>
                <button
                  onClick={() => setView("terminal")}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors ${
                    view === "terminal"
                      ? "bg-brand-600/15 text-brand-300"
                      : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)]"
                  }`}
                  title="Live terminal into the session microVM"
                >
                  <TerminalSquare className="w-3.5 h-3.5" /> Terminal
                </button>
                <button
                  onClick={() => setView("artifacts")}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors ${
                    view === "artifacts"
                      ? "bg-brand-600/15 text-brand-300"
                      : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)]"
                  }`}
                  title="Files this session generated or you uploaded"
                >
                  <FileBox className="w-3.5 h-3.5" /> Artifacts
                </button>
              </div>
              </div>
            </div>

            {view === "terminal" ? (
              <div className="flex-1 min-h-0">
                <ShellTerminal
                  sessionId={active.sessionId}
                  // The server launches `claude --resume` itself (shell-init reads
                  // the runtime's resume hint), so the browser only types the
                  // first-prompt seed while pendingSeed is set — once typed we
                  // clear it so reopening re-attaches without re-typing.
                  resumeFirstPrompt={active.pendingSeed || undefined}
                  onSeedConsumed={() => {
                    setActive((s) => (s ? { ...s, pendingSeed: undefined } : s));
                    fetch(`/api/cloud-code/sessions/${active.sessionId}`, {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ clearPendingSeed: true }),
                    }).catch(() => {});
                  }}
                />
              </div>
            ) : view === "artifacts" ? (
              <div className="flex-1 min-h-0">
                <ArtifactsPanel sessionId={active.sessionId} />
              </div>
            ) : (
            <div className="relative flex-1 min-h-0">
            <div
              ref={scrollRef}
              onScroll={onStreamScroll}
              data-testid="cc-stream"
              className="h-full overflow-y-auto overscroll-contain px-3 md:px-5 py-5 flex flex-col gap-4"
            >
              {displayTurns.length === 0 && (
                <p className="text-xs text-[var(--color-text-muted)] text-center mt-4">
                  First task clones the repo (warm after). Try: “add a CONTRIBUTING.md, commit on a branch, open a PR.”
                </p>
              )}
              {displayTurns.map((t, i) =>
                t.role === "user" ? (
                  // User turns keep a bubble (right-aligned) — the visual anchor
                  // for "what I asked". Capped width so long prompts wrap nicely.
                  <div key={i} className="self-end max-w-[85%] md:max-w-[75%] bg-brand-600 text-white px-3.5 py-2 rounded-2xl rounded-br-sm text-sm whitespace-pre-wrap break-words">
                    {t.text}
                  </div>
                ) : (
                  // Agent turns: no bubble — full content width (esp. on mobile),
                  // just a brand label above. Matches ChatGPT/Claude's UI.
                  <div key={i} data-testid="cc-agent-turn" className="self-stretch w-full">
                    <div className={`flex items-center gap-1 text-[10.5px] font-semibold mb-1.5 ${CLI_BRAND[active.cli].dot}`}>
                      <CliMark cli={active.cli} className="w-3 h-3" />
                      <span className="tracking-wide">{CLI_BRAND[active.cli].label}</span>
                    </div>
                    <div className="text-sm leading-relaxed">
                      <MarkdownRenderer content={t.text} />
                    </div>
                  </div>
                )
              )}
              {activeSending && (
                <div className="self-start flex items-center gap-2 text-[var(--color-text-muted)] text-sm">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> working… (keeps running if you close this)
                </div>
              )}
              <div ref={streamEnd} />
            </div>
            {/* Jump-to-latest — shows only when you've scrolled up off the bottom. */}
            {!stuck && (
              <button
                onClick={() => scrollToLatest("smooth")}
                className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1 px-3 py-1.5 rounded-full bg-brand-600 text-white text-xs font-medium shadow-lg hover:bg-brand-500 transition-colors"
                aria-label="Jump to latest"
              >
                <ArrowDown className="w-3.5 h-3.5" /> Latest
              </button>
            )}
            </div>
            )}

            {view === "chat" && (
            <div className="flex-shrink-0 px-3 md:px-5 py-3 md:py-3.5 border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
              {/* items-end keeps the send button pinned to the last line as the
                  box grows; the textarea's own padding centers a single line. */}
              <div className="flex items-end gap-2 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-2xl pl-3.5 pr-2 py-1.5 focus-within:border-brand-500/50 transition-colors">
                <textarea
                  ref={inputRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  rows={1}
                  placeholder={activeSending ? "Working… (you can queue your next message)" : "Give the next task…   (Enter to send, Shift+Enter for a new line)"}
                  autoFocus
                  // Stop iOS/Safari from offering password/card/contact AutoFill on a
                  // plain prompt box (the key/card/pin chips above the keyboard).
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-testid="cc-message-input"
                  className="flex-1 bg-transparent resize-none outline-none text-sm leading-6 py-1.5 max-h-[152px] placeholder:text-[var(--color-text-muted)]"
                />
                {activeSending ? (
                  <button
                    onClick={() => stopTurn()}
                    disabled={activeStopping}
                    data-testid="cc-stop"
                    className="w-8 h-8 mb-0.5 rounded-lg bg-red-600 text-white flex items-center justify-center hover:bg-red-500 transition-colors disabled:opacity-40 flex-shrink-0"
                    aria-label="Stop"
                    title="Stop the running turn"
                  >
                    {activeStopping ? <Loader2 className="w-4 h-4 animate-spin" /> : <Square className="w-3.5 h-3.5" fill="currentColor" />}
                  </button>
                ) : draft.trim() && !voiceActive ? (
                  <button
                    onClick={send}
                    disabled={!draft.trim()}
                    data-testid="cc-send"
                    className="w-8 h-8 mb-0.5 rounded-lg bg-brand-600 text-white flex items-center justify-center hover:bg-brand-500 transition-colors disabled:opacity-40 flex-shrink-0"
                    aria-label="Send"
                  >
                    <Send className="w-4 h-4" />
                  </button>
                ) : (
                  // Empty composer → push-to-talk mic (hidden where unsupported,
                  // which falls back to showing the disabled send button).
                  <VoiceButton
                    onText={(t) => setDraft(t)}
                    onError={(m) => flash(m)}
                    onActiveChange={setVoiceActive}
                  />
                )}
              </div>
            </div>
            )}
          </>
        )}
      </main>

      {showNew && <NewSessionModal onClose={() => setShowNew(false)} onCreate={createSession} />}
      {showConfig && <ConfigModal onClose={() => setShowConfig(false)} onToast={flash} />}

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg bg-red-600 text-white text-xs font-medium shadow-lg z-50">
          {toast}
        </div>
      )}
    </div>
  );
}

function NewSessionModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (cli: CloudCodeCli, repo: string) => void;
}) {
  const [cli, setCli] = useState<CloudCodeCli>("claude");
  const [repo, setRepo] = useState("");

  return (
    <div
      className="fixed inset-0 z-[200] grid place-items-center p-4 bg-black/60"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-md bg-surface-1 border border-[var(--color-border)] rounded-xl p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="cc-new-title"
      >
        <h2 id="cc-new-title" className="text-base font-semibold mb-4 flex items-center gap-2">
          <Cloud className="w-4 h-4 text-brand-400" /> New Cloud Code session
        </h2>

        <label className="block text-xs font-medium text-[var(--color-text-muted)] mb-1.5">Agent</label>
        <div className="flex gap-2 mb-4">
          {(["claude", "codex"] as CloudCodeCli[]).map((c) => (
            <button
              key={c}
              onClick={() => setCli(c)}
              data-testid={`cc-cli-${c}`}
              className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                cli === c
                  ? "bg-brand-600/15 border-brand-500/40 text-brand-300"
                  : "border-[var(--color-border)] hover:bg-[var(--color-bg-tertiary)]"
              }`}
            >
              {c === "claude" ? "Claude Code" : "Codex (GPT-5.5)"}
            </button>
          ))}
        </div>

        <label className="block text-xs font-medium text-[var(--color-text-muted)] mb-1.5">
          Repository <span className="opacity-60">(owner/name — optional)</span>
        </label>
        <input
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          placeholder="owner/name"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-testid="cc-repo-input"
          className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] text-sm outline-none focus:border-brand-500/50 mb-1.5 font-mono"
        />
        <p className="text-[11px] text-[var(--color-text-muted)] mb-5 leading-relaxed">
          Needs the full <span className="font-mono">owner/name</span>. Leave empty and ask
          “list my repos” — the agent has <span className="font-mono">gh</span> access.
        </p>

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm border border-[var(--color-border)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => onCreate(cli, repo.trim())}
            data-testid="cc-start"
            className="px-4 py-2 rounded-lg text-sm font-medium bg-brand-600 text-white hover:bg-brand-500 transition-colors flex items-center gap-1.5"
          >
            <Radio className="w-3.5 h-3.5" /> Start
          </button>
        </div>
      </div>
    </div>
  );
}

interface ConfigVersion {
  version: string;
  label?: string;
  sizeBytes: number;
  fileCount: number;
  createdAt: string;
}

interface GithubState {
  appConfigured: boolean;
  isAdmin: boolean;
  connection: { account?: string; repoSelection?: string; repoCount?: number } | null;
}

function ConfigModal({ onClose, onToast }: { onClose: () => void; onToast: (m: string) => void }) {
  const [versions, setVersions] = useState<ConfigVersion[]>([]);
  const [current, setCurrent] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [github, setGithub] = useState<GithubState>({ appConfigured: false, isAdmin: false, connection: null });
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/cloud-code/config");
    if (res.ok) {
      const d = await res.json();
      setVersions(d.versions || []);
      setCurrent(d.currentVersion);
    }
  }, []);
  const loadGithub = useCallback(async () => {
    const res = await fetch("/api/cloud-code/github");
    if (res.ok) setGithub(await res.json());
  }, []);
  useEffect(() => {
    load();
    loadGithub();
  }, [load, loadGithub]);

  const disconnectGithub = async () => {
    setBusy(true);
    try {
      await fetch("/api/cloud-code/github", { method: "DELETE" });
      await loadGithub();
      onToast("GitHub disconnected");
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File) => {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("bundle", file);
      const res = await fetch("/api/cloud-code/config", { method: "POST", body: fd });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "upload failed");
      onToast("Config uploaded — now active");
      await load();
    } catch (e) {
      onToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const setActive = async (version?: string) => {
    setBusy(true);
    try {
      const res = await fetch("/api/cloud-code/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version }),
      });
      if (!res.ok) throw new Error("failed");
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[200] grid place-items-center p-4 bg-black/60" onClick={onClose} role="presentation">
      <div
        className="w-full max-w-lg bg-surface-1 border border-[var(--color-border)] rounded-xl p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="cc-config-title"
      >
        <h2 id="cc-config-title" className="text-base font-semibold mb-1 flex items-center gap-2">
          <Settings className="w-4 h-4 text-brand-400" /> My CLI config
        </h2>
        <p className="text-[12px] text-[var(--color-text-muted)] mb-4 leading-relaxed">
          Upload a zip of your Claude Code / Codex setup so every session launches with it.
          Layout: <span className="font-mono">claude/</span> (settings, .mcp.json, skills/, agents/) and{" "}
          <span className="font-mono">codex/</span> (config.toml, AGENTS.md). Your Bedrock model
          access is always preserved.
        </p>

        <input
          ref={fileRef}
          type="file"
          accept=".zip"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload(f);
            e.target.value = "";
          }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-dashed border-[var(--color-border)] hover:border-brand-500/50 hover:bg-[var(--color-bg-tertiary)] text-sm transition-colors disabled:opacity-50 mb-4"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
          Upload config bundle (.zip)
        </button>

        {/* GitHub: connect an App installation so private repos clone with
            short-lived, per-repo tokens instead of a shared PAT. */}
        <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)] mb-2">
          GitHub
        </div>
        <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-[var(--color-border)] mb-5">
          <Github className="w-4 h-4 shrink-0 text-[var(--color-text-muted)]" />
          <div className="flex-1 min-w-0">
            {github.connection ? (
              <>
                <div className="text-[13px] font-medium truncate">
                  {github.connection.account || "Connected"}
                </div>
                <div className="text-[10.5px] text-[var(--color-text-muted)]">
                  {github.connection.repoSelection === "selected"
                    ? `${github.connection.repoCount ?? "selected"} repo${github.connection.repoCount === 1 ? "" : "s"}`
                    : "all repositories"}{" "}
                  · short-lived tokens
                </div>
              </>
            ) : (
              <>
                <div className="text-[13px] font-medium">Not connected</div>
                <div className="text-[10.5px] text-[var(--color-text-muted)]">
                  {github.appConfigured
                    ? "Connect to clone private repos with scoped, expiring tokens"
                    : github.isAdmin
                      ? "Set up the GitHub App to enable private-repo cloning"
                      : "GitHub App isn't set up — ask your operator"}
                </div>
              </>
            )}
          </div>
          {github.connection ? (
            <button
              onClick={disconnectGithub}
              disabled={busy}
              className="text-[11px] px-2.5 py-1 rounded border border-[var(--color-border)] hover:text-red-400 hover:border-red-500/40 transition-colors disabled:opacity-50"
            >
              Disconnect
            </button>
          ) : (
            (github.appConfigured || github.isAdmin) && (
              <a
                href="/api/cloud-code/github/install"
                className="text-[11px] px-2.5 py-1 rounded border border-brand-500/50 text-brand-300 hover:bg-brand-500/10 transition-colors"
              >
                {github.appConfigured ? "Connect" : "Set up"}
              </a>
            )
          )}
        </div>

        <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)] mb-2">
          Versions
        </div>
        <div className="max-h-56 overflow-y-auto flex flex-col gap-1.5">
          {versions.length === 0 && (
            <p className="text-xs text-[var(--color-text-muted)] py-2">No config uploaded — sessions use defaults.</p>
          )}
          {versions.map((v) => (
            <div
              key={v.version}
              className="flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--color-border)]"
            >
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-mono truncate">{v.version}</div>
                <div className="text-[10.5px] text-[var(--color-text-muted)]">
                  {v.fileCount} files · {(v.sizeBytes / 1024).toFixed(0)} KB ·{" "}
                  {new Date(v.createdAt).toLocaleString()}
                </div>
              </div>
              {current === v.version ? (
                <span className="flex items-center gap-1 text-[11px] text-green-400 font-medium">
                  <Check className="w-3.5 h-3.5" /> Active
                </span>
              ) : (
                <button
                  onClick={() => setActive(v.version)}
                  disabled={busy}
                  className="text-[11px] px-2.5 py-1 rounded border border-[var(--color-border)] hover:bg-[var(--color-bg-tertiary)] transition-colors disabled:opacity-50"
                >
                  Use
                </button>
              )}
            </div>
          ))}
        </div>

        <div className="flex justify-between items-center mt-5">
          {current ? (
            <button
              onClick={() => setActive(undefined)}
              disabled={busy}
              className="text-[12px] text-[var(--color-text-muted)] hover:text-red-400 transition-colors disabled:opacity-50"
            >
              Disable (use defaults)
            </button>
          ) : (
            <span />
          )}
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm border border-[var(--color-border)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
