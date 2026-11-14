import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import type { EditorView } from "@codemirror/view";
import { python } from "@codemirror/lang-python";
import {
  checkHealth,
  runCode,
  traceCode,
  type RunResult,
  type TraceResult,
} from "./api";
import { buildCallTree, buildLoopRuns, computeHighlights } from "./viz/trace";
import { execLineExtension, highlightLine } from "./viz/editorLine";
import {
  DataPanel,
  FunctionsPanel,
  LoopsPanel,
  PlaybackBar,
} from "./viz/Panels";
import { GraphCanvas, type GraphBindings } from "./viz/GraphCanvas";
import { LogsPanel } from "./viz/LogsPanel";
import {
  allVarTypes,
  autoRoles,
  buildLogs,
  deriveGraph,
  graphCandidates,
} from "./viz/graph";
import { lookupVar } from "./viz/trace";
import { EXAMPLES } from "./viz/examples";

const DEFAULT_CODE = `# Welcome to VisualCode Studio — click Visualize, then press Play.
# Tip: switch the 'graph' variable to graph view to watch the traversal
# follow the edges as visit() recurses.
graph = {"a": ["b", "c"], "b": ["d"], "c": ["d"], "d": []}
visited = []

def visit(node):
    if node in visited:
        return
    visited.append(node)
    for neighbor in graph[node]:
        visit(neighbor)

visit("a")
print("order:", visited)
`;

type Status = "idle" | "running" | "done" | "failed";

export default function App() {
  const [code, setCode] = useState(DEFAULT_CODE);
  const [result, setResult] = useState<RunResult | null>(null);
  const [trace, setTrace] = useState<TraceResult | null>(null);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(5);
  const [status, setStatus] = useState<Status>("idle");
  const [busy, setBusy] = useState<"run" | "trace" | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [backendUp, setBackendUp] = useState<boolean | null>(null);
  const [bindings, setBindings] = useState<GraphBindings>({
    direction: "auto",
    roles: { frontierKind: "queue" },
  });
  const viewRef = useRef<EditorView | null>(null);

  // Load the in-browser Python runtime; retry every 10s if it failed.
  useEffect(() => {
    let cancelled = false;
    let ok = false;
    const check = async () => {
      if (ok) return;
      ok = await checkHealth();
      if (!cancelled) setBackendUp(ok);
    };
    check();
    const id = setInterval(check, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Playback timer.
  useEffect(() => {
    if (!playing || !trace) return;
    const last = trace.steps.length - 1;
    const id = setInterval(() => {
      setIdx((i) => {
        if (i >= last) {
          setPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, 1000 / speed);
    return () => clearInterval(id);
  }, [playing, speed, trace]);

  // Source line highlight follows the timeline.
  const step = trace?.steps[idx];
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    highlightLine(view, step ? step.line : null);
  }, [step]);

  const runs = useMemo(
    () => (trace ? buildLoopRuns(trace.steps) : []),
    [trace]
  );
  const calls = useMemo(
    () => (trace ? buildCallTree(trace.steps) : []),
    [trace]
  );
  const highlights = useMemo(
    () =>
      trace
        ? computeHighlights(trace.steps, trace.loops, trace.subs ?? {}, runs, idx)
        : undefined,
    [trace, runs, idx]
  );

  // Graph workspace: candidates and automatic role bindings per trace.
  const candidates = useMemo(
    () => (trace ? graphCandidates(trace.steps[trace.steps.length - 1]) : []),
    [trace]
  );
  const varNames = useMemo(
    () => (trace ? [...allVarTypes(trace.steps).keys()] : []),
    [trace]
  );
  useEffect(() => {
    if (!trace) return;
    setBindings({
      graphVar: candidates[0],
      direction: "auto",
      roles: autoRoles(trace.steps, candidates[0]),
    });
  }, [trace, candidates]);

  const logs = useMemo(() => {
    if (!trace) return [];
    const last = trace.steps[trace.steps.length - 1];
    const graph = bindings.graphVar
      ? deriveGraph(last ? lookupVar(last, bindings.graphVar) : undefined)
      : null;
    return buildLogs(
      trace.steps,
      trace.loops,
      bindings.roles,
      trace.stdout,
      code,
      graph
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trace, bindings]);

  const clearTrace = useCallback(() => {
    setTrace(null);
    setPlaying(false);
    setIdx(0);
    const view = viewRef.current;
    if (view) highlightLine(view, null);
  }, []);

  const handleCodeChange = useCallback(
    (value: string) => {
      setCode(value);
      if (trace) clearTrace(); // trace no longer matches the edited source
    },
    [trace, clearTrace]
  );

  const execute = useCallback(
    async (mode: "run" | "trace") => {
      setBusy(mode);
      setStatus("running");
      setRequestError(null);
      setPlaying(false);
      try {
        if (mode === "run") {
          clearTrace();
          const res = await runCode(code);
          setResult(res);
        } else {
          const res = await traceCode(code);
          setResult(res);
          setTrace(res.trace_available ? res : null);
          setIdx(0);
        }
        setStatus("done");
        setBackendUp(true);
      } catch (err) {
        setStatus("failed");
        setResult(null);
        clearTrace();
        setBackendUp(await checkHealth());
        setRequestError(
          err instanceof Error
            ? err.message
            : "Could not run the code in the Python runtime."
        );
      } finally {
        setBusy(null);
      }
    },
    [code, clearTrace]
  );

  const handleClear = useCallback(() => {
    setResult(null);
    setRequestError(null);
    setStatus("idle");
    clearTrace();
  }, [clearTrace]);

  const running = busy !== null;
  const shownStdout =
    trace && step ? trace.stdout.slice(0, step.out) : result?.stdout ?? "";

  return (
    <div className="app">
      <header className="toolbar">
        <h1>VisualCode Studio</h1>
        <div className="toolbar-actions">
          <select
            className="examples-select"
            value=""
            disabled={running}
            onChange={(e) => {
              const ex = EXAMPLES[e.target.value];
              if (ex) handleCodeChange(ex.code);
            }}
            title="Load an example algorithm"
          >
            <option value="">Examples…</option>
            {Object.entries(EXAMPLES).map(([key, ex]) => (
              <option key={key} value={key}>
                {ex.label}
              </option>
            ))}
          </select>
          <span
            className={`backend-dot ${
              backendUp === null ? "unknown" : backendUp ? "up" : "down"
            }`}
            title={
              backendUp === null
                ? "Loading Python runtime…"
                : backendUp
                  ? "Python runtime ready"
                  : "Python runtime failed to load"
            }
          />
          <button
            onClick={() => execute("run")}
            disabled={running}
            className="run-btn"
          >
            {busy === "run" ? "Running…" : "Run"}
          </button>
          <button
            onClick={() => execute("trace")}
            disabled={running}
            className="viz-btn"
          >
            {busy === "trace" ? "Tracing…" : "Visualize"}
          </button>
          <button onClick={handleClear} disabled={running}>
            Clear output
          </button>
        </div>
      </header>

      {backendUp === false && (
        <div className="banner error-banner">
          The Python runtime (Pyodide) could not be loaded. Check your
          internet connection — it is downloaded from a CDN on first use.
        </div>
      )}

      <main className="panes">
        <section className="editor-pane">
          <CodeMirror
            value={code}
            onChange={handleCodeChange}
            extensions={[python(), execLineExtension]}
            height="100%"
            basicSetup={{ lineNumbers: true }}
            onCreateEditor={(view) => {
              viewRef.current = view;
            }}
          />
        </section>

        <section className="output-pane">
          <div className="status-line">
            {status === "idle" && <span>Ready.</span>}
            {status === "running" && (
              <span>{busy === "trace" ? "Tracing…" : "Running…"}</span>
            )}
            {status === "failed" && (
              <span className="status-error">Request failed</span>
            )}
            {status === "done" && result && (
              <>
                <span
                  className={
                    result.timed_out || (result.exit_code ?? 1) !== 0
                      ? "status-error"
                      : "status-ok"
                  }
                >
                  {result.timed_out
                    ? "Timed out"
                    : result.exit_code === 0
                      ? "Finished"
                      : `Exited with code ${result.exit_code}`}
                </span>
                <span className="duration">
                  {result.duration_ms.toFixed(0)} ms
                </span>
                {trace && (
                  <span className="duration">
                    {trace.steps.length} steps
                    {trace.steps_truncated ? " (truncated)" : ""}
                  </span>
                )}
              </>
            )}
          </div>

          {requestError && (
            <div className="panel error-panel">
              <h2>Request error</h2>
              <pre>{requestError}</pre>
            </div>
          )}

          {result && "trace_available" in result &&
            !(result as TraceResult).trace_available &&
            !result.timed_out && (
              <div className="panel error-panel">
                <h2>Trace unavailable</h2>
                <pre>No execution trace could be produced for this run.</pre>
              </div>
            )}

          {trace && trace.steps.length > 0 && (
            <>
              <details open className="viz-section">
                <summary>Graph</summary>
                <GraphCanvas
                  steps={trace.steps}
                  step={step}
                  hl={highlights}
                  bindings={bindings}
                  setBindings={setBindings}
                  candidates={candidates}
                  varNames={varNames}
                />
              </details>
              <details open className="viz-section">
                <summary>Execution Log</summary>
                <LogsPanel logs={logs} idx={idx} setIdx={setIdx} />
              </details>
              <PlaybackBar
                idx={idx}
                setIdx={setIdx}
                total={trace.steps.length}
                playing={playing}
                setPlaying={setPlaying}
                speed={speed}
                setSpeed={setSpeed}
                step={step}
              />
              <details open className="viz-section">
                <summary>Data Structures</summary>
                <DataPanel step={step} hl={highlights} />
              </details>
              <details open className="viz-section">
                <summary>Loops</summary>
                <LoopsPanel
                  runs={runs}
                  loops={trace.loops}
                  idx={idx}
                  setIdx={setIdx}
                  steps={trace.steps}
                  graphVar={bindings.graphVar}
                />
              </details>
              <details open className="viz-section">
                <summary>Functions</summary>
                <FunctionsPanel
                  calls={calls}
                  step={step}
                  idx={idx}
                  setIdx={setIdx}
                />
              </details>
            </>
          )}

          <div className="panel">
            <h2>
              Output{result?.stdout_truncated ? " (truncated)" : ""}
              {trace && step && step.out < trace.stdout.length
                ? " — up to current step"
                : ""}
            </h2>
            <pre>{shownStdout || (status === "done" ? "(no output)" : "")}</pre>
          </div>

          <div className="panel error-panel">
            <h2>Errors{result?.stderr_truncated ? " (truncated)" : ""}</h2>
            <pre>{result?.stderr || ""}</pre>
          </div>
        </section>
      </main>
    </div>
  );
}
