"""Tests for the HTTP API layer."""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health():
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_run_simple_code():
    resp = client.post("/api/run", json={"code": 'print("api test")'})
    assert resp.status_code == 200
    body = resp.json()
    assert body["stdout"].strip() == "api test"
    assert body["stderr"] == ""
    assert body["exit_code"] == 0
    assert body["timed_out"] is False
    assert body["duration_ms"] > 0


def test_run_error_code():
    resp = client.post("/api/run", json={"code": "raise ValueError('boom')"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["exit_code"] != 0
    assert "ValueError" in body["stderr"]
    assert "boom" in body["stderr"]


def test_run_with_custom_timeout():
    resp = client.post(
        "/api/run",
        json={"code": "while True: pass", "timeout_seconds": 1},
    )
    assert resp.status_code == 200
    assert resp.json()["timed_out"] is True


def test_run_rejects_missing_code():
    resp = client.post("/api/run", json={})
    assert resp.status_code == 422


def test_run_rejects_excessive_timeout():
    resp = client.post(
        "/api/run",
        json={"code": "print(1)", "timeout_seconds": 9999},
    )
    assert resp.status_code == 422


def test_run_third_party_import_via_api():
    resp = client.post(
        "/api/run",
        json={"code": "import requests\nprint(requests.__version__)"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["exit_code"] == 0, body["stderr"]
    assert body["stdout"].strip()  # some version string
