// Runs Python entirely in the browser using Pyodide (CPython compiled to
// WebAssembly). Replaces the local FastAPI backend so the app works on a
// static host like Netlify.
import tracerSource from "../../../backend/app/tracer.py?raw";
import driverSource from "./driver.py?raw";

export const PYODIDE_VERSION = "0.27.2";
const INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

const HOME = "/home/pyodide";
const USER_FILE = `${HOME}/main.py`;
const TRACER_FILE = `${HOME}/vcs_tracer.py`;
const TRACE_JSON = `${HOME}/trace.json`;

// Minimal typing for the parts of Pyodide used here.
interface PyProxyFn {
  (...args: unknown[]): unknown;
  destroy?: () => void;
}
interface Pyodide {
  FS: {
    writeFile(path: string, data: string): void;
    readFile(path: string, opts: { encoding: "utf8" }): string;
    unlink(path: string): void;
  };
  globals: { get(name: string): PyProxyFn };
  runPython(code: string): unknown;
  loadPackagesFromImports(code: string): Promise<unknown>;
  setStdout(opts: { write: (buf: Uint8Array) => number }): void;
  setStderr(opts: { write: (buf: Uint8Array) => number }): void;
  setStdin(opts: { stdin: () => string | null }): void;
}

export type WorkerRequest = {
  id: number;
  kind: "run" | "trace";
  code: string;
  maxSteps: number;
};

export type WorkerMessage =
  | { type: "ready" }
  | { type: "load-error"; message: string }
  | { type: "started"; id: number }
  | { type: "out"; id: number; stream: "stdout" | "stderr"; text: string }
  | {
      type: "done";
      id: number;
      exitCode: number;
      durationMs: number;
      trace: unknown | null;
    }
  | { type: "failed"; id: number; message: string };

const ctx = self as unknown as {
  postMessage(m: unknown): void;
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
};
const post = (m: WorkerMessage) => ctx.postMessage(m);

let currentId = -1;
const decoders = {
  stdout: new TextDecoder(),
  stderr: new TextDecoder(),
};
const writer = (stream: "stdout" | "stderr") => (buf: Uint8Array) => {
  const text = decoders[stream].decode(buf, { stream: true });
  if (text) post({ type: "out", id: currentId, stream, text });
  return buf.length;
};

async function boot(): Promise<Pyodide> {
  const mod = (await import(
    /* @vite-ignore */ `${INDEX_URL}pyodide.mjs`
  )) as { loadPyodide: (o: { indexURL: string }) => Promise<Pyodide> };
  const py = await mod.loadPyodide({ indexURL: INDEX_URL });
  py.setStdout({ write: writer("stdout") });
  py.setStderr({ write: writer("stderr") });
  py.setStdin({ stdin: () => null }); // input() sees EOF, like stdin=DEVNULL
  py.FS.writeFile(TRACER_FILE, tracerSource);
  py.runPython(driverSource);
  return py;
}

const ready = boot().then(
  (py) => {
    post({ type: "ready" });
    return py;
  },
  (err) => {
    post({
      type: "load-error",
      message: `Could not load the Python runtime: ${String(err?.message ?? err)}`,
    });
    throw err;
  }
);

let queue: Promise<void> = Promise.resolve();

ctx.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  queue = queue.then(() => handle(req)).catch(() => {});
};

async function handle(req: WorkerRequest) {
  const py = await ready;
  currentId = req.id;
  try {
    // Auto-load packages shipped with Pyodide (numpy, etc.) if imported.
    try {
      await py.loadPackagesFromImports(req.code);
    } catch {
      /* unknown imports surface as a normal ModuleNotFoundError */
    }
    py.FS.writeFile(USER_FILE, req.code);
    try {
      py.FS.unlink(TRACE_JSON);
    } catch {
      /* not present */
    }
    post({ type: "started", id: req.id });
    const start = performance.now();
    let exitCode: number;
    let trace: unknown | null = null;
    if (req.kind === "run") {
      exitCode = Number(py.globals.get("vcs_run")(USER_FILE));
    } else {
      exitCode = Number(
        py.globals.get("vcs_trace")(TRACER_FILE, USER_FILE, TRACE_JSON, req.maxSteps)
      );
      try {
        trace = JSON.parse(py.FS.readFile(TRACE_JSON, { encoding: "utf8" }));
      } catch {
        trace = null;
      }
    }
    const durationMs = performance.now() - start;
    for (const s of ["stdout", "stderr"] as const) {
      const rest = decoders[s].decode();
      if (rest) post({ type: "out", id: req.id, stream: s, text: rest });
    }
    post({ type: "done", id: req.id, exitCode, durationMs, trace });
  } catch (err) {
    post({
      type: "failed",
      id: req.id,
      message: String((err as Error)?.message ?? err),
    });
  }
}
