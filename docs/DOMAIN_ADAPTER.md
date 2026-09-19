# The source-domain adapter boundary

This document describes how a new source domain is added to Lumen Gate, what the
boundary between the two systems is allowed to contain, and why it sits where it
does. The code is in [`crates/domain_adapter`](../crates/domain_adapter) and the
on-chain half is in
[`contracts/finality_registry`](../contracts/finality_registry).

## The shape of the boundary

An adapter is the only part of this system that knows how to read one source
domain's consensus evidence. Everything else — the registry's policy, the
gateway's settlement rules, the relayer, the console — works with the values an
adapter returns.

```text
raw evidence in                                   attestation out
┌───────────────────────────────────────┐         ┌──────────────────────────────┐
│ adapter id        which reader        │         │ height                       │
│ evidence version  which format        │         │ state root                   │
│ network           which network       │  ───►   │ finalized-at + its unit      │
│ payload           opaque to everyone  │         │ security backing             │
│ declared height   indexed, not trusted│         │ evidence digest              │
│ declared root     indexed, not trusted│         │ adapter + evidence versions  │
│ submitter         who handed it over  │         └──────────────────────────────┘
└───────────────────────────────────────┘
```

Two rejected alternatives are worth naming, because they are the obvious
choices and both are wrong:

- **"Hand us your block header."** A header is a format. Formats change: a
  hard fork renames a field, a new client serialises differently, a proof system
  changes its encoding. An adapter handed a header has to be rewritten for each
  such change.
- **"Hand us a boolean."** A boolean hides the backing, and the backing is what
  a reader needs in order to price the risk for their own use case. A proof, a
  signature set with three of five honest, and a single trusted operator are all
  "finalized" and are not remotely the same thing.

## What the interface refuses to contain

**No assume-valid branch.** Every rejection path returns an error. There is no
default that accepts, no branch that treats an unparsable payload as an empty
but acceptable one, and no `unwrap_or(true)`. In the test suite, every one of
those refusals has a test of its own: declared height mismatch, declared root
mismatch, unknown evidence version, wrong adapter, truncated payload, zeroed
signature, zero threshold, below the caller's minimum height, older than the
caller's maximum age.

**No blind trust in declared fields.** The envelope carries `declared_height`
and `declared_root` because an index needs them before an adapter runs: they are
what the network keyed on, deduplicated by and replay-guarded against. The
adapter re-derives both from the payload and refuses a mismatch. If the index and
the payload disagree, one of them is lying and the adapter cannot tell which.

**No silent version drift.** An adapter declares the evidence versions it
accepts. An unknown version is refused, never reinterpreted as the version the
adapter happens to know.

**No scores.** Nothing computes a trust rating. A domain profile is facts with
their units attached: which consensus, which proof lane, which threshold, how
deep, and whether the backing can be slashed. A reader who wants to know whether
"2-of-3 signatures from an unbonded set" is enough for their use case decides
that themselves with the numbers in front of them.

## Adding a source domain

1. **Write the adapter.** Implement `FinalityAdapter` for the new evidence
   format: parse the payload, re-derive the declared fields, declare the
   `SecurityBacking`, and say in the descriptor what the adapter does *not*
   claim. The descriptor's `not_claimed` list is not decoration; the existing
   adapter uses it to state that the pairing check happens on-chain and that the
   demo validator set is not slashable.
2. **Pin the adapter id.** The id is `sha256(name)` and it has to match what the
   source side and the on-chain domain key use. This was a real defect once: an
   off-chain boundary derived the id with an extra namespace prefix and refused
   every honest proof the chain accepts.
3. **Register the domain.** Registration records the facts the profile will
   present. There is no field for a rating, on purpose.
4. **Set the policy and admit the domain.** Admission requires the adapter to
   accept real evidence for that domain; it is not a checkbox.
5. **Re-prove it continuously.** The self-audit loop probes the live contracts
   every round, so a domain that stops producing acceptable evidence shows up as
   a failing check rather than as a silent gap.

## The message envelope and replay protection

A settlement message says one thing: value moved from here to there, and here is
the evidence. The envelope carries:

| Field | Why it exists |
| --- | --- |
| `message_id` | derived from the content, so two parties that disagree about the id disagree about the content, visibly |
| `source_domain`, `target_domain` | the direction, which is also the key of the replay guard |
| `source_height`, `event_index` | exactly which event is claimed, so a Merkle proof can be checked against a leaf rather than against "the block" |
| `nonce` | what makes replay protection cheap |
| `sender`, `recipient`, `payload_hash` | binds the amount and the addresses, so a message cannot be re-used with a different amount |
| `kind` | lock, mint, burn, unlock, or opaque custom bytes |
| `expiry_height` | a message that never expires is a message an attacker can hold and submit at the worst moment |

Replay protection is one **high-water mark per `(source_domain, target_domain,
sender)`**: the highest nonce accepted so far. Accepting a nonce invalidates
every smaller one forever, in constant storage, and the trail can only move
forward. Message ids are also tracked, but as a bounded backstop — an unbounded
id set is a memory leak with a security excuse, and it fails exactly when it
matters, because an attacker only needs one id the set forgot.

The check order is deliberate and tested: expiry first, then content identity,
then the nonce last, because the nonce check is the one that mutates state. A
refusal above that line leaves the guard exactly as it was.

## The on-chain half

The registry contract performs the same parsing and the same re-derivation
inside Soroban, where the decision is actually made, and then verifies the
evidence cryptographically with the native BLS12-381 host functions (curve,
subgroup and full pairing checks). The off-chain adapter is not a substitute for
that; it is a pre-flight check so that a malformed or stale payload never costs
anybody a fee, and so that a proposed domain can be judged before it is admitted.

Run it by hand:

```bash
curl -s "$SIM_URL/proof?height=1&kind=bls" | ./target/debug/domain-adapter verify
./target/debug/domain-adapter verify --proof proof.json --require-slashable
./target/debug/domain-adapter describe
```

Exit code 0 means accepted, 1 means refused (with the typed reason on stdout),
2 means the input could not be read at all. A refusal is a normal outcome, not a
crash.
