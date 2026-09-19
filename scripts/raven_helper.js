#!/usr/bin/env node
// Optional documentation helper for Lumen Gate.
// Raven is a research aid, not a runtime dependency or mint authority.

const RAVEN_MCP_ENDPOINT = "https://raven.stellar.org/mcp";
const QUERIES = [
  "Soroban BLS12-381 host functions list",
  "Soroban BN254 Groth16 verifier example",
  "SAC set_admin Stellar Asset Contract gateway",
  "stellar.toml CURRENCIES anchor settlement",
  "Soroban transaction simulation resource assembly sendTransaction",
];

function printUsage() {
  console.log("=== Lumen Gate documentation research ===\n");
  console.log(`Raven MCP endpoint: ${RAVEN_MCP_ENDPOINT}`);
  console.log("\nAsk for primary sources and verify every answer against the target network:\n");
  for (const [index, query] of QUERIES.entries()) {
    console.log(`${index + 1}. search({query: "${query}", limit: 5})`);
  }
  console.log("\nLocal implementation map:");
  console.log("- contracts/finality_registry/src/lib.rs");
  console.log("- contracts/settlement_gateway/src/lib.rs");
  console.log("- scripts/deploy.sh");
  console.log("- anchor/stellar.toml and anchor/server.js");
  console.log("\nA documentation answer is not a deployment receipt. Record real contract IDs,\ntransaction hashes and negative-test results before making a product claim.");
}

if (require.main === module) printUsage();

module.exports = { RAVEN_MCP_ENDPOINT, QUERIES };
