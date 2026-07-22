"use client";

/**
 * use-voice-input — tap-to-talk dictation with the lowest latency the device can
 * offer. On iOS Safari / Chrome / Edge / desktop Safari this is the on-device Web
 * Speech API: words land as you speak (interim results), zero network round trip,
 * zero cost, nothing leaves the device. Browsers without it (Firefox, some in-app
 * webviews) report `supported: false` so the UI can hide the mic.
 *
 * Engine-agnostic by design: exposes start/stop + a stream of {final, interim}
 * text. A future server-side fallback can implement the same surface.
 */

import { useCallback, useEffect, useRef, useState } from "react";

// Minimal Web Speech typings (the DOM lib ships them inconsistently).
interface SpeechRecognitionAlternativeLike { transcript: string }
interface SpeechRecognitionResultLike {
  0: SpeechRecognitionAlternativeLike;
  isFinal: boolean;
  length: number;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: { length: number; [i: number]: SpeechRecognitionResultLike };
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export interface VoiceInput {
  /** True when this browser can do on-device dictation. */
  supported: boolean;
  /** True while actively listening. */
  listening: boolean;
  /** Finalized text for this dictation pass (stable). */
  finalText: string;
  /** In-flight words not yet finalized (streams in live). */
  interimText: string;
  /** Last error string, if any (e.g. "not-allowed" = mic permission denied). */
  error: string | null;
  /** Begin a fresh dictation pass (clears prior text). */
  start: () => void;
  /** Stop listening, keep the text. */
  stop: () => void;
  /** Stop and discard everything (slide-to-cancel). */
  cancel: () => void;
}

/**
 * @param onText called on every update with the best-so-far text (final +
 *   interim) — wire it straight into the composer for live transcription.
 */
export function useVoiceInput(onText?: (text: string) => void): VoiceInput {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [finalText, setFinalText] = useState("");
  const [interimText, setInterimText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const finalRef = useRef("");          // accumulated final across onresult events
  const cancelledRef = useRef(false);   // suppress text emission on cancel
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  useEffect(() => {
    setSupported(getCtor() !== null);
  }, []);

  const teardown = useCallback(() => {
    const rec = recRef.current;
    if (rec) {
      rec.onresult = rec.onerror = rec.onend = null;
      try { rec.abort(); } catch { /* already stopped */ }
    }
    recRef.current = null;
  }, []);

  const start = useCallback(() => {
    const Ctor = getCtor();
    if (!Ctor) { setError("unsupported"); return; }
    teardown();
    cancelledRef.current = false;
    finalRef.current = "";
    setFinalText("");
    setInterimText("");
    setError(null);

    const rec = new Ctor();
    rec.lang = (typeof navigator !== "undefined" && navigator.language) || "en-US";
    rec.continuous = true;       // keep going across pauses (locked recording)
    rec.interimResults = true;   // stream partials → lowest perceived latency

    rec.onresult = (e) => {
      if (cancelledRef.current) return;
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const txt = r[0].transcript;
        if (r.isFinal) finalRef.current += txt;
        else interim += txt;
      }
      setFinalText(finalRef.current);
      setInterimText(interim);
      const combined = (finalRef.current + interim).replace(/\s+/g, " ").trimStart();
      onTextRef.current?.(combined);
    };
    rec.onerror = (ev) => {
      // "no-speech"/"aborted" are benign; surface permission + real failures.
      if (ev.error && ev.error !== "no-speech" && ev.error !== "aborted") {
        setError(ev.error);
      }
    };
    rec.onend = () => {
      setListening(false);
      setInterimText("");
    };

    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      // .start() throws if called while already running — ignore.
    }
  }, [teardown]);

  const stop = useCallback(() => {
    const rec = recRef.current;
    if (rec) { try { rec.stop(); } catch { /* noop */ } }
    setListening(false);
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    finalRef.current = "";
    teardown();
    setListening(false);
    setFinalText("");
    setInterimText("");
  }, [teardown]);

  useEffect(() => teardown, [teardown]);

  return { supported, listening, finalText, interimText, error, start, stop, cancel };
}
