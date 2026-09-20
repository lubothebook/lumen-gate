#!/usr/bin/env python3
"""Residue gate for gate2/zkvm (HARDENING-2.0.md culture, operator naming rule).

The neutral-naming requirement for the ported zkVM stack must be RE-PROVED on
every CI run, not promised once at import time: any identifier, filename,
doc line or lockfile entry carrying the forbidden source family fails here.
The English word "budget" legitimately contains three of the four letters and
is the ONLY tolerated overlap; the scan is case-insensitive by design.

Lives in a file (not inline in the workflow) because heredoc terminators at
column zero close a YAML literal block early - the first version of this gate
broke the whole workflow file and CI caught it. That lesson is the header.
"""
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "zkvm")
SCAN_EXT = (".rs", ".toml", ".md", ".json", ".zkl", ".lock", ".yml", ".yaml", ".txt")

def main() -> int:
    bad = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in ("target", "out", ".git")]
        for name in filenames:
            if not name.endswith(SCAN_EXT):
                continue
            path = os.path.join(dirpath, name)
            try:
                with open(path, errors="replace") as fh:
                    for lineno, line in enumerate(fh, 1):
                        for m in re.finditer(r"(?i)bud", line):
                            if re.match(r"(?i)budget", line[m.start():]):
                                continue
                            bad.append((os.path.relpath(path, ROOT), lineno, line.strip()[:90]))
            except OSError as exc:  # unreadable file is a gate failure, not a skip
                bad.append((path, 0, f"UNREADABLE: {exc}"))
    if bad:
        print(f"RESIDUE FOUND: {len(bad)} line(s) carrying the forbidden family name")
        for item in bad[:10]:
            print("  ", *item)
        return 1
    print("residue gate: clean (zero occurrences outside the word 'budget')")
    return 0

if __name__ == "__main__":
    sys.exit(main())
