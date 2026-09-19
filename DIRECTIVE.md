# Lumen Gate — Standing Directive

## 0. Role of this document (protocol: read first)

- This file is the single authoritative directive for the project. There is no
  second "main directive" anywhere in the repository. Older directive files and
  any duplicates are merged into this one and deleted; nothing that contradicts
  this document may exist as a parallel source of truth.
- Every work session begins by reading this file, especially Section 3 (Status).
  Section 3 is updated at the end of the session. Work that is already done is
  never redesigned from scratch or renamed for its own sake; it is built upon.
- The product name is fixed: **Lumen Gate**. It is used in the README title,
  the repository description, the UI title, the anchor metadata, CLI output,
  package names and the deploy name. The repository URL is a technical path and
  is not a product name.
- Two absolute writing rules apply repo-wide:
  1. The retired brand name (and any explicit or implicit derivative of it)
     never appears in any file, comment, variable, README, UI string, commit
     message or log line. Verified with a grep gate in CI.
  2. Nothing that ties this project to a country, region or national identity
     appears anywhere: no localised language files, no localised persona, no
     location-specific anchor, no regional framing. The product speaks English
     and is network-native, not place-native.
- The source chain is referred to only as `source chain`, `source-chain`,
  `source_domain` or `SOURCE_DOMAIN`. No external chain's brand, unverified
  ecosystem statistic or third-party product name is attached to the demo
  protocol.
- The project is developed continuously on a single branch, `main`. Work is
  committed and pushed to `main` as it happens so that parallel sessions (human
  or automated) can see the latest state and continue from it. No long-lived
  feature branches, no "big bang" merges.

---

## 1. Purpose and the two claims that must hold live

The application exists to prove two claims, really and on-chain:

1. **Machine-approved settlement.** The mint decision depends on no human
   signature, no multisig and no private bridge database; only on cryptographic
   evidence verified inside Soroban (BLS12-381 aggregate signature and/or a
   Groth16/BN254 proof). The last human capability in the setup path is
   permanently given up with `renounce_admin`, and that renounce is a recorded,
   verifiable transaction.
2. **Gasless user.** Someone with zero spendable XLM on Stellar can receive the
   asset, because the Stellar network fee is advanced by a relayer and repaid
   out of the source-chain lock in the source asset.

Both claims must be demonstrable, live and non-fake, before submission. If a
claim cannot be demonstrated, the corresponding sentence is removed from the
README rather than softened. A feature that does not work is never written as if
it works.

---

## 2. Architecture (kept, not rewritten)

- Soroban contracts: `finality_registry` (BLS lane, Groth16/BN254 lane, domain
  registry, explicit evidence parsing, no `assume valid` branch, admin
  permanently renounced) and `settlement_gateway` (message envelope, Merkle
  proof of the specific source event, nonce high-water-mark replay protection,
  `FeeConfig`, `finalize_inbound_gasless`, `finalize_inbound_sponsored`,
  `burn_and_relay`, admin permanently renounced).
- Proof lanes: BLS12-381 using the Protocol 22 native CAP-0059 host functions
  (curve, subgroup and full pairing checks); Groth16/BN254 using the native
  `bn254_multi_pairing_check`. The ZK lane is a quorum-and-root-binding
  statement proof, not a signature proof, and settlement never anchors on it.
- Off-chain: `source_simulator` (real BLS aggregation, binary Merkle tree, lock
  amount includes the fee), `relayer` (real Soroban RPC `getLatestLedger`,
  `simulateTransaction`, `getEvents`, receipt confirmation), `frontend`
  (Freighter, capability-gated panels), `anchor` facade (SEP-1 metadata,
  SEP-10 authentication, minimal real SEP-6 surface, self-audit read surface,
  operator-gated relay trigger), serverless `api/` layer for the hosted console.
- Tests: contract unit tests plus behavioural fault probes (zeroed signature,
  tampered signature, root mismatch, version gate, replay, wrong verifying key,
  post-renounce admin calls) and a continuously running self-audit loop.

Existing components are extended, not replaced. The live deployment is frozen
by design: the verifying key, the BLS policy, the domain list and the gateway
fee configuration are immutable on testnet because both admins are renounced.
Contract source semantics therefore must not change (a changed contract would
invalidate the recorded WASM hash); additive tests are allowed, and new
functionality belongs in the off-chain surface, the facade and the docs.

---

## 3. Status (updated at the end of every session)

### Done

- [x] BLS12-381 verification lane with native host functions, including the
      full pairing check (`submit_finality_evidence_bls`, `submit_bls_hardened`).
- [x] Groth16/BN254 verification lane with native multi-pairing, honestly
      labelled as a quorum/root-binding proof rather than a signature proof.
- [x] Message envelope, nonce high-water-mark and Merkle replay protection,
      proven live on testnet (replay rejected with `#9 EvidenceAlreadyProcessed`).
- [x] Gasless mint proven live: recipient holding exactly its minimum reserve
      and zero spendable XLM; relayer repaid in the wrapped asset. The claim is
      now re-derived from Horizon by the audit loop every round instead of being
      read from a receipt file.
- [x] Reverse path proven live: burn on Stellar, canonical event decoded through
      Soroban RPC, one-time source unlock.
- [x] Registry **and** gateway admin renounced on-chain, with a second renounce
      and a post-renounce `set_vk` proven to be refused. The audit loop re-probes
      the refusal every round.
- [x] Frontend console, Freighter, relayer and anchor facade wired end to end;
      the console drives the round trip and is capability-gated.
- [x] Self-audit loop live at **11 checks**, including four that need no signing
      key: the recipient's live balance arithmetic, the recorded mint on its
      ledger, the post-renounce `set_vk` refusal, and the facade's SEP surface
      (20/20 via `tools/sep-conformance.js`).
- [x] **Section 10.1 SEP-10 implemented**: challenge built and signed by the
      anchor account, verified with the SDK's own SEP-10 reader, short-lived
      HS256 JWT issued, wrong-signer refused, no signing key means "not
      configured" rather than a challenge nobody can verify.
- [x] **Section 10.2 minimal real SEP-6 implemented**: official field names,
      records that advance only on evidence read from a ledger (source lock
      event, Horizon payment, verified burn transaction), SEP-12 answering 501.
- [x] **Section 10.3 SEP-1 complete**: `VERSION`, `NETWORK_PASSPHRASE`,
      `SIGNING_KEY`, `ACCOUNTS`, `HORIZON_URL`, `WEB_AUTH_ENDPOINT`,
      `[DOCUMENTATION]`, `[[CURRENCIES]]` with `is_asset_anchored=false` and a
      testnet statement. Deployment-dependent values are rendered from the
      environment and omitted when undefined instead of being faked.
- [x] **Section 10.4 one error envelope and `/v1` versioning**, applied to the
      facade and the serverless layer alike, with the console reading codes from
      the envelope.
- [x] **Section 10.5 rate limiting** on the public read surface, with
      `X-RateLimit-*` headers and a 429 in the standard envelope.
- [x] README explains machine approval from first principles and draws the
      honest boundary at "Is this a zkVM? No", now with what a real zkVM would
      require (trace columns, transition constraints, a memory argument).
- [x] Project name is Lumen Gate everywhere; the retired brand name appears in
      no tracked file, and that is machine-checked.
- [x] Single directive file (this document), English only, no country or region
      references, no localised documents. Enforced by `scripts/repo-gate.sh` and
      the CI workflow on every push.
- [x] Reference patterns adopted as this project's own code
      (`crates/domain_adapter`): adapter interface with raw evidence in and an
      attestation out, security-backing descriptor, no assume-valid branch,
      content-derived message ids, per-direction nonce high-water marks.
- [x] `cargo test --workspace` → 46 passed (12 registry, 11 gateway, 3
      simulator, 20 adapter). README states the same number.
- [x] The lattice is the submitted 60x60 cube tile painted at exactly 60x60
      with a 4px inset white frame snapping to the cube under the pointer;
      verified pixel-for-pixel that the shipped tile is the submitted asset
      (the file bytes differ from the submitted PNG only in encoding, not in
      any pixel).
- [x] Behavioural coverage for that surface: `tools/check-grid-fx.js` drives
      `watchGrid()` with synthetic pointer events against a stub DOM (snap to
      the right cube, one paint per frame, scroll compensation, suppression
      over interactive surfaces, hiding on leave/scroll/blur) and asserts the
      static lattice contract in the markup; it runs inside the self-audit's
      `console_wiring_consistent` record, so a silent lattice fails the round.
      Verified: `node tools/check-grid-fx.js`, `node tools/check-console.js`
      (74 ids, 50 lookups, 4/4 embedded assets).

### Still missing (stated, not hidden)

- [ ] Production validator set: the BLS lane runs 3 demo keys with a threshold
      of 2, unbonded. Real DKG and a slashable set are roadmap, and the adapter
      descriptor says so in its own `not_claimed` list.
- [ ] A source-root-bound ZK circuit. The existing one proves a quorum and a
      root binding; it is not a signature proof, so settlement never anchors on
      it.
- [ ] Market-priced fees. The relayer fee is a fixed 0.1 wSRC chosen at
      submission time, not derived from the live XLM fee and a rate. The
      mechanism is proven; the pricing is not built.
- [ ] Bonds, slashing, validator rotation, fraud proofs.
- [ ] SEP-24 hosted flow and SEP-12 KYC. Marked `not_implemented` where a client
      would look for them.
- [ ] Relayer liveness: one operator runs it. It is not a trusted party in the
      mint decision, but it is a liveness dependency.
- [ ] The recorded settlement receipts were re-verified against Horizon this
      session rather than regenerated, because the relayer's signing key is
      deliberately not in the repository. Re-running a fresh end-to-end mint
      requires the operator's key; the audit loop's own evidence submissions do
      run live with a throwaway funded account.

---

## 4. Hardening backlog (priority order this round)

### 4.1 Admin and verifying-key trust gap (implemented, keep probing)

`admin` was a bootstrap role only: it set the verifying key, the BLS policy and
the domain admission, then `renounce_admin` permanently removed it on both the
registry and the gateway. The proof must stay visible in the demo:
"admin renounced, tx hash: …", and the self-audit loop re-probes it every round
by simulating the admin call and requiring the host to trap.

### 4.2 Real zero-XLM claim (implemented, keep re-proving)

The live receipt is a recipient account at exactly its minimum reserve with zero
spendable XLM, whose XLM balance is identical before and after the mint. The
claim in the README must keep the honest qualifier: gasless means *zero spendable
XLM*, not zero setup — a Stellar account with a trustline for the wrapped asset
is still required, and the outbound direction is not gasless.

### 4.3 Fault probes (extend with facade probes)

Contract-side probes already cover zeroed signature, tampered signature, root
mismatch, version gate, replay, forged Groth16 proof, wrong verifying key,
non-admin mutation and post-renounce attempts. This round adds facade-side
probes to the same loop, so the integration surface is audited continuously too:
SEP-10 challenge/verify, SEP-6 schema completeness, error-envelope consistency,
and rate-limit enforcement.

### 4.4 Statistics and badges

Every number that appears in the README must be reproducible from the
repository or from a receipt file. If a badge or an ecosystem statistic cannot
be re-verified at submission time, it is removed rather than kept. No
"verified"-style badge over an unverified figure.

---

## 5. The gasless flow (settled design; do not re-derive)

- The user locks `amount = desired + fee` on the source chain.
- Evidence (BLS or ZK) is produced and verified inside `finality_registry`
  (machine approval).
- The relayer pays the real Stellar transaction fee in XLM and calls
  `finalize_inbound_gasless`.
- The recipient receives `desired`; the relayer receives the fee in the source
  asset; `RelayerReward` is accounted.
- The recipient needs no XLM and no spendable balance. A trustline for the
  wrapped asset is required, because Stellar assets cannot be held without one.

The Stellar network fee is physically paid in XLM by the relayer — that is a
protocol rule and it is not being circumvented. What the design changes is *who
pays* and *who is repaid*: the relayer advances the fee and is repaid out of the
locked source-chain amount, so the user's XLM balance is untouched.

---

## 6. Standing checklist (before every submission)

- [ ] Repo-wide grep for the retired brand name returns nothing.
- [ ] Repo-wide grep for country/region references returns nothing.
- [ ] The repository contains exactly one directive file (this one).
- [ ] All user-facing text, docs and commit messages are English.
- [ ] Admin renounce is recorded and re-probed by the self-audit loop.
- [ ] The zero-XLM flow is re-proven with a fresh, unfunded keypair.
- [ ] Every README claim maps to a file, a receipt or a re-runnable command.
- [ ] `cargo test --workspace` passes and the count in the README matches.
- [ ] The anchor facade's SEP claims match what the facade actually serves
      (Section 10), including explicit "not implemented" markers.
- [ ] The self-audit loop runs, and its latest round is readable from the API
      surface and the console.
- [ ] Everything is committed and pushed to `main`.

---

## 7. Submission framing (honest, and it stays honest)

The hackathon track asks for a working product built on Stellar with real
integration. This repository satisfies that, and the framing in the presentation
stays exactly this: *"we applied a design pattern we already knew to
Stellar-specific primitives, writing the Soroban implementation from scratch."*
The demo leads with testnet receipts rather than with unverifiable ecosystem
badges or security adjectives. The source chain may be a deterministic
simulator; every Stellar-side step is real.

---

## 8. README explainer: how approval works without a human

The README carries a section that explains approval from the ground up for a
reader who does not know cryptography, including: what a normal bridge does
(validators sign, a relayer collects signatures, the destination chain trusts
people), how aggregate BLS signatures are checked with a single pairing equation
inside Soroban, what a Groth16 proof is and why its verification is constant
size and constant cost, and why a renounced verifying key means there is no key
left that could override what the math already decided. The section is
maintained alongside the code; if the mechanism changes, the text changes.

---

## 9. Self-audit loop (continuous proof, not a one-off test)

The fault probes run continuously, not only in CI. Every round the loop:

1. accepts a freshly produced valid evidence set and confirms acceptance;
2. submits the malformed variants and confirms each is refused;
3. probes the admin capability on both contracts and requires the host to trap;
4. probes the anchor facade's SEP-10, SEP-6, error-envelope and rate-limit
   behaviour (Section 10);
5. writes the result, with a timestamp, to a machine-readable record.

The record is served read-only by the facade and rendered in the console as
"last check: <time>, N/N checks passed". The loop has no authority: it observes
and reports, and it creates no new admin-like power. The line to use with judges:
*"the system did not only prove once that it runs without a human; it keeps
proving it, live, on its own."*

---

## 10. Anchor facade: professionalisation (priority this round)

The facade must stop reading like a hackathon API and behave like a real
Stellar anchor's service surface. Order of work: 10.1 first (it is the
precondition for 10.2), then 10.3 and 10.4, then 10.5.

### 10.1 SEP-10 web authentication (highest priority)

- `GET /v1/sep10/auth?account=G...&home_domain=&client_domain=` returns a
  challenge transaction, signed by the anchor's signing key, carrying the
  Stellar network passphrase and a short validity window, with
  `web_auth_domain` and the optional client-domain signature handled.
- `POST /v1/sep10/auth` accepts the signed challenge, verifies that the account
  really signed it (`verifyChallengeTxSigners` against the same network
  passphrase), and on success returns a short-lived JWT plus its expiry.
- The JWT is the user layer; the operator token stays the operator layer. Write
  endpoints require one or the other; neither is a substitute for the other.
- If no signing key is configured, SEP-10 reports "not configured" and refuses —
  it never issues a challenge it cannot sign or verify.

### 10.2 Real, minimal SEP-6

- `GET /v1/sep6/info` describes the deposit and withdraw capabilities that truly
  exist, using official field names (`enabled`, `authentication_required`,
  `min_amount`, `max_amount`, `fee_fixed`, `fee_percent`, `fields`).
- `GET /v1/deposit` and `GET /v1/withdraw` return official SEP-6 fields (`how`,
  `id`, `eta`, `min_amount`, `max_amount`, `fee_fixed`, `extra_info`) and create
  a real transaction record that is later reconciled against live evidence: the
  source-chain events for deposits, and a burn transaction verified through
  Soroban RPC `getTransaction` for withdrawals.
- `GET /v1/transactions` returns records in the SEP-6 `transaction` schema with
  the documented statuses; records only advance when the underlying evidence is
  observed on-chain, never because a client asserted it.
- Anything still absent (SEP-12 KYC, SEP-24 hosted flow, fiat rails) is marked
  `not_implemented` explicitly, with no placeholder that looks like a feature.

### 10.3 Full SEP-1 compliance in `stellar.toml`

Checked against the official field list: `VERSION`, `NETWORK_PASSPHRASE`,
`SIGNING_KEY`, `ACCOUNTS`, `HORIZON_URL`, `WEB_AUTH_ENDPOINT`, `[DOCUMENTATION]`
with `ORG_NAME`/`ORG_URL`/`ORG_DESCRIPTION`, and `[[CURRENCIES]]` with `code`,
`issuer`, `display_decimals`, `name`, `desc`, `is_asset_anchored`,
`anchor_asset_type`, `status`, `conditions`. Because the demo asset is a test
asset, `is_asset_anchored` is `false` and the description says plainly that this
is a testnet deployment. Values are facts; a `stellar.toml` that advertises
something the service cannot deliver is worse than an empty one.

### 10.4 One consistent error envelope and explicit versioning

- Every endpoint answers with
  `{ "error": { "code": "...", "message": "...", "details": {...} } }` for
  failures, including 404, 405, 429 and 5xx.
- Canonical routes live under `/v1/...` so that future breaking changes are
  possible; the unversioned paths remain as aliases so nothing that integrates
  today breaks silently.

### 10.5 Rate limiting on public reads

Public read endpoints (`/self-audit`, `/api/finality`, `/info`, `/deposit`,
`/withdraw`, `/transactions`) get a simple per-IP limit (default 60 requests per
minute, env-tunable) with `X-RateLimit-*` headers and a 429 in the standard
envelope. The operator token continues to protect writes.

---

## 11. Fee mechanism and the proving-system framing

### 11.1 Where the fee really comes from

The Stellar network fee is physically paid by the relayer in XLM — a protocol
rule. The relayer is repaid in the source asset out of the locked amount
(recorded receipt: relayer paid 137,293 stroops; recipient XLM identical before
and after). The honest limitation to keep in the README: **the relayer fee is a
fixed amount chosen at submission time, not real-time market pricing.**

### 11.2 "Is this a zkVM? No" — keep the words, deepen the substance

The statement is technically correct and stays. A fixed-statement Groth16
circuit is not a virtual machine: there is no instruction set, no memory model,
no commitment to a guest program and no witness that replays execution. Relabel
it and a technical judge can pull the claim apart exactly where the project
credits itself with honesty; that costs more than the label gains.

Preferred path: do not change the label, deepen the narrative. Explain what a
real zkVM proof would require — a multi-column execution trace, per-step
transition constraints, a memory argument with a permutation or Merkle-based
commitment, and a commitment to the guest program — and state that this project
made a deliberate MVP-scope choice instead. Second path, only if time allows:
genuinely widen the circuit to prove a chained state transition over N
consecutive headers. Then the label would change because the engineering did.

---

## 12. Language, attribution and repository hygiene

- All repository content is English: code, comments, docs, UI strings, commit
  messages, README, directive. Localised documentation files are removed.
- The retired brand name, and nothing that hints at it, appears anywhere. The
  same applies to any third-party product name for the source chain.
- Design patterns taken from external reference material are re-expressed as
  neutral, generic engineering (for example: a finality-adapter interface with a
  raw-evidence envelope and a security-backing descriptor; a cross-domain
  message envelope with content-derived identifiers; a per-direction nonce
  high-water mark). Pattern intent may be adopted; names, identifiers and code
  are rewritten for this project.
- Testnet-only values (demo validator keys, locally generated trusted setup,
  simulator endpoints) are labelled as such wherever they appear.

---

## 13. Adopting reference patterns without importing their identity

The following ideas are adopted as engineering intent, re-derived for this
project, and documented in `docs/DOMAIN_ADAPTER.md`:

- **Adapter interface.** Raw evidence in, finality attestation out. The adapter
  re-derives the declared height and root from the evidence payload and rejects
  anything that does not match; there is no "assume valid" branch and every
  rejection path returns an error.
- **Security backing descriptor.** Every attestation states how it is backed
  (signature set with signer count, threshold and slashing flag, or a proof
  system identifier), so the settlement layer can apply a policy instead of
  trusting a label.
- **Domain profile as facts, not scores.** The registry stores verifiable
  properties of a source domain: consensus kind, evidence version, proof lane,
  required confirmation depth, admitted state. Reputation and scoring stay out.
- **Cross-domain message envelope.** Content-derived message identifiers,
  explicit source and target domains, source height, nonce, sender, recipient,
  payload hash and message kind, with expiry.
- **Replay protection by high-water mark.** One monotonic counter per
  `(source_domain, target_domain, sender)`; accepting a nonce invalidates every
  smaller one, so the trail can only move forward.
- **Post-quantum roadmap, not post-quantum claims.** The hybrid signature
  direction is documented as future work; there is no native host support for it
  on Soroban today, so no code pretends otherwise.
