"""Traced execution: runs user code under app/tracer.py in a subprocess.

Same sandbox model as runner.py (temp dir, sys.executable, timeout, capped
output) plus a JSON trace file produced by the tracer. If the process is
killed by the timeout the trace file is never written; the result then has
trace_available=False and empty steps.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

from .runner import MAX_OUTPUT_BYTES, MAX_TIMEOUT_SECONDS, _read_capped

DEFAULT_MAX_STEPS = 1500
MAX_TRACE_JSON_BYTES = 80_000_000  # refuse to load absurdly large traces

_TRACER_PATH = Path(__file__).parent / "tracer.py"


@dataclass
class TraceExecutionResult:
    stdout: str
    stderr: str
    exit_code: int | None
    duration_ms: float
    timed_out: bool
    stdout_truncated: bool
    stderr_truncated: bool
    trace_available: bool
    steps_truncated: bool
    steps: list = field(default_factory=list)
    loops: list = field(default_factory=list)
    subs: dict = field(default_factory=dict)


def trace_python_code(
    code: str,
    timeout_seconds: float = 10.0,
    max_steps: int = DEFAULT_MAX_STEPS,
) -> TraceExecutionResult:
    timeout_seconds = min(max(timeout_seconds, 0.1), MAX_TIMEOUT_SECONDS)

    with tempfile.TemporaryDirectory(
        prefix="vcs_trace_", ignore_cleanup_errors=True
    ) as tmp:
        tmp_path = Path(tmp)
        script = tmp_path / "main.py"
        script.write_text(code, encoding="utf-8")
        json_path = tmp_path / "trace.json"
        stdout_file = tmp_path / "stdout.capture"
        stderr_file = tmp_path / "stderr.capture"

        timed_out = False
        exit_code: int | None = None
        start = time.perf_counter()

        with stdout_file.open("wb") as out_f, stderr_file.open("wb") as err_f:
            proc = subprocess.Popen(
                [
                    sys.executable, "-u", str(_TRACER_PATH),
                    str(script), str(json_path), str(max_steps),
                ],
                stdout=out_f,
                stderr=err_f,
                stdin=subprocess.DEVNULL,
                cwd=tmp,
            )
            try:
                proc.wait(timeout=timeout_seconds)
                exit_code = proc.returncode
            except subprocess.TimeoutExpired:
                timed_out = True
                proc.kill()
                proc.wait()

        duration_ms = (time.perf_counter() - start) * 1000.0

        stdout, stdout_truncated = _read_capped(stdout_file, MAX_OUTPUT_BYTES)
        stderr, stderr_truncated = _read_capped(stderr_file, MAX_OUTPUT_BYTES)
        # Windows text mode writes \r\n; normalize so per-step character
        # offsets recorded by the tracer line up with this string.
        stdout = stdout.replace("\r\n", "\n")
        stderr = stderr.replace("\r\n", "\n")

        if timed_out:
            note = (
                f"Execution timed out after {timeout_seconds:g} seconds and "
                "was terminated. No trace is available for timed-out runs."
            )
            stderr = f"{stderr}\n{note}" if stderr else note

        steps: list = []
        loops: list = []
        subs: dict = {}
        steps_truncated = False
        trace_available = False
        try:
            if json_path.exists() and json_path.stat().st_size <= MAX_TRACE_JSON_BYTES:
                with json_path.open(encoding="utf-8") as f:
                    data = json.load(f)
                steps = data.get("steps", [])
                loops = data.get("loops", [])
                subs = data.get("subs", {})
                steps_truncated = bool(data.get("steps_truncated", False))
                trace_available = True
        except (OSError, json.JSONDecodeError):
            trace_available = False

        return TraceExecutionResult(
            stdout=stdout,
            stderr=stderr,
            exit_code=exit_code,
            duration_ms=duration_ms,
            timed_out=timed_out,
            stdout_truncated=stdout_truncated,
            stderr_truncated=stderr_truncated,
            trace_available=trace_available,
            steps_truncated=steps_truncated,
            steps=steps,
            loops=loops,
            subs=subs,
        )
