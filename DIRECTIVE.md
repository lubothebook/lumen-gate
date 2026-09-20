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
- [x] Self-audit loop extended to **13 checks** with the gate-vm lane in the
      picture: the lane's live acceptance is re-derived from Horizon every round
      together with a byte-for-byte read of its registry's stored key, and the
      post-renounce `set_vk` check was tightened so a transport failure can no
      longer be misread as a contract refusal (reachability read + intact-key
      read required). Recorded round: **13/13, round 18**, live against the testnet
      registry; the facade probe now reports 26/26.
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
- [x] **The session owns its records (hardening beyond the directive)**:
      opening a SEP-6 deposit or withdraw record and reading transaction history
      require a SEP-10 session, and the account is always the token subject.
      Anonymous callers cannot plant pending records against arbitrary
      addresses, and history cannot be pivoted by swapping an `account`
      parameter. The hosted `api/` layer emits the same error envelope as the
      facade, and the console parses failures through one tolerant reader so an
      upstream shape change never surfaces as `[object Object]`.
- [x] **`tools/sep-conformance.js` drives the surface as a client would; 27
      checks pass** against a freshly started facade
      (`bash tools/probe-run.sh` starts, probes and tears down in one command):
      challenge structure (sequence 0, exact manageData name, 64-byte nonce,
      bounded timebox, the web-auth-domain extra-operation rule), discovery's
      `SIGNING_KEY` matched against the key challenges are actually sourced
      from, forged HS256 tokens refused, fully signed but expired challenges
      refused, record routes session-gated, cross-account requests refused with
      403, history scoped to the session, and `Retry-After` asserted on the
      rate-limit refusal.
- [x] **Rust workspace pinned under rustfmt**: 114 formatting drifts
      normalised, `cargo test --workspace` re-run after the format (46 passed),
      and `scripts/repo-gate.sh` gained three mechanical invariants on top of
      its brand, region, language, directive-count, honesty, and secret checks:
      formatter clean when rustfmt exists (an honest skip when it does not), no
      string-shaped errors regressing into `api/`, and runtime state (demo
      signing secret, mutable SEP-6 record store) never tracked.
- [x] **The zkVM section names the machinery it lacks** (`docs/PROVING_SYSTEM.md`
      §7): a wide execution trace with one column per register, bus and flag,
      per-row transition constraints tying row *i* to row *i+1*, boundary
      conditions anchoring first and last rows to the claimed input and output,
      and a memory-consistency argument built from a committed memory
      transcript with constrained read/write lookups. Described as a design
      pattern, with no borrowed name, because the section's point is that the
      gap is understood rather than merely admitted.
- [x] README explains machine approval from first principles and draws the
      honest boundary around the VM claim: what a VM proof needs (trace columns,
      transition constraints, a memory argument, a program commitment), which of
      those the repository now has and in what shape, and which part of the
      machine is a budget rather than a general-purpose design. The boundary
      moved with the artifact rather than ahead of it — see §11.2.
- [x] **The ZK lane is no longer a single fixed statement.** A second circuit,
      `circuits/step_chain_statement.circom`, proves an **N-step chained state
      transition**: `state_root_0 → … → state_root_3`, every link derived from
      the previous root and that step's own evidence digest. 2259 non-linear and
      2784 linear constraints (was 628), six public inputs, its own domain tag
      (`lumen-gate-step-chain-v1`, a different label from the single statement
      and the BLS hash-to-curve path), and no `signal output` so the public
      vector cannot grow a silent extra element. The old circuits are untouched
      and still build and verify.
- [x] **Constraint-level hardening, not witness-side convention.** Every signal
      is boolean-forced, equated to an expression of other signals, or bound to a
      public input; `is_active` gates the count *and* leaves the root unchanged
      on a padded step; `chain_length` is range-checked with bits and required to
      equal the sum of `is_active`; zero/inequality checks use the circomlib
      inverse-witness components rather than a reinvented comparison; every
      public input appears in at least one constraint. The list is in the
      circuit header, signal by signal.
- [x] **One negative test per constraint family, not one byte flip**:
      `tools/step-chain-tests.mjs` runs 18 checks against the compiled witness
      generator — non-boolean activity, non-boolean approvals, an active step
      without a quorum, activating a padded step, a length mismatch, a zero-length
      chain, a length above capacity, a lowered threshold, a wrong domain tag,
      wrong end/start/event roots, a forged intermediate root, and the degenerate
      unmoving chain — each requiring its own refusal, plus a positive check that
      padded approvals really do not reach the digest.
- [x] **The second lane is live on testnet, on a registry of its own.** The
      earlier registry's admin was renounced before this lane existed and a
      renounced admin cannot set a key, so the lane was deployed beside it rather
      than by weakening it: `CCR3NZD5ASZAC3RPHDJOVSHWZBIF46ELP3JGWFC37ZL65YZ443ULZLMM`.
      `tools/step-chain-live.js` reports **12/12**: key accepted at 896 bytes, a
      3-step chain accepted (`2269641a…`, event `step_chain_verified`),
      wrong-length key refused with the stored key unchanged, swapped roots
      refused `#5`, lowered quorum refused `#5`, 255-byte proof refused `#8`,
      replay refused `#9`, the settlement anchor unmoved, the domain still not
      active on the strength of a quorum proof, then renounce and a second key
      write that traps. Recorded in `deployments/step-chain.json`.
- [x] **Explicit size bounds on the decode path.** The step-chain key length
      (896 = 64 + 3×128 + 7×64), the proof length (256), the public-input count
      (6) and the payload length (112) are each checked before any decoding, and
      a proof one byte short and one byte long are both refused with `InvalidProof`
      rather than sliced into coordinates. The two lanes keep their keys in
      separate slots with separate length rules, so neither can borrow the other's.
- [x] **The chained lane cannot influence settlement**, and the live record
      proves it rather than asserting it: an accepted chain does not move
      `last_root` or `last_event_root`, does not mark the domain active, and is
      stored in its own slot. A quorum proof is not a signature proof, so it does
      not get to move the anchor settlement reads.
- [x] **The exit into a local currency runs through a real SEP-6 anchor.** New
      `anchor/cashout-client.js` (SEP-1 discovery, SEP-10 auth, a firm SEP-38
      quote, SEP-6 withdrawal, a memo-bearing USDC payment, polled to a terminal
      status) and six new facade routes behind `api/cashout.js`. Live:
      `deployments/cashout-quote.json` (0.5 USDC → `completed`, 24.27 out, reference
      `FAST-0UDDCJJKSY`) and `deployments/cashout-live.json`, which drives the same
      exit **through the facade** in 8/8 checks, including two refusals: no
      session → 401, and the operator token is not a substitute for the user.
- [x] **The wSRC→USDC step is honest about itself.** `bridgeToUsdc()` asks
      Horizon for a real `pathPaymentStrictSend` route; there is none on Testnet
      in either direction (checked live, and `GET /v1/cashout/bridge` reports the
      pair it looked up). With no market to trade against, the fallback is a
      counterparty exchange at a configured rate, opt-in, memo-tagged on both
      legs, and described as a simplification in the README rather than as a DEX.
- [x] **User-initiated actions without the operator token**: `POST /v1/user/lock`
      and `POST /v1/user/relay` accept the deployment's own SEP-10 session. The
      lock's recipient is forced to the session account (a caller-supplied
      recipient is ignored — verified live), the relay is opt-in with a
      per-account cooldown, and neither grants mint authority: the relayer still
      signs and pays and the registry still decides what is final.
- [x] **SEP-1 documentation fields completed** (`ORG_OFFICIAL_EMAIL`,
      `ORG_SUPPORT_EMAIL`, `ORG_LOGO`, `ACCOUNTS_REQUIRE_MEMO`) and the logo URL
      is actually served (`GET /v1/logo.png`), because a discovery field that
      points at a 404 is a field that lies. `TRANSFER_SERVER_SEP0024`,
      `KYC_SERVER`, `DIRECT_PAYMENT_SERVER` and `ANCHOR_QUOTE_SERVER` stay absent
      with a comment saying why: those roles are not implemented, and discovery
      fields are acted on without asking.
- [x] **The fee wording states the mechanism and refuses to imply a price**: the
      relayer fronts its own XLM at submission, is repaid from the locked
      source-chain amount in the wrapped asset, the current `0.1 wSRC` is a fixed
      constant chosen at submission time, and there is **no real-time pricing**
      anywhere — no feed, no spread, no repricing. README says which part is
      missing (market pricing) instead of describing the constant as a market.
- [x] `cargo test --workspace` → **59 passed** (25 registry, 11 gateway, 3
      simulator, 20 adapter); README states the same number. The circuit suite is
      separate and needs no network: 18 checks from `tools/step-chain-tests.mjs`.

- [x] **The last-word control now covers commit messages, not only files.**
      `scripts/repo-gate.sh` scans every commit reachable from `HEAD` for the
      retired name. Exactly one occurrence exists: `cf8127db`, authored before
      this rule was applied. It is recorded as a known exception rather than
      silently tolerated, because removing a word from the message of a commit
      that other clones already have means rewriting the history of a shared
      branch — and that breaks every parallel session working on it. The check
      is therefore "no commit other than the recorded pre-rule one", which fails
      the moment a new one appears, and it says so in its own output rather than
      reporting a clean history it does not have.
- [x] Project name is Lumen Gate everywhere; the retired brand name appears in
      no tracked file, and that is machine-checked.
- [x] Single directive file (this document), English only, no country or region
      references, no localised documents. Enforced by `scripts/repo-gate.sh` and
      the CI workflow on every push.
- [x] Reference patterns adopted as this project's own code
      (`crates/domain_adapter`): adapter interface with raw evidence in and an
      attestation out, security-backing descriptor, no assume-valid branch,
      content-derived message ids, per-direction nonce high-water marks.
- [x] `cargo test --workspace` → 59 passed (25 registry, 11 gateway, 3
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
- [x] Shared skill library vendored under `skills/` (Apache-2.0 dev skills for
      contracts, cross-chain, zk, standards, dapp, assets, data; MIT review
      skills), indexed in `skills/README.md` with attribution in
      `skills/NOTICE.md`, so every agent on this repo works from the same
      reference material. Directive Section 0 precedence stated there.
- [x] SEP-10 hardened per the standards skill: signature verification now
      reads the client account's signer record from Horizon and requires the
      collected weight to meet the account's medium threshold; unfunded
      accounts keep the spec's master-key fallback, Horizon unavailability
      refuses loudly, and the method used is returned in the response.
      Verified live on testnet (threshold path with a real funded account,
      master-key path with an unfunded one, wrong signer refused) and
      mechanically by `tools/check-sep10.js`, whose second case is the
      below-threshold master-key signature the previous verifier accepted.
- [x] The self-audit loop asks twelve questions; question 12 runs
      `tools/check-sep10.js` as `sep10_weight_verification`.
- [x] CI is strict and green-shaped. The `tests` job keeps the toolchain
      action's implicit `-D warnings` (dead code is a CI error, not a
      suggestion) and adds `cargo clippy --workspace --all-targets
      -- -D warnings`; the one suppression is `#![allow(deprecated)]` at both
      contract roots, reasoned at the site, for the event-publisher migration
      that belongs to a coordinated redeploy (listed below, not hidden). The
      `contracts` job no longer runs a bare `cargo build` for wasm, which can
      never pass: soroban-sdk 28's build script looks for a marker that only
      `stellar contract build` exports, so the job installs the CLI pinned to
      the SDK's release line (v28.0.0) and builds with it; a rebuild from
      current source reproduces the gateway at the deployed `wasm_bytes`
      (18,303). The `surface` job was red since its first run for an
      instructive reason: `GITHUB_ENV` does not reach a process started in the
      same step, so the facade booted without its SEP-10 key and answered
      every route `not_configured`; the key and public URL are now inlined on
      the server command, and the probe passes 27/27 against exactly the CI
      invocation (verified locally on 127.0.0.1, the origin that previously
      failed).
- [x] The cash-out path keeps its function and loses its geography. The
      exit client had inherited the counterparty anchor's region: a
      hard-coded fiat identifier, `TR_*` environment names, and a file named
      for it. The client is now `anchor/cashout-client.js`, discovers the
      SEP-38 buy assets from the anchor's own `/info` list (override:
      `CASHOUT_QUOTE_ASSET`) instead of naming a currency, and refuses
      honestly when nothing is quotable; verified live - the discovery path
      reproduces the committed receipt's 24.27-unit quote against the testnet
      anchor. The gate gained the patterns that missed it (`\bTRY\b`, the
      env prefix, the old slugs), canaried by planting and removing a
      violation, and gained a written exclusion: recorded third-party
      responses in `deployments/` stay byte-exact because a tidied receipt is
      not a receipt.
- [x] The relayer reads what it declares. The BLS lane cross-checks the
      signed payload against the block it is about to attest - equal height,
      state root and event root - before spending gas on submission, and the
      ZK lane is exempt with a stated reason because its payload commits to a
      different relation; a mismatched envelope is refused with a print, not
      silently paid for. Manifest resolution is now uniform: RPC URL falls
      back to `deployments/testnet.json`, and so does the relayer fee
      recipient (`accounts.relayer_only`), which was the one place the
      placeholder address could still win; a live run whose `STELLAR_NETWORK`
      disagrees with the manifest's network aborts before signing.

- [x] Console burn path submits the bytes Freighter signed. The prepared
      transaction was being sent unsigned after a successful signature, so
      every outbound burn failed with `tx_bad_auth`; the signed XDR now goes
      through `submitSoroban`, a refused submission surfaces its reason, and a
      Freighter refusal in the newer `{ error }` shape is reported as a
      refusal instead of rendering `undefined` as the connected address. An
      advisory `getNetwork()` check warns when the wallet is not on Testnet
      before the first signature is asked for.
- [x] Homepage re-composed on one design system: every text block sits on its
      own black strip with the lattice - and the pointer frame - living in the
      gaps; the header is reduced to the small corner mark on no background;
      the header's pill navigation moved to the footer as plain backgroundless
      buttons; the submitted banner artwork is embedded byte for byte at the
      centre of the hero (`frontend/public/lumen-gate-banner.png`, pinned by
      check-console like the other four assets); `image-rendering: pixelated`
      is scoped back to the tile so glyphs render smooth; the lattice frame
      glides between cubes instead of teleporting; the registry stat writes
      the contract id in full.
- [x] Trust model visible without knowing any URL: a panel on the homepage
      writes both `renounce_admin` transaction hashes in full (registry and
      gateway) with explorer links, read from the shipped deployment manifest
      so it works even with no API layer; a self-audit badge shows the latest
      result with a relative timestamp and refreshes on a timer; the BLS lane
      and the Groth16 quorum-statement lane carry distinct permanent labels,
      and the receipts table badges which method verified which receipt,
      including both lanes' acceptance of height 91.
- [x] Review polish: Stellar's seven-decimal amounts render rounded on the
      face of the page with the exact value on the cell's title; every async
      button parks in a visible pending state while it waits; disabled
      capability buttons carry their reason in the note underneath and on the
      control's own title attribute.

- [x] The lattice is a coded wall, not a wallpaper: every cube is its own
      element painted from the submitted tile at the tile's own size, and the
      4px white frame is each cube's own :hover state - it appears exactly
      while the pointer is over that cube and closes when it leaves. Density
      modes are retired: 1:1 (one asset pixel per screen pixel) is the only
      mode, so the footer switch is gone. `tools/check-grid-fx.js` was
      rewritten around the new contract: body must NOT paint the tile, the
      per-cube hover frame is pinned byte-level, and buildLattice() is driven
      under synthetic viewports (308 cubes at 1280x800 dpr 1, exact coverage
      at dpr 2, no pointless rebuild).
- [x] The section navigation is a fixed dock at the bottom of the screen
      (backgroundless text buttons inside one frosted pill), and the text
      sections are full-bleed black strips that hug their content with every
      grid top-aligned.
- [x] Wallet connection is proven, not asserted: `tools/check-wallet-connect.js`
      boots the real app.js against a stub DOM built from the real markup,
      clicks the real connect button with a Freighter-shaped stub and asserts
      the whole connected state (green network pill, address on the chip,
      rounded balances with exact titles, full renounce hashes, live audit
      badge), plus the refusal and no-extension paths.

**This round: the execution lane — a bounded machine, proved step by step.**

- [x] `crates/execution_vm`: an eleven-opcode register machine — halt, add, sub,
      mul, eq, lt, jmp, jnz, load (immediate or memory form), store, assert — on
      wrapping 64-bit words, eight registers with r0 pinned to zero, sixteen
      memory words, a sixteen-instruction program and a twenty-row step budget.
      The trace is a table (twenty rows by twenty-three columns), not a list, and
      `check_trace` re-checks every row against the semantics: no partial rows,
      an operand is read rather than chosen, memory is carried rather than
      logged, and each row's cost is a function of the instruction that ran.
      28 tests.
- [x] `circuits/execution_trace.circom`, `ExecutionTrace(20,16,16,8)`: **9996
      non-linear and 2694 linear constraints**, 22 public inputs, verification
      key **1920 bytes**, proof 256 bytes, payload 232 bytes. The guest program
      is the public input, not baked into the key: each row's decode is one
      linear equation against the word its program counter selects, with the
      opcode pinned by a selector one-hot, the indices by their own one-hots and
      the immediate by a 32-bit decomposition. Own domain tag
      `lumen-gate-execution-v1` (`00cf562c…7db4`).
- [x] **The four things the directive said a VM proof needs are installed**:
      an instruction set with semantics; a commitment to the guest program (the
      packed words, bound on-chain to a sha256 program digest); a memory model
      (sixteen carried words, `mem[i+1] = mem[i] + store_gate·(written − mem[i])`
      from zero, read through a gated one-hot, so a read returns what the state
      carried in); and a witness generator that replays the execution (the
      interpreter's own trace, padded and re-checked before it becomes witness
      data). Section 11.2 of this directive is updated accordingly.
- [x] **Live on testnet**: fresh registry
      `CAQ77OEKCHLLCE36MOHY6NO3YJU45FTRLY73REQW4DI5TQMFMZZ5G6LK`, 1920-byte key
      accepted in its own slot, and a 16-step run of a twelve-instruction
      program accepted in transaction `70cb914a…` (ledger 4,765,687, **206,052
      stroops**): 16 steps of 20 rows, 25 gas, final pc 12, program digest
      `725aa389…`. Refusals recorded in the same run: a different program under
      the same proof (#5), a rewritten step count (#5), an instruction hidden
      past the end of the code (#6), a one-byte-short proof (#8), a proof with
      its group elements moved (#8), a one-byte-short payload (#11), a replayed
      evidence (#9), and a post-renounce key replacement (trapped, key
      unchanged). **14/14**, record in `deployments/execution-lane.json`.
- [x] **`tools/execution-trace-tests.mjs`: 34 checks, one per constraint
      family**, and the harness now requires each mutation to be refused *at the
      constraint it targets* — the refusal is matched against the pinned source
      line, so a mutation that trips a different constraint no longer reads as
      coverage. Five more checks are programs the machine itself refuses (an
      assertion on a zero operand, a step overrun, an address past the address
      space, an instruction outside the subset, a program longer than the
      committed slots), because a refusal is not a run.
- [x] `circuits/build.sh` carries `execution_trace`, and the r1cs reproduces
      byte for byte (`sha256` unchanged) from that script alone.
      `circuits/setup.sh` now derives the powers-of-tau size from the circuit's
      own constraint count, with a floor of 2^13 so the three earlier lanes keep
      the keys their deployments were made with.
- [x] **The gate-vm lane, live**: `crates/gate_vm` (field-native 8-register
      machine, in-circuit Poseidon opcode, witness emitter),
      `circuits/gate_vm.circom` (5109 non-linear / 5075 linear constraints,
      fold-committed program, window-as-gas, circuit-counted hash steps), the
      registry's fourth slot (`set_gate_vm_vk` / `submit_gate_vm_zk`, 896-byte
      key, six bound publics) and `tools/gate-vm-lane-live.js` — 14/14 probes
      on testnet, honest accept at ledger 4,765,859 for 177,143 stroops,
      recorded in `deployments/gate-vm-lane.json`.
- [x] **Poseidon calibrated four ways, not trusted**: the Rust port, the
      generated constants, a probe circuit compiled against the same pinned
      circomlib, and committed golden fixtures the test suite replays — the
      mechanism that makes "a hand-ported hash that silently differs"
      unreachable at build time rather than at audit time.
- [x] `circuits/build.sh` all-targets mode compiles every listed circuit again:
      the quarantined fixture's duplicated-`IsZero` and non-quadratic lines were
      pre-existing breakage from the 2.2.3 transition, fixed semantically
      intact, and the workspace now passes `cargo clippy --all-targets
      -- -D warnings` with the two trivial sibling-crate lints swept.
- [x] **The hero banner is the operator's own file, byte for byte.** The
      submitted 1500×500 PNG replaced the previous banner in the page and in
      `frontend/public/` (sha256 `27756e19…4549`, 10,308 bytes), and the page's
      embedded copy is regenerated from that file rather than retyped — the
      proof tool compares the two and reports `5/5 embedded assets verified`.
      Rendered and read back in a real browser: the image resolves at its own
      aspect, 560×187 on a 1440×900 viewport, and does not resample; the
      full-bleed lattice behind it stays interactive. No generated artwork
      anywhere, per the standing rule that the operator's pixels are the
      design.
- [x] **The design record lives in the product, not in a picture folder.**
      Screenshots were committed for one round and then removed: a screenshot is
      a claim that goes stale, and the operator's standing rule is that the
      interface is code, so a picture of it is the weakest possible evidence.
      The About section now carries an **interface panel** that renders the
      three claims from the page as it loads - it counts and measures the
      strips (13 on this page, 30px of open lattice between neighbours, no
      horizontal overflow), it draws six real cubes from the submitted tile at
      the tile's own 60px so the pointer can raise the 4px ring on one of them,
      and it builds the disabled-control table from the DOM, reasons included.
      Both browser harnesses assert the panel's numbers against the page's own
      measurements, so it cannot describe a page that is not there.
- [x] **The first screen is a wordmark, one sentence and two buttons.** The
      hero carries no strip, the wallet band starts directly under it and its top
      edge lands inside the first viewport, and the explanation blocks that used
      to sit between the two (who signs / who pays / who can change the rules,
      and the four counters) became ordinary rows of the settlement strip below
      the wallet. The version number moved to the end of the page as its own
      roadmap strip: **1.0** is this repository, **2.0** is a separate system
      whose design is not written yet, and its button is disabled with its reason
      stated rather than teasing a reader before they have read anything. The
      first screen also gained a header CTA, so the wallet is one click away from
      every scroll position instead of only from the hero.
- [x] **The strips hug their text.** The operator's complaint was measurable:
      20-30px of band padding above and below every row, which reads as space
      between the text and its own strip. It is 13-18px now, the air between rows
      comes from the row gap where the lattice shows, and the page harness fails
      if any band pads more than 24px - a spacing rule that is checked rather
      than eyeballed.
- [x] **The lattice thinned out where it was costing the most.** One element per
      pitch instead of one per tile: the tile stays 60x60 and never resampled,
      but the pitch opens with the screen (phone 1 tile, laptop 2, wide display
      4). A 1920x1080 screen went from 576 cubes to **40**, and the harness
      asserts the count, the tokens and that a rebuild only happens when the
      screen really changed.
- [x] **The wallet connects for both shapes a real extension answers in, and it
      can be read with no extension at all.** Freighter's newer builds resolve
      `requestAccess()` with an address, older ones answer `getPublicKey()` with
      the string; the harness now proves both, in the real module, rather than
      asserting one. The card also offers *View the demo account*: the manifest's
      gasless recipient read straight from Horizon, signed by nobody, labelled
      read-only in the chip and in the note, with burning still routed through the
      connect path because signing needs a wallet.
- [x] **Amounts are typed in human units.** `13.7`, not `137000000`, with the
      base-unit integer stated underneath as what goes on the wire. The
      conversion is string arithmetic, not `* 1e7`, because that multiplication
      is wrong in binary floating point (`13.7 * 1e7` = `136999999.99`) and the
      error would only surface on some amounts. Two decimals place too many is
      refused with a reason.
- [x] **Three button weights, so the demo path and the operator shelf are not
      the same colour.** `primary` = the next step of the demo; a plain button =
      a real but optional action; `.mini` = housekeeping (copy a command, set a
      token, fill a field). The cash-out panel split its voices too: a sentence
      for the user at the top, and the engineering honesty inside a labelled
      *Operating detail* disclosure, so one paragraph is never addressed to two
      readers at once.
- [x] **Tab labels stay on one line at every width.** Shortened to
      `Receive · mint` / `Send back · burn` / `Cash out` with `white-space:
      nowrap`, measured in a 390px viewport: three labels, one line each, no
      clipping, no horizontal page overflow.
- [x] **The hero is the one row on the page with no strip, and the page
      announces which system it is.** The operator asked for the first area to
      carry no black band, for the wallet to sit under it, and for two buttons
      under the banner: **1.0**, which is this repository's system, and **2.0**,
      a separate system whose design has not been written yet and whose button
      therefore states that instead of pretending to be a door. The hero panel
      is now transparent - the lattice reads through it, which is the honest
      version of the same contrast - and the version switch sits directly under
      the wordmark. The wallet band moved above the settlement explanation to
      sit under the hero, and the dock navigation was reordered to match the
      page rather than the page matching the dock.
- [x] **Two defects the hero round surfaced, both fixed rather than worked
      around.** The first: the fixed navigation pill floats over the bottom of
      the viewport, so a control that a scroll leaves in that band takes the
      click and does nothing - the exact shape of the "the wallet buttons do not
      work" report, found this time by the harness itself. The page now declares
      `scroll-padding-bottom` so nothing is scrolled to rest inside the dock's
      band. The second: the click-through only counted a click as observed if a
      log line, note or disabled flag moved inside its snapshot window, so a
      control whose work is a network round trip looked dead while it was still
      working. The harness now counts "the control says it is working" as
      observable work as well, and it clicks the way a person does - it brings
      the control to the middle of the screen and asserts that the control,
      not an overlay, is the topmost element under its own centre.
- [x] **The click-through runs against the live deployment, and it does not
      guess when the page is ready.** Both browser harnesses take a URL; run
      against the deployed console, the page check passes and the action check
      passes three times in a row - 29 controls, every one with a consequence,
      four disabled controls each stating its reason. The first production run
      failed, and the reason is worth keeping: the harness waited for markup
      instead of for the boot sequence, so a click landed before `wire()` had
      run and every button looked dead. A false "dead button" report is worse
      than no report, so the page now sets a boot beacon when it has finished
      wiring and the harness accepts the beacon or, for any build that predates
      it, the network pill leaving its "connecting" state.
- [x] **Every control was clicked, in a browser, and the silent ones were
      fixed.** The operator's sentence - "the wallet buttons don't work, test
      the whole system and the screen" - is answerable now: 29 controls clicked
      in a real browser, each asserted to have an observable consequence (a log
      line, a note that changed, a pane that switched, a dialog that opened, a
      table that refreshed), and every disabled control held to a stated
      reason. The first pass found two silent grey buttons - "Pay with
      Freighter" and "Check status" were disabled with nothing anywhere saying
      why - and two more that carried a tooltip but pointed at no note. One
      table (`DISABLED_REASONS`) now paints the note and the title together, so
      the two cannot drift, and `tools/check-console.js` fails the build if a
      button the code disables is missing from it.
- [x] **Text sits on line strips, not on painted sections.** The last round's
      correction, finally executed: a section no longer paints a block. Each
      row of text carries its own full-bleed strip (infinite sideways, hairline
      top and bottom, ink padded back to the shell measure so rows still line
      up across strips), and the lattice shows in the gap between one strip and
      the next. Measured, not asserted: twelve strips, every one edge to edge,
      every pair 30px apart at 1440, no horizontal scrollbar at 1440 / 768 /
      390 / 360.
- [x] **The pointer frame was a claim with no behaviour, and that is fixed.**
      The frame was written as a `:hover` state on the cube while the lattice
      is painted at `z-index: -1` - so every wrapper above it won the hit test
      and the frame never appeared on the live page, through three rounds of
      documentation that said it did. It is painted by pointer tracking now,
      with the covering surfaces named in `LATTICE_BLOCKERS`, and it is checked
      at two levels: `tools/check-grid-fx.js` drives the hit-test logic against
      synthetic stacks (card, band, header, boundary and strip all hide it; a
      cube in an open gap is the only one framed; exactly one at a time; it
      closes on pointerleave and on scroll), and the new
      `tools/check-live-page.js` drives the real page in a real browser.
- [x] **The browser harness is committed, and it skips honestly.** Without
      puppeteer installed it prints `[skip]` and exits 0 rather than passing by
      default; with a dev server and a browser it asserts the strips, the
      frame, the banner's own aspect, that every control is reachable (nothing
      covered by an overlay) and that the page makes no failing request. First
      green run on the round's work: *12 strips full-bleed with 30px of open
      lattice between them, frame follows the pointer in the gaps and nowhere
      else, banner 1500x500 drawn 560x187, 25 controls all reachable, 0 failing
      requests.* It is deliberately outside the gate and CI: a check that needs
      a browser must not make CI depend on one.
- [x] **A real browser harness exists for this repository now**
      (headless Chromium, driven outside the sandbox and not committed): it
      boots the actual page with the API layer running, screenshots desktop and
      mobile, enumerates every control with its disabled state, and reports
      every non-2xx response. First full pass: 25 controls enumerated, the
      network pill green on a live ledger, one 500 from `/api/finality` — which
      is this sandbox missing the root `node_modules` the function requires,
      not a defect in the handler — and no other failed request.

### Still missing (stated, not hidden)

- [ ] Production validator set: the BLS lane runs 3 demo keys with a threshold
      of 2, unbonded. Real DKG and a slashable set are roadmap, and the adapter
      descriptor says so in its own `not_claimed` list.
- [ ] **Signatures inside the circuit.** The settlement and chained lanes prove a
      quorum of approval *bits*; no lane verifies a signature. The chained lane carries the
      quorum step by step and binds each step's evidence into the state it
      produces, but a production chain puts a signature gadget inside the
      circuit — that is the next step, not a relabelling of this one.
- [ ] **Chain continuity across accepted proofs.** A chained proof carries
      `chain_start_root` as a public input bound to the payload; the registry
      enforces a forward-only height trail, but it does not yet *prove* that a
      new chain starts at the previously accepted root. Closing that means
      committing to the previous root inside the circuit.
- [ ] **A per-domain quorum for the chained lane.** Its threshold is the
      constant compiled into the circuit (2) and the contract binds the public
      input to that same constant, so neither a prover nor an operator can choose
      it. Moving it to a per-domain policy without weakening the binding means
      committing to the threshold inside the circuit rather than trusting a
      storage read.
- [ ] **The execution lane's end state is not anchored.** The registry records
      a run in its own slot — program digest, instruction count, step count,
      gas, final program counter, end register root — and writes
      `settlement_anchored: false`. An execution proof therefore establishes
      that a run happened as stated; it does not move the root that minting
      reads. Wiring the two is a contract change with a policy question attached
      (which programs may move the anchor, and who may submit them), and it has
      not been made.
- [ ] **The machine has a budget, not a machine model.** Twenty rows per proof,
      sixteen instructions per program, sixteen memory words, eight registers,
      no syscalls, no unbounded execution — a program that needs a twenty-first
      step has no proof in this circuit, and the registry refuses a payload that
      claims one. Raising the budget is a parameter change plus a larger
      ceremony. There is also no compiler: guests are assembled from a short
      text listing, not compiled from a high-level language.
- [ ] **A market for the exit bridge.** The wSRC→USDC swap falls back to a
      counterparty exchange at a configured rate because no order book route
      exists on Testnet in either direction. On a network with a market the same
      function takes the order-book branch; until then the simplification is
      written down rather than hidden.
- [ ] **A production anchor.** The exit integrates with a Testnet sandbox
      anchor whose bank and KYC are simulated by the anchor itself. Moving to a
      real one is a home-domain and network change, but it is not this
      deployment's decision to make, and the README does not pretend it already
      happened.
- [ ] Market-priced fees. The relayer fee is a fixed 0.1 wSRC chosen at
      submission time, not derived from the live XLM fee and a rate. The
      mechanism is proven; the pricing is not built.
- [ ] Bonds, slashing, validator rotation, fraud proofs.
- [ ] SEP-24 hosted flow and SEP-12 KYC. Marked `not_implemented` where a client
      would look for them.
- [ ] Event-format migration debt: both contracts publish through the
      publisher SDK 28 deprecates, because the relayer decodes Burn payloads
      from the exact legacy topics. Moving to the event macros changes the
      on-chain topic layout and must land together with a relayer decoder
      change and a redeploy; until then the crate-root `allow(deprecated)`
      stands, and nothing else may lean on it as precedent.
- [ ] Relayer liveness: one operator runs it. It is not a trusted party in the
      mint decision, but it is a liveness dependency.
- [ ] The recorded settlement receipts were re-verified against Horizon this
      session rather than regenerated, because the relayer's signing key is
      deliberately not in the repository. Re-running a fresh end-to-end mint
      requires the operator's key; the audit loop's own evidence submissions do
      run live with a throwaway funded account.

---

## 4. Hardening backlog (priority order this round)

- [x] **Session close (this round).** Merged showcase registry live and
      frozen (`CBND4C3E…`, receipts in `deployments/merged-registry.json`,
      audit check 14 watching it: 20 rounds of history, latest 14/14);
      gate-vm core split with 32-line sibling proven through ceremony and
      verified Groth16 (`wchk` + snarkjs OK, five artifacts committed under
      `deployments/vectors/gate_vm32/`, end-root invariance across both
      compilations pinned); phase-1 import wired with filename-keyed pins and
      the bucket-outage discovery documented as the reason `local` remains the
      honest default; signature-gadget cost measured (8,086 constraints for a
      full EdDSA verifier — budget closed as objection, pairing library is
      the standing gap); console gained the fetch-nothing receipts card and
      the three-bounds honesty entry. Next up, in order: (1) registry slot +
      ceilings for the 32-line lane on a fresh registry — vectors are ready,
      contract needs the setter; (2) merged-registry becomes the audit loop's
      primary target once the fifth slot exists; (3) guest-compiler and
      memory-bus items remain undelivered and remain written down as such.

### 4.0 Decisions taken this session (the operator answered; execute in order)

- [x] **Merged live registry.** One fresh registry carrying all lane slots
      (settlement vk, step-chain, execution, gate-vm — and later the 32-line
      gate-vm key once it exists): bootstrap, probe every lane against it, then
      renounce. The per-lane registries stay as historical records; the merged
      one becomes the showcase. `tools/merge-lanes-live.js` is the intended
      vehicle, mirroring the per-lane live tools.
      **Result:** live on `CBND4C3E…` — three full per-lane suites (11 step-
      chain, 13 execution, 13 gate-vm checks) run *unmodified against the one
      registry* with renounce deferred, the settlement slot installed from the
      live showcase registry's own served bytes, four slots proven distinct and
      byte-exact (the two 896s side by side), one renounce then freezing the
      union with every setter contract-refused after. Receipt
      `deployments/merged-registry.json`; audit check 14 re-proves it every
      round (first round after landing: 14/14, round 19). The first attempt —
      registry `CBVB2PCB…`, every lane check equally passed, equally frozen —
      is recorded as superseded by an aggregator bug in the *reader*, not the
      flow: the receipt of a run may not depend on the reader's luck. The
      per-lane registries are re-labelled historical in `testnet.json`; the
      merged one is now the showcase. The gate-vm32 slot joins when its
      ceremony and committed vectors land; no contract edit was needed to merge
      four lanes — the fifth needs the setter, which is exactly why the 32-row
      vectors and the merged registry were sequenced this way.
- [x] **Signature-gadget feasibility prototype.** A small circom experiment that
      *measures* — not imagines — what one BLS-style scalar-multiplication /
      pairing check costs inside a BN254 circuit: constraint counts for the
      field-op ladder, a budget verdict against the 64 KB wasm / 10^8-instruction
      host model, and the report committed beside the fixture. The docs' "next
      piece of work" sentence gets a number or a stop-sign, never a hope.
      **Result:** `circuits/signature_gadget_probe.circom` compiles circomlib's
      full `EdDSAPoseidonVerifier` at **7,383 + 703 = 8,086 constraints**; the
      verdict is in PROVING_SYSTEM §5e — budget is off the list of objections,
      the real gap is a pairing/field-arithmetic library, which the pinned npm
      cut of circomlib does not ship (its `bigint/` and `secp256k1/` dirs are
      GitHub-only). The pairing half of the brief could not be measured without
      vendoring a new dependency; that is recorded as the stop-sign it is,
      and the probe names itself as not-a-lane in its own header.
- [x] **32-row gate-vm variant.** `GateVm(K,T,R)` becomes a parameterised core
      with two thin mains: `gate_vm.circom` (8/8/8, unchanged — its vectors,
      live key and audit readback keep their bytes) and `gate_vm32.circom`
      (32-line programs, 32-row windows, 5-bit pc). New ceremony size derived
      from the r1cs, new committed vectors, new payload ceilings. Both sizes are
      documented as one machine with two compilations, not as two machines.
      **Result:** core split landed with byte-identical 8/8/8 constraint counts
      (5109/5075 — the live lane's numbers, untouched); pc width derived from
      K, not written down; gate_vm32 compiles at 22861/21779 (4.38x — linear
      growth, the window-as-gas claim visible in build reports); the crate grew
      `SUPPORTED_SHAPES` + `assemble_len` + `run()` shape refusal, 20/20 tests
      including the padded-commit property (output invariant under padding,
      program root not) and refusal of uncompiled shapes; snarkjs `wchk` passes
      the 32-row witness against the 32-row r1cs. The ceremony size derives to
      2^16 and runs; committed 32-row vectors and registry ceilings ride the
      merged-registry item, which is where a new slot gets probed anyway.
- [x] **Public phase-1 import.** `circuits/setup.sh` accepts
      `PTAU_SOURCE=phase1`: it downloads the published powers-of-tau for the
      needed power, checks it against the sha256 pinned in this repository, and
      runs the lane's setup against that file instead of a locally minted one.
      The "who knows the toxic waste" paragraph in DEVELOPMENT_FIXTURE narrows
      honestly: for the zkey, still one contribution here; for phase1, the
      published ceremony's transcript, verifiable by anyone who re-downloads.
      No lane artifact is re-minted silently: regeneration of a lane's vk is an
      explicit, committed event, and until a merged registry exists, live slots
      keep the keys they were deployed with.
      **Result:** mechanism landed — `PTAU_SOURCE=local|phase1|file:<path>` in
      `setup.sh`, chain verified with `powersoftau verify`, pins keyed by
      filename in `circuits/PTAU_SHA256` (its header documents what a pin
      means and what it does not). Live slots untouched, no vk re-minted.
      Discovery on record: both public buckets the snarkjs README names are
      anonymous-GET AccessDenied as of 2026-09-14 (upstream issue #636, open)
      — the import path exists, the public copy it would import is currently
      unreachable, and the docs say exactly that instead of pretending either
      half away. `file:` mode proven end-to-end against a supplied transcript
      (verify + pin + groth16 setup + prove all ran on it).
- [x] **Read-only status surface.** The console gains one card fed exclusively
      from `deployments/*.json` (lane list, last audit round N/N with its
      timestamp, each live lane's ledger + fee): no signer, no new endpoint, no
      write path. The sibling agents own the surrounding UI; this card reads
      the records, it does not touch the lattice.
      **Result:** the card exists and the acceptance wording holds exactly: no
      new endpoint was needed because the existing build-time sync
      (`tools/sync-frontend-deployment.mjs`) now embeds a `lanes` block generated
      from the six receipts in deployments/, and the card renders from that
      module only — an outage cannot change it, a live answer cannot flatter
      it. Rows: last audit round (20, 14/14, timestamped), the merged showcase
      with its per-suite counts, and each live lane with its registry link,
      acceptance-tx link, ledger and fee — parsed from what the audit loop
      itself read from Horizon, never recomputed here. Where a receipt is
      silent the card shows an em-dash and says that null is not zero.
      `check-console.js` still passes; `--check` keeps the module from
      drifting, so the card cannot lag the receipts unnoticed.
- [x] **One 'is it a zkVM?' card.** The README's honest one-liner gets its
      interface counterpart: four lanes, two machines, and the three bounds
      (window, ceremony, anchor) in the same breath the card makes the claim.
      **Result:** the console's honesty panel now makes the claim and the three
      bounds in one entry — two machines, two statements, window-as-gas
      spelled out for both machines, the ceremony bound told with the
      AccessDenied fact rather than a euphemism, and the anchor bound kept —
      and the panel's stale wording ("one bounded machine") died with it.
      `tools/check-console.js` passes on the changed page.

### 4.0b The relayer question and the one-signer proposal (operator's round, answered)

Six answers were given and are being executed on: permissionless submission
is demonstrated to the fullest scope (the operator's word was 'everything necessary' — the stranger's
live acceptance on the five-slot showcase, docs/BRIDGE_TRUST_MODEL.md §1;
the user-side `finalize_inbound` leg is wallet-direct in the code today),
gasless stays as a named fee-service and nothing more, the outbound
Stellar-history direction gets the feasibility treatment (measured floors:
SHA-256 block 59,313+3,215 via `circuits/sha256_block_probe.circom`; full
EdDSA verifier 8,086 via the §5e probe; ed25519/BLS rows estimated and
flagged as such), the light-client goal is the declared path (§4.0c phases),
the showcase registry is v2 with all five slots, and every new claim in the
README carries its bound in the same sentence.

The operator's faster-settlement idea — the zkVM approving before validators,
"one validator is enough" — is recorded where it belongs: TRUE about
on-chain verification cost (pairing check is constant-ish, measured
~29.1M instructions), FALSE about canonicity until some circuit verifies a
signature (the quorum is the input of trust, not a redundancy), and
convertible between the two exactly along the phase table in
docs/BRIDGE_TRUST_MODEL.md §2-3. No wording anywhere in the repository may
skip the middle row of that sentence; Phase 2's stop-sign clause is pre-
authorized: if no bigint/pairing gadget set can be vendored or written to
measured satisfaction, the one-signer claim does not enter the README,
permanently, and this directive entry is where that decision will have been
made in advance rather than in the moment of temptation.

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

### 11.2 The zkVM answer, superseded by the artifact

This section used to say the answer was "no" and that the words should stay. The
second path it named — *widen the circuit until the label changes because the
engineering did* — has been taken, so the section changes with it.

What changed: `circuits/execution_trace.circom` with `crates/execution_vm`
proves the step-by-step execution of a *committed program* on a machine with a
defined instruction set, a carried memory model, a witness that replays the run,
and a decode that ties every row to the packed program word its program counter
selects. That is an execution-trace proof, and calling it nothing at all would
now be the dishonest position.

What did not change, and stays in the same sentence: this is a **bounded** VM,
not a general-purpose zkVM. Twenty rows, sixteen instructions, sixteen memory
words, eight registers, no syscalls, no unbounded execution; the guest is
assembled from a listing rather than compiled; and its end root is deliberately
not wired into the settlement anchor. The README, `docs/PROVING_SYSTEM.md` §5c
and §7, and the circuit header all state the bound in the same breath as the
claim, because a judge who finds the bound mis-stated will discount the whole
file. A second bounded machine has since joined it — `circuits/gate_vm.circom`
with `crates/gate_vm`, live on testnet with its own registry slot and its own
14-probe record: an eight-line, eight-register machine whose program enters the
statement only as a Poseidon-fold commitment and whose Poseidon instruction
lets the *program itself* hash. It is described by the same sentence's rules:
bounded (eight rows are the whole budget), assembled, anchored on nothing, and
labelled an execution proof rather than a platform. The two fixed-statement
lanes keep their own labels: they are statement proofs, and nothing about them
is described as a VM.

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
