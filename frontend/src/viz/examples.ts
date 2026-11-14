// Example graph algorithm programs. These are ordinary user programs —
// the visualizer displays whatever they really do when traced.

export const EXAMPLES: Record<string, { label: string; code: string }> = {
  bfs: {
    label: "BFS — breadth-first search",
    code: `# BFS: watch the queue grow and shrink while the graph fills in.
from collections import deque

graph = {"a": ["b", "c"], "b": ["d", "e"], "c": ["f"], "d": [], "e": ["f"], "f": []}
visited = []
order = []
queue = deque(["a"])

while queue:
    node = queue.popleft()
    if node in visited:
        continue
    visited.append(node)
    order.append(node)
    for neighbor in graph[node]:
        if neighbor not in visited:
            queue.append(neighbor)

print("BFS order:", order)
`,
  },
  dfs: {
    label: "DFS — depth-first (recursive)",
    code: `# Recursive DFS on a graph WITH a cycle — visited stops the recursion.
graph = {"a": ["b", "c"], "b": ["d"], "c": ["d"], "d": ["a"]}
visited = []
order = []

def dfs(node):
    if node in visited:
        return
    visited.append(node)
    order.append(node)
    for neighbor in graph[node]:
        dfs(neighbor)

dfs("a")
print("DFS order:", order)
`,
  },
  dijkstra: {
    label: "Dijkstra — shortest path",
    code: `# Dijkstra: distances and predecessors update live; path is rebuilt at the end.
import heapq

graph = {
    "a": {"b": 2, "c": 5},
    "b": {"c": 1, "d": 4},
    "c": {"d": 1},
    "d": {"e": 3},
    "e": {},
}
dist = {"a": 0}
prev = {}
pq = [(0, "a")]

while pq:
    d, u = heapq.heappop(pq)
    if d > dist.get(u, float("inf")):
        continue
    for v, w in graph[u].items():
        nd = d + w
        if nd < dist.get(v, float("inf")):
            dist[v] = nd
            prev[v] = u
            heapq.heappush(pq, (nd, v))

path = ["e"]
while path[-1] in prev:
    path.append(prev[path[-1]])
path.reverse()
print("dist:", dist)
print("shortest a->e:", path)
`,
  },
  astar: {
    label: "A* — heuristic search",
    code: `# A*: like Dijkstra but ordered by dist + heuristic estimate to the goal.
import heapq

graph = {
    "a": {"b": 2, "c": 5},
    "b": {"c": 1, "d": 4},
    "c": {"d": 1},
    "d": {"e": 3},
    "e": {},
}
h = {"a": 6, "b": 5, "c": 3, "d": 2, "e": 0}  # admissible estimates to e
dist = {"a": 0}
prev = {}
pq = [(h["a"], "a")]
goal = "e"

while pq:
    f, u = heapq.heappop(pq)
    if u == goal:
        break
    for v, w in graph[u].items():
        nd = dist[u] + w
        if nd < dist.get(v, float("inf")):
            dist[v] = nd
            prev[v] = u
            heapq.heappush(pq, (nd + h[v], v))

path = [goal]
while path[-1] in prev:
    path.append(prev[path[-1]])
path.reverse()
print("A* path:", path)
`,
  },
  cycle: {
    label: "Cycle detection (directed)",
    code: `# Cycle detection with the white/grey/black scheme: grey = on the stack.
graph = {"a": ["b"], "b": ["c"], "c": ["a"], "d": ["c"]}
visited = []
stack = []
cycle = []

def has_cycle(node):
    if node in stack:
        cycle.append(node)
        return True
    if node in visited:
        return False
    visited.append(node)
    stack.append(node)
    for neighbor in graph[node]:
        if has_cycle(neighbor):
            if not cycle or cycle[-1] != node:
                cycle.append(node)
            return True
    stack.remove(node)
    return False

found = False
for start in graph:
    if has_cycle(start):
        found = True
        break

print("cycle found:", found, "|", list(reversed(cycle)))
`,
  },
  topo: {
    label: "Topological sort (Kahn)",
    code: `# Kahn's algorithm: repeatedly take nodes with no remaining incoming edges.
from collections import deque

graph = {"a": ["b", "c"], "b": ["d"], "c": ["d"], "d": ["e"], "e": []}
indegree = {n: 0 for n in graph}
for n in graph:
    for m in graph[n]:
        indegree[m] += 1

queue = deque(n for n in graph if indegree[n] == 0)
order = []

while queue:
    node = queue.popleft()
    order.append(node)
    for neighbor in graph[node]:
        indegree[neighbor] -= 1
        if indegree[neighbor] == 0:
            queue.append(neighbor)

print("topological order:", order)
`,
  },
};
