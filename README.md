# VisualCode Studio — Stages 1 + 2 + 3

A locally hosted Python code editor with real subprocess-based execution
(Stage 1) and step-by-step execution visualization (Stage 2).

- **Frontend:** React + Vite + TypeScript, CodeMirror 6 (Python highlighting)
- **Backend:** Python + FastAPI; code runs in a separate Python subprocess
- **Stage 1:** editor, Run button, stdout/stderr panels, status and duration.
- **Stage 2:** **Visualize** button — traces real execution and lets you play
  it back: current-line highlighting, variable/data-structure inspector
  (lists, tuples, dicts, sets, nesting, optional graph view for adjacency
  dicts), loop navigator (for/while, nesting, per-iteration jumps), function
  call stack and call hierarchy with arguments, return values and recursion
  depth. Playback supports play/pause, step forward/backward, reset, speed,
  and a timeline slider; stepping backward restores exact recorded snapshots.
- **Stage 3:** animated **graph algorithm workspace** — an SVG canvas (stable
  circular layout, directed/undirected/auto, edge weights) that animates real
  traversals: current node, discovered neighbor, traversed edge, visited
  nodes, queue/stack membership, distances, predecessor tree and final path.
  A variable is registered as the graph via a dropdown (adjacency dict,
  dict-of-dicts, or edge list); visited/queue/stack/dist/prev/path variables
  are auto-bound by name and type, overridable in the bindings panel. A
  terminal-style execution log beneath the canvas lists every recorded event
  (calls, returns, loops, iterations, node visits, edge examinations,
  queue/stack push–pop, distance and predecessor updates, output,
  exceptions); clicking a log line jumps the shared timeline to that step.
  The toolbar's Examples menu loads BFS, DFS, Dijkstra, A*, cycle detection
  and topological sort programs. All states are read from recorded runtime
  snapshots — nothing is simulated, and backward playback is exact.

> **Security note:** the runner executes code with the same privileges as the
> backend process. It is bound to localhost and intended for your own code on
> your own machine. It is **not** a sandbox for untrusted public code.

## Running on Netlify (in-browser Python)

The deployed frontend does not need the FastAPI backend. Python runs directly
in the browser with [Pyodide](https://pyodide.org) (CPython compiled to
WebAssembly) inside a Web Worker, using the same `backend/app/tracer.py` for
Visualize. `netlify.toml` builds the `frontend/` folder. Packages bundled
with Pyodide (e.g. `numpy`) load automatically when imported; network
libraries such as `requests` don't work in the browser. A run that goes past
10 seconds is stopped by terminating the worker.

## Prerequisites

- Python 3.11+ (developed on 3.14)
- Node.js 18+ and npm

## Setup

### 1. Backend

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

(macOS/Linux: `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`)

### 2. Frontend

```powershell
cd frontend
npm install
```

## Running

Start the backend (from `backend/`):

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Start the frontend (from `frontend/`, in a second terminal):

```powershell
npm run dev
```

Open **http://127.0.0.1:5173** in your browser. The green dot in the toolbar
confirms the backend is reachable. The Vite dev server proxies `/api/*` to the
backend on port 8000, so no CORS configuration is needed in the browser.

## Using third-party libraries in your code

User code runs with the **backend's virtual environment** (the runner invokes
`sys.executable`). To make a library importable from the editor, install it
into that venv:

```powershell
cd backend
.\.venv\Scripts\python.exe -m pip install <package>
```

Example: `requests` is already listed in `requirements.txt`, so
`import requests` works out of the box. Importing a package that is not
installed produces a normal `ModuleNotFoundError` traceback in the Errors
panel — packages are never auto-installed.

## API

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/health` | GET | Backend availability check |
| `/api/run` | POST | Execute Python code |
| `/api/trace` | POST | Execute Python code and record execution events |

`POST /api/run` body: `{"code": "<python source>", "timeout_seconds": 10}`
(`timeout_seconds` optional; default 10, max 60).

Response: `stdout`, `stderr`, `exit_code`, `duration_ms`, `timed_out`,
`stdout_truncated`, `stderr_truncated`. Captured output is capped at 100 KB
per stream. Each run writes the code to a temporary `.py` file in a fresh
temporary directory, which is removed after execution.

`POST /api/trace` adds `max_steps` (default 1500, max 5000) and returns the
run fields plus `trace_available`, `steps_truncated`, `loops` (static AST
table of every for/while loop) and `steps`. Each step is a real recorded
event (`call`/`line`/`return`/`exception`) with the source line, a full
serialized snapshot of all user stack frames, the stdout offset at that
moment, loop enter/iteration/exit events, return values and exception info.
Only user code is traced — imported libraries never appear in the trace.
Values are serialized with caps (depth 4, 60 items per container, 200 chars
per string). Timed-out runs produce no trace. A run that exceeds `max_steps`
stops recording but finishes executing normally.

## Tests

Backend tests (37 tests: Stage 1 — output capture, stdlib + third-party
imports, missing modules, syntax errors, tracebacks, timeouts, output
capping, repeated runs, API validation; Stage 2 — data-structure snapshots,
nested-loop events and counts, while/continue/break semantics, function
calls/returns/recursion, per-step playback snapshots, trace API):

```powershell
cd backend
.\.venv\Scripts\python.exe -m pytest
```

Frontend type-check and production build:

```powershell
cd frontend
npm run build
```

## Project layout

```
backend/
  app/main.py        FastAPI app (health, run, trace endpoints, CORS)
  app/runner.py      Subprocess execution: temp file, timeout, output caps
  app/tracer.py      Standalone tracing script run inside the subprocess
                     (sys.settrace + AST loop table; user frames only)
  app/tracing.py     Subprocess wrapper for traced runs
  tests/             pytest suite (runner, tracer, API)
  requirements.txt
frontend/
  src/App.tsx            Editor, Run/Visualize/Clear, playback state, panels
  src/api.ts             Backend API client (run + trace)
  src/viz/trace.ts       Trace types; loop-run and call-tree builders
  src/viz/editorLine.ts  CodeMirror current-line highlight extension
  src/viz/ValueView.tsx  Data-structure renderers + SVG graph view
  src/viz/Panels.tsx     Playback bar, Data/Loops/Functions panels
  vite.config.ts         Dev server + /api proxy to port 8000
```
