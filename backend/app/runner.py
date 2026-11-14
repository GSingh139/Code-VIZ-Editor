"""Python code execution via a separate subprocess.

Each run writes the submitted code to a temporary .py file inside a fresh
temporary directory, executes it with the same interpreter that runs the
backend (sys.executable), and captures stdout/stderr through temporary
files so the backend's memory use stays bounded no matter how much the
user's program prints.
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

DEFAULT_TIMEOUT_SECONDS = 10.0
MAX_TIMEOUT_SECONDS = 60.0
# Cap on captured output per stream (bytes read back into the backend).
MAX_OUTPUT_BYTES = 100_000


@dataclass
class ExecutionResult:
    stdout: str
    stderr: str
    exit_code: int | None
    duration_ms: float
    timed_out: bool
    stdout_truncated: bool
    stderr_truncated: bool


def _read_capped(path: Path, cap: int) -> tuple[str, bool]:
    """Read at most `cap` bytes from a capture file; report truncation."""
    size = path.stat().st_size
    with path.open("rb") as f:
        data = f.read(cap)
    text = data.decode("utf-8", errors="replace")
    return text, size > cap


def run_python_code(
    code: str,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
) -> ExecutionResult:
    """Execute Python source in a subprocess and capture the outcome.

    Never raises for user-code problems (syntax errors, exceptions,
    missing modules, timeouts); those are reported in the result.
    """
    timeout_seconds = min(max(timeout_seconds, 0.1), MAX_TIMEOUT_SECONDS)

    # ignore_cleanup_errors: on Windows a killed process's grandchildren can
    # briefly hold files open; execution results matter more than the rmdir.
    with tempfile.TemporaryDirectory(prefix="vcs_run_", ignore_cleanup_errors=True) as tmp:
        tmp_path = Path(tmp)
        script = tmp_path / "main.py"
        script.write_text(code, encoding="utf-8")
        stdout_file = tmp_path / "stdout.capture"
        stderr_file = tmp_path / "stderr.capture"

        timed_out = False
        exit_code: int | None = None
        start = time.perf_counter()

        with stdout_file.open("wb") as out_f, stderr_file.open("wb") as err_f:
            proc = subprocess.Popen(
                [sys.executable, "-u", str(script)],
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

        if timed_out:
            note = f"Execution timed out after {timeout_seconds:g} seconds and was terminated."
            stderr = f"{stderr}\n{note}" if stderr else note

        return ExecutionResult(
            stdout=stdout,
            stderr=stderr,
            exit_code=exit_code,
            duration_ms=duration_ms,
            timed_out=timed_out,
            stdout_truncated=stdout_truncated,
            stderr_truncated=stderr_truncated,
        )
