// A tiny critically damped spring. Everything the visitor can touch animates through it,
// so every motion starts from the live on-screen value and velocity and can be interrupted.
// Defaults follow Apple's guidance: damping 1.0, response 0.35 s. Bounce only where momentum exists.
type Track = { raf: number; x: number; v: number };
const tracks = new WeakMap<object, Record<string, Track>>();

export const reduced = () =>
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

export type SpringOpts = {
  response?: number;
  damping?: number;
  velocity?: number;
};

/** Animate a number toward `to`, calling `apply` each frame. Re-targeting keeps position and velocity. */
export function spring(
  owner: object,
  key: string,
  from: number,
  to: number,
  apply: (x: number) => void,
  o: SpringOpts = {},
): Promise<void> {
  const map = tracks.get(owner) ?? {};
  tracks.set(owner, map);
  const live = map[key];
  if (live) cancelAnimationFrame(live.raf);
  if (reduced()) {
    apply(to);
    delete map[key];
    return Promise.resolve();
  }
  const t: Track = {
    raf: 0,
    x: live ? live.x : from,
    v: live ? live.v : (o.velocity ?? 0),
  };
  map[key] = t;
  const response = o.response ?? 0.35;
  const damping = o.damping ?? 1;
  const k = ((2 * Math.PI) / response) ** 2;
  const c = 2 * damping * Math.sqrt(k);
  return new Promise((resolve) => {
    let last = performance.now();
    const step = (now: number) => {
      let dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      while (dt > 0) {
        const h = Math.min(dt, 1 / 240);
        const a = -k * (t.x - to) - c * t.v;
        t.v += a * h;
        t.x += t.v * h;
        dt -= h;
      }
      apply(t.x);
      if (Math.abs(t.x - to) < 0.003 && Math.abs(t.v) < 0.003) {
        apply(to);
        delete map[key];
        resolve();
        return;
      }
      t.raf = requestAnimationFrame(step);
    };
    t.raf = requestAnimationFrame(step);
  });
}

/** Rise and fade in. Under reduced motion this is a short cross-fade. */
export function enter(
  el: HTMLElement,
  o: { y?: number; delay?: number; scale?: number } = {},
) {
  if (reduced()) {
    el.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 140,
      easing: "linear",
    });
    return;
  }
  const y = o.y ?? 8;
  const s0 = o.scale ?? 1;
  const go = () =>
    spring(el, "enter", 0, 1, (p) => {
      el.style.opacity = String(Math.min(1, Math.max(0, p)));
      el.style.transform = `translateY(${(1 - p) * y}px) scale(${s0 + (1 - s0) * p})`;
      if (p === 1) {
        el.style.opacity = "";
        el.style.transform = "";
      }
    });
  el.style.opacity = "0";
  if (o.delay) setTimeout(go, o.delay);
  else go();
}

/** Spring an element's height open or closed from wherever it is now. */
export function setOpen(el: HTMLElement, open: boolean) {
  el.style.overflow = "hidden";
  const from = el.getBoundingClientRect().height;
  if (open) el.hidden = false;
  const to = open ? el.scrollHeight : 0;
  void spring(
    el,
    "h",
    from,
    to,
    (h) => {
      el.style.height = `${Math.max(0, h)}px`;
    },
    { response: 0.4 },
  ).then(() => {
    if (open) {
      el.style.height = "";
      el.style.overflow = "";
    } else el.hidden = true;
  });
}

/** Slide an indicator to a target box. */
export function slideTo(ind: HTMLElement, left: number, width: number) {
  const curL = ind.offsetLeft;
  const curW = ind.offsetWidth;
  if (!curW) {
    ind.style.transform = `translateX(${left}px)`;
    ind.style.width = `${width}px`;
    return;
  }
  void spring(ind, "x", curL, left, (x) => {
    ind.style.transform = `translateX(${x}px)`;
  });
  void spring(ind, "w", curW, width, (w) => {
    ind.style.width = `${w}px`;
  });
}
