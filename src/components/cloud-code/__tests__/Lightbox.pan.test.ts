import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Behavioral tests for Lightbox pan/zoom/clamp (TEAM-3098).
 *
 * The vitest config runs in a plain `node` environment (no jsdom, no
 * testing-library — see vitest.config.ts), so instead of mounting through
 * react-dom we drive the component directly: React's hooks are replaced with
 * a tiny slot-based harness, the component function is called to produce its
 * element tree, and the handlers on the <img> element are invoked with
 * synthetic events. This exercises the real gesture/clamp/state logic —
 * everything except actual DOM painting — and asserts on the same
 * `style.transform` string the browser would receive.
 *
 * Named `.test.ts` (not `.tsx`) because the vitest `include` pattern is
 * `src/**\/*.test.ts`; the file uses no JSX anyway.
 */

// ---------------------------------------------------------------------------
// Mini hook harness (mocked into "react" below).
// ---------------------------------------------------------------------------

type Effect = { fn: () => void | (() => void); deps?: unknown[] };

class Harness {
  states: unknown[] = [];
  refs: { current: unknown }[] = [];
  effects: Effect[] = [];
  prevDeps: (unknown[] | undefined)[] = [];
  cleanups: (void | (() => void))[] = [];
  si = 0;
  ri = 0;
  ei = 0;
  dirty = false;
  tree: any = null;

  constructor(private renderFn: () => any) {}

  useState(init: unknown): [unknown, (v: unknown) => void] {
    const i = this.si++;
    if (this.states.length <= i) {
      this.states[i] = typeof init === "function" ? (init as () => unknown)() : init;
    }
    const set = (v: unknown) => {
      const next = typeof v === "function" ? (v as (p: unknown) => unknown)(this.states[i]) : v;
      if (!Object.is(next, this.states[i])) {
        this.states[i] = next;
        this.dirty = true;
      }
    };
    return [this.states[i], set];
  }

  useRef(init: unknown): { current: unknown } {
    const i = this.ri++;
    if (this.refs.length <= i) this.refs[i] = { current: init };
    return this.refs[i];
  }

  useEffect(fn: Effect["fn"], deps?: unknown[]): void {
    this.effects[this.ei++] = { fn, deps };
  }

  render(): any {
    do {
      this.dirty = false;
      this.si = this.ri = this.ei = 0;
      this.tree = this.renderFn();
    } while (this.dirty);
    this.effects.forEach((e, i) => {
      const prev = this.prevDeps[i];
      const changed = !prev || !e.deps || e.deps.some((d, j) => !Object.is(d, prev[j]));
      if (changed) {
        const cleanup = this.cleanups[i];
        if (typeof cleanup === "function") cleanup();
        this.cleanups[i] = e.fn();
        this.prevDeps[i] = e.deps;
      }
    });
    return this.tree;
  }

  unmount(): void {
    this.cleanups.forEach((c) => {
      if (typeof c === "function") c();
    });
  }
}

const harness = vi.hoisted(() => ({ current: null as any }));

vi.mock("react", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    useState: (init: unknown) => harness.current.useState(init),
    useRef: (init: unknown) => harness.current.useRef(init),
    useEffect: (fn: () => void, deps?: unknown[]) => harness.current.useEffect(fn, deps),
    useCallback: (fn: unknown) => fn,
  };
});

import * as ReactModule from "react";
import Lightbox from "../Lightbox";

// vitest's esbuild transform compiles the component's JSX to classic
// `React.createElement` calls (tsconfig jsx: "preserve"); the component has
// no default React import, so satisfy the identifier via the global.
(globalThis as any).React = ReactModule;

// ---------------------------------------------------------------------------
// window/document stubs (node env has neither).
// ---------------------------------------------------------------------------

const keydownHandlers: Array<(e: { key: string }) => void> = [];
const bodyStyle: Record<string, string> = {};
const windowHandlers: Record<string, Array<() => void>> = {};
(globalThis as any).window = {
  innerWidth: 1000,
  innerHeight: 700,
  addEventListener: (type: string, fn: () => void) => {
    (windowHandlers[type] ||= []).push(fn);
  },
  removeEventListener: (type: string, fn: () => void) => {
    const arr = windowHandlers[type] || [];
    const i = arr.indexOf(fn);
    if (i !== -1) arr.splice(i, 1);
  },
};
(globalThis as any).document = {
  addEventListener: (type: string, fn: (e: { key: string }) => void) => {
    if (type === "keydown") keydownHandlers.push(fn);
  },
  removeEventListener: (type: string, fn: (e: { key: string }) => void) => {
    const i = keydownHandlers.indexOf(fn);
    if (i !== -1) keydownHandlers.splice(i, 1);
  },
  body: { style: bodyStyle },
};

// jsdom/node has no PointerEvent capture APIs — the fake <img> stubs them,
// which also verifies the component tolerates environments without them.
const fakeImg = {
  offsetWidth: 0,
  offsetHeight: 0,
  setPointerCapture: vi.fn(),
  releasePointerCapture: vi.fn(),
};

// ---------------------------------------------------------------------------
// Element-tree helpers.
// ---------------------------------------------------------------------------

function findEl(node: any, pred: (n: any) => boolean): any {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findEl(child, pred);
      if (found) return found;
    }
    return null;
  }
  if (pred(node)) return node;
  return findEl(node.props?.children, pred);
}

let h: Harness;
let onClose: ReturnType<typeof vi.fn>;

const img = () => findEl(h.tree, (n) => n.type === "img");
const root = () => h.tree; // backdrop div

function transformState() {
  const t: string = img().props.style.transform;
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\((-?[\d.]+)\)/.exec(t);
  if (!m) throw new Error(`unparseable transform: ${t}`);
  return { tx: Number(m[1]), ty: Number(m[2]), scale: Number(m[3]) };
}

function mount(opts: { imgW: number; imgH: number; vw: number; vh: number }) {
  (globalThis as any).window.innerWidth = opts.vw;
  (globalThis as any).window.innerHeight = opts.vh;
  fakeImg.offsetWidth = opts.imgW;
  fakeImg.offsetHeight = opts.imgH;
  fakeImg.setPointerCapture.mockClear();
  fakeImg.releasePointerCapture.mockClear();
  onClose = vi.fn();
  h = new Harness(() => (Lightbox as any)({ src: "test.png", alt: "t", onClose }));
  harness.current = h;
  h.render();
  const imgEl = img();
  const ref = imgEl.ref ?? imgEl.props.ref;
  if (!ref) throw new Error("img ref not found on element");
  ref.current = fakeImg; // what a real renderer would do on mount
}

// Fire a handler on the <img> and flush the resulting state updates.
function fire(handler: string, ev: any) {
  const fn = img().props[handler];
  if (typeof fn !== "function") throw new Error(`no handler ${handler}`);
  fn(ev);
  h.render();
}

function ptr(over: Record<string, unknown> = {}) {
  return {
    pointerType: "mouse",
    button: 0,
    pointerId: 1,
    clientX: 0,
    clientY: 0,
    preventDefault: () => {},
    stopPropagation: () => {},
    ...over,
  };
}

function touchEv(points: Array<{ x: number; y: number }>) {
  return {
    touches: points.map((p) => ({ clientX: p.x, clientY: p.y })),
    preventDefault: () => {},
    stopPropagation: () => {},
  };
}

// Emulate DOM bubbling for a click that starts on the image: the img handler
// runs first; the backdrop's onClick only fires if propagation wasn't stopped.
function clickImage() {
  let stopped = false;
  fire("onClick", { stopPropagation: () => (stopped = true) });
  if (!stopped) {
    root().props.onClick({ stopPropagation: () => {} });
    h.render();
  }
}

function clickBackdrop() {
  root().props.onClick({ stopPropagation: () => {} });
  h.render();
}

// Full mouse drag as a browser would deliver it: down, moves, up, then the
// trailing click event (browsers fire click after a drag on the same target).
function mouseDrag(
  from: { x: number; y: number },
  to: { x: number; y: number },
  over: Record<string, unknown> = {},
) {
  fire("onPointerDown", ptr({ clientX: from.x, clientY: from.y, ...over }));
  fire("onPointerMove", ptr({ clientX: to.x, clientY: to.y, ...over }));
  fire("onPointerUp", ptr({ clientX: to.x, clientY: to.y, ...over }));
  clickImage();
}

const wheel = (deltaY: number) => fire("onWheel", { deltaY, preventDefault: () => {} });
const doubleClick = () => fire("onDoubleClick", {});

// Full one-finger touch pan as a browser would deliver it: start, move, end.
function touchDrag(from: { x: number; y: number }, to: { x: number; y: number }) {
  fire("onTouchStart", touchEv([{ x: from.x, y: from.y }]));
  fire("onTouchMove", touchEv([{ x: to.x, y: to.y }]));
  fire("onTouchEnd", touchEv([]));
}

// Genuine (drag-free) double-click: two clean clicks then the dblclick event.
function genuineDoubleClick() {
  clickImage();
  clickImage();
  doubleClick();
}

let now = 100_000;
beforeEach(() => {
  now = 100_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  keydownHandlers.length = 0;
  bodyStyle.overflow = "";
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Default geometry: 800×600 layout image in a 1000×700 viewport. At the
// double-click scale (2.5) the image is 2000×1500 → maxX 500, maxY 400.
const BASE = { imgW: 800, imgH: 600, vw: 1000, vh: 700 };
// Wide image: 1000×250 → at 2.5, 2500×625: maxX 750, height fits → ty pinned 0.
const WIDE = { imgW: 1000, imgH: 250, vw: 1000, vh: 700 };
// Tall image: 350×700 → at 2.5, 875×1750: width fits → tx pinned 0, maxY 525.
const TALL = { imgW: 350, imgH: 700, vw: 1000, vh: 700 };

describe("Lightbox mouse drag pan (FR-1)", () => {
  it("AC-1.1: drag at scale>1 pans 1:1 up/down/left/right/diagonal within clamp", () => {
    mount(BASE);
    genuineDoubleClick(); // → 2.5x
    expect(transformState().scale).toBe(2.5);

    mouseDrag({ x: 400, y: 300 }, { x: 460, y: 340 }); // diagonal
    expect(transformState()).toMatchObject({ tx: 60, ty: 40 });
    mouseDrag({ x: 400, y: 300 }, { x: 300, y: 300 }); // left
    expect(transformState()).toMatchObject({ tx: -40, ty: 40 });
    mouseDrag({ x: 400, y: 300 }, { x: 400, y: 200 }); // up
    expect(transformState()).toMatchObject({ tx: -40, ty: -60 });
    mouseDrag({ x: 400, y: 300 }, { x: 400, y: 400 }); // down
    expect(transformState()).toMatchObject({ tx: -40, ty: 40 });
    mouseDrag({ x: 400, y: 300 }, { x: 500, y: 300 }); // right
    expect(transformState()).toMatchObject({ tx: 60, ty: 40 });
  });

  it("AC-1.2 / AC-6.1: pointerdown+move at scale=1 does not change tx/ty", () => {
    mount(BASE);
    fire("onPointerDown", ptr({ clientX: 100, clientY: 100 }));
    fire("onPointerMove", ptr({ clientX: 300, clientY: 300 }));
    fire("onPointerUp", ptr({ clientX: 300, clientY: 300 }));
    expect(transformState()).toEqual({ tx: 0, ty: 0, scale: 1 });
  });

  it("AC-1.3: pan stops after pointerup — later moves do nothing", () => {
    mount(BASE);
    genuineDoubleClick();
    mouseDrag({ x: 400, y: 300 }, { x: 450, y: 320 });
    const after = transformState();
    fire("onPointerMove", ptr({ clientX: 900, clientY: 900 }));
    expect(transformState()).toEqual(after);
  });

  it("AC-1.4: pointer capture is requested on drag start and released on end", () => {
    mount(BASE);
    genuineDoubleClick();
    fire("onPointerDown", ptr({ clientX: 400, clientY: 300, pointerId: 7 }));
    expect(fakeImg.setPointerCapture).toHaveBeenCalledWith(7);
    fire("onPointerUp", ptr({ clientX: 400, clientY: 300, pointerId: 7 }));
    expect(fakeImg.releasePointerCapture).toHaveBeenCalledWith(7);
  });

  it("AC-1.5: non-primary button does not pan", () => {
    mount(BASE);
    genuineDoubleClick();
    fire("onPointerDown", ptr({ clientX: 400, clientY: 300, button: 2 }));
    fire("onPointerMove", ptr({ clientX: 500, clientY: 400, button: 2 }));
    fire("onPointerUp", ptr({ clientX: 500, clientY: 400, button: 2 }));
    expect(transformState()).toMatchObject({ tx: 0, ty: 0 });
  });

  it("touch-type pointer events are ignored — touch handlers own touch", () => {
    mount(BASE);
    genuineDoubleClick();
    fire("onPointerDown", ptr({ clientX: 400, clientY: 300, pointerType: "touch" }));
    fire("onPointerMove", ptr({ clientX: 500, clientY: 400, pointerType: "touch" }));
    expect(transformState()).toMatchObject({ tx: 0, ty: 0 });
    expect(fakeImg.setPointerCapture).not.toHaveBeenCalled();
  });
});

describe("Lightbox pan clamping (FR-2, two aspect ratios per AC-2.6)", () => {
  it("AC-2.2: wide image — horizontal clamps at bounds, vertical stays 0", () => {
    mount(WIDE);
    genuineDoubleClick(); // 2.5x → 2500×625
    mouseDrag({ x: 0, y: 0 }, { x: 5000, y: 5000 });
    expect(transformState()).toMatchObject({ tx: 750, ty: 0 });
    mouseDrag({ x: 5000, y: 5000 }, { x: -5000, y: -5000 });
    expect(transformState()).toMatchObject({ tx: -750, ty: 0 });
  });

  it("AC-2.3: tall image — both top and bottom edges reachable, clamps there", () => {
    mount(TALL);
    genuineDoubleClick(); // 2.5x → 875×1750
    // Drag down: top edge comes into view, clamps at +maxY.
    mouseDrag({ x: 0, y: 0 }, { x: 0, y: 9999 });
    expect(transformState()).toMatchObject({ tx: 0, ty: 525 });
    // Drag up: bottom edge comes into view, clamps at -maxY.
    mouseDrag({ x: 0, y: 9999 }, { x: 0, y: -9999 });
    expect(transformState()).toMatchObject({ tx: 0, ty: -525 });
  });

  it("AC-2.1 / AC-2.4: touch pan is clamped by the same bounds", () => {
    mount(WIDE);
    genuineDoubleClick(); // 2.5x
    fire("onTouchStart", touchEv([{ x: 100, y: 100 }]));
    fire("onTouchMove", touchEv([{ x: 9100, y: 9100 }]));
    fire("onTouchEnd", touchEv([]));
    expect(transformState()).toMatchObject({ tx: 750, ty: 0 });

    mount(TALL);
    genuineDoubleClick();
    fire("onTouchStart", touchEv([{ x: 100, y: 9999 }]));
    fire("onTouchMove", touchEv([{ x: 100, y: -9999 }]));
    fire("onTouchEnd", touchEv([]));
    expect(transformState()).toMatchObject({ tx: 0, ty: -525 });
  });

  it("AC-2.5: wheel zoom-out while panned re-clamps at the intermediate scale", () => {
    mount(WIDE);
    genuineDoubleClick(); // 2.5x
    mouseDrag({ x: 0, y: 0 }, { x: 5000, y: 0 });
    expect(transformState().tx).toBe(750);
    wheel(100); // 2.5 − 0.3 = 2.2 → maxX = (2200 − 1000)/2 = 600
    expect(transformState()).toMatchObject({ tx: 600, ty: 0, scale: 2.2 });
  });

  it("AC-2.5: pinch zoom-out while panned re-clamps at intermediate scales", () => {
    mount(WIDE);
    genuineDoubleClick(); // 2.5x
    mouseDrag({ x: 0, y: 0 }, { x: 5000, y: 0 });
    expect(transformState().tx).toBe(750);
    // Pinch from dist 100 → 80: scale 2.5 × 0.8 = 2 → maxX = 500.
    fire("onTouchStart", touchEv([{ x: 100, y: 100 }, { x: 200, y: 100 }]));
    fire("onTouchMove", touchEv([{ x: 100, y: 100 }, { x: 180, y: 100 }]));
    fire("onTouchEnd", touchEv([]));
    expect(transformState()).toMatchObject({ tx: 500, ty: 0, scale: 2 });
  });

  it("AC-7.1: wheel zoom back to 1 resets tx/ty", () => {
    mount(BASE);
    genuineDoubleClick();
    mouseDrag({ x: 400, y: 300 }, { x: 500, y: 400 });
    expect(transformState().tx).not.toBe(0);
    wheel(10_000); // → clamped to 1
    expect(transformState()).toEqual({ tx: 0, ty: 0, scale: 1 });
  });
});

describe("Lightbox one-finger touch pan (FR-3)", () => {
  it("AC-3.2: touch move at scale=1 does not move the image, and the swipe's lastTap clear stops a following quick tap from toggling zoom", () => {
    mount(BASE);
    fire("onTouchStart", touchEv([{ x: 100, y: 100 }]));
    fire("onTouchMove", touchEv([{ x: 160, y: 100 }])); // 60px, well over the 5px threshold
    expect(transformState()).toEqual({ tx: 0, ty: 0, scale: 1 });
    fire("onTouchEnd", touchEv([]));

    // A quick tap right after the swipe must not pair with the swipe's start
    // to register as the second tap of a double-tap (Lightbox.tsx ~163-167
    // clears lastTap.current on the swipe precisely to prevent this).
    now += 100;
    fire("onTouchStart", touchEv([{ x: 160, y: 100 }]));
    fire("onTouchEnd", touchEv([]));
    expect(transformState().scale).toBe(1);
  });

  it("AC-3.3: a second finger landing during an in-progress one-finger pan hands control to pinch", () => {
    mount(BASE);
    genuineDoubleClick(); // 2.5x

    // One-finger pan in progress.
    fire("onTouchStart", touchEv([{ x: 400, y: 300 }]));
    fire("onTouchMove", touchEv([{ x: 430, y: 300 }])); // dx 30, well within clamp
    expect(transformState()).toMatchObject({ tx: 30, ty: 0, scale: 2.5 });

    // Second finger lands — re-entry into onTouchStart with 2 touches (Lightbox.tsx
    // ~118-124) switches gesture mode from "pan" to "pinch".
    fire("onTouchStart", touchEv([{ x: 100, y: 100 }, { x: 200, y: 100 }])); // dist 100
    fire("onTouchMove", touchEv([{ x: 100, y: 100 }, { x: 250, y: 100 }])); // dist 150 → ×1.5
    expect(transformState()).toMatchObject({ tx: 30, ty: 0, scale: 3.75 });

    // Further two-finger movement that preserves the pinch distance (no zoom
    // change) but shifts finger 1's absolute position a long way — if 1:1
    // finger-1 pan tracking were still active this would move tx, but pan
    // mode was replaced by pinch, so tx/ty stay governed by the pinch branch.
    fire("onTouchMove", touchEv([{ x: 300, y: 100 }, { x: 450, y: 100 }])); // dist still 150
    expect(transformState()).toMatchObject({ tx: 30, ty: 0, scale: 3.75 });

    fire("onTouchEnd", touchEv([]));
  });

  it("AC-3.1: one-finger touch pan tracks the finger 1:1 while movement stays within the clamp bounds", () => {
    mount(BASE);
    genuineDoubleClick(); // 2.5x → maxX 500 / maxY 400; deltas below stay well inside
    touchDrag({ x: 400, y: 300 }, { x: 460, y: 340 }); // diagonal
    expect(transformState()).toMatchObject({ tx: 60, ty: 40 });
    touchDrag({ x: 400, y: 300 }, { x: 300, y: 300 }); // left
    expect(transformState()).toMatchObject({ tx: -40, ty: 40 });
    touchDrag({ x: 400, y: 300 }, { x: 400, y: 200 }); // up
    expect(transformState()).toMatchObject({ tx: -40, ty: -60 });
    touchDrag({ x: 400, y: 300 }, { x: 400, y: 400 }); // down
    expect(transformState()).toMatchObject({ tx: -40, ty: 40 });
    touchDrag({ x: 400, y: 300 }, { x: 500, y: 300 }); // right
    expect(transformState()).toMatchObject({ tx: 60, ty: 40 });
  });
});

describe("Lightbox cursor and transition (FR-4, FR-7)", () => {
  it("cursor: zoom-in at 1x, grab when zoomed, grabbing mid-drag", () => {
    mount(BASE);
    expect(img().props.style.cursor).toBe("zoom-in");
    genuineDoubleClick();
    expect(img().props.style.cursor).toBe("grab");
    fire("onPointerDown", ptr({ clientX: 400, clientY: 300 }));
    expect(img().props.style.cursor).toBe("grabbing");
    fire("onPointerUp", ptr({ clientX: 400, clientY: 300 }));
    expect(img().props.style.cursor).toBe("grab");
  });

  it("transition disabled during mouse drag and touch pan, restored when idle", () => {
    mount(BASE);
    expect(img().props.style.transition).toBe("transform 0.15s ease-out");
    genuineDoubleClick();
    fire("onPointerDown", ptr({ clientX: 400, clientY: 300 }));
    fire("onPointerMove", ptr({ clientX: 420, clientY: 300 }));
    expect(img().props.style.transition).toBe("none");
    fire("onPointerUp", ptr({ clientX: 420, clientY: 300 }));
    expect(img().props.style.transition).toBe("transform 0.15s ease-out");
    fire("onTouchStart", touchEv([{ x: 100, y: 100 }]));
    fire("onTouchMove", touchEv([{ x: 150, y: 100 }]));
    expect(img().props.style.transition).toBe("none");
    fire("onTouchEnd", touchEv([]));
  });
});

describe("Lightbox drag vs click threshold (FR-5)", () => {
  it("AC-5.1: a drag ≥ threshold then release does not close the lightbox", () => {
    mount(BASE);
    genuineDoubleClick();
    mouseDrag({ x: 400, y: 300 }, { x: 450, y: 300 });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("AC-5.2: sub-threshold press-release behaves as a click — image doesn't close, backdrop does", () => {
    mount(BASE);
    genuineDoubleClick();
    // Press with 2px of movement (below the 5px threshold) then release+click.
    fire("onPointerDown", ptr({ clientX: 400, clientY: 300 }));
    fire("onPointerMove", ptr({ clientX: 402, clientY: 300 }));
    fire("onPointerUp", ptr({ clientX: 402, clientY: 300 }));
    clickImage();
    expect(onClose).not.toHaveBeenCalled();
    clickBackdrop();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("AC-5.3: a double-click involving a drag does not toggle zoom; a genuine one does", () => {
    mount(BASE);
    genuineDoubleClick();
    expect(transformState().scale).toBe(2.5);
    // Drag (first press), quick clean second click, then the dblclick event.
    mouseDrag({ x: 400, y: 300 }, { x: 450, y: 300 });
    clickImage();
    doubleClick();
    expect(transformState().scale).toBe(2.5); // unchanged
    // A genuine double-click afterwards still toggles back to 1x.
    genuineDoubleClick();
    expect(transformState()).toEqual({ tx: 0, ty: 0, scale: 1 });
  });

  it("AC-5.4: a touch pan does not arm the double-tap detector", () => {
    mount(BASE);
    genuineDoubleClick(); // 2.5x
    // One-finger pan that actually moves…
    fire("onTouchStart", touchEv([{ x: 100, y: 100 }]));
    fire("onTouchMove", touchEv([{ x: 160, y: 100 }]));
    fire("onTouchEnd", touchEv([]));
    // …then a tap 100ms later must NOT count as the second tap of a double-tap.
    now += 100;
    fire("onTouchStart", touchEv([{ x: 160, y: 100 }]));
    fire("onTouchEnd", touchEv([]));
    expect(transformState().scale).toBe(2.5);
  });
});

// ---------------------------------------------------------------------------
// Browser-faithful tap simulation (TEAM-3329). Real browsers synthesize
// mouse events from taps: each un-prevented touchend yields a click, and two
// such clicks in quick succession also yield a dblclick. jsdom/this harness
// does none of that, so these helpers replay the full sequence, honoring
// defaultPrevented on touchend exactly like a browser would.
// ---------------------------------------------------------------------------

// Single tap: touchstart/touchend, then the synthesized click unless the
// touchend was default-prevented. Returns whether it was prevented.
function tap(p: { x: number; y: number }): boolean {
  fire("onTouchStart", touchEv([p]));
  let prevented = false;
  fire("onTouchEnd", {
    touches: [],
    preventDefault: () => (prevented = true),
    stopPropagation: () => {},
  });
  if (!prevented) clickImage();
  return prevented;
}

describe("Lightbox touch double-tap vs synthesized mouse events (TEAM-3329)", () => {
  it("defect 1: double-tap toggle survives the browser's synthesized click/dblclick", () => {
    mount(BASE);
    const prevented1 = tap({ x: 100, y: 100 });
    now += 100;
    const prevented2 = tap({ x: 100, y: 100 }); // second tap toggles in touchstart
    expect(transformState().scale).toBe(2.5);
    // The browser only synthesizes the trailing dblclick when both taps'
    // clicks went through; the fix must prevent the handled tap's touchend.
    expect(prevented2).toBe(true);
    if (!prevented1 && !prevented2) doubleClick();
    expect(transformState().scale).toBe(2.5); // still zoomed — no re-toggle
  });

  it("defect 1 belt-and-braces: a dblclick delivered despite preventDefault right after a double-tap is ignored, but a later mouse double-click still works", () => {
    mount(BASE);
    tap({ x: 100, y: 100 });
    now += 100;
    tap({ x: 100, y: 100 }); // → 2.5x
    expect(transformState().scale).toBe(2.5);
    doubleClick(); // hostile: browser synthesized it anyway
    expect(transformState().scale).toBe(2.5); // guard swallowed it
    now += 1000; // well past the touch-proximity window
    genuineDoubleClick();
    expect(transformState()).toEqual({ tx: 0, ty: 0, scale: 1 });
  });

  it("defect 2: pinch disarms the double-tap detector — a quick tap after a pinch does not reset zoom", () => {
    mount(BASE);
    // First finger down (arms the tap detector), second lands → pinch to 1.5x.
    fire("onTouchStart", touchEv([{ x: 100, y: 100 }]));
    fire("onTouchStart", touchEv([{ x: 100, y: 100 }, { x: 200, y: 100 }])); // dist 100
    fire("onTouchMove", touchEv([{ x: 100, y: 100 }, { x: 250, y: 100 }])); // dist 150 → ×1.5
    fire("onTouchEnd", touchEv([]));
    expect(transformState().scale).toBe(1.5);
    // Tap within 300ms of the pinch's first finger-down: must NOT pair with
    // it as a double-tap (which would reset the zoom to 1).
    now += 150;
    tap({ x: 150, y: 100 });
    expect(transformState().scale).toBe(1.5);
  });
});

describe("Lightbox zoom behaviors preserved (FR-6/8)", () => {
  it("AC-8.2: wheel sensitivity is deltaY×0.003, clamped 1–5", () => {
    mount(BASE);
    wheel(-500); // 1 + 1.5
    expect(transformState().scale).toBe(2.5);
    wheel(-10_000);
    expect(transformState().scale).toBe(5);
    wheel(10_000);
    expect(transformState().scale).toBe(1);
  });

  it("AC-8.1: pinch zoom clamps to 1–5", () => {
    mount(BASE);
    fire("onTouchStart", touchEv([{ x: 100, y: 100 }, { x: 200, y: 100 }])); // dist 100
    fire("onTouchMove", touchEv([{ x: 100, y: 100 }, { x: 1100, y: 100 }])); // ×10
    expect(transformState().scale).toBe(5);
    fire("onTouchMove", touchEv([{ x: 100, y: 100 }, { x: 101, y: 100 }])); // ×0.01
    expect(transformState().scale).toBe(1);
    fire("onTouchEnd", touchEv([]));
  });

  it("AC-8.3 / AC-6.3: double-click from 1x zooms to 2.5x; double-tap toggles too", () => {
    mount(BASE);
    genuineDoubleClick();
    expect(transformState().scale).toBe(2.5);
    genuineDoubleClick();
    expect(transformState().scale).toBe(1);
    // Touch double-tap: two touchstarts within 300ms.
    fire("onTouchStart", touchEv([{ x: 100, y: 100 }]));
    fire("onTouchEnd", touchEv([]));
    now += 150;
    fire("onTouchStart", touchEv([{ x: 100, y: 100 }]));
    fire("onTouchEnd", touchEv([]));
    expect(transformState().scale).toBe(2.5);
  });

  it("AC-7.2: double-click while zoomed+panned resets scale to 1 and tx/ty to 0", () => {
    mount(BASE);
    genuineDoubleClick(); // 2.5x
    mouseDrag({ x: 400, y: 300 }, { x: 500, y: 400 });
    expect(transformState().tx).not.toBe(0);
    genuineDoubleClick();
    expect(transformState()).toEqual({ tx: 0, ty: 0, scale: 1 });
  });
});

describe("Lightbox shell behavior preserved (AC-6.2)", () => {
  it("backdrop click closes, image click doesn't, Escape closes", () => {
    mount(BASE);
    clickImage();
    expect(onClose).not.toHaveBeenCalled();
    clickBackdrop();
    expect(onClose).toHaveBeenCalledTimes(1);
    keydownHandlers.forEach((fn) => fn({ key: "Escape" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    keydownHandlers.forEach((fn) => fn({ key: "a" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("locks body scroll while mounted and restores it on unmount", () => {
    bodyStyle.overflow = "auto";
    mount(BASE);
    expect(bodyStyle.overflow).toBe("hidden");
    h.unmount();
    expect(bodyStyle.overflow).toBe("auto");
  });
});
