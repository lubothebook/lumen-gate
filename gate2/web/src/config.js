// Tek dogruluk kaynagi: deployments/testnet-2.0.json. Adresler buraya
// asla elle kopyalanmaz; makbuz dosyasindan okunur.
import manifest from "../../../deployments/testnet-2.0.json";

const c = manifest.contracts;

export const CONFIG = {
  network: "testnet",
  networkPassphrase: "Test SDF Network ; September 2015",
  rpcUrl: "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",
  irisApi: c.iris_api_testnet_base,
  // Kanonik (sertlestirilmis) gate_claim ve bu kulvarin makbuz kaydi:
  gateClaimCanonical: c.gate_claim_testnet.id,
  gateClaimPreHardening: c.gate_claim_testnet_pre_hardening.id,
  campaign: c.gate_campaign_example_testnet.id,
  stamp: c.gate_stamp_testnet.id,
  deployerPublicKey: c.testnet_deployer.public_key,
  usdc: c.circle_testnet_reference.native_usdc_stellar_testnet,
  usdcIssuer: c.circle_testnet_reference.native_usdc_stellar_testnet_issuer,
  tokenMessenger: c.circle_testnet_reference.stellar_domain27.token_messenger_minter,
  messageTransmitter: c.circle_testnet_reference.stellar_domain27.message_transmitter,
  sepolia: {
    usdc: c.circle_testnet_reference.sepolia_domain0.usdc,
    tokenMessengerV2: c.circle_testnet_reference.sepolia_domain0.token_messenger_v2,
    messageTransmitterV2: c.circle_testnet_reference.sepolia_domain0.message_transmitter_v2,
  },
  burnRouter: null, // F2/F4 Sepolia fonu bekliyor; uydurma adres yazilmaz
  burnRouterBlocker:
    "BurnRouter Sepolia'de kurulu degil: F2 uctan uca burn, Sepolia testnet ETH/USDC fonu bekliyor (DIRECTIVE 2.0 Bolum 10 stop-raporu). Fon geldiginde router adresi makbuza yazilir ve bu ekran canlanir.",
};
