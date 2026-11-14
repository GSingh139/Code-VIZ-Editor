"""In-browser execution helpers (run inside Pyodide in a Web Worker).

Mirrors the old backend: plain runs exec the script as __main__, traced
runs use the same standalone tracer.py the backend used.
"""
import sys
import traceback


def _vcs_flush():
    for s in (sys.stdout, sys.stderr):
        try:
            s.flush()
        except Exception:
            pass


def vcs_run(path):
    with open(path, encoding="utf-8") as f:
        src = f.read()
    try:
        code = compile(src, path, "exec")
    except SyntaxError:
        sys.stderr.write(
            "".join(traceback.format_exception_only(*sys.exc_info()[:2])))
        _vcs_flush()
        return 1
    g = {"__name__": "__main__", "__file__": path, "__builtins__": __builtins__}
    old_argv = sys.argv
    sys.argv = [path]
    try:
        exec(code, g)
        return 0
    except SystemExit as e:
        return e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
    except BaseException:
        et, ev, tb = sys.exc_info()
        sys.stderr.write("".join(traceback.format_exception(et, ev, tb.tb_next)))
        return 1
    finally:
        sys.argv = old_argv
        _vcs_flush()


def vcs_trace(tracer_path, user_path, out_json, max_steps):
    with open(tracer_path, encoding="utf-8") as f:
        src = f.read()
    ns = {"__name__": "vcs_tracer", "__file__": tracer_path,
          "__builtins__": __builtins__}
    exec(compile(src, tracer_path, "exec"), ns)
    old_argv, old_path0 = sys.argv, (sys.path[0] if sys.path else None)
    sys.argv = [tracer_path, user_path, out_json, str(max_steps)]
    try:
        return ns["main"]()
    finally:
        sys.argv = old_argv
        if old_path0 is not None:
            sys.path[0] = old_path0
        _vcs_flush()
