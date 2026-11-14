export interface RunResult {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  duration_ms: number;
  timed_out: boolean;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
}

// Relative URLs: the Vite dev server proxies /api to the backend.
const BASE = "/api";

export async function checkHealth(): Promise<boolean> {
  try {
    const resp = await fetch(`${BASE}/health`);
    return resp.ok;
  } catch {
    return false;
  }
}

import type { LoopMeta, Step, SubEntry } from "./viz/trace";

export interface TraceResult extends RunResult {
  trace_available: boolean;
  steps_truncated: boolean;
  steps: Step[];
  loops: LoopMeta[];
  subs: Record<string, SubEntry[]>;
}

export async function traceCode(code: string): Promise<TraceResult> {
  const resp = await fetch(`${BASE}/trace`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Backend returned ${resp.status}: ${detail}`);
  }
  return resp.json();
}

export async function runCode(code: string): Promise<RunResult> {
  const resp = await fetch(`${BASE}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Backend returned ${resp.status}: ${detail}`);
  }
  return resp.json();
}
