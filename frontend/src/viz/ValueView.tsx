// Recursive visual renderer for serialized Python values, plus the optional
// SVG graph view for adjacency-list dictionaries.

import type { Value } from "./trace";

export interface HlProps {
  hiIndex?: number; // element/row currently visited by the running loop
  hiKey?: string; // dict key currently visited
}

export function ValueView({ v, hiIndex, hiKey }: { v: Value } & HlProps) {
  switch (v.t) {
    case "list":
    case "tuple":
    case "deque":
      return <SeqView v={v} hiIndex={hiIndex} />;
    case "dict":
      return <DictView v={v} hiIndex={hiIndex} hiKey={hiKey} />;
    case "set":
      return <SetView v={v} hiIndex={hiIndex} />;
    case "str":
      return (
        <span className="val str">
          "{v.v}"{v.trunc ? "…" : ""}
        </span>
      );
    case "none":
      return <span className="val none">None</span>;
    case "bool":
      return <span className="val bool">{v.v}</span>;
    case "int":
    case "float":
    case "complex":
      return <span className="val num">{v.v}</span>;
    case "func":
      return <span className="val def">function {v.v}</span>;
    case "class":
      return <span className="val def">class {v.v}</span>;
    case "module":
      return <span className="val def">module {v.v}</span>;
    case "cycle":
      return <span className="val none">↩ cyclic</span>;
    default:
      return (
        <span className="val obj">
          {v.cls ?? v.t} {v.v}
        </span>
      );
  }
}

function SeqView({ v, hiIndex }: { v: Value } & HlProps) {
  const items = (v.items ?? []) as Value[];
  if (v.items === undefined) {
    // Depth-capped: show compact repr.
    return <span className="val obj">{v.v}</span>;
  }
  return (
    <div className={`seq ${v.t}`}>
      {v.t === "tuple" && (
        <span className="type-tag imm" title="Tuples are immutable">
          tuple 🔒
        </span>
      )}
      {v.t === "deque" && (
        <span className="type-tag" title="collections.deque">
          deque
        </span>
      )}
      {items.length === 0 && <span className="val none">empty</span>}
      {items.map((it, ix) => (
        <div className="cell" key={ix}>
          <div className="cell-idx">{ix}</div>
          <div className={`cell-val${ix === hiIndex ? " hl" : ""}`}>
            <ValueView v={it} />
          </div>
        </div>
      ))}
      {v.trunc && <span className="val none">… {v.n} total</span>}
    </div>
  );
}

function DictView({ v, hiIndex, hiKey }: { v: Value } & HlProps) {
  const items = (v.items ?? []) as [Value, Value][];
  if (v.items === undefined) return <span className="val obj">{v.v}</span>;
  if (items.length === 0) return <span className="val none">empty dict</span>;
  return (
    <table className="dict">
      <tbody>
        {items.map(([k, val], ix) => (
          <tr
            key={ix}
            className={
              ix === hiIndex || (hiKey !== undefined && k.v === hiKey)
                ? "hl"
                : ""
            }
          >
            <td className="dict-key">
              <ValueView v={k} />
            </td>
            <td className="dict-arrow">→</td>
            <td>
              <ValueView v={val} />
            </td>
          </tr>
        ))}
        {v.trunc && (
          <tr>
            <td colSpan={3} className="val none">
              … {v.n} entries total
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function SetView({ v, hiIndex }: { v: Value } & HlProps) {
  const items = (v.items ?? []) as Value[];
  if (v.items === undefined) return <span className="val obj">{v.v}</span>;
  return (
    <div className="setv">
      <span className="type-tag" title="Sets have no fixed order">
        set · unordered
      </span>
      {items.length === 0 && <span className="val none">empty</span>}
      {items.map((it, ix) => (
        <span className={`set-chip${ix === hiIndex ? " hl" : ""}`} key={ix}>
          <ValueView v={it} />
        </span>
      ))}
      {v.trunc && <span className="val none">…</span>}
    </div>
  );
}

// ------------------------------------------------------------- graph view --

const SEQ_TYPES = new Set(["list", "tuple", "set"]);

/** A dict is graph-eligible when every value is a list/tuple/set
 *  (an adjacency list). Never applied automatically — user opts in. */
export function isGraphEligible(v: Value): boolean {
  if (v.t !== "dict" || !v.items || v.items.length === 0) return false;
  return (v.items as [Value, Value][]).every(([, val]) =>
    SEQ_TYPES.has(val.t)
  );
}

export interface GraphFocus {
  node?: string; // node whose edges are being followed right now
  neighbor?: string; // neighbor currently reached along an edge
}

export function GraphView({ v, focus }: { v: Value; focus?: GraphFocus }) {
  const labels: string[] = [];
  const edges: [string, string][] = [];
  const seen = new Set<string>();
  const addLabel = (s: string) => {
    if (!seen.has(s)) {
      seen.add(s);
      labels.push(s);
    }
  };
  for (const [k, val] of (v.items ?? []) as [Value, Value][]) {
    const a = k.v ?? "?";
    addLabel(a);
    for (const it of (val.items ?? []) as Value[]) {
      const b = it.v ?? "?";
      addLabel(b);
      edges.push([a, b]);
    }
  }

  const W = 340;
  const H = Math.max(220, 40 * labels.length > 300 ? 300 : 260);
  const cx = W / 2;
  const cy = H / 2;
  const r = Math.min(W, H) / 2 - 36;
  const pos = new Map<string, { x: number; y: number }>();
  labels.forEach((label, i) => {
    const angle = (2 * Math.PI * i) / labels.length - Math.PI / 2;
    pos.set(label, {
      x: cx + r * Math.cos(angle),
      y: cy + r * Math.sin(angle),
    });
  });

  return (
    <svg
      className="graph"
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Graph view of adjacency dictionary"
    >
      <defs>
        <marker
          id="arrow"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 8 4 L 0 8 z" fill="#8c959f" />
        </marker>
        <marker
          id="arrow-active"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 8 4 L 0 8 z" fill="#fb8500" />
        </marker>
      </defs>
      {edges.map(([a, b], i) => {
        const pa = pos.get(a)!;
        const pb = pos.get(b)!;
        // Shorten the line so the arrow stops at the node circle.
        const dx = pb.x - pa.x;
        const dy = pb.y - pa.y;
        const len = Math.hypot(dx, dy) || 1;
        const R = 16;
        const activeEdge =
          focus?.node === a && focus?.neighbor !== undefined && focus.neighbor === b;
        return (
          <line
            key={i}
            x1={pa.x + (dx / len) * R}
            y1={pa.y + (dy / len) * R}
            x2={pb.x - (dx / len) * (R + 2)}
            y2={pb.y - (dy / len) * (R + 2)}
            className={activeEdge ? "graph-edge active" : "graph-edge"}
            markerEnd={activeEdge ? "url(#arrow-active)" : "url(#arrow)"}
          />
        );
      })}
      {labels.map((label) => {
        const p = pos.get(label)!;
        const cls =
          focus?.node === label
            ? "graph-node current"
            : focus?.neighbor === label
              ? "graph-node neighbor"
              : "graph-node";
        return (
          <g key={label}>
            <circle cx={p.x} cy={p.y} r={16} className={cls} />
            <text x={p.x} y={p.y + 4} textAnchor="middle" className="graph-label">
              {label.length > 4 ? label.slice(0, 4) : label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
