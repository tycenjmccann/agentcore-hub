"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  ShellChannel,
  decodeFrame,
  decodeText,
  encodeStdin,
  encodeResize,
  encodeHeartbeat,
} from "@/lib/cloud-code/shell-protocol";

type Status = "connecting" | "connected" | "closed" | "error";

/**
 * Live PTY terminal into a session's microVM. The browser connects DIRECTLY to
 * the AgentCore runtime over a presigned wss:// URL (minted by our API); our
 * server never proxies the socket. Speaks the K8s channel-prefix protocol.
 */
export default function ShellTerminal({
  sessionId,
  resumeSessionId,
  resumeFirstPrompt,
  onSeedConsumed,
}: {
  sessionId: string;
  // When set, the shell auto-runs `claude --resume <resumeSessionId>` on connect
  // (ported session opened in the Terminal tab). resumeFirstPrompt, if given, is
  // typed as the first message to the resumed agent.
  resumeSessionId?: string;
  resumeFirstPrompt?: string;
  // Called once after the first-prompt seed has been typed, so the parent can
  // persist a clear (clearPendingSeed). Reopening then re-attaches via
  // `claude --resume` WITHOUT re-typing the seed.
  onSeedConsumed?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [err, setErr] = useState<string | null>(null);
  // Resume should fire exactly once per attach, even if onopen re-runs.
  const resumedRef = useRef(false);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let term: Terminal | null = null;
    let fit: FitAddon | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let disposed = false;

    const term0 = new Terminal({
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      scrollback: 5000,        // keep history so there's something to scroll
      scrollSensitivity: 3,    // smoother wheel/touch scroll
      theme: { background: "#0b0f17", foreground: "#e2e8f0" },
    });
    term = term0;
    fit = new FitAddon();
    term0.loadAddon(fit);
    if (hostRef.current) {
      term0.open(hostRef.current);
      fit.fit();
      // xterm's scrollable element is .xterm-viewport, NOT our host div. Let it
      // pan vertically on touch (finger-scroll the terminal) and contain the
      // overscroll so the gesture never chains up to scroll the page behind it.
      const vp = hostRef.current.querySelector(".xterm-viewport") as HTMLElement | null;
      if (vp) {
        vp.style.touchAction = "pan-y";
        vp.style.overscrollBehavior = "contain";
      }
    }
    term0.writeln("\x1b[90mConnecting to your session…\x1b[0m");

    (async () => {
      try {
        const res = await fetch(`/api/cloud-code/sessions/${sessionId}/shell`, { method: "POST" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "failed to get shell URL");
        if (disposed) return;

        ws = new WebSocket(data.url);
        ws.binaryType = "arraybuffer";

        ws.onopen = () => {
          setStatus("connected");
          if (fit && term0) {
            ws!.send(encodeResize(term0.cols, term0.rows));
          }
          heartbeat = setInterval(() => {
            if (ws?.readyState === WebSocket.OPEN) ws.send(encodeHeartbeat());
          }, 30_000);

          // Ported session opened in Terminal: cd into the cloned workspace and
          // natively resume the laptop conversation, then type the first prompt.
          // WORKSPACE_DIR is exported per-session by shell-init; fall back to the
          // session's workspace path. The agent picks up with full history.
          if (resumeSessionId && !resumedRef.current) {
            resumedRef.current = true;
            const safeSid = sessionId.replace(/[^A-Za-z0-9._-]/g, "-");
            const cd = `cd "$WORKSPACE_ROOT/sessions/${safeSid}"/* 2>/dev/null || cd "$WORKSPACE_ROOT"`;
            const resume = `claude --resume ${resumeSessionId}`;
            // Send cd + resume as one line; the agent opens in the TUI.
            setTimeout(() => {
              if (ws?.readyState !== WebSocket.OPEN) return;
              ws.send(encodeStdin(`${cd} && ${resume}\n`));
              // The first-prompt seed is typed ONCE (it's a long nudge). Tell the
              // parent so it persists a clear — reopening re-runs `claude --resume`
              // above (idempotent) but never re-types this seed (which would stack
              // in the transcript). Re-attach without a seed skips this block.
              if (resumeFirstPrompt) {
                setTimeout(() => {
                  if (ws?.readyState === WebSocket.OPEN) {
                    ws.send(encodeStdin(`${resumeFirstPrompt}\n`));
                    onSeedConsumed?.();
                  }
                }, 4000);
              }
            }, 600);
          }
        };

        ws.onmessage = (ev) => {
          const f = decodeFrame(ev.data as ArrayBuffer);
          if (f.channel === ShellChannel.STDOUT || f.channel === ShellChannel.STDERR) {
            term0.write(f.payload);
          } else if (f.channel === ShellChannel.STATUS) {
            try {
              const s = JSON.parse(decodeText(f.payload));
              if (s.status === "Failure") {
                term0.writeln(`\r\n\x1b[90m[session ended: ${s.message || s.reason || "exit"}]\x1b[0m`);
              }
            } catch {
              /* ignore non-JSON status */
            }
          } else if (f.channel === ShellChannel.CLOSE) {
            setStatus("closed");
          }
        };

        ws.onerror = () => {
          setErr("connection error");
          setStatus("error");
        };
        ws.onclose = () => {
          if (!disposed) setStatus((s) => (s === "error" ? s : "closed"));
        };

        term0.onData((d) => {
          if (ws?.readyState === WebSocket.OPEN) ws.send(encodeStdin(d));
        });
        term0.onResize(({ cols, rows }) => {
          if (ws?.readyState === WebSocket.OPEN) ws.send(encodeResize(cols, rows));
        });
      } catch (e) {
        if (disposed) return;
        setErr((e as Error).message);
        setStatus("error");
        term0.writeln(`\r\n\x1b[31m${(e as Error).message}\x1b[0m`);
      }
    })();

    const onWinResize = () => fit?.fit();
    window.addEventListener("resize", onWinResize);

    return () => {
      disposed = true;
      window.removeEventListener("resize", onWinResize);
      if (heartbeat) clearInterval(heartbeat);
      ws?.close();
      term?.dispose();
    };
  }, [sessionId]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-1.5 text-[11px] border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
        <span
          className={`w-2 h-2 rounded-full ${
            status === "connected"
              ? "bg-green-400"
              : status === "connecting"
              ? "bg-amber-400 animate-pulse"
              : "bg-[var(--color-text-muted)]"
          }`}
        />
        <span className="text-[var(--color-text-muted)]">
          {status === "connected"
            ? "live terminal — attached to the session microVM"
            : status === "connecting"
            ? "connecting…"
            : err || "disconnected"}
        </span>
      </div>
      {/* Touch scrolling is wired on the inner .xterm-viewport (see effect)
          so finger-scroll pans the terminal, not the page. */}
      <div
        ref={hostRef}
        className="flex-1 min-h-0 p-2 bg-[#0b0f17] overscroll-contain"
      />
    </div>
  );
}
