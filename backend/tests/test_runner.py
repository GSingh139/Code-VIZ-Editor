"""Tests for the subprocess runner itself (no HTTP involved)."""

from app.runner import MAX_OUTPUT_BYTES, run_python_code


def test_stdout_capture():
    result = run_python_code('print("hello world")')
    assert result.stdout.strip() == "hello world"
    assert result.stderr == ""
    assert result.exit_code == 0
    assert not result.timed_out
    assert result.duration_ms > 0


def test_stdlib_import():
    result = run_python_code("import math\nprint(math.sqrt(16))")
    assert result.stdout.strip() == "4.0"
    assert result.exit_code == 0


def test_third_party_import():
    # requests is installed in the backend's own environment; because the
    # runner uses sys.executable, user code must see it too.
    result = run_python_code("import requests\nprint(requests.__name__)")
    assert result.stdout.strip() == "requests"
    assert result.exit_code == 0, result.stderr


def test_missing_module_reports_error():
    result = run_python_code("import definitely_not_a_real_module_xyz")
    assert result.exit_code != 0
    assert "ModuleNotFoundError" in result.stderr
    assert "definitely_not_a_real_module_xyz" in result.stderr


def test_syntax_error():
    result = run_python_code("def broken(:\n    pass")
    assert result.exit_code != 0
    assert "SyntaxError" in result.stderr


def test_runtime_exception_traceback():
    result = run_python_code("x = 1 / 0")
    assert result.exit_code != 0
    assert "ZeroDivisionError" in result.stderr
    assert "Traceback" in result.stderr


def test_timeout_kills_process():
    result = run_python_code("while True:\n    pass", timeout_seconds=1)
    assert result.timed_out
    assert "timed out" in result.stderr.lower()


def test_partial_output_before_timeout():
    result = run_python_code(
        'print("before the loop")\nwhile True:\n    pass',
        timeout_seconds=1,
    )
    assert result.timed_out
    assert "before the loop" in result.stdout


def test_output_is_capped():
    # Print well over the cap; captured text must be limited.
    result = run_python_code('print("x" * 500_000)')
    assert result.stdout_truncated
    assert len(result.stdout.encode("utf-8")) <= MAX_OUTPUT_BYTES
    assert result.exit_code == 0


def test_nonzero_exit_code():
    result = run_python_code("import sys\nsys.exit(3)")
    assert result.exit_code == 3


def test_repeated_executions():
    for i in range(5):
        result = run_python_code(f"print({i} * 2)")
        assert result.stdout.strip() == str(i * 2)
        assert result.exit_code == 0
