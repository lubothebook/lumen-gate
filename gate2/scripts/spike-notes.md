# F1 spike notes — inputs taken from live doc pages (fetched 2026-09-20)

Source: developers.circle.com/cctp/references/stellar-contracts (fetched this session;
append-only page record below; nothing here is invented — every address below was on
the page verbatim).

## Testnet contract addresses, domain 27 (Stellar testnet)
- TokenMessengerMinter: CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP
- MessageTransmitter:  CBJ6MTCKKZG73PMDZCJMSFRD7DQEMI4FKDH7CGDSV4W6FHCRBCQAVVJY
- CctpForwarder:       CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ

(Mainnet counterparts exist on the same page; not used — testnet-only per directive.)

## Facts that shape S1 (D1-G vs D1-F)
- "CCTP treats `mintRecipient` as a contract address" on Stellar. Account recipients
  go through CctpForwarder with `forwardRecipient` strkey in hook data.
- MessageTransmitter.receive_message "is called by an offchain forwarding service
  (or by CctpForwarder in the forwarder flow)"; verified delivery then routes to the
  recipient contract via TokenMessengerMinter.handle_receive_finalized_message /
  handle_receive_unfinalized_message ("called by MessageTransmitter").
- Consequence for the spike: the G design (GateClaim = mintRecipient =
  destinationCaller) means GateClaim must implement the receiving-contract hook
  interface and have the transmitter call INTO it — S1 tests exactly that wiring
  against the testnet contracts above; the F fallback (CctpForwarder.mint_and_forward,
  public, anyone-can-call, NFT unbindable) is already documented as non-custodial
  but open — the risk sentence for README if F wins is confirmed by the page.
- Interfaces on the page: deposit_for_burn, deposit_for_burn_with_hook(hook_data),
  get_max_message_body_size, is_nonce_used (replay), get_local_domain (27),
  get_version (Iris), mint_and_forward(message, attestation) atomic.

## Still to fetch before F1 runs (do not guess these)
- Sepolia-side: tokenMessenger, messageTransmitter, and Circle's Sepolia USDC +
  its burn-from-EVM-to-domain-27 config, from developers.circle.com supported
  chains page; Iris testnet API base (api.circle.com sandbox vs iris-testing).
- developers.stellar.org/docs/tokens/cross-chain-transfers for the Stellar-side
  account/trustline requirement (S4) and decimal handling.

## On-chain truth (read live from testnet 2026-09-20, audit-probe simulations - zero fees, no state change)
- MT.get_local_domain = 27; get_version = 1; get_max_message_body_size = 8192.
- TMM.get_message_body_version = 1.
- **TMM.get_local_token(remote_domain=0, remote_token=0x...1c7d4b...) = CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA** - the native USDC contract id on Stellar testnet, derived from Circle's own link table, not from any doc page.
- TMM.get_token_decimal_config(usdc) = { canonical_decimals: 6, local_decimals: 7 } - the x10 conversion is the CHAIN's config value, live.
- TMM.get_min_fee(usdc) = 0; get_max_burn_amount_per_message(usdc) = 10,000,000,000,000 (10M USDC, 6-dec) - the per-message cap the directive wants in the UI already exists on-chain (F4 note: the router must respect it, not re-invent it).
- TMM.paused = false.

## Doc-vs-chain reconciliation (recorded, not patched anywhere)
- stellar-contracts.md lists `handle_receive_finalized_message` / `handle_receive_unfinalized_message`; the live TMM wasm exports them as **`handle_recv_finalized_message` / `handle_recv_unfinalized_message`**. Product code must follow the ON-CHAIN names; the doc table names are prose.
- MT.receive_message live signature is `receive_message(env, caller, message, attestation) -> bool` - the `caller` arg is how the destinationCaller restriction works (stellar.md: "require_auth compares bytes"). This is what makes the G design race-safe by construction, and what the docs' "mintRecipient must be the CctpForwarder" warning is actually about (user accounts G/M can't receive a mint; a CONTRACT recipient is exactly how CctpForwarder itself receives - hence S1's open question narrows to: does the mint land on an arbitrary C account like SpikeGate, i.e. can a contract hold the balance and pay out).
- Both `pause`, `upgrade`, `denylist`, `rescue_sep41` are exported on the live TMM/MT/FWD wasm: Circle retains operator surface on its own contracts - this belongs in the 2.0 trust model text verbatim.

## IRIS API (from technical-guide.md + live probes, no key needed on testnet)
- Base: https://iris-api-sandbox.circle.com (page names it; my earlier guess "iris-testing-api" 404s - recorded as a dead end, page value used).
- GET /v2/publicKeys -> 200 with the attester key list (live probe, evidence of service availability).
- GET /v2/messages/{sourceDomainId}?transactionHash=... | ?nonce=... -> messages + attestations.
- GET /v2/burn/USDC/fees/{sourceDomainId}/{destDomainId} -> LIVE for 0/27: FAST (threshold 1000) minimumFee = 1 subunit; STANDARD (2000) = 0. Times (finality page): Sepolia fast ~2 blocks/~20s, standard ~65 blocks/15-19 min; Stellar destination mint ~1 ledger/~5s.
- POST /v2/reattest/{nonce} exists for soft-finality revival (edge cases).

## FUNDING - the phase's only open blocker
- Circle testnet faucet is now console-gated (developers.circle.com/wallets/developer-console-faucet.md); the captcha-less https://faucet.circle.com/api/send endpoint is gone (page serves an app shell); public no-captcha ETH faucets probed (sepolia-faucet.ethdevops.io, faucet.sepolia.dev, sepolia-faucet.pk910.de) are down/unreachable from here.
- Consequence: S1/S2/S3's *on-chain half* waits for testnet ETH + Sepolia USDC on the runtime EVM key. `gate2/scripts/spike-s1.mjs status` prints the address and exits 3 with instructions; `burn` and `claim` complete the spike the moment funds land. No simulated burn will be passed off as evidence in the meantime.

## Toolchain notes (rebuild-survival for this environment)
- soroban-sdk 28 requires target `wasm32v1-none` (rustup add) and REJECTS wasm32-unknown-unknown on rust 1.82+.
- `stellar contract build` refuses a profile without `overflow-checks = true`; standalone crates need their own [profile.release] - the root workspace profile does not apply to gate2/soroban/spike_gate (deliberately NOT a workspace member, so F0's "two member lines" diff stays exact).
- CLI arg formats: u32 as bare number; BytesN<32> as BARE hex WITHOUT the 0x prefix and without JSON quotes (both variants 400 with "expected bytes32"); Address as bare strkey; return values print as JSON ("\"C...\"" for addresses, bare for ints).
