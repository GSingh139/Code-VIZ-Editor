// Visualization panels: playback controls, data structures, loops, functions.
// All panels read from the SAME step index, so they stay synchronized.

import { useState } from "react";
import type {
  CallNode,
  Highlights,
  LoopMeta,
  LoopRun,
  Step,
  Value,
} from "./trace";
import { spanState, valueSummary } from "./trace";
import { GraphView, isGraphEligible, ValueView } from "./ValueView";

const EMPTY_HL: Highlights = {
  seq: new Map(),
  dictKey: new Map(),
  graph: new Map(),
  changed: new Set(),
};

// ------------------------------------------------------------ playback bar --

const SPEEDS = [1, 2, 5, 10, 20];

export function PlaybackBar(props: {
  idx: number;
  setIdx: (i: number) => void;
  total: number;
  playing: boolean;
  setPlaying: (p: boolean) => void;
  speed: number;
  setSpeed: (s: number) => void;
  step: Step | undefined;
}) {
  const { idx, setIdx, total, playing, setPlaying, speed, setSpeed, step } =
    props;
  const last = total - 1;
  return (
    <div className="playback">
      <div className="playback-buttons">
        <button onClick={() => { setPlaying(false); setIdx(0); }} title="Reset">
          ⏮ Reset
        </button>
        <button
          onClick={() => { setPlaying(false); setIdx(Math.max(0, idx - 1)); }}
          disabled={idx <= 0}
          title="Step backward"
        >
          ◀ Step
        </button>
        <button
          className="play-btn"
          onClick={() => setPlaying(!playing)}
          disabled={idx >= last && !playing}
        >
          {playing ? "⏸ Pause" : "▶ Play"}
        </button>
        <button
          onClick={() => { setPlaying(false); setIdx(Math.min(last, idx + 1)); }}
          disabled={idx >= last}
          title="Step forward"
        >
          Step ▶
        </button>
        <select
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
          title="Playback speed (steps per second)"
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
      </div>
      <input
        type="range"
        min={0}
        max={last}
        value={idx}
        onChange={(e) => { setPlaying(false); setIdx(Number(e.target.value)); }}
        className="timeline"
      />
      <div className="playback-info">
        step {idx + 1} / {total}
        {step && (
          <>
            {" · "}line {step.line} · {step.f === "<module>" ? "module" : `${step.f}()`}
            {" · "}{step.ev}
            {step.exc && (
              <span className="status-error">
                {" "}· {step.exc.type}: {step.exc.msg}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------- data panel --

const DEF_TYPES = new Set(["func", "class", "module"]);

function VariableRow({
  name,
  v,
  hl,
}: {
  name: string;
  v: Value;
  hl: Highlights;
}) {
  const [asGraph, setAsGraph] = useState(false);
  const eligible = isGraphEligible(v);
  const changed = hl.changed.has(name);
  const focus = hl.graph.get(name);
  return (
    <div className={`var-row${changed ? " changed" : ""}`}>
      <div className="var-head">
        <span className="var-name">{name}</span>
        <span className="var-type">{v.t === "obj" ? v.cls : v.t}</span>
        {changed && <span className="upd-tag">updated</span>}
        {eligible && (
          <button
            className={`mini-btn ${asGraph ? "on" : ""}`}
            onClick={() => setAsGraph(!asGraph)}
            title="Interpret this dictionary as an adjacency list"
          >
            {asGraph ? "table view" : "graph view"}
          </button>
        )}
      </div>
      <div className="var-value">
        {asGraph && eligible ? (
          <GraphView v={v} focus={focus} />
        ) : (
          <ValueView
            v={v}
            hiIndex={hl.seq.get(name)}
            hiKey={hl.dictKey.get(name)}
          />
        )}
      </div>
    </div>
  );
}

export function DataPanel({
  step,
  hl = EMPTY_HL,
}: {
  step: Step | undefined;
  hl?: Highlights;
}) {
  if (!step || step.stack.length === 0) {
    return <p className="hint">No state at this step.</p>;
  }
  const frames = [];
  const top = step.stack[step.stack.length - 1];
  if (step.stack.length > 1) {
    frames.push({ title: `Locals — ${top.f}()`, frame: top });
  }
  frames.push({ title: "Globals (module)", frame: step.stack[0] });

  return (
    <div>
      {frames.map(({ title, frame }) => {
        const entries = Object.entries(frame.loc);
        const vars = entries.filter(([, v]) => !DEF_TYPES.has(v.t));
        const defs = entries.length - vars.length;
        return (
          <div key={title} className="frame-vars">
            <h3>{title}</h3>
            {vars.length === 0 && <p className="hint">No variables yet.</p>}
            {vars.map(([name, v]) => (
              <VariableRow key={name} name={name} v={v} hl={hl} />
            ))}
            {defs > 0 && (
              <p className="hint">
                {defs} definition{defs > 1 ? "s" : ""} (functions/classes/modules) hidden.
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------- loops panel --

function LoopRunView(props: {
  run: LoopRun;
  loops: LoopMeta[];
  idx: number;
  setIdx: (i: number) => void;
  steps: Step[];
  graphVar?: string;
}) {
  const { run, loops, idx, setIdx, steps, graphVar } = props;
  const meta = loops[run.loopId];
  const state = spanState(idx, run.enter, run.exit);
  const current =
    state === "active"
      ? [...run.iterations].reverse().find((it) => it.step <= idx)
      : undefined;

  const header =
    meta.type === "for"
      ? `for ${meta.target ?? "…"} in ${meta.iter ?? "…"}`
      : `while ${meta.cond ?? "…"}`;

  return (
    <div className={`loop-run ${state}`}>
      <div className="loop-head">
        <button className="link-btn" onClick={() => setIdx(run.enter)}>
          {header}
        </button>
        <span className="loop-line">line {meta.line}</span>
        <span className={`badge ${state}`}>{state}</span>
      </div>
      <div className="loop-detail">
        {state === "active" && current && (
          <span>
            iteration <strong>{current.n}</strong>
            {meta.type === "while" && " · condition was true"}
            {meta.type === "for" && meta.target && (
              <CurrentTarget steps={steps} idx={idx} name={meta.target} />
            )}
          </span>
        )}
        {state === "active" && !current && <span>checking condition…</span>}
        {state === "completed" && (
          <span>
            {run.completed ?? run.iterations.length} iteration
            {(run.completed ?? 0) === 1 ? "" : "s"} completed
            {meta.type === "while" && " · exited (condition false or break)"}
          </span>
        )}
      </div>
      {run.iterations.length > 0 &&
        (graphVar !== undefined &&
        (meta.iobj === graphVar || meta.iname === graphVar) ? (
          <p className="hint gc-note">
            ⤴ animated on the graph canvas · iterations in the execution log
          </p>
        ) : (
          <div className="iter-chips">
            {run.iterations.map((it) => (
              <button
                key={it.n}
                className={`iter-chip ${current?.n === it.n ? "current" : ""} ${
                  it.step <= idx ? "past" : ""
                }`}
                onClick={() => setIdx(it.step)}
                title={`Jump to iteration ${it.n} (step ${it.step + 1})`}
              >
                {it.n}
              </button>
            ))}
          </div>
        ))}
      {run.children.length > 0 && (
        <div className="loop-children">
          {run.children.map((child) => (
            <LoopRunView
              key={child.id}
              run={child}
              loops={loops}
              idx={idx}
              setIdx={setIdx}
              steps={steps}
              graphVar={graphVar}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CurrentTarget(props: { steps: Step[]; idx: number; name: string }) {
  const { steps, idx, name } = props;
  const step = steps[idx];
  const top = step?.stack[step.stack.length - 1];
  const v = top?.loc[name];
  if (!v) return null;
  return (
    <span>
      {" · "}
      <code>{name}</code> = {valueSummary(v)}
    </span>
  );
}

export function LoopsPanel(props: {
  runs: LoopRun[];
  loops: LoopMeta[];
  idx: number;
  setIdx: (i: number) => void;
  steps: Step[];
  graphVar?: string;
}) {
  if (props.runs.length === 0) {
    return <p className="hint">This program has no loops.</p>;
  }
  return (
    <div>
      {props.runs.map((run) => (
        <LoopRunView key={run.id} {...props} run={run} />
      ))}
    </div>
  );
}

// --------------------------------------------------------- functions panel --

function CallNodeView(props: {
  node: CallNode;
  idx: number;
  setIdx: (i: number) => void;
}) {
  const { node, idx, setIdx } = props;
  const state = spanState(idx, node.call, node.ret === null ? null : node.ret + 1);
  const argStr = node.args
    .map(([n, v]) => `${n}=${valueSummary(v)}`)
    .join(", ");
  const pulse =
    idx === node.call ? " just-called" : idx === node.ret ? " just-returned" : "";
  return (
    <div className={`call-node ${state}${pulse}`}>
      <div className="call-head">
        <button className="link-btn" onClick={() => setIdx(node.call)}>
          {node.func}({argStr})
        </button>
        <span className={`badge ${state}`}>{state}</span>
        {node.ret !== null && idx >= node.ret && node.retVal && (
          <span className="ret-val">→ {valueSummary(node.retVal)}</span>
        )}
      </div>
      {node.children.length > 0 && (
        <div className="call-children">
          {node.children.map((child) => (
            <CallNodeView key={child.id} node={child} idx={idx} setIdx={setIdx} />
          ))}
        </div>
      )}
    </div>
  );
}

export function FunctionsPanel(props: {
  calls: CallNode[];
  step: Step | undefined;
  idx: number;
  setIdx: (i: number) => void;
}) {
  const { calls, step, idx, setIdx } = props;
  // The module-level "call" is the root; show its children as the call tree.
  const tree = calls.length === 1 && calls[0].func === "<module>"
    ? calls[0].children
    : calls;
  return (
    <div>
      <h3>Call stack (now)</h3>
      {step && step.stack.length > 0 ? (
        <div className="stack-now">
          {[...step.stack].reverse().map((fr, i) => (
            <div
              key={i}
              className={`stack-frame ${i === 0 ? "top" : ""}`}
            >
              <span className="stack-depth">{step.stack.length - 1 - i}</span>
              <span>{fr.f === "<module>" ? "module" : `${fr.f}()`}</span>
              <span className="loop-line">line {fr.line}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="hint">No active frames.</p>
      )}
      <h3>Call hierarchy</h3>
      {tree.length === 0 ? (
        <p className="hint">No function calls in this program.</p>
      ) : (
        tree.map((node) => (
          <CallNodeView key={node.id} node={node} idx={idx} setIdx={setIdx} />
        ))
      )}
    </div>
  );
}
