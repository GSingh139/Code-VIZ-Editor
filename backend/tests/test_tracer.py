"""Tests for the tracing engine, mirroring the Stage 2 acceptance tests.

Everything asserts against REAL execution events from the subprocess tracer —
nothing is mocked.
"""

from app.tracing import trace_python_code


def var_states(result, name):
    """Ordered, de-duplicated serialized states of a module-level variable."""
    states = []
    for step in result.steps:
        if not step["stack"]:
            continue
        loc = step["stack"][0]["loc"]  # module frame
        if name in loc and (not states or states[-1] != loc[name]):
            states.append(loc[name])
    return states


def seq_values(state):
    return [item["v"] for item in state["items"]]


def loop_events(result, kind=None):
    out = []
    for step in result.steps:
        for ev in step.get("loops", []):
            if kind is None or ev["k"] == kind:
                out.append((step["i"], ev))
    return out


# ------------------------------------------------- Test A: data structures --

def test_a_list_create_modify_append_remove():
    result = trace_python_code(
        "nums = [1, 2, 3]\n"
        "nums[1] = 99\n"
        "nums.append(4)\n"
        "nums.remove(1)\n"
        "done = True\n"
    )
    assert result.exit_code == 0
    assert result.trace_available
    states = [seq_values(s) for s in var_states(result, "nums")]
    assert states == [
        ["1", "2", "3"],
        ["1", "99", "3"],
        ["1", "99", "3", "4"],
        ["99", "3", "4"],
    ]


def test_a_dict_tuple_set_nested():
    result = trace_python_code(
        "info = {'name': 'Ada', 'age': 36}\n"
        "info['age'] = 37\n"
        "point = (3, 4)\n"
        "tags = {'a'}\n"
        "nested = {'grid': [[1, 2], [3, 4]]}\n"
        "end = 1\n"
    )
    assert result.exit_code == 0
    ages = [dict((k["v"], v["v"]) for k, v in s["items"])["age"]
            for s in var_states(result, "info")]
    assert ages == ["36", "37"]

    point = var_states(result, "point")[-1]
    assert point["t"] == "tuple"
    assert seq_values(point) == ["3", "4"]

    tags = var_states(result, "tags")[-1]
    assert tags["t"] == "set"

    nested = var_states(result, "nested")[-1]
    assert nested["t"] == "dict"
    grid = nested["items"][0][1]
    assert grid["t"] == "list"
    assert grid["items"][0]["t"] == "list"
    assert seq_values(grid["items"][0]) == ["1", "2"]


# --------------------------------------------------- Test B: nested loops --

NESTED = (
    "pairs = []\n"
    "for i in range(2):\n"
    "    for j in range(3):\n"
    "        pairs.append((i, j))\n"
)


def test_b_nested_loop_metadata_and_counts():
    result = trace_python_code(NESTED)
    assert result.exit_code == 0

    outer = next(m for m in result.loops if m["line"] == 2)
    inner = next(m for m in result.loops if m["line"] == 3)
    assert outer["type"] == "for" and outer["parent"] is None
    assert inner["parent"] == outer["id"]
    assert outer["target"] == "i" and inner["target"] == "j"

    exits = [ev for _, ev in loop_events(result, "exit")]
    inner_exits = [e for e in exits if e["loop"] == inner["id"]]
    outer_exits = [e for e in exits if e["loop"] == outer["id"]]
    assert [e["completed"] for e in inner_exits] == [3, 3]
    assert [e["completed"] for e in outer_exits] == [2]

    # Each iteration event's step snapshot must hold the right loop variable.
    for step_i, ev in loop_events(result, "iter"):
        if ev["loop"] == inner["id"]:
            loc = result.steps[step_i]["stack"][0]["loc"]
            assert loc["j"]["v"] == str(ev["iter"] - 1)


def test_b_iteration_steps_show_historical_state():
    result = trace_python_code(NESTED)
    iters = [(i, ev) for i, ev in loop_events(result, "iter")]
    # At the start of inner iteration 1 of the first outer pass, pairs is
    # still empty; by the last inner iteration it holds 5 tuples.
    first_step = iters[1][0]  # first inner iter event
    last_step = iters[-1][0]
    pairs_first = result.steps[first_step]["stack"][0]["loc"]["pairs"]
    pairs_last = result.steps[last_step]["stack"][0]["loc"]["pairs"]
    assert pairs_first["n"] == 0
    assert pairs_last["n"] == 5


# ----------------------------------------- Test C: while, continue, break --

def test_c_while_with_continue_and_break():
    result = trace_python_code(
        "i = 0\n"
        "total = 0\n"
        "while i < 6:\n"
        "    i += 1\n"
        "    if i == 2:\n"
        "        continue\n"
        "    if i == 5:\n"
        "        break\n"
        "    total += i\n"
    )
    assert result.exit_code == 0
    meta = result.loops[0]
    assert meta["type"] == "while"
    assert meta["cond"] == "i < 6"

    exits = [ev for _, ev in loop_events(result, "exit")]
    assert exits[-1]["completed"] == 5  # 5 bodies entered (break on the 5th)

    final = result.steps[-1]["stack"][0]["loc"]
    assert final["i"]["v"] == "5"
    assert final["total"]["v"] == "8"  # 1 + 3 + 4


def test_c_while_condition_false_immediately():
    result = trace_python_code("while False:\n    print('never')\nx = 1\n")
    assert result.exit_code == 0
    # The loop is entered (condition checked) but completes 0 iterations.
    enters = [ev for _, ev in loop_events(result, "enter")]
    assert len(enters) == 1
    exits = [ev for _, ev in loop_events(result, "exit")]
    assert len(exits) == 1
    assert exits[0]["completed"] == 0


# -------------------------------------------------------- Test D: functions --

FUNCS = (
    "def add(a, b):\n"
    "    return a + b\n"
    "\n"
    "def compute(x):\n"
    "    return add(x, 10)\n"
    "\n"
    "def fib(n):\n"
    "    if n <= 1:\n"
    "        return n\n"
    "    return fib(n - 1) + fib(n - 2)\n"
    "\n"
    "r1 = compute(5)\n"
    "r2 = fib(4)\n"
)


def test_d_calls_args_returns_recursion():
    result = trace_python_code(FUNCS)
    assert result.exit_code == 0

    calls = [s for s in result.steps if s["ev"] == "call"]
    names = [s["f"] for s in calls]
    assert "compute" in names and "add" in names
    assert names.count("fib") == 9  # fib(4) makes 9 calls

    add_call = next(s for s in calls if s["f"] == "add")
    args = add_call["stack"][-1]["loc"]
    assert args["a"]["v"] == "5" and args["b"]["v"] == "10"

    add_return = next(s for s in result.steps
                      if s["ev"] == "return" and s["f"] == "add")
    assert add_return["ret"]["v"] == "15"

    # Recursion depth: module=0, fib(4)=1 ... fib(1)=4.
    assert max(s["d"] for s in result.steps if s["f"] == "fib") == 4

    final = result.steps[-1]["stack"][0]["loc"]
    assert final["r1"]["v"] == "15"
    assert final["r2"]["v"] == "3"


# --------------------------------------------------------- Test E: playback --

def test_e_every_step_is_a_full_snapshot():
    result = trace_python_code(
        "x = 1\n"
        "x = 2\n"
        "x = 3\n"
    )
    xs = [s["v"] for s in var_states(result, "x")]
    assert xs == ["1", "2", "3"]
    # Snapshots are independent: stepping backward re-reads earlier steps.
    for step in result.steps:
        assert "stack" in step and "out" in step and "i" in step
    assert [s["i"] for s in result.steps] == list(range(len(result.steps)))


def test_e_stdout_offsets_are_per_step():
    result = trace_python_code('print("one")\nprint("two")\nx = 1\n')
    assert result.stdout == "one\ntwo\n"
    offsets = [s["out"] for s in result.steps]
    assert offsets == sorted(offsets)
    assert offsets[-1] == len(result.stdout)
    assert 0 in offsets  # before any print
    assert "\r" not in result.stdout


# ------------------------------------------------------- Test F: regression --

def test_f_third_party_import_not_traced():
    result = trace_python_code("import requests\nprint(requests.__name__)\n")
    assert result.exit_code == 0, result.stderr
    assert result.stdout.strip() == "requests"
    # Library internals must not appear: only user-file frames are recorded,
    # so the step count stays tiny despite the huge import.
    assert len(result.steps) < 30


def test_f_exception_traceback_is_clean():
    result = trace_python_code("def f():\n    return 1 / 0\nf()\n")
    assert result.exit_code == 1
    assert "ZeroDivisionError" in result.stderr
    assert "tracer.py" not in result.stderr
    exc_steps = [s for s in result.steps if s["ev"] == "exception"]
    assert any(s["exc"]["type"] == "ZeroDivisionError" for s in exc_steps)


def test_f_syntax_error():
    result = trace_python_code("def broken(:\n")
    assert result.exit_code == 1
    assert "SyntaxError" in result.stderr
    assert result.steps == []


def test_f_timeout_no_trace():
    result = trace_python_code("while True:\n    pass\n", timeout_seconds=1)
    assert result.timed_out
    assert not result.trace_available


def test_f_max_steps_truncation_keeps_stdout():
    result = trace_python_code(
        "for i in range(500):\n    pass\nprint('finished')\n",
        max_steps=50,
    )
    assert result.exit_code == 0
    assert result.steps_truncated
    assert len(result.steps) <= 50
    assert "finished" in result.stdout  # program ran to completion untraced


def test_f_sys_exit_code_preserved():
    result = trace_python_code("import sys\nsys.exit(3)\n")
    assert result.exit_code == 3


# -------------------------------------- iteration linking metadata (viz) --

def test_iter_metadata_name_sub_range_method():
    result = trace_python_code(
        "g = {'a': ['b'], 'b': []}\n"      # 1
        "for k in g:\n"                     # 2  ikind=name
        "    pass\n"                        # 3
        "for n in g['a']:\n"                # 4  ikind=sub (const key)
        "    pass\n"                        # 5
        "node = 'a'\n"                      # 6
        "for n in g[node]:\n"               # 7  ikind=sub (name key)
        "    pass\n"                        # 8
        "for v in g.values():\n"            # 9  ikind=method
        "    pass\n"                        # 10
        "xs = [1, 2]\n"                     # 11
        "for i in range(2):\n"              # 12 ikind=range
        "    xs[i] += 1\n"                  # 13 subscript xs[i]
    )
    assert result.exit_code == 0
    metas = {m["line"]: m for m in result.loops}
    assert metas[2]["ikind"] == "name" and metas[2]["iname"] == "g"
    assert metas[4]["ikind"] == "sub" and metas[4]["iobj"] == "g"
    assert metas[4]["ikey"] == "'a'" and metas[4]["ikeykind"] == "const"
    assert metas[7]["ikind"] == "sub" and metas[7]["ikey"] == "node"
    assert metas[7]["ikeykind"] == "name"
    assert metas[9]["ikind"] == "method" and metas[9]["imeth"] == "values"
    assert metas[12]["ikind"] == "range"
    assert {"obj": "xs", "key": "i", "kind": "name"} in result.subs["13"]


def test_graph_traversal_links_node_and_neighbor():
    # The recorded locals at each inner-loop iteration give the exact
    # (node, neighbor) pair — the edge being followed.
    result = trace_python_code(
        "graph = {'a': ['b', 'c'], 'b': [], 'c': []}\n"
        "visited = []\n"
        "def visit(node):\n"
        "    visited.append(node)\n"
        "    for neighbor in graph[node]:\n"
        "        visit(neighbor)\n"
        "visit('a')\n"
    )
    assert result.exit_code == 0
    edges = []
    for step in result.steps:
        for ev in step.get("loops", []):
            if ev["k"] == "iter":
                top = step["stack"][-1]
                if "node" in top["loc"] and "neighbor" in top["loc"]:
                    edges.append((top["loc"]["node"]["v"],
                                  top["loc"]["neighbor"]["v"]))
    assert ("a", "b") in edges and ("a", "c") in edges
    final = result.steps[-1]["stack"][0]["loc"]["visited"]
    assert [x["v"] for x in final["items"]] == ["a", "b", "c"]
