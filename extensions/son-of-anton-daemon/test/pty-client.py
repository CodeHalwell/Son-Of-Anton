# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root.
"""Run the real Codypendent TUI in a disposable terminal for integration tests."""
import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
child = subprocess.Popen([sys.argv[1]], stdin=slave, stdout=slave, stderr=slave,
							start_new_session=True, env={**os.environ, "TERM": "xterm-256color"})
os.close(slave)
try:
	while child.poll() is None:
		ready, _, _ = select.select([master, sys.stdin.fileno()], [], [], 0.2)
		if master in ready:
			try:
				data = os.read(master, 65536)
			except OSError:
				break
			if not data:
				break
			sys.stdout.buffer.write(data)
			sys.stdout.buffer.flush()
		if sys.stdin.fileno() in ready:
			data = os.read(sys.stdin.fileno(), 4096)
			if not data:
				break
			os.write(master, data)
finally:
	if child.poll() is None:
		os.killpg(child.pid, signal.SIGTERM)
		try:
			child.wait(timeout=3)
		except subprocess.TimeoutExpired:
			os.killpg(child.pid, signal.SIGKILL)
			child.wait()
	os.close(master)
