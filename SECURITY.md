# Security policy (HARDENING-2.0.md section 11)

**Scope.** This repository is testnet engineering evidence (Stellar testnet and
Ethereum Sepolia only). Nothing in it is expected to hold or move real value;
"vulnerability" here means anything that would break the correctness claims
(accepting invalid proofs, minting beyond what was burned, silently expiring
migration records, unfrozen admin capability) or the honesty claims (receipts
that do not replay, wording that outruns `deployments/testnet-2.0.json`).

**How to report.** Use GitHub's private vulnerability reporting for this
repository: open a [private security advisory](https://github.com/lubothebook/lumen-gate/security/advisories/new).
A public issue is the wrong channel. The operator has not yet published a
direct email address for this purpose, and this file refuses to invent a
placeholder one - that gap is recorded in `deployments/hardening-2.0.json`.

**What happens to a report.** Accepted findings are written, in full, into the
evidence ledgers (`findings[]` in `deployments/testnet-2.0.json`, post-mortem
style per HARDENING-2.0.md section 11: what happened, why, what changed).
Findings are never quietly deleted from the record even after the fix lands;
the fix cites the finding it closes.

**Known trust roots (not vulnerabilities, limits):** the 2.0 migration path's
attestation trust root is Circle's Iris service, whose own contracts expose
`pause`, `upgrade` and deny-list functions (see gate2/scripts/spike-notes.md
on-chain reading); Gate 1.0's demo registries are renounced and permanently
unrebindable - which is exactly why two of its self-audit checks now report
red instead of being re-keyed.
