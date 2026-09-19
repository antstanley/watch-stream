"""Send real Ctrl+C through a PTY, including the kernel's terminal signal mode."""
import errno
import json
import os
import pty
import select
import signal
import socket
import sys
import termios
import time

with socket.socket() as probe:
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]

pid, terminal = pty.fork()
if pid == 0:
    termios.tcsetwinsize(0, (24, 120))
    os.environ.pop("CI", None)
    os.execv(sys.argv[1], [sys.argv[1], sys.argv[2], str(port), sys.argv[3]])

output = bytearray()
reaped = False


def terminate(signum, _frame):
    # execFile's timeout must also reap this fixture's process group.
    raise SystemExit(128 + signum)


signal.signal(signal.SIGTERM, terminate)


def read_output(timeout=0.05):
    if select.select([terminal], [], [], timeout)[0]:
        try:
            output.extend(os.read(terminal, 65536))
        except OSError as error:
            if error.errno != errno.EIO:
                raise


def wait_for(text):
    deadline = time.monotonic() + 30
    while text.encode() not in output:
        read_output()
        if time.monotonic() > deadline:
            raise AssertionError("Timed out waiting for " + text)


try:
    wait_for("Which AWS profile should watch-tail use?")
    os.write(terminal, b"\x1b[B\r")
    wait_for("profile test-profile already works")
    wait_for("(Ctrl+C to stop)")
    isig = bool(termios.tcgetattr(terminal)[3] & termios.ISIG)
    os.write(terminal, b"\x03")
    deadline = time.monotonic() + 5
    while True:
        read_output()
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            reaped = True
            break
        if time.monotonic() > deadline:
            raise AssertionError(f"Ctrl+C did not stop CLI; ISIG={isig}")
    assert isig, "Profile restart left kernel terminal signals disabled"
    assert os.waitstatus_to_exitcode(status) == 0, f"Exit status {status}"
    assert b"stopped" in output, "CLI did not complete shutdown"
    with socket.socket() as probe:
        probe.settimeout(1)
        assert probe.connect_ex(("127.0.0.1", port)) != 0, "Child server still listening"
    if sys.argv[3] == "true":
        assert b"Listening on" in output, "Verbose child output was lost"
    print(json.dumps({"isig": isig, "cliExited": True, "portReleased": True}))
except Exception:
    print(output.decode(errors="replace"), file=sys.stderr)
    raise
finally:
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    if not reaped:
        os.waitpid(pid, 0)
    os.close(terminal)
