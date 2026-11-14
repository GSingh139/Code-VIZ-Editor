"""HTTP tests for /api/trace."""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_trace_endpoint_basic():
    resp = client.post("/api/trace", json={"code": "x = 1\nprint(x)\n"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["exit_code"] == 0
    assert body["stdout"] == "1\n"
    assert body["trace_available"] is True
    assert len(body["steps"]) > 0
    assert body["steps"][0]["ev"] == "call"


def test_trace_endpoint_loops_metadata():
    resp = client.post(
        "/api/trace",
        json={"code": "for i in range(2):\n    pass\n"},
    )
    body = resp.json()
    assert len(body["loops"]) == 1
    assert body["loops"][0]["type"] == "for"


def test_trace_endpoint_validates_max_steps():
    resp = client.post(
        "/api/trace", json={"code": "x=1", "max_steps": 999999}
    )
    assert resp.status_code == 422


def test_run_endpoint_still_works():
    resp = client.post("/api/run", json={"code": 'print("stage1 intact")'})
    assert resp.status_code == 200
    assert resp.json()["stdout"].strip() == "stage1 intact"
