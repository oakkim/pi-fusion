#!/usr/bin/env python3
"""Spawn shim: node-spawned `pi` hangs silently in this environment, but
python-subprocess-spawned `pi` works. So node bench/run.mjs shells out here.

Usage: spawn.py <cwd> <timeout_secs> <argv...>
Stdout: child's stdout. Exit: 0 ok, 2 timeout (partial stdout still printed), 3 other error.
"""
import subprocess
import sys

cwd = sys.argv[1]
timeout = float(sys.argv[2])
argv = sys.argv[3:]

try:
    r = subprocess.run(argv, cwd=cwd, capture_output=True, timeout=timeout, text=True)
    sys.stdout.write(r.stdout or "")
    if r.returncode != 0:
        sys.stderr.write((r.stderr or "")[:2000])
        sys.exit(3)
except subprocess.TimeoutExpired as e:
    sys.stdout.write(e.stdout or "")
    sys.stderr.write("run timed out")
    sys.exit(2)
