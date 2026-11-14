// Terminal-style execution log. Every entry is generated from a recorded
// execution event; clicking an entry moves the shared timeline to its step.

import { useEffect, useRef, useState } from "react";
import type { LogEntry } from "./graph";

export function LogsPanel(props: {
  logs: LogEntry[];
  idx: number;
  setIdx: (i: number) => void;
}) {
  const { logs, idx, setIdx } = props;
  const [showStatements, setShowStatements] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<HTMLButtonElement | null>(null);

  const visible = showStatements
    ? logs
    : logs.filter((e) => e.kind !== "stmt");

  // The highlighted entries are the ones recorded at the current step.
  const hasAtIdx = visible.some((e) => e.step === idx);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [idx, showStatements]);

  let activeMarked = false;
  return (
    <div className="logs">
      <div className="logs-toolbar">
        <label className="logs-filter">
          <input
            type="checkbox"
            checked={showStatements}
            onChange={(e) => setShowStatements(e.target.checked)}
          />{" "}
          show every statement
        </label>
        <span className="logs-count">{visible.length} events</span>
      </div>
      <div className="logs-body" ref={bodyRef}>
        {visible.map((e, i) => {
          const isCurrent = hasAtIdx ? e.step === idx : false;
          const past = e.step <= idx;
          const mark = isCurrent && !activeMarked;
          if (mark) activeMarked = true;
          return (
            <button
              key={i}
              ref={mark ? activeRef : undefined}
              className={`log-row ${e.kind}${isCurrent ? " current" : ""}${past ? " past" : ""}`}
              onClick={() => setIdx(e.step)}
              title={`Jump to step ${e.step + 1}`}
            >
              <span className="log-step">
                [STEP {String(e.step + 1).padStart(3, "0")}]
              </span>{" "}
              {e.text}
            </button>
          );
        })}
        {visible.length === 0 && <p className="hint">No events.</p>}
      </div>
    </div>
  );
}
