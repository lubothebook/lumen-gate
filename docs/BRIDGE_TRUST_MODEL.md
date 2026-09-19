# What the relayer actually carries, and what would remain without it

This document answers two questions the repository is not allowed to answer
loosely, because both change what the word "trustless" would mean in its
README. Everything numbered here is either a live receipt, a host test, or a
constraint count from a circuit in this repository.

## 1. The claim as of today: the relayer moves no trust

The submit paths of the registry have never been permissioned: the contract's
`submit_*` entry points authorize nobody. The `submitter` field inside an
evidence record is history, not a gate. What makes an acceptance valid is the
pairing equation against a frozen verification key, the payload's internal
binding, the height rule, and the consumed-digest set — none of which reads a
caller identity. This was structural before; now it is recorded:

- the 32-line lane's honest acceptance on the five-slot showcase registry was
  submitted by an account generated at run time (`GBPUXZEW…`), funded by
  friendbot, named in no configuration of this repository, paying its own
  fee — 181,707 stroops on ledger 4,766,791, confirmed from Horizon by the
  tool that made it happen; the replay of that same evidence from the
  *deployer's* key was refused, which is the proof that the digest belongs to
  the evidence, not to whoever signed an attempt with it;
- the gateway's user-side inbound entry (`finalize_inbound`) takes no relayer
  signature at all — the console calls it from the user's own wallet; only
  the gasless variant requires a relayer, and what it requires the relayer
  for is the fee, not the decision.

So "the bridge without a relayer" is, on the inbound leg, already the bridge:
the relayer is a service that pays fees and watches ledgers so users don't
have to. That is a legitimate role — it is named here by what it is and not
called trust. The honest limits of the removal: a user without testnet XLM
cannot self-submit (friendbot fixes this on testnets; a production network
does not have friendbot), and the *watching* job — knowing when a deposit has
finalized — still has to be done by somebody's loop before the submit can
happen. Permissionless submission is not permissionless *arrival*; anyone can
carry the evidence, but someone has to first see that there is one.

Outbound (Stellar → source chain) is the other direction and keeps the shape
it has: the burn is the user's own signature and fee, but the release on the
source side is an operator action. Turning that into "no operator" requires a
claim-pool funded in advance or a source-chain contract that verifies Stellar
events inside itself — and the second one is section 3 of this document, not
a sentence we have earned yet.

## 2. "The zkVM approves before the validators: one validator is enough"

This proposal was put to the repository and it deserves the treatment it was
asked for: said plainly, priced honestly, and bounded before it is believed.

What is true: a verified Groth16 proof is checked by the contract itself, in
one host call whose cost does not meaningfully grow with circuit size (about
29.1M CPU instructions on the Soroban host for the pairing, measured against
the current keys, and the same equation count for any circuit with the same
number of public inputs). If a proof ever said "this state root follows from
the canonical chain by the chain's own rules," no validator message would be
needed on top of it — the signature count behind a root would become policy,
not trust. One signer, three signers, thirty: the contract would be verifying
math, not counting approvals.

What is also true, and the reason no card in this repository says the first
sentence without this one: **the proofs that exist here prove runs, not
canonicity.** The bounded machines prove that *some* execution of a committed
program takes published inputs to published outputs. A prover can wrap any
root they like into such a statement; what stops a lie from settling is that
the registry binds the roots it accepts, and the roots it considers canonical
are the ones the source chain's validators signed. The proof compresses the
checking; it does not choose what to check. In the current design the quorum
is not a redundancy the zkVM failed to remove — it is the input of trust the
circuit was never asked to verify.

The gap is therefore specific and enumerable, and it is not budget:

| component | cost | status |
| --- | --- | --- |
| one SHA-256 compression block in a BN254 circuit | **59,313 non-linear + 3,215 linear** constraints | measured here, in this repository, with the pinned circomlib (`circuits/sha256_block_probe.circom`) |
| a full EdDSA signature verification inside a circuit | **8,086** constraints | measured here (`circuits/signature_gadget_probe.circom`, PROVING_SYSTEM §5e) — for the group circomlib ships; not Stellar's ed25519 and not BLS |
| ed25519 verification over the curve Stellar actually uses | ~10⁵–10⁶ per signature | **estimate**, from 255-bit ladder length and limb-arithmetic size; no bigint/field gadgets ship in the pinned npm cut — flagged, not measured |
| a BLS aggregate verification (the source side's own scheme) | ~10⁶–10⁷ | **estimate** dominated by the Fp12 pairing; the pairing library is the standing gap named in §5e and no number here should be quoted as measured until one is compiled |
| a light client's per-header work: hash the validator set, the tx-set roots, check N signer slots | N × 62.5k + the signature rows | arithmetic on the measured line above; honest up to the constants it names |

What "one validator is enough" becomes when the pieces arrive: the registry's
quorum requirement turns into a *policy number* beside the verification key —
because the proof would already contain the checking of that validator's
signature against the header, and the header's own hash would bind it to the
canonical chain. Until a circuit verifies a signature, the quorum is the
bridge's trust source and saying otherwise would relabel an assumption as an
achievement. The repository's claim, kept at exactly this size for now: the
path is priced, its first two floors are measured on our own stack, and the
expensive part is the field arithmetic, not the ceremony.

## 3. The phase plan this file commits to

1. **Phase 0 — done, on-chain:** permissionless submit demonstrated by a
   stranger's acceptance (this file §1); ceiling and confusion refusals on
   the five-slot registry; the fetch-nothing receipts card.
2. **Phase 1 — the signature lane, with the measured cost:** step-chain
   circuit gains one signature check per step against a registered signer set
   (the 8,086-class gadget, resized to the domain tag and the chain's own
   hash); registry accepts a *signed* quorum-bitmap replacement only if the
   in-circuit verifier passes. EdDSA-over-babyjubjub first because it is the
   one this stack can build today; this is not a production signature scheme
   for any live chain and the lane header will say so in those words.
3. **Phase 2 — the field-arithmetic gate, or the stop sign:** vendor (from
   its upstream tag) or write and measure a bigint/field gadget set; rebuild
   the Phase-1 verifier against the source chain's actual scheme (ed25519 for
   Stellar-side events, BLS for the Cosmos-family source). If the pairing
   library is not vendored or written to measured satisfaction, **this file
   says STOP** and the one-signer claim stays out of the README permanently —
   the way §5e already refuses to call a budget problem what it is a library
   problem.
4. **Phase 3 — canonicity in-circuit:** header-hash binding (the measured
   SHA-256 rows), validator-set commitments, and the quorum number demoted to
   policy. Outbound claim-pools inherit from this phase; before it, the
   source-side release stays operator action and is written as such.

Each phase ends the way every claim in this repository ends: a receipt, a
refusal matrix, and the bounds stated in the same breath as the achievement.
