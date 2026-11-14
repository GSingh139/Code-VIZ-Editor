// Types mirroring the backend trace format, plus pure builders that derive
// loop-run and call-tree structures from the recorded steps. Everything here
// is computed from real execution events — never simulated.

export interface Value {
  t: string;
  v?: string;
  n?: number;
  id?: number;
  cls?: string;
  items?: Value[] | [Value, Value][];
  trunc?: boolean;
}

export interface LoopEvent {
  k: "enter" | "iter" | "exit";
  loop: number;
  iter?: number;
  completed?: number;
}

export interface Frame {
  f: string;
  line: number;
  loc: Record<string, Value>;
}

export interface Step {
  i: number;
  ev: "call" | "line" | "return" | "exception";
  line: number;
  f: string;
  d: number;
  out: number;
  stack: Frame[];
  loops?: LoopEvent[];
  ret?: Value;
  exc?: { type: string; msg: string };
}

export interface LoopMeta {
  id: number;
  type: "for" | "while";
  line: number;
  body_end: number;
  parent: number | null;
  target?: string;
  iter?: string;
  cond?: string;
  // How the loop's iterable relates to a visible variable (from the AST):
  ikind?: "name" | "sub" | "range" | "method" | "other";
  iname?: string; // for x in NAME / enumerate(NAME)
  iobj?: string; // for x in IOBJ[ikey] / IOBJ.items()
  ikey?: string;
  ikeykind?: "name" | "const";
  imeth?: string;
  tnames?: string[]; // simple names in the loop target, e.g. (v, w) -> [v, w]
}

export interface SubEntry {
  obj: string;
  key: string;
  kind: "name" | "const";
}

// -------------------------------------------------------------- loop runs --

export interface LoopRun {
  id: number;
  loopId: number;
  enter: number; // step index of loop entry
  exit: number | null; // step index where control left the loop
  completed: number | null;
  iterations: { n: number; step: number }[];
  children: LoopRun[];
}

export function buildLoopRuns(steps: Step[]): LoopRun[] {
  const roots: LoopRun[] = [];
  const stack: LoopRun[] = [];
  let nid = 0;
  for (const s of steps) {
    for (const ev of s.loops ?? []) {
      if (ev.k === "enter") {
        const run: LoopRun = {
          id: nid++,
          loopId: ev.loop,
          enter: s.i,
          exit: null,
          completed: null,
          iterations: [],
          children: [],
        };
        (stack.length ? stack[stack.length - 1].children : roots).push(run);
        stack.push(run);
      } else if (ev.k === "iter") {
        for (let k = stack.length - 1; k >= 0; k--) {
          if (stack[k].loopId === ev.loop) {
            stack[k].iterations.push({ n: ev.iter!, step: s.i });
            break;
          }
        }
      } else if (ev.k === "exit") {
        for (let k = stack.length - 1; k >= 0; k--) {
          if (stack[k].loopId === ev.loop && stack[k].exit === null) {
            stack[k].exit = s.i;
            stack[k].completed =
              ev.completed ?? stack[k].iterations.length;
            stack.splice(k);
            break;
          }
        }
      }
    }
  }
  return roots;
}

// -------------------------------------------------------------- call tree --

export interface CallNode {
  id: number;
  func: string;
  call: number; // step index of the call event
  ret: number | null; // step index of the return event
  retVal?: Value;
  args: [string, Value][];
  depth: number;
  children: CallNode[];
}

export function buildCallTree(steps: Step[]): CallNode[] {
  const roots: CallNode[] = [];
  const stack: CallNode[] = [];
  let nid = 0;
  for (const s of steps) {
    if (s.ev === "call") {
      const top = s.stack[s.stack.length - 1];
      const node: CallNode = {
        id: nid++,
        func: s.f,
        call: s.i,
        ret: null,
        args: top ? (Object.entries(top.loc) as [string, Value][]) : [],
        depth: s.d,
        children: [],
      };
      (stack.length ? stack[stack.length - 1].children : roots).push(node);
      stack.push(node);
    } else if (s.ev === "return") {
      const top = stack.pop();
      if (top) {
        top.ret = s.i;
        top.retVal = s.ret;
      }
    }
  }
  return roots;
}

export type RunState = "inactive" | "active" | "completed";

export function spanState(
  idx: number,
  start: number,
  end: number | null
): RunState {
  if (idx < start) return "inactive";
  if (end !== null && idx >= end) return "completed";
  return "active";
}

// -------------------------------------------------------------- highlights --

/** Execution-linked highlights for the current step. Everything here is
 *  resolved from RECORDED runtime state (locals snapshots + real iteration
 *  events) — never inferred from syntax alone. */
export interface Highlights {
  /** container variable name -> element/row index currently being visited */
  seq: Map<string, number>;
  /** dict variable name -> key label whose row/node is being visited */
  dictKey: Map<string, string>;
  /** dict variable name -> traversed edge (current node -> neighbor) */
  graph: Map<string, { node?: string; neighbor?: string }>;
  /** variable names whose value changed since the previous step */
  changed: Set<string>;
}

export function lookupVar(step: Step, name: string): Value | undefined {
  for (let k = step.stack.length - 1; k >= 0; k--) {
    const v = step.stack[k].loc[name];
    if (v !== undefined) return v;
  }
  return undefined;
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && (s[0] === "'" || s[0] === '"') && s[s.length - 1] === s[0])
    return s.slice(1, -1);
  return s;
}

export function computeHighlights(
  steps: Step[],
  loops: LoopMeta[],
  subs: Record<string, SubEntry[]>,
  runs: LoopRun[],
  idx: number
): Highlights {
  const hl: Highlights = {
    seq: new Map(),
    dictKey: new Map(),
    graph: new Map(),
    changed: new Set(),
  };
  const step = steps[idx];
  if (!step) return hl;

  // Active loop runs, outermost first (inner ones applied later override).
  const active: LoopRun[] = [];
  const walk = (rs: LoopRun[]) => {
    for (const r of rs) {
      if (r.enter <= idx && (r.exit === null || idx < r.exit)) active.push(r);
      walk(r.children);
    }
  };
  walk(runs);

  for (const run of active) {
    const meta = loops[run.loopId];
    if (!meta || meta.type !== "for") continue;
    const cur = [...run.iterations].reverse().find((it) => it.step <= idx);
    if (!cur) continue;
    if (meta.ikind === "name" && meta.iname) {
      hl.seq.set(meta.iname, cur.n - 1);
    } else if (meta.ikind === "method" && meta.iobj) {
      hl.seq.set(meta.iobj, cur.n - 1);
    } else if (meta.ikind === "sub" && meta.iobj && meta.ikey) {
      const node =
        meta.ikeykind === "name"
          ? lookupVar(step, meta.ikey)?.v
          : stripQuotes(meta.ikey);
      const targetName =
        meta.tnames?.[0] ??
        (meta.target && /^[A-Za-z_]\w*$/.test(meta.target)
          ? meta.target
          : undefined);
      const neighbor = targetName
        ? lookupVar(step, targetName)?.v
        : undefined;
      if (node !== undefined) {
        hl.graph.set(meta.iobj, { node, neighbor });
        hl.dictKey.set(meta.iobj, node);
      }
    }
  }

  // Subscripts on the CURRENT line (xs[i], grid[2]) resolved with live values.
  for (const sub of subs[String(step.line)] ?? []) {
    const container = lookupVar(step, sub.obj);
    if (!container || (container.t !== "list" && container.t !== "tuple"))
      continue;
    let i: number | undefined;
    if (sub.kind === "const") {
      i = parseInt(sub.key, 10);
    } else {
      const kv = lookupVar(step, sub.key);
      if (kv?.t === "int") i = parseInt(kv.v ?? "", 10);
    }
    if (i !== undefined && !Number.isNaN(i) && i >= 0) hl.seq.set(sub.obj, i);
  }

  // Changed variables vs previous step (module frame always; top frame when
  // it is the same function at the same depth).
  const prev = steps[idx - 1];
  if (prev) {
    const compareFrames = (a?: Frame, b?: Frame) => {
      if (!a || !b) return;
      for (const [name, v] of Object.entries(a.loc)) {
        const old = b.loc[name];
        if (old === undefined || JSON.stringify(old) !== JSON.stringify(v))
          hl.changed.add(name);
      }
    };
    compareFrames(step.stack[0], prev.stack[0]);
    const top = step.stack[step.stack.length - 1];
    const prevTop = prev.stack[prev.stack.length - 1];
    if (step.stack.length > 1 && prevTop && top.f === prevTop.f && step.d === prev.d)
      compareFrames(top, prevTop);
  }
  return hl;
}

export function valueSummary(v: Value | undefined): string {
  if (!v) return "";
  if (v.t === "str") return JSON.stringify(v.v ?? "");
  if (v.v !== undefined) return v.v;
  if (v.t === "list" || v.t === "tuple" || v.t === "set" || v.t === "dict")
    return `${v.t}(${v.n})`;
  return v.t;
}
