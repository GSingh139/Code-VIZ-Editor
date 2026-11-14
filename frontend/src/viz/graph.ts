// Graph workspace core: derive a graph from a recorded variable, bind
// runtime variables to visualization roles (visited / frontier / dist /
// prev / path), compute the graph state at any step from REAL snapshots,
// and generate terminal logs from the real event stream.
//
// Nothing here invents events: every node state, queue operation, distance
// or edge shown is read from (or diffed between) recorded execution steps.

import type { LoopMeta, Step, Value } from "./trace";
import { lookupVar, valueSummary } from "./trace";

const SEQ = new Set(["list", "tuple", "set", "deque"]);

// ---------------------------------------------------------- graph deriving --

export interface GraphEdge {
  a: string;
  b: string;
  w?: string;
}

export interface GraphData {
  nodes: string[];
  edges: GraphEdge[];
  weighted: boolean;
  symmetric: boolean;
}

/** Derive nodes/edges from an adjacency dict ({n: [m]}, {n: {m: w}},
 *  {n: [(m, w)]}) or an edge list ([(a, b)], [(a, b, w)]). */
export function deriveGraph(v: Value | undefined): GraphData | null {
  if (!v) return null;
  const nodes: string[] = [];
  const seen = new Set<string>();
  const edges: GraphEdge[] = [];
  const add = (s: string) => {
    if (!seen.has(s)) {
      seen.add(s);
      nodes.push(s);
    }
  };

  if (v.t === "dict" && v.items) {
    for (const [k, val] of v.items as [Value, Value][]) {
      const a = k.v;
      if (a === undefined) return null;
      add(a);
      if (SEQ.has(val.t) && val.items) {
        for (const item of val.items as Value[]) {
          const parts = (item.items ?? []) as Value[];
          if (
            (item.t === "tuple" || item.t === "list") &&
            parts.length === 2 &&
            parts[0].v !== undefined
          ) {
            add(parts[0].v);
            edges.push({ a, b: parts[0].v, w: parts[1].v });
          } else if (item.v !== undefined) {
            add(item.v);
            edges.push({ a, b: item.v });
          } else {
            return null;
          }
        }
      } else if (val.t === "dict" && val.items) {
        for (const [b, w] of val.items as [Value, Value][]) {
          if (b.v === undefined) return null;
          add(b.v);
          edges.push({ a, b: b.v, w: w.v });
        }
      } else {
        return null;
      }
    }
  } else if (SEQ.has(v.t) && v.items) {
    for (const item of v.items as Value[]) {
      if (item.t !== "tuple" && item.t !== "list") return null;
      const parts = (item.items ?? []) as Value[];
      if (parts.length < 2 || parts[0].v === undefined || parts[1].v === undefined)
        return null;
      add(parts[0].v);
      add(parts[1].v);
      edges.push({
        a: parts[0].v,
        b: parts[1].v,
        w: parts.length > 2 ? parts[2].v : undefined,
      });
    }
    if (edges.length === 0) return null;
  } else {
    return null;
  }

  if (nodes.length === 0) return null;
  const weighted = edges.some((e) => e.w !== undefined);
  const key = (a: string, b: string) => `${a}\u0000${b}`;
  const all = new Set(edges.map((e) => key(e.a, e.b)));
  const symmetric =
    edges.length > 0 && edges.every((e) => all.has(key(e.b, e.a)));
  return { nodes, edges, weighted, symmetric };
}

/** Variable names (at the given step) that derive to a graph with edges. */
export function graphCandidates(step: Step | undefined): string[] {
  if (!step) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const frame of step.stack) {
    for (const [name, v] of Object.entries(frame.loc)) {
      if (seen.has(name)) continue;
      seen.add(name);
      const g = deriveGraph(v);
      if (g && g.edges.length > 0) names.push(name);
    }
  }
  return names;
}

// ------------------------------------------------------------ role binding --

export interface Roles {
  visited?: string;
  frontier?: string;
  frontierKind: "queue" | "stack";
  dist?: string;
  prev?: string;
  path?: string;
}

const ROLE_NAMES: Record<string, string[]> = {
  visited: ["visited", "seen", "explored", "done", "closed", "closed_set"],
  queue: ["queue", "q", "frontier", "pq", "heap", "open_set", "pending", "worklist"],
  stack: ["stack"],
  dist: ["dist", "distances", "distance", "dists", "g_score", "cost", "costs"],
  prev: ["prev", "parent", "pred", "predecessor", "predecessors", "came_from", "parents"],
  path: ["path", "order", "result", "traversal", "topo", "topo_order", "visit_order"],
};

/** Every variable name seen anywhere in the trace, with its (first) type. */
export function allVarTypes(steps: Step[]): Map<string, string> {
  const types = new Map<string, string>();
  for (const s of steps) {
    for (const frame of s.stack) {
      for (const [name, v] of Object.entries(frame.loc)) {
        if (!types.has(name)) types.set(name, v.t);
      }
    }
  }
  return types;
}

export function autoRoles(steps: Step[], graphVar?: string): Roles {
  const types = allVarTypes(steps);
  const pick = (role: string, ok: (t: string) => boolean): string | undefined => {
    for (const cand of ROLE_NAMES[role]) {
      const t = types.get(cand);
      if (t !== undefined && cand !== graphVar && ok(t)) return cand;
    }
    return undefined;
  };
  const isSeq = (t: string) => SEQ.has(t);
  const roles: Roles = { frontierKind: "queue" };
  roles.visited = pick("visited", (t) => isSeq(t) || t === "dict");
  const q = pick("queue", (t) => isSeq(t));
  const st = pick("stack", (t) => isSeq(t));
  if (q) {
    roles.frontier = q;
    roles.frontierKind = "queue";
  } else if (st) {
    roles.frontier = st;
    roles.frontierKind = "stack";
  }
  roles.dist = pick("dist", (t) => t === "dict");
  roles.prev = pick("prev", (t) => t === "dict");
  roles.path = pick("path", (t) => isSeq(t));
  if (roles.path === roles.visited) roles.path = undefined;
  return roles;
}

// -------------------------------------------------------- per-step state --

export interface GraphState {
  visited: Set<string>;
  waiting: string[];
  dist: Map<string, string>;
  prev: Map<string, string>;
  path: string[];
}

function members(v: Value | undefined, nodeSet?: Set<string>): string[] {
  if (!v || !v.items) return [];
  if (v.t === "dict")
    return (v.items as [Value, Value][]).flatMap(([k]) =>
      k.v !== undefined ? [k.v] : []
    );
  const out: string[] = [];
  for (const item of v.items as Value[]) {
    if (item.v !== undefined) {
      out.push(item.v);
    } else if (item.items) {
      // e.g. heap entries (dist, node): take the element that is a node
      const parts = item.items as Value[];
      const hit = nodeSet
        ? parts.find((p) => p.v !== undefined && nodeSet.has(p.v))
        : parts.find((p) => p.v !== undefined);
      if (hit?.v !== undefined) out.push(hit.v);
    }
  }
  return out;
}

function dictEntries(v: Value | undefined): [string, string][] {
  if (!v || v.t !== "dict" || !v.items) return [];
  return (v.items as [Value, Value][]).flatMap(([k, val]) =>
    k.v !== undefined ? [[k.v, valueSummary(val)] as [string, string]] : []
  );
}

export function graphStateAt(
  step: Step | undefined,
  roles: Roles,
  nodeSet: Set<string>
): GraphState {
  const state: GraphState = {
    visited: new Set(),
    waiting: [],
    dist: new Map(),
    prev: new Map(),
    path: [],
  };
  if (!step) return state;
  if (roles.visited)
    for (const m of members(lookupVar(step, roles.visited), nodeSet))
      state.visited.add(m);
  if (roles.frontier)
    state.waiting = members(lookupVar(step, roles.frontier), nodeSet);
  if (roles.dist)
    for (const [k, v] of dictEntries(lookupVar(step, roles.dist)))
      state.dist.set(k, v);
  if (roles.prev)
    for (const [k, v] of dictEntries(lookupVar(step, roles.prev)))
      state.prev.set(k, v);
  if (roles.path)
    state.path = members(lookupVar(step, roles.path), nodeSet);
  return state;
}

// ------------------------------------------------------------------- logs --

export type LogKind =
  | "info"
  | "stmt"
  | "call"
  | "return"
  | "loop"
  | "iter"
  | "edge"
  | "visit"
  | "frontier"
  | "dist"
  | "pred"
  | "output"
  | "exc";

export interface LogEntry {
  step: number;
  kind: LogKind;
  text: string;
}

function loopLabel(meta: LoopMeta | undefined): string {
  if (!meta) return "loop";
  return meta.type === "for"
    ? `for ${meta.target ?? "…"} in ${meta.iter ?? "…"}`
    : `while ${meta.cond ?? "…"}`;
}

function resolveEdge(
  step: Step,
  meta: LoopMeta | undefined
): { node?: string; neighbor?: string } {
  if (!meta || meta.ikind !== "sub" || !meta.ikey) return {};
  const node =
    meta.ikeykind === "name"
      ? lookupVar(step, meta.ikey)?.v
      : meta.ikey.replace(/^['"]|['"]$/g, "");
  const tname = meta.tnames?.[0];
  const neighbor = tname ? lookupVar(step, tname)?.v : undefined;
  return { node, neighbor };
}

export function buildLogs(
  steps: Step[],
  loops: LoopMeta[],
  roles: Roles,
  stdout: string,
  source: string,
  graph: GraphData | null
): LogEntry[] {
  const logs: LogEntry[] = [];
  const srcLines = source.split("\n");
  const fk = roles.frontierKind === "stack" ? "STACK" : "QUEUE";
  const nodeSet = new Set(graph?.nodes ?? []);

  if (steps.length > 0) {
    logs.push({ step: 0, kind: "info", text: "PROGRAM START" });
    if (graph)
      logs.push({
        step: 0,
        kind: "info",
        text: `GRAPH READY | ${graph.nodes.length} nodes, ${graph.edges.length} edges${graph.weighted ? ", weighted" : ""}`,
      });
  }

  let prev: Step | undefined;
  for (const s of steps) {
    if (s.ev === "call" && s.f !== "<module>") {
      const top = s.stack[s.stack.length - 1];
      const args = top
        ? Object.entries(top.loc)
            .slice(0, 4)
            .map(([n, v]) => `${n}=${valueSummary(v)}`)
            .join(", ")
        : "";
      logs.push({
        step: s.i,
        kind: "call",
        text: `FUNCTION CALL | ${s.f}(${args}) | depth ${s.d}`,
      });
    } else if (s.ev === "return" && s.f !== "<module>") {
      logs.push({
        step: s.i,
        kind: "return",
        text: `FUNCTION RETURN | ${s.f} → ${valueSummary(s.ret)}`,
      });
    } else if (s.ev === "exception" && s.exc) {
      logs.push({
        step: s.i,
        kind: "exc",
        text: `EXCEPTION | ${s.exc.type}: ${s.exc.msg}`,
      });
    } else if (s.ev === "line") {
      const src = (srcLines[s.line - 1] ?? "").trim();
      logs.push({ step: s.i, kind: "stmt", text: `LINE ${s.line} | ${src}` });
    }

    for (const ev of s.loops ?? []) {
      const meta = loops[ev.loop];
      if (ev.k === "enter") {
        logs.push({
          step: s.i,
          kind: "loop",
          text: `LOOP ENTER | ${loopLabel(meta)} | line ${meta?.line}`,
        });
      } else if (ev.k === "iter") {
        logs.push({
          step: s.i,
          kind: "iter",
          text: `ITERATION ${ev.iter} | ${loopLabel(meta)}`,
        });
        const { node, neighbor } = resolveEdge(s, meta);
        if (node !== undefined && neighbor !== undefined)
          logs.push({
            step: s.i,
            kind: "edge",
            text: `EDGE EXAMINED | ${node} -> ${neighbor}`,
          });
      } else if (ev.k === "exit") {
        logs.push({
          step: s.i,
          kind: "loop",
          text: `LOOP EXIT | ${loopLabel(meta)} | ${ev.completed} iteration${ev.completed === 1 ? "" : "s"} completed`,
        });
      }
    }

    if (prev) {
      if (roles.visited) {
        const before = new Set(members(lookupVar(prev, roles.visited), nodeSet));
        for (const m of members(lookupVar(s, roles.visited), nodeSet))
          if (!before.has(m))
            logs.push({ step: s.i, kind: "visit", text: `NODE VISITED | ${m}` });
      }
      if (roles.frontier) {
        const before = members(lookupVar(prev, roles.frontier), nodeSet);
        const now = members(lookupVar(s, roles.frontier), nodeSet);
        const b = [...before];
        for (const m of now) {
          const at = b.indexOf(m);
          if (at >= 0) b.splice(at, 1);
          else logs.push({ step: s.i, kind: "frontier", text: `${fk} PUSH | ${m}` });
        }
        for (const m of b)
          logs.push({ step: s.i, kind: "frontier", text: `${fk} POP | ${m}` });
      }
      if (roles.dist) {
        const before = new Map(dictEntries(lookupVar(prev, roles.dist)));
        for (const [k, v] of dictEntries(lookupVar(s, roles.dist)))
          if (before.get(k) !== v)
            logs.push({ step: s.i, kind: "dist", text: `DISTANCE | ${k} = ${v}` });
      }
      if (roles.prev) {
        const before = new Map(dictEntries(lookupVar(prev, roles.prev)));
        for (const [k, v] of dictEntries(lookupVar(s, roles.prev)))
          if (before.get(k) !== v)
            logs.push({ step: s.i, kind: "pred", text: `PREDECESSOR | ${k} ← ${v}` });
      }
      if (s.out > prev.out) {
        const chunk = stdout.slice(prev.out, s.out).trimEnd();
        for (const ln of chunk.split("\n"))
          logs.push({ step: s.i, kind: "output", text: `OUTPUT | ${ln}` });
      }
    }
    prev = s;
  }

  const last = steps[steps.length - 1];
  if (last) {
    if (roles.path) {
      const p = members(lookupVar(last, roles.path), nodeSet);
      if (p.length > 0)
        logs.push({
          step: last.i,
          kind: "info",
          text: `RESULT | ${roles.path} = ${p.join(" -> ")}`,
        });
    }
    logs.push({ step: last.i, kind: "info", text: "PROGRAM END" });
  }
  return logs;
}
