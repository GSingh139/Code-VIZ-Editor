// Animated SVG graph canvas. Node/edge states are derived from recorded
// runtime values at the current step; positions are computed once from the
// final graph value so the layout stays stable through playback.

import { useMemo } from "react";
import type { Highlights, Step } from "./trace";
import { lookupVar } from "./trace";
import type { GraphData, Roles } from "./graph";
import { deriveGraph, graphStateAt } from "./graph";

export interface GraphBindings {
  graphVar?: string;
  direction: "auto" | "directed" | "undirected";
  roles: Roles;
}

const W = 520;
const H = 340;
const R = 18;

function layoutNodes(nodes: string[]): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  const cx = W / 2;
  const cy = H / 2;
  const radius = Math.min(W, H) / 2 - 46;
  nodes.forEach((n, i) => {
    const angle = (2 * Math.PI * i) / nodes.length - Math.PI / 2;
    pos.set(n, { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) });
  });
  return pos;
}

export function GraphCanvas(props: {
  steps: Step[];
  step: Step | undefined;
  hl: Highlights | undefined;
  bindings: GraphBindings;
  setBindings: (b: GraphBindings) => void;
  candidates: string[];
  varNames: string[];
}) {
  const { steps, step, hl, bindings, setBindings, candidates, varNames } = props;
  const { graphVar, direction, roles } = bindings;

  // Stable layout: derive the graph from the LAST step (algorithms rarely
  // mutate the graph itself); fall back to the current step.
  const graph: GraphData | null = useMemo(() => {
    if (!graphVar) return null;
    const last = steps[steps.length - 1];
    return (
      deriveGraph(last ? lookupVar(last, graphVar) : undefined) ??
      deriveGraph(step ? lookupVar(step, graphVar) : undefined)
    );
  }, [steps, step, graphVar]);

  const pos = useMemo(
    () => (graph ? layoutNodes(graph.nodes) : new Map()),
    [graph]
  );

  const undirected =
    direction === "undirected" || (direction === "auto" && (graph?.symmetric ?? false));

  const nodeSet = useMemo(() => new Set(graph?.nodes ?? []), [graph]);
  const state = useMemo(
    () => graphStateAt(step, roles, nodeSet),
    [step, roles, nodeSet]
  );
  const focus = graphVar ? hl?.graph.get(graphVar) : undefined;
  const waiting = new Set(state.waiting);
  const pathEdges = new Set<string>();
  for (let i = 0; i + 1 < state.path.length; i++)
    pathEdges.add(`${state.path[i]}\u0000${state.path[i + 1]}`);

  const setRole = (k: keyof Roles, v: string) =>
    setBindings({
      ...bindings,
      roles: { ...roles, [k]: v === "" ? undefined : v },
    });

  if (candidates.length === 0) {
    return (
      <p className="hint">
        No graph variable detected. Create an adjacency dict (e.g.{" "}
        <code>{"{'a': ['b']}"}</code>) or an edge list (e.g.{" "}
        <code>[("a", "b")]</code>) and run Visualize again.
      </p>
    );
  }

  const edgeClass = (a: string, b: string): string => {
    const active =
      focus?.node !== undefined &&
      focus?.neighbor !== undefined &&
      ((focus.node === a && focus.neighbor === b) ||
        (undirected && focus.node === b && focus.neighbor === a));
    if (active) return "gc-edge active";
    if (pathEdges.has(`${a}\u0000${b}`) || (undirected && pathEdges.has(`${b}\u0000${a}`)))
      return "gc-edge path";
    if (state.prev.get(b) === a || (undirected && state.prev.get(a) === b))
      return "gc-edge tree";
    return "gc-edge";
  };

  const nodeClass = (n: string): string => {
    if (focus?.node === n) return "gc-node current";
    if (focus?.neighbor === n) return "gc-node discovered";
    if (state.path.includes(n)) return "gc-node path";
    if (waiting.has(n)) return "gc-node waiting";
    if (state.visited.has(n)) return "gc-node visited";
    return "gc-node";
  };

  // Deduplicate symmetric pairs when drawing undirected.
  const drawnEdges = graph
    ? undirected
      ? graph.edges.filter((e) => e.a <= e.b || !graph.edges.some((r) => r.a === e.b && r.b === e.a))
      : graph.edges
    : [];

  return (
    <div className="graph-canvas">
      <div className="gc-controls">
        <label>
          graph{" "}
          <select
            value={graphVar ?? ""}
            onChange={(e) =>
              setBindings({ ...bindings, graphVar: e.target.value || undefined })
            }
          >
            <option value="">(none)</option>
            {candidates.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label>
          edges{" "}
          <select
            value={direction}
            onChange={(e) =>
              setBindings({
                ...bindings,
                direction: e.target.value as GraphBindings["direction"],
              })
            }
          >
            <option value="auto">auto</option>
            <option value="directed">directed</option>
            <option value="undirected">undirected</option>
          </select>
        </label>
        <details className="gc-roles">
          <summary>bindings</summary>
          <div className="gc-role-grid">
            {(
              [
                ["visited", "visited"],
                ["frontier", "queue/stack"],
                ["dist", "distances"],
                ["prev", "predecessors"],
                ["path", "path/order"],
              ] as [keyof Roles, string][]
            ).map(([k, label]) => (
              <label key={k}>
                {label}{" "}
                <select
                  value={(roles[k] as string | undefined) ?? ""}
                  onChange={(e) => setRole(k, e.target.value)}
                >
                  <option value="">(none)</option>
                  {varNames.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <label>
              frontier kind{" "}
              <select
                value={roles.frontierKind}
                onChange={(e) =>
                  setBindings({
                    ...bindings,
                    roles: {
                      ...roles,
                      frontierKind: e.target.value as Roles["frontierKind"],
                    },
                  })
                }
              >
                <option value="queue">queue (FIFO)</option>
                <option value="stack">stack (LIFO)</option>
              </select>
            </label>
          </div>
        </details>
      </div>

      {graph && (
        <>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="gc-svg"
            role="img"
            aria-label="Animated graph traversal"
          >
            <defs>
              {["", "-active", "-path", "-tree"].map((suffix) => (
                <marker
                  key={suffix}
                  id={`gc-arrow${suffix}`}
                  viewBox="0 0 8 8"
                  refX="7"
                  refY="4"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 8 4 L 0 8 z" className={`gc-arrow${suffix}`} />
                </marker>
              ))}
            </defs>
            {drawnEdges.map((e, i) => {
              const pa = pos.get(e.a);
              const pb = pos.get(e.b);
              if (!pa || !pb) return null;
              const dx = pb.x - pa.x;
              const dy = pb.y - pa.y;
              const len = Math.hypot(dx, dy) || 1;
              // offset parallel edges (a->b and b->a) apart when directed
              const hasReverse =
                !undirected &&
                graph.edges.some((r) => r.a === e.b && r.b === e.a);
              const ox = hasReverse ? (-dy / len) * 5 : 0;
              const oy = hasReverse ? (dx / len) * 5 : 0;
              const x1 = pa.x + (dx / len) * R + ox;
              const y1 = pa.y + (dy / len) * R + oy;
              const x2 = pb.x - (dx / len) * (R + 2) + ox;
              const y2 = pb.y - (dy / len) * (R + 2) + oy;
              const cls = edgeClass(e.a, e.b);
              const marker = cls.includes("active")
                ? "url(#gc-arrow-active)"
                : cls.includes("path")
                  ? "url(#gc-arrow-path)"
                  : cls.includes("tree")
                    ? "url(#gc-arrow-tree)"
                    : "url(#gc-arrow)";
              return (
                <g key={i}>
                  <line
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    className={cls}
                    markerEnd={undirected ? undefined : marker}
                  />
                  {e.w !== undefined && (
                    <text
                      x={(x1 + x2) / 2 + (-dy / len) * 9}
                      y={(y1 + y2) / 2 + (dx / len) * 9 + 3}
                      className="gc-weight"
                      textAnchor="middle"
                    >
                      {e.w}
                    </text>
                  )}
                </g>
              );
            })}
            {graph.nodes.map((n) => {
              const p = pos.get(n)!;
              const d = state.dist.get(n);
              return (
                <g key={n}>
                  <circle cx={p.x} cy={p.y} r={R} className={nodeClass(n)} />
                  <text x={p.x} y={p.y + 4} textAnchor="middle" className="gc-label">
                    {n.length > 4 ? n.slice(0, 4) : n}
                  </text>
                  {d !== undefined && (
                    <text
                      x={p.x}
                      y={p.y + R + 13}
                      textAnchor="middle"
                      className="gc-dist"
                    >
                      d={d}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          <div className="gc-legend">
            <span><i className="lg unvisited" /> unvisited</span>
            <span><i className="lg current" /> current</span>
            <span><i className="lg discovered" /> discovered</span>
            <span><i className="lg waiting" /> in {roles.frontierKind}</span>
            <span><i className="lg visited" /> visited</span>
            <span><i className="lg path" /> path</span>
          </div>
          {state.waiting.length > 0 && (
            <div className="gc-frontier">
              {roles.frontierKind === "stack" ? "stack (top last): " : "queue (front first): "}
              {state.waiting.map((n, i) => (
                <span key={`${n}-${i}`} className="gc-frontier-chip">
                  {n}
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
