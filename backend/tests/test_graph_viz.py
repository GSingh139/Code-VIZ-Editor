"""Stage 3 tests: the recorded events must contain everything the graph
canvas and terminal logs need — real queue/stack contents, visited sets,
distances and predecessors at every step. Nothing is synthesized."""

from app.tracing import trace_python_code


def lookup(step, name):
    for frame in reversed(step["stack"]):
        if name in frame["loc"]:
            return frame["loc"][name]
    return None


def states_of(result, name):
    seen = []
    for step in result.steps:
        v = lookup(step, name)
        if v is not None and (not seen or seen[-1] != v):
            seen.append(v)
    return seen


BFS = (
    "from collections import deque\n"
    "graph = {'a': ['b', 'c'], 'b': ['d'], 'c': ['d'], 'd': []}\n"
    "visited = []\n"
    "queue = deque(['a'])\n"
    "while queue:\n"
    "    node = queue.popleft()\n"
    "    if node in visited:\n"
    "        continue\n"
    "    visited.append(node)\n"
    "    for neighbor in graph[node]:\n"
    "        if neighbor not in visited:\n"
    "            queue.append(neighbor)\n"
    "print(visited)\n"
)


def test_1_bfs_queue_and_visited_are_recorded():
    result = trace_python_code(BFS)
    assert result.exit_code == 0, result.stderr
    assert result.stdout.strip() == "['a', 'b', 'c', 'd']"

    # deque serialized structurally (needed for queue visualization)
    queues = states_of(result, "queue")
    assert all(q["t"] == "deque" for q in queues)
    contents = [[x["v"] for x in q["items"]] for q in queues]
    assert ["a"] in contents          # initial queue
    assert ["b", "c"] in contents     # after visiting a
    # every push/pop is observable as a state change between steps
    assert len(contents) >= 6

    visits = [[x["v"] for x in v["items"]] for v in states_of(result, "visited")]
    assert visits[-1] == ["a", "b", "c", "d"]  # true BFS order


DFS_CYCLE = (
    "graph = {'a': ['b'], 'b': ['c'], 'c': ['a']}\n"  # cycle a->b->c->a
    "visited = []\n"
    "def dfs(node):\n"
    "    if node in visited:\n"
    "        return\n"
    "    visited.append(node)\n"
    "    for neighbor in graph[node]:\n"
    "        dfs(neighbor)\n"
    "dfs('a')\n"
)


def test_2_dfs_on_cycle_terminates_and_records_recursion():
    result = trace_python_code(DFS_CYCLE)
    assert result.exit_code == 0
    visits = states_of(result, "visited")[-1]
    assert [x["v"] for x in visits["items"]] == ["a", "b", "c"]
    # recursion depth recorded: dfs(a)->dfs(b)->dfs(c)->dfs(a) = depth 4
    assert max(s["d"] for s in result.steps if s["f"] == "dfs") == 4


def test_3_disconnected_graph_traversal():
    result = trace_python_code(
        "graph = {'a': ['b'], 'b': [], 'x': ['y'], 'y': []}\n"
        "visited = []\n"
        "def dfs(n):\n"
        "    if n in visited:\n"
        "        return\n"
        "    visited.append(n)\n"
        "    for m in graph[n]:\n"
        "        dfs(m)\n"
        "for start in graph:\n"
        "    dfs(start)\n"
    )
    assert result.exit_code == 0
    final = states_of(result, "visited")[-1]
    assert [x["v"] for x in final["items"]] == ["a", "b", "x", "y"]


def test_5_dijkstra_distances_and_predecessors():
    result = trace_python_code(
        "import heapq\n"
        "graph = {'a': {'b': 1, 'c': 4}, 'b': {'c': 2}, 'c': {}}\n"
        "dist = {'a': 0}\n"
        "prev = {}\n"
        "pq = [(0, 'a')]\n"
        "while pq:\n"
        "    d, u = heapq.heappop(pq)\n"
        "    if d > dist.get(u, float('inf')):\n"
        "        continue\n"
        "    for v, w in graph[u].items():\n"
        "        nd = d + w\n"
        "        if nd < dist.get(v, float('inf')):\n"
        "            dist[v] = nd\n"
        "            prev[v] = u\n"
        "            heapq.heappush(pq, (nd, v))\n"
        "print(dist)\n"
    )
    assert result.exit_code == 0, result.stderr
    assert result.stdout.strip() == "{'a': 0, 'b': 1, 'c': 3}"

    # dist updates are visible step by step (c first 4 via a, then 3 via b)
    dist_states = states_of(result, "dist")
    as_dicts = [
        {k["v"]: val["v"] for k, val in s["items"]} for s in dist_states
    ]
    assert {"a": "0", "b": "1", "c": "4"} in as_dicts
    assert as_dicts[-1] == {"a": "0", "b": "1", "c": "3"}

    prev_final = {k["v"]: val["v"] for k, val in
                  states_of(result, "prev")[-1]["items"]}
    assert prev_final == {"b": "a", "c": "b"}

    # the inner loop over graph[u].items() is linked for edge highlighting
    meta = next(m for m in result.loops if m.get("imeth") == "items")
    assert meta["ikind"] == "sub" and meta["iobj"] == "graph"
    assert meta["ikey"] == "u" and meta["tnames"] == ["v", "w"]


def test_7_nested_loops_during_traversal():
    result = trace_python_code(
        "graph = {'a': ['b', 'c'], 'b': [], 'c': []}\n"
        "edges = []\n"
        "for u in graph:\n"
        "    for v in graph[u]:\n"
        "        edges.append((u, v))\n"
    )
    assert result.exit_code == 0
    final = states_of(result, "edges")[-1]
    pairs = [tuple(x["v"] for x in t["items"]) for t in final["items"]]
    assert pairs == [("a", "b"), ("a", "c")]
    outer = next(m for m in result.loops if m["parent"] is None)
    inner = next(m for m in result.loops if m["parent"] == outer["id"])
    assert outer["iname"] == "graph" and inner["iobj"] == "graph"
