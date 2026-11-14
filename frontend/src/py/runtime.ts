// Main-thread side of the in-browser Python runtime. Each execution runs in a
// Web Worker; a run that exceeds the timeout terminates the worker (the
// browser equivalent of killing the subprocess) and a fresh one is started.
import type { WorkerMessage, WorkerRequest } from "./worker";

export const DEFAULT_TIMEOUT_SECONDS = 10;
export const DEFAULT_MAX_STEPS = 1500;
const MAX_OUTPUT_CHARS = 100_000;

export interface RawResult {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  duration_ms: number;
  timed_out: boolean;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  trace: Record<string, unknown> | null;
}

type Pending = {
  id: number;
  stdout: string;
  stderr: string;
  resolve: (r: RawResult) => void;
  reject: (e: Error) => void;
  onStarted: () => void;
};

let worker: Worker | null = null;
let readyPromise: Promise<void> | null = null;
let pending: Pending | null = null;
let nextId = 1;

function spawn() {
  const w = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
  });
  worker = w;
  readyPromise = new Promise<void>((resolve, reject) => {
    w.onmessage = (ev: MessageEvent<WorkerMessage>) => {
      const m = ev.data;
      if (m.type === "ready") return resolve();
      if (m.type === "load-error") return reject(new Error(m.message));
      if (!pending || m.id !== pending.id) return;
      if (m.type === "started") {
        pending.onStarted();
      } else if (m.type === "out") {
        pending[m.stream] += m.text;
      } else if (m.type === "done") {
        const p = pending;
        pending = null;
        p.resolve(finish(p, m.exitCode, m.durationMs, false, m.trace));
      } else if (m.type === "failed") {
        const p = pending;
        pending = null;
        p.reject(new Error(m.message));
      }
    };
    w.onerror = (e) => reject(new Error(e.message || "Python worker failed"));
  });
  readyPromise.catch(() => {
    // Allow a later retry after a failed load (e.g. offline).
    if (worker === w) {
      w.terminate();
      worker = null;
      readyPromise = null;
    }
  });
}

function finish(
  p: Pending,
  exitCode: number | null,
  durationMs: number,
  timedOut: boolean,
  trace: unknown
): RawResult {
  const cap = (s: string) =>
    s.length > MAX_OUTPUT_CHARS ? [s.slice(0, MAX_OUTPUT_CHARS), true] as const : [s, false] as const;
  const [stdout, stdout_truncated] = cap(p.stdout);
  const [stderr, stderr_truncated] = cap(p.stderr);
  return {
    stdout,
    stderr,
    exit_code: exitCode,
    duration_ms: durationMs,
    timed_out: timedOut,
    stdout_truncated,
    stderr_truncated,
    trace: (trace as Record<string, unknown>) ?? null,
  };
}

export function ensureReady(): Promise<void> {
  if (!worker || !readyPromise) spawn();
  return readyPromise!;
}

export async function execute(
  kind: "run" | "trace",
  code: string,
  timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  maxSteps = DEFAULT_MAX_STEPS
): Promise<RawResult> {
  await ensureReady();
  if (pending) throw new Error("Another execution is already in progress.");
  const w = worker!;
  const id = nextId++;
  return new Promise<RawResult>((resolve, reject) => {
    let start = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The timeout clock starts once user code begins executing, so package
    // downloads (e.g. numpy on first use) don't count against it.
    const onStarted = () => {
      start = performance.now();
      timer = setTimeout(onTimeout, timeoutSeconds * 1000);
    };
    const onTimeout = () => {
      if (!pending || pending.id !== id) return;
      const p = pending;
      pending = null;
      w.terminate();
      if (worker === w) {
        worker = null;
        readyPromise = null;
      }
      const note =
        `Execution timed out after ${timeoutSeconds} seconds and was terminated.` +
        (kind === "trace" ? " No trace is available for timed-out runs." : "");
      p.stderr = p.stderr ? `${p.stderr}\n${note}` : note;
      resolve(finish(p, null, performance.now() - start, true, null));
      ensureReady().catch(() => {}); // warm up a replacement worker
    };
    pending = {
      id,
      stdout: "",
      stderr: "",
      resolve: (r) => {
        clearTimeout(timer);
        resolve(r);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
      onStarted,
    };
    const req: WorkerRequest = { id, kind, code, maxSteps };
    w.postMessage(req);
  });
}
