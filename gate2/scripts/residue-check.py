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

# Three files exist to name the source. They are exempt; nothing else is.
#
# The neutral-naming rule is about the ported CODE: identifiers, filenames,
# module paths, lockfile entries - nothing shipped should carry the upstream
# brand. A provenance record is the opposite kind of document. It exists to
# say exactly where this workspace came from, and a provenance file that may
# not name its source records nothing.
#
# STATUS.md is the same kind of document: it records which upstream crates
# were deliberately NOT ported, the contradiction between the two candidate
# sources, and what this code derives from. Each of those statements is
# unwriteable without naming the thing being named.
#
# evidence.json is the machine-readable form of the same record: the source
# repo URL and commit, the candidates that 404'd, and the exact cargo command
# whose output the numbers were measured from. Scrubbing it would leave
# unreproducible claims - the opposite of what an evidence file is for.
#
# So the exemption is three explicit paths - not a pattern, not a directory,
# not an extension. Every other file under gate2/zkvm, including every other
# .md, is still scanned. Proved non-vacuous by planting residue in a .rs file
# and in a third .md and confirming this gate fails on both.
EXEMPT = ("PROVENANCE.md", "STATUS.md", "evidence.json")

def main() -> int:
    bad = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in ("target", "out", ".git")]
        for name in filenames:
            if not name.endswith(SCAN_EXT):
                continue
            path = os.path.join(dirpath, name)
            if os.path.relpath(path, ROOT).replace(os.sep, "/") in EXEMPT:
                continue
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
