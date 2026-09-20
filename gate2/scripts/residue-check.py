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
# So the exemption is four explicit paths - not a pattern, not a directory, not
# an extension. Every other file under gate2/zkvm, including every other .md and
# every file with no extension at all, is still scanned. Proved non-vacuous by
# planting residue in a .rs file, in a third .md, and in an extensionless NOTICE,
# and confirming this gate fails on all three.
EXEMPT = ("PROVENANCE.md", "STATUS.md", "evidence.json", "LICENSE")

# LICENSE joins the set for a different reason than the three records above, and
# the reason is not bookkeeping but law. It is PolyForm Shield 1.0.0, whose
# Required Notice clause obliges the distributor to reproduce the licensor's
# copyright line, name and line of business - lines that carry the upstream name
# by design. Scrubbing them would not neutralise the tree, it would breach the
# licence the port was taken under. The file is vendored byte-identical to the
# monorepo root LICENSE.md (sha256 77080c7c...897401, the value PROVENANCE.md
# states and the value this gate can be checked against), so it is not a place
# residue could hide either: any edit changes the hash.
#
# scripts/repo-gate.sh rule 1 carries the same four exclusions. This file used to
# carry three, and reached the fourth only by accident: it filtered on file
# extension, and LICENSE has none, so it was never read at all. The rule is now
# stated rather than inherited from a filename convention.
# Extensionless files are scanned too. Filtering on extension alone left a hole
# exactly as wide as the files a licence or a notice usually arrives in: LICENSE,
# NOTICE, COPYING, Makefile. Nothing under gate2/zkvm needs the hole today, and
# that is the point - a gate whose coverage depends on how a file happens to be
# named stops covering the moment someone adds one.
def is_scanned(name: str) -> bool:
    return name.endswith(SCAN_EXT) or "." not in name


def looks_binary(path: str) -> bool:
    """True when the file carries a NUL byte in its first block.

    Extensionless names include build products, and the walk reads the working
    tree rather than the index, so an artifact with no suffix can appear at any
    time. Decoding one as text produces invented hits, which would fail the gate
    on residue that is not there. A binary is skipped; an UNREADABLE file is not,
    and stays a failure - skipping what cannot be read is how a gate goes quiet.
    """
    try:
        with open(path, "rb") as fh:
            return b"\x00" in fh.read(8192)
    except OSError:
        return False

def is_exempt(rel: str) -> bool:
    """True for the provenance set, matched as an exact path.

    Deliberately not a prefix and not a glob, so the set cannot be widened by
    dropping a source file underneath an exempt directory.
    """
    return rel in EXEMPT


def main() -> int:
    bad = []
    tolerated = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in ("target", "out", ".git")]
        for name in filenames:
            if not is_scanned(name):
                continue
            path = os.path.join(dirpath, name)
            rel = os.path.relpath(path, ROOT).replace(os.sep, "/")
            # NOTE: an exempt path is NOT skipped here. It is read, and its hits
            # are routed to `tolerated` below so a green run reports what was
            # allowed. Skipping early is what makes an exemption unauditable.
            if looks_binary(path):
                continue
            try:
                with open(path, errors="replace") as fh:
                    for lineno, line in enumerate(fh, 1):
                        for m in re.finditer(r"(?i)bud", line):
                            if re.match(r"(?i)budget", line[m.start():]):
                                continue
                            item = (rel, lineno, line.strip()[:90])
                            # An exempt file is counted, not skipped silently: a
                            # green run should show what was allowed and where, so
                            # the exemption can be audited instead of trusted.
                            (tolerated if is_exempt(rel) else bad).append(item)
            except OSError as exc:  # unreadable file is a gate failure, not a skip
                bad.append((rel, 0, f"UNREADABLE: {exc}"))
    if bad:
        print(f"RESIDUE FOUND: {len(bad)} line(s) carrying the forbidden family name")
        for item in bad[:10]:
            print("  ", *item)
        return 1
    where = {}
    for rel, _lineno, _text in tolerated:
        where[rel] = where.get(rel, 0) + 1
    detail = ", ".join(f"{path} ({count})" for path, count in sorted(where.items())) or "none"
    print("residue gate: clean (zero occurrences outside the provenance set)")
    print(f"  tolerated in the provenance set: {len(tolerated)} line(s) - {detail}")
    print("  the word 'budget' is tolerated everywhere by design")
    return 0

if __name__ == "__main__":
    sys.exit(main())
