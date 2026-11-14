// CodeMirror extension: highlight the source line currently executing.

import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";

export const setExecLine = StateEffect.define<number | null>();

const execLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setExecLine)) {
        if (e.value === null || e.value < 1 || e.value > tr.state.doc.lines) {
          deco = Decoration.none;
        } else {
          const line = tr.state.doc.line(e.value);
          deco = Decoration.set([
            Decoration.line({ class: "cm-exec-line" }).range(line.from),
          ]);
        }
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export const execLineExtension = [execLineField];

export function highlightLine(view: EditorView, line: number | null) {
  const effects: StateEffect<unknown>[] = [setExecLine.of(line)];
  if (line !== null && line >= 1 && line <= view.state.doc.lines) {
    effects.push(
      EditorView.scrollIntoView(view.state.doc.line(line).from, {
        y: "nearest",
      })
    );
  }
  view.dispatch({ effects });
}
