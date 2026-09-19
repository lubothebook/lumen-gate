// Generate frontend/src/deployment.js from deployments/testnet.json.
//
// The deployment manifest is the single source of truth for addresses. The
// frontend must not carry a second, hand-edited copy of them: a page that shows
// a contract address has to show the address the receipt was written against.
//
// Usage:
//   node tools/sync-frontend-deployment.mjs            # write the module
//   node tools/sync-frontend-deployment.mjs --check    # fail if it is stale
//
// --check is what keeps the two files from drifting: run it before a commit.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const manifestPath = join(repoRoot, 'deployments', 'testnet.json');
const outputPath = join(repoRoot, 'frontend', 'src', 'deployment.js');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

function contractId(name) {
  const entry = manifest.contracts?.[name];
  if (!entry) return null;
  return typeof entry === 'string' ? entry : entry.contract_id || null;
}

const deployment = {
  network: manifest.network,
  passphrase: manifest.network_passphrase,
  rpcUrl: manifest.rpc_url,
  horizonUrl: manifest.horizon_url,
  registryId: contractId('finality_registry'),
  gatewayId: contractId('settlement_gateway'),
  tokenId: contractId('wrapped_asset_sac'),
  sourceDomainKey: manifest.domain?.domain_key || null,
  targetDomain: manifest.target_domain || null,
  adapterId: manifest.domain?.adapter_id || null,
  generatedFrom: 'deployments/testnet.json',
};

const missing = Object.entries(deployment)
  .filter(([, value]) => value === null || value === undefined)
  .map(([key]) => key);
if (missing.length > 0) {
  console.error(`deployments/testnet.json is missing: ${missing.join(', ')}`);
  process.exit(1);
}

const contents = `// GENERATED FILE - do not edit by hand.
//
// Source: deployments/testnet.json, written by tools/sync-frontend-deployment.mjs.
// Every value here is a live testnet fact recorded next to the transaction that
// produced it. If a value looks wrong, fix the manifest and regenerate; do not
// patch this file.
export const deployment = ${JSON.stringify(deployment, null, 2)};

export default deployment;
`;

const previous = (() => {
  try {
    return readFileSync(outputPath, 'utf8');
  } catch {
    return null;
  }
})();

if (process.argv.includes('--check')) {
  if (previous !== contents) {
    console.error('frontend/src/deployment.js is stale. Run: node tools/sync-frontend-deployment.mjs');
    process.exit(1);
  }
  console.log('frontend/src/deployment.js matches deployments/testnet.json');
  process.exit(0);
}

writeFileSync(outputPath, contents);
console.log(`wrote ${outputPath}`);
for (const [key, value] of Object.entries(deployment)) {
  console.log(`  ${key}: ${value}`);
}
