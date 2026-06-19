"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Plus, Cloud, Send, Trash2, GitBranch, Loader2, Radio, MessageSquare, TerminalSquare, Settings, Upload, Check } from "lucide-react";
import dynamic from "next/dynamic";
import { sseData } from "@/lib/sse";

// xterm touches the DOM/window — load only in the browser.
const ShellTerminal = dynamic(() => import("@/components/cloud-code/ShellTerminal"), { ssr: false });
import type {
  CloudCodeSession,
  CloudCodeSessionSummary,
  CloudCodeCli,
  SessionWarmth,
} from "@/lib/cloud-code/types";

const WARMTH_DOT: Record<SessionWarmth, string> = {
  warm: "bg-green-400 shadow-[0_0_0_3px_rgba(34,197,94,0.15)]",
  idle: "bg-amber-400/70",
  cold: "bg-[var(--color-text-muted)]",
};

const CLI_BADGE: Record<CloudCodeCli, string> = {
  claude: "bg-purple-500/15 text-purple-300",
  codex: "bg-green-500/15 text-green-300",
};

export default function CloudCodePage() {
  const [sessions, setSessions] = useState<CloudCodeSessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [active, setActive] = useState<CloudCodeSession | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [view, setView] = useState<"chat" | "terminal">("chat");
  const [sessionsOpen, setSessionsOpen] = useState(false); // mobile session drawer
  const streamEnd = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const fetchSessions = useCallback(async () => {
    const res = await fetch("/api/cloud-code/sessions");
    if (!res.ok) return;
    const data = await res.json();
    setSessions(data.sessions || []);
  }, []);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  // Load full session when selected
  useEffect(() => {
    setView("chat");
    if (!selectedId) {
      setActive(null);
      return;
    }
    fetch(`/api/cloud-code/sessions/${selectedId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setActive(d.session))
      .catch(() => {});
  }, [selectedId]);

  useEffect(() => {
    streamEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [active?.turns.length, sending]);

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
    if (!active || !draft.trim() || sending) return;
    const prompt = draft.trim();
    setDraft("");
    setSending(true);
    // Optimistic user turn
    setActive((s) =>
      s ? { ...s, turns: [...s.turns, { role: "user", text: prompt, at: new Date().toISOString() }] } : s
    );
    try {
      // Claude streams (SSE); codex is buffered (plain JSON).
      const canStream = active.cli === "claude";
      const res = await fetch(
        `/api/cloud-code/sessions/${active.sessionId}/message${canStream ? "?stream=1" : ""}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt }) }
      );

      if (canStream && res.body && res.headers.get("content-type")?.includes("event-stream")) {
        // Append a live agent turn and grow it as text frames arrive.
        setActive((s) =>
          s ? { ...s, turns: [...s.turns, { role: "agent", text: "", at: new Date().toISOString() }] } : s
        );
        let acc = "";
        // sseData handles the byte/frame plumbing; we own the {type:text|done|error} schema.
        for await (const data of sseData(res.body)) {
          let obj: { type?: string; text?: string; response?: string; error?: string };
          try { obj = JSON.parse(data); } catch { continue; }
          if (obj.type === "text") acc += obj.text || "";
          else if (obj.type === "done") acc = obj.response || acc;
          else if (obj.type === "error") acc += `\n⚠ ${obj.error}`;
          // Update the last (agent) turn's text in place.
          setActive((s) => {
            if (!s) return s;
            const turns = s.turns.slice();
            turns[turns.length - 1] = { role: "agent", text: acc, at: turns[turns.length - 1].at };
            return { ...s, turns };
          });
        }
        fetchSessions();
      } else {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Turn failed");
        setActive(data.session);
        fetchSessions();
      }
    } catch (err) {
      flash((err as Error).message);
      setActive((s) =>
        s
          ? {
              ...s,
              turns: [
                ...s.turns,
                { role: "agent", text: `⚠ ${(err as Error).message}`, at: new Date().toISOString() },
              ],
            }
          : s
      );
    } finally {
      setSending(false);
      // Re-focus the box so you can keep typing without clicking back in.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  };

  const remove = async (id: string) => {
    await fetch(`/api/cloud-code/sessions/${id}`, { method: "DELETE" });
    if (selectedId === id) setSelectedId(null);
    fetchSessions();
  };

  return (
    <div className="flex h-[calc(100vh-56px)] -m-4 md:-m-6 relative">
      {/* Mobile backdrop for the session drawer */}
      {sessionsOpen && (
        <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={() => setSessionsOpen(false)} aria-hidden="true" />
      )}
      {/* Sidebar — session history. Off-canvas drawer on mobile, in-flow on desktop. */}
      <aside className={`fixed md:static z-40 top-0 left-0 h-full w-72 bg-[var(--color-bg-secondary)] border-r border-[var(--color-border)] flex flex-col flex-shrink-0 transition-transform duration-300 ${sessionsOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"}`}>
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
              onClick={() => { setSelectedId(s.sessionId); setSessionsOpen(false); }}
              className={`group px-2.5 py-2 rounded-lg mb-1 cursor-pointer border ${
                selectedId === s.sessionId
                  ? "bg-brand-600/15 border-brand-500/30"
                  : "border-transparent hover:bg-[var(--color-bg-tertiary)]"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${WARMTH_DOT[s.warmth]}`} />
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
                <span className={`px-1.5 rounded font-semibold uppercase tracking-wide ${CLI_BADGE[s.cli]}`}>
                  {s.cli}
                </span>
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

      {/* Main — chat */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Mobile-only bar: open the session drawer + quick New */}
        <div className="md:hidden flex items-center justify-between px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
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
            <div className="px-3 md:px-5 py-3 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="font-semibold text-[13.5px] truncate">{active.title}</div>
                <div className="text-[11px] text-[var(--color-text-muted)] font-mono flex items-center gap-2">
                  <span className={`px-1.5 rounded font-semibold uppercase ${CLI_BADGE[active.cli]}`}>{active.cli}</span>
                  {active.repo && (
                    <span className="flex items-center gap-1">
                      <GitBranch className="w-3 h-3" /> {active.repo}
                    </span>
                  )}
                </div>
              </div>
              {/* Chat ⇄ Terminal toggle */}
              <div className="flex items-center rounded-lg border border-[var(--color-border)] overflow-hidden flex-shrink-0">
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
              </div>
            </div>

            {view === "terminal" ? (
              <div className="flex-1 min-h-0">
                <ShellTerminal sessionId={active.sessionId} />
              </div>
            ) : (
            <div data-testid="cc-stream" className="flex-1 overflow-y-auto px-5 py-5 flex flex-col gap-3.5">
              {active.turns.length === 0 && (
                <p className="text-xs text-[var(--color-text-muted)] text-center mt-4">
                  First task clones the repo (warm after). Try: “add a CONTRIBUTING.md, commit on a branch, open a PR.”
                </p>
              )}
              {active.turns.map((t, i) =>
                t.role === "user" ? (
                  <div key={i} className="self-end max-w-[75%] bg-brand-600 text-white px-3.5 py-2 rounded-xl rounded-br-sm text-sm whitespace-pre-wrap">
                    {t.text}
                  </div>
                ) : (
                  <div key={i} data-testid="cc-agent-turn" className="self-start max-w-[80%]">
                    <div className="text-[10.5px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)] mb-1">
                      {active.cli}
                    </div>
                    <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl rounded-tl-sm px-3.5 py-2.5 text-sm whitespace-pre-wrap">
                      {t.text}
                    </div>
                  </div>
                )
              )}
              {sending && (
                <div className="self-start flex items-center gap-2 text-[var(--color-text-muted)] text-sm">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> working… (keeps running if you close this)
                </div>
              )}
              <div ref={streamEnd} />
            </div>
            )}

            {view === "chat" && (
            <div className="px-5 py-3.5 border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
              <div className="flex items-end gap-2 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-xl px-3.5 py-2">
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
                  placeholder={sending ? "Working… (you can queue your next message)" : "Give the next task…"}
                  autoFocus
                  data-testid="cc-message-input"
                  className="flex-1 bg-transparent resize-none outline-none text-sm max-h-32"
                />
                <button
                  onClick={send}
                  disabled={sending || !draft.trim()}
                  data-testid="cc-send"
                  className="w-8 h-8 rounded-lg bg-brand-600 text-white flex items-center justify-center hover:bg-brand-500 transition-colors disabled:opacity-40 flex-shrink-0"
                  aria-label="Send"
                >
                  <Send className="w-4 h-4" />
                </button>
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
        className="w-full max-w-md bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl p-6"
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

function ConfigModal({ onClose, onToast }: { onClose: () => void; onToast: (m: string) => void }) {
  const [versions, setVersions] = useState<ConfigVersion[]>([]);
  const [current, setCurrent] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/cloud-code/config");
    if (res.ok) {
      const d = await res.json();
      setVersions(d.versions || []);
      setCurrent(d.currentVersion);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

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
        className="w-full max-w-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl p-6"
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
