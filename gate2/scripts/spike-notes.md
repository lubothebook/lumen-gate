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
