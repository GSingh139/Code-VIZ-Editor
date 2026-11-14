"""Standalone tracing runner, executed as a script in the sandbox subprocess.

Usage: python tracer.py <user_script.py> <output.json> <max_steps>

Runs the user's script under sys.settrace and records real execution events:
one step per executed line / call / return / exception in USER code only
(imported libraries are never traced). Each step carries a serialized
snapshot of every live user stack frame, so any historical state can be
reconstructed exactly — no guessing, no reverse simulation.

Loop events (enter / iteration / exit, with parent-child nesting) are derived
from actual control flow using an AST table of the source's for/while loops.

This file is standalone on purpose: it must not import anything from the
FastAPI app, only the standard library.
"""

from __future__ import annotations

import ast
import collections
import json
import os
import sys
import traceback

MAX_SER_DEPTH = 4
MAX_ITEMS = 60
MAX_STR = 200
MAX_LOCALS = 40
MAX_STACK_FRAMES = 30

HIDDEN_NAMES = {
    "__builtins__", "__loader__", "__spec__", "__cached__", "__file__",
    "__package__", "__annotations__", "__doc__", "__name__",
}


# ---------------------------------------------------------------- values ---

def _short_repr(v) -> str:
    try:
        r = repr(v)
    except Exception:
        r = f"<unrepresentable {type(v).__name__}>"
    return r[:MAX_STR] + ("…" if len(r) > MAX_STR else "")


def ser(v, depth: int = MAX_SER_DEPTH, seen: frozenset = frozenset()):
    """Serialize a Python value to a JSON-safe, size-capped description."""
    import types

    if v is None:
        return {"t": "none", "v": "None"}
    if isinstance(v, bool):
        return {"t": "bool", "v": repr(v)}
    if isinstance(v, (int, float, complex)):
        return {"t": type(v).__name__, "v": _short_repr(v)}
    if isinstance(v, str):
        out = {"t": "str", "v": v[:MAX_STR], "n": len(v)}
        if len(v) > MAX_STR:
            out["trunc"] = True
        return out
    if id(v) in seen:
        return {"t": "cycle", "v": "…cyclic reference…"}

    if isinstance(v, (list, tuple, collections.deque)):
        t = ("tuple" if isinstance(v, tuple)
             else "deque" if isinstance(v, collections.deque) else "list")
        if isinstance(v, collections.deque):
            v = list(v)
        if depth <= 0:
            return {"t": t, "id": id(v), "n": len(v), "v": _short_repr(v)}
        inner = seen | {id(v)}
        return {
            "t": t, "id": id(v), "n": len(v),
            "items": [ser(x, depth - 1, inner) for x in v[:MAX_ITEMS]],
            "trunc": len(v) > MAX_ITEMS,
        }
    if isinstance(v, dict):
        if depth <= 0:
            return {"t": "dict", "id": id(v), "n": len(v), "v": _short_repr(v)}
        inner = seen | {id(v)}
        items = []
        for i, (k, val) in enumerate(v.items()):
            if i >= MAX_ITEMS:
                break
            items.append([ser(k, 1, inner), ser(val, depth - 1, inner)])
        return {"t": "dict", "id": id(v), "n": len(v), "items": items,
                "trunc": len(v) > MAX_ITEMS}
    if isinstance(v, (set, frozenset)):
        if depth <= 0:
            return {"t": "set", "id": id(v), "n": len(v), "v": _short_repr(v)}
        inner = seen | {id(v)}
        items = []
        for i, x in enumerate(v):
            if i >= MAX_ITEMS:
                break
            items.append(ser(x, depth - 1, inner))
        return {"t": "set", "id": id(v), "n": len(v), "items": items,
                "trunc": len(v) > MAX_ITEMS}

    if isinstance(v, types.ModuleType):
        return {"t": "module", "v": v.__name__}
    if isinstance(v, type):
        return {"t": "class", "v": v.__name__}
    if callable(v):
        return {"t": "func", "v": getattr(v, "__name__", "<callable>")}
    return {"t": "obj", "cls": type(v).__name__, "id": id(v),
            "v": _short_repr(v)}


def ser_locals(frame) -> dict:
    out = {}
    for i, (name, val) in enumerate(frame.f_locals.items()):
        if name in HIDDEN_NAMES:
            continue
        if i >= MAX_LOCALS and len(out) >= MAX_LOCALS:
            break
        out[name] = ser(val)
    return out


# ------------------------------------------------------------- AST loops ---

def _iter_info(node: ast.For) -> dict:
    """Classify what a for-loop iterates over, so the frontend can link the
    current iteration (a real recorded event) to the visualized container."""
    it = node.iter
    if isinstance(it, ast.Name):
        return {"ikind": "name", "iname": it.id}
    if isinstance(it, ast.Subscript) and isinstance(it.value, ast.Name):
        sl = it.slice
        if isinstance(sl, ast.Name):
            return {"ikind": "sub", "iobj": it.value.id,
                    "ikey": sl.id, "ikeykind": "name"}
        if isinstance(sl, ast.Constant):
            return {"ikind": "sub", "iobj": it.value.id,
                    "ikey": repr(sl.value), "ikeykind": "const"}
    if isinstance(it, ast.Call):
        f = it.func
        if isinstance(f, ast.Name):
            if f.id == "range":
                return {"ikind": "range"}
            if f.id == "enumerate" and it.args and isinstance(it.args[0], ast.Name):
                # enumerate preserves iteration order over the named container
                return {"ikind": "name", "iname": it.args[0].id}
        if isinstance(f, ast.Attribute) and f.attr in ("keys", "items", "values"):
            if isinstance(f.value, ast.Name):
                return {"ikind": "method", "iobj": f.value.id, "imeth": f.attr}
            # graph[u].items() — iterate a nested container chosen at runtime
            if (isinstance(f.value, ast.Subscript)
                    and isinstance(f.value.value, ast.Name)):
                sl = f.value.slice
                if isinstance(sl, ast.Name):
                    return {"ikind": "sub", "iobj": f.value.value.id,
                            "ikey": sl.id, "ikeykind": "name", "imeth": f.attr}
                if isinstance(sl, ast.Constant):
                    return {"ikind": "sub", "iobj": f.value.value.id,
                            "ikey": repr(sl.value), "ikeykind": "const",
                            "imeth": f.attr}
    return {"ikind": "other"}


class SubscriptCollector(ast.NodeVisitor):
    """Per-line table of simple subscripts (xs[i], grid[2]) so the frontend
    can highlight the accessed cell using the RUNTIME value of the index."""

    def __init__(self):
        self.subs: dict[str, list[dict]] = {}

    def visit_Subscript(self, node):
        if isinstance(node.value, ast.Name):
            entry = None
            if isinstance(node.slice, ast.Name):
                entry = {"obj": node.value.id, "key": node.slice.id,
                         "kind": "name"}
            elif (isinstance(node.slice, ast.Constant)
                  and isinstance(node.slice.value, int)
                  and not isinstance(node.slice.value, bool)):
                entry = {"obj": node.value.id, "key": str(node.slice.value),
                         "kind": "const"}
            if entry is not None:
                line = self.subs.setdefault(str(node.lineno), [])
                if entry not in line:
                    line.append(entry)
        self.generic_visit(node)


class LoopCollector(ast.NodeVisitor):
    """Static table of every for/while loop: header line, body range, parent."""

    def __init__(self):
        self.loops: list[dict] = []
        self.stack: list[int] = []

    def _add(self, node, ltype: str):
        meta = {
            "id": len(self.loops),
            "type": ltype,
            "line": node.lineno,
            "body_end": node.body[-1].end_lineno,
            "parent": self.stack[-1] if self.stack else None,
        }
        try:
            if ltype == "for":
                meta["target"] = ast.unparse(node.target)
                meta["tnames"] = [n.id for n in ast.walk(node.target)
                                  if isinstance(n, ast.Name)]
                meta["iter"] = ast.unparse(node.iter)
                meta.update(_iter_info(node))
            else:
                meta["cond"] = ast.unparse(node.test)
        except Exception:
            pass
        self.loops.append(meta)
        self.stack.append(meta["id"])
        for child in node.body:
            self.visit(child)
        self.stack.pop()
        for child in node.orelse:
            self.visit(child)

    def visit_For(self, node):
        self._add(node, "for")

    def visit_AsyncFor(self, node):
        self._add(node, "for")

    def visit_While(self, node):
        self._add(node, "while")

    def _fresh_scope(self, node):
        # Loops inside a nested function belong to that function's frames,
        # not to whatever loop lexically surrounds the def.
        saved, self.stack = self.stack, []
        self.generic_visit(node)
        self.stack = saved

    def visit_FunctionDef(self, node):
        self._fresh_scope(node)

    def visit_AsyncFunctionDef(self, node):
        self._fresh_scope(node)

    def visit_ClassDef(self, node):
        self._fresh_scope(node)


# ----------------------------------------------------------------- stdout ---

class _Tee:
    """Counts characters written to stdout so each step knows the output
    position at that moment (frontend shows output progressively)."""

    def __init__(self, orig):
        self._orig = orig
        self.n = 0

    def write(self, s):
        try:
            self.n += len(s)
        except TypeError:
            pass
        return self._orig.write(s)

    def flush(self):
        return self._orig.flush()

    def __getattr__(self, name):
        return getattr(self._orig, name)


# ----------------------------------------------------------------- tracer ---

class Tracer:
    def __init__(self, user_file: str, loops: list[dict], max_steps: int,
                 tee: _Tee):
        self.user_file = user_file
        self.max_steps = max_steps
        self.tee = tee
        self.steps: list[dict] = []
        self.truncated = False
        self.by_line = {m["line"]: m for m in loops}
        self.frame_loops: dict[int, list[dict]] = {}

    # -- loop bookkeeping ---------------------------------------------------

    def _loop_events_for_line(self, frame, line: int) -> list[dict]:
        events: list[dict] = []
        st = self.frame_loops.setdefault(id(frame), [])

        # Leave loops whose body range no longer contains this line.
        while st and not (st[-1]["meta"]["line"] <= line <= st[-1]["meta"]["body_end"]):
            left = st.pop()
            events.append({"k": "exit", "loop": left["meta"]["id"],
                           "completed": left["iters"]})

        meta = self.by_line.get(line)
        top = st[-1] if st else None

        # A body line right after a header hit = a new iteration actually ran.
        if top and top["pending"] and (meta is None or meta["id"] != top["meta"]["id"]):
            top["iters"] += 1
            top["pending"] = False
            events.append({"k": "iter", "loop": top["meta"]["id"],
                           "iter": top["iters"]})
            top = st[-1]

        if meta is not None:
            if top and top["meta"]["id"] == meta["id"]:
                top["pending"] = True  # header re-hit: next check/iteration
            else:
                st.append({"meta": meta, "iters": 0, "pending": True})
                events.append({"k": "enter", "loop": meta["id"]})
        return events

    def _loop_exits_for_return(self, frame) -> list[dict]:
        st = self.frame_loops.pop(id(frame), [])
        return [{"k": "exit", "loop": s["meta"]["id"], "completed": s["iters"]}
                for s in reversed(st)]

    # -- recording ------------------------------------------------------------

    def _record(self, frame, ev: str, levents: list[dict] | None,
                ret=None, exc=None):
        if len(self.steps) >= self.max_steps:
            self.truncated = True
            sys.settrace(None)
            return
        frames = []
        f = frame
        while f is not None and f.f_code.co_filename == self.user_file:
            frames.append(f)
            f = f.f_back
        frames.reverse()
        stack = [
            {"f": fr.f_code.co_name, "line": fr.f_lineno, "loc": ser_locals(fr)}
            for fr in frames[-MAX_STACK_FRAMES:]
        ]
        step = {
            "i": len(self.steps),
            "ev": ev,
            "line": frame.f_lineno,
            "f": frame.f_code.co_name,
            "d": len(frames) - 1,
            "out": self.tee.n,
            "stack": stack,
        }
        if levents:
            step["loops"] = levents
        if ev == "return":
            step["ret"] = ser(ret)
        if exc is not None:
            step["exc"] = {"type": exc[0].__name__, "msg": str(exc[1])[:200]}
        self.steps.append(step)

    # -- trace callback -------------------------------------------------------

    def trace(self, frame, event, arg):
        if self.truncated:
            return None
        if frame.f_code.co_filename != self.user_file:
            return None
        if event == "call":
            self._record(frame, "call", None)
        elif event == "line":
            levents = self._loop_events_for_line(frame, frame.f_lineno)
            self._record(frame, "line", levents)
        elif event == "return":
            levents = self._loop_exits_for_return(frame)
            self._record(frame, "return", levents, ret=arg)
        elif event == "exception":
            self._record(frame, "exception", None, exc=arg)
        return self.trace


# ------------------------------------------------------------------- main ---

def _filtered_traceback(etype, evalue, tb) -> str:
    """User-facing traceback without the tracer's own frames."""
    entries = [e for e in traceback.extract_tb(tb)
               if e.filename != os.path.abspath(__file__)
               and e.filename != __file__]
    lines = ["Traceback (most recent call last):\n"]
    lines += traceback.format_list(entries)
    lines += traceback.format_exception_only(etype, evalue)
    return "".join(lines)


def main() -> int:
    user_file, out_json, max_steps = sys.argv[1], sys.argv[2], int(sys.argv[3])
    result = {"steps": [], "loops": [], "subs": {}, "steps_truncated": False}

    with open(user_file, encoding="utf-8") as f:
        source = f.read()

    status = 0
    tee = _Tee(sys.stdout)
    try:
        code = compile(source, user_file, "exec")
        tree = ast.parse(source)
    except SyntaxError:
        sys.stderr.write(
            "".join(traceback.format_exception_only(*sys.exc_info()[:2])))
        with open(out_json, "w", encoding="utf-8") as f:
            json.dump(result, f)
        return 1

    collector = LoopCollector()
    collector.visit(tree)
    sub_collector = SubscriptCollector()
    sub_collector.visit(tree)
    tracer = Tracer(user_file, collector.loops, max_steps, tee)

    # The user script should see a normal environment.
    sys.path[0] = os.path.dirname(os.path.abspath(user_file))
    sys.argv = [user_file]
    sys.stdout = tee
    g = {"__name__": "__main__", "__file__": user_file,
         "__builtins__": __builtins__}

    sys.settrace(tracer.trace)
    try:
        exec(code, g)
    except SystemExit as e:
        status = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
    except BaseException:
        status = 1
        sys.settrace(None)
        sys.stderr.write(_filtered_traceback(*sys.exc_info()))
    finally:
        sys.settrace(None)
        sys.stdout = tee._orig
        result["steps"] = tracer.steps
        result["loops"] = collector.loops
        result["subs"] = sub_collector.subs
        result["steps_truncated"] = tracer.truncated
        with open(out_json, "w", encoding="utf-8") as f:
            json.dump(result, f)
    return status


if __name__ == "__main__":
    sys.exit(main())
