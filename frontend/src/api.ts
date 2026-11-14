export interface RunResult {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  duration_ms: number;
  timed_out: boolean;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
}

// Python runs in the browser (Pyodide in a Web Worker) — no server needed.
import { ensureReady, execute } from "./py/runtime";

export async function checkHealth(): Promise<boolean> {
  try {
    await ensureReady();
    return true;
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
  const { trace, ...run } = await execute("trace", code);
  return {
    ...run,
    trace_available: trace !== null,
    steps_truncated: Boolean(trace?.steps_truncated),
    steps: (trace?.steps as Step[]) ?? [],
    loops: (trace?.loops as LoopMeta[]) ?? [],
    subs: (trace?.subs as Record<string, SubEntry[]>) ?? {},
  };
}

export async function runCode(code: string): Promise<RunResult> {
  const { trace: _unused, ...run } = await execute("run", code);
  void _unused;
  return run;
}
