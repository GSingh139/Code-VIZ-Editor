"""VisualCode Studio backend — FastAPI app exposing health and run endpoints.

Run locally only (bound to 127.0.0.1 by run instructions in the README).
This subprocess runner is NOT a secure sandbox for untrusted public code.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .runner import DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS, run_python_code
from .tracing import DEFAULT_MAX_STEPS, trace_python_code

app = FastAPI(title="VisualCode Studio Backend", version="0.1.0")

# The Vite dev server origins (default port 5173, plus fallback 5174).
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)

MAX_CODE_CHARS = 200_000


class RunRequest(BaseModel):
    code: str = Field(..., max_length=MAX_CODE_CHARS)
    timeout_seconds: float = Field(
        default=DEFAULT_TIMEOUT_SECONDS, gt=0, le=MAX_TIMEOUT_SECONDS
    )


class RunResponse(BaseModel):
    stdout: str
    stderr: str
    exit_code: int | None
    duration_ms: float
    timed_out: bool
    stdout_truncated: bool
    stderr_truncated: bool


class TraceRequest(RunRequest):
    max_steps: int = Field(default=DEFAULT_MAX_STEPS, ge=10, le=5000)


class TraceResponse(RunResponse):
    trace_available: bool
    steps_truncated: bool
    steps: list
    loops: list
    subs: dict


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/run", response_model=RunResponse)
async def run(req: RunRequest) -> RunResponse:
    # Run in a worker thread so slow executions don't block the event loop.
    result = await run_in_threadpool(
        run_python_code, req.code, req.timeout_seconds
    )
    return RunResponse(**result.__dict__)


@app.post("/api/trace", response_model=TraceResponse)
async def trace(req: TraceRequest) -> TraceResponse:
    result = await run_in_threadpool(
        trace_python_code, req.code, req.timeout_seconds, req.max_steps
    )
    return TraceResponse(**result.__dict__)
