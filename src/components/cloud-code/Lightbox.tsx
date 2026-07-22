"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { X, Download } from "lucide-react";

/**
 * Full-screen image viewer with pinch-zoom, double-tap-to-zoom, and pan.
 * Mobile-first: a tapped artifact thumbnail opens here so you can inspect a
 * screenshot/mockup at full size. Tap the backdrop or × to close.
 *
 * Touch model:
 *  - one finger drag (while zoomed) → pan
 *  - two-finger pinch → zoom about the pinch midpoint
 *  - double-tap → toggle 1× ⇄ 2.5×
 * Mouse: wheel to zoom, drag to pan.
 */
export default function Lightbox({
  src,
  alt,
  downloadName,
  onClose,
}: {
  src: string;
  alt?: string;
  downloadName?: string;
  onClose: () => void;
}) {
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);

  // Gesture state kept in refs so handlers don't churn on every move.
  const gesture = useRef<{
    mode: "none" | "pan" | "pinch";
    startX: number;
    startY: number;
    startTx: number;
    startTy: number;
    startDist: number;
    startScale: number;
  }>({ mode: "none", startX: 0, startY: 0, startTx: 0, startTy: 0, startDist: 0, startScale: 1 });
  const lastTap = useRef(0);

  const reset = useCallback(() => {
    setScale(1);
    setTx(0);
    setTy(0);
  }, []);

  // Close on Escape; lock body scroll while open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const dist = (t: React.TouchList) =>
    Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

  const onTouchStart = (e: React.TouchEvent) => {
    const g = gesture.current;
    if (e.touches.length === 2) {
      g.mode = "pinch";
      g.startDist = dist(e.touches);
      g.startScale = scale;
      g.startTx = tx;
      g.startTy = ty;
    } else if (e.touches.length === 1) {
      // Double-tap detection.
      const now = Date.now();
      if (now - lastTap.current < 300) {
        setScale((s) => (s > 1 ? 1 : 2.5));
        if (scale > 1) reset();
        lastTap.current = 0;
        return;
      }
      lastTap.current = now;
      g.mode = "pan";
      g.startX = e.touches[0].clientX;
      g.startY = e.touches[0].clientY;
      g.startTx = tx;
      g.startTy = ty;
    }
  };

  const onTouchMove = (e: React.TouchEvent) => {
    const g = gesture.current;
    if (g.mode === "pinch" && e.touches.length === 2) {
      e.preventDefault();
      const next = Math.min(5, Math.max(1, (dist(e.touches) / g.startDist) * g.startScale));
      setScale(next);
      if (next === 1) {
        setTx(0);
        setTy(0);
      }
    } else if (g.mode === "pan" && e.touches.length === 1 && scale > 1) {
      e.preventDefault();
      setTx(g.startTx + (e.touches[0].clientX - g.startX));
      setTy(g.startTy + (e.touches[0].clientY - g.startY));
    }
  };

  const onTouchEnd = () => {
    gesture.current.mode = "none";
  };

  // Desktop: wheel zoom.
  const onWheel = (e: React.WheelEvent) => {
    const next = Math.min(5, Math.max(1, scale - e.deltaY * 0.003));
    setScale(next);
    if (next === 1) {
      setTx(0);
      setTy(0);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/90"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      {/* Top bar: close + download. Stop propagation so taps here don't close. */}
      <div
        className="absolute top-0 left-0 right-0 flex items-center justify-between px-4 py-3 z-10"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="w-9 h-9 rounded-full bg-white/15 text-white flex items-center justify-center hover:bg-white/25 transition-colors"
          aria-label="Close"
        >
          <X className="w-5 h-5" />
        </button>
        <a
          href={src}
          download={downloadName}
          className="w-9 h-9 rounded-full bg-white/15 text-white flex items-center justify-center hover:bg-white/25 transition-colors"
          aria-label="Download"
        >
          <Download className="w-5 h-5" />
        </a>
      </div>

      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt || ""}
        draggable={false}
        onClick={(e) => e.stopPropagation()}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onWheel={onWheel}
        onDoubleClick={() => (scale > 1 ? reset() : setScale(2.5))}
        className="max-w-full max-h-full object-contain select-none touch-none"
        style={{
          transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
          transition: gesture.current.mode === "none" ? "transform 0.15s ease-out" : "none",
          cursor: scale > 1 ? "grab" : "zoom-in",
        }}
      />
    </div>
  );
}
