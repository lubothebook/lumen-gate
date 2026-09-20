// Tek dogruluk kaynagi: deployments/testnet-2.0.json. Adresler buraya
// asla elle kopyalanmaz; makbuz dosyasindan okunur.
import manifest from "../../../deployments/testnet-2.0.json";

const c = manifest.contracts || {};
const idOf = (entry) => (entry && typeof entry === "object" && entry.id) || null;

export const CONFIG = {
  network: "testnet",
  networkPassphrase: "Test SDF Network ; September 2015",
  rpcUrl: "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",
  irisApi: c.iris_api_testnet_base,
  // Kanonik (sertlestirilmis) gate_claim ve bu kulvarin makbuz kaydi:
  gateClaimCanonical: idOf(c.gate_claim_testnet),
  gateClaimPreHardening: idOf(c.gate_claim_testnet_pre_hardening),
  campaign: idOf(c.gate_campaign_example_testnet),
  stamp: idOf(c.gate_stamp_testnet),
  // F5/F6: live on testnet since 2026-09-20. Read straight from the receipt,
  // exactly like every other id on this screen.
  battery: idOf(c.gate_battery_testnet),
  ticket: idOf(c.gate_ticket_testnet),
  // mint_ticket needs a minter contract that does not exist on testnet yet, so
  // init_minter was never called. Reads are live; minting stays honestly shut.
  ticketMinterSet: Boolean(c.gate_ticket_testnet) && !c.gate_ticket_testnet.minter_not_set,
  deployerPublicKey: c.testnet_deployer?.public_key,
  usdc: c.circle_testnet_reference?.native_usdc_stellar_testnet,
  usdcIssuer: c.circle_testnet_reference?.native_usdc_stellar_testnet_issuer,
  tokenMessenger: c.circle_testnet_reference?.stellar_domain27?.token_messenger_minter,
  messageTransmitter: c.circle_testnet_reference?.stellar_domain27?.message_transmitter,
  sepolia: {
    usdc: c.circle_testnet_reference?.sepolia_domain0?.usdc,
    tokenMessengerV2: c.circle_testnet_reference?.sepolia_domain0?.token_messenger_v2,
    messageTransmitterV2: c.circle_testnet_reference?.sepolia_domain0?.message_transmitter_v2,
  },
  burnRouter: null, // deploy + makbuz bekliyor; uydurma adres yazilmaz
  burnRouterBlocker:
    "BurnRouter is not deployed on Sepolia. The v2 router, its 31/31 test suite and the deploy script are ready in the repo; the lane is gated on two operator inputs: Sepolia testnet funding, and the router-binding finding (the live gate_claim accepts burns only from the exact bound router address — the router must land there or a fresh gate_claim must be bound to it). When deployed and receipted, this screen lights up from the same manifest.",
};
