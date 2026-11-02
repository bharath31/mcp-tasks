// Every request the console makes, newest first, with the Worker's Server-Timing breakdown.
// The activity panel reads it so a visitor can see what each click actually did.
import type { Activity } from "./types";

const MAX = 40;
const items: Activity[] = [];
const listeners = new Set<(items: readonly Activity[]) => void>();
let seq = 0;

function notify() {
  for (const l of listeners) l(items);
}

export function subscribe(fn: (items: readonly Activity[]) => void) {
  listeners.add(fn);
  fn(items);
  return () => listeners.delete(fn);
}

/** `total;dur=12, db;desc="9 Postgres round trips";dur=8` → { total: {ms: 12}, db: {...} }. */
export function parseServerTiming(h: string | null): Activity["server"] {
  if (!h) return undefined;
  const out: NonNullable<Activity["server"]> = {};
  for (const part of h.split(",")) {
    const [name, ...params] = part.trim().split(";");
    if (!name) continue;
    const e: { ms: number; desc?: string } = { ms: 0 };
    for (const p of params) {
      const [k, v = ""] = p.trim().split("=");
      if (k === "dur") e.ms = Number(v) || 0;
      if (k === "desc") e.desc = v.replace(/^"|"$/g, "");
    }
    out[name] = e;
  }
  return out;
}

export function begin(method: string, path: string): Activity {
  const a: Activity = {
    id: ++seq,
    method,
    path: path.split("?")[0]!,
    startedAt: performance.now(),
  };
  items.unshift(a);
  if (items.length > MAX) items.length = MAX;
  notify();
  return a;
}

export function end(
  a: Activity,
  r: { status?: number; headers?: Headers; failed?: boolean },
) {
  a.ms = Math.round(performance.now() - a.startedAt);
  a.status = r.status;
  a.failed = r.failed || (r.status ?? 0) >= 400;
  a.server = parseServerTiming(r.headers?.get("server-timing") ?? null);
  notify();
}

/** Server time of a streamed response, which reports it in its last event instead of a header. */
export function endStream(
  a: Activity,
  status: number,
  t?: {
    totalMs?: number;
    connectMs?: number;
    queries?: number;
    queryMs?: number;
    fgaCalls?: number;
    fgaMs?: number;
    modelCalls?: number;
    modelMs?: number;
  },
) {
  end(a, { status });
  if (!t) return;
  a.server = {
    total: { ms: t.totalMs ?? 0 },
    connect: { ms: t.connectMs ?? 0, desc: "Postgres connect" },
    db: { ms: t.queryMs ?? 0, desc: `${t.queries ?? 0} Postgres round trips` },
    ...(t.fgaCalls
      ? { fga: { ms: t.fgaMs ?? 0, desc: `${t.fgaCalls} FGA calls` } }
      : {}),
    ...(t.modelCalls
      ? { model: { ms: t.modelMs ?? 0, desc: `${t.modelCalls} model calls` } }
      : {}),
  };
  notify();
}
