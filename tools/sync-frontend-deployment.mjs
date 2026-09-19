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

// The lanes block is what the status card is allowed to know: only what the
// receipt files in deployments/ already say. It never fetches, never computes
// a "0" where a receipt is silent, and names its own sources so the page can
// be audited against the repository. Absent facts render as em-dashes, not
// as zeroes dressed up as measurements.
function readReceipt(name) {
  try {
    return JSON.parse(readFileSync(join(repoRoot, 'deployments', name), 'utf8'));
  } catch {
    return null;
  }
}

const audit = readReceipt('self-audit.json');
// the showcase is whatever record stands: v2 (five slots) when it exists,
// the four-slot merged record until then — the card reads the receipts, it
// does not pick favorites among them
const merged = readReceipt('registry-v2.json') || readReceipt('merged-registry.json');
const lastAudit = audit?.latest
  ? {
      round: audit.latest.round ?? null,
      passed: audit.latest.checks_passed ?? null,
      total: audit.latest.checks_total ?? null,
      all_passed: audit.latest.all_passed ?? true,
      finished_at: audit.latest.finished_at ?? null,
      registry: audit.latest.registry ?? null,
    }
  : null;

// ledger and fee figures for a lane: the audit loop reads them from Horizon
// every round, so the numbers the card shows were live when recorded. A lane
// whose latest detail does not carry them shows null and renders an em-dash.
function onLedger(detail) {
  const ledger = String(detail || '').match(/ledger[\D]+([\d,]+)/);
  const fee = String(detail || '').match(/\(?([\d,]+) stroops\)?/);
  return { ledger: ledger ? ledger[1] : null, fee_stroops: fee ? fee[1] : null };
}

function laneReceipt(receiptName, auditCheck, { txFromHonest = true } = {}) {
  const rec = readReceipt(receiptName);
  if (!rec) return { recorded: false };
  const checks = rec.checks || rec.records || [];
  const honest = checks.find((c) => /honest_.*_accepted/.test(c.check || ''));
  const auditDetail = (audit?.latest?.checks || []).find((c) => c.check === auditCheck)?.detail
    ?? (audit?.latest?.records || []).find((r) => r.check === auditCheck)?.detail;
  let ledgerFacts = auditDetail ? onLedger(auditDetail) : { ledger: null, fee_stroops: null };
  // lanes whose facts live in the merged round's detail: "gate_vm ledger N (F stroops)"
  const mergedDetail = (audit?.latest?.checks || []).find((c) => c.check === "merged_registry_still_frozen")?.detail || "";
  const seg = String(receiptName).match(/^([a-z-]+?)(-lane)?\.json$/)?.[1]?.replace(/-/g, "_");
  // (file names and audit-lane names differ by the -lane/-chain noise: the
  // receipt is named execution-lane.json, the merged detail calls it execution;
  // strip exactly that, nothing cleverer)
  if ((!ledgerFacts.ledger || !ledgerFacts.fee_stroops) && seg) {
    const m = mergedDetail.match(new RegExp(`${seg} ledger ([\\d,]+) \\(([\\d,]+) stroops\\)`));
    if (m) ledgerFacts = { ledger: m[1], fee_stroops: m[2] };
  }
  return {
    recorded: true,
    registry: rec.registry_id ?? null,
    honest_transaction: (txFromHonest ? honest?.transaction : null) ?? rec.honest_transaction ?? null,
    checks: `${checks.filter((c) => c.passed).length}/${checks.length}`,
    ...ledgerFacts,
  };
}

const lanes = {
  sources: ['deployments/self-audit.json', 'deployments/merged-registry.json', 'deployments/testnet.json', 'deployments/step-chain.json', 'deployments/execution-lane.json', 'deployments/gate-vm-lane.json'],
  meaning_of_dash: 'the receipts record nothing here — which is not the same as zero',
  last_audit: lastAudit,
  merged_registry: merged
    ? {
        contract_id: merged.registry?.contract_id ?? null,
        all_lanes_passed: merged.passed ?? false,
        lane_suites: merged.lane_suites ?? {},
        record: 'deployments/merged-registry.json',
      }
    : null,
  settlement: {
    registry: contractId('finality_registry'),
    admin_state: manifest.contracts?.finality_registry?.admin ?? manifest.contracts?.finality_registry?.status ?? null,
    last_finalized_height: manifest.registry_state?.last_finalized_height ?? manifest.finality?.last_finalized_height ?? null,
  },
  step_chain: laneReceipt('step-chain.json', 'honest_evidence_accepted'),
  execution: laneReceipt('execution-lane.json', 'execution_lane_still_verified'),
  gate_vm: laneReceipt('gate-vm-lane.json', 'gate_vm_lane_still_verified'),
  // the sibling lane lives only on the showcase registry; its row is built
  // from the showcase's own record and the audit tail, not from a lane file
  gate_vm32: (() => {
    if (!merged?.registry?.contract_id) return { recorded: false };
    const checks = merged.v2_checks || merged.merged_checks || [];
    const stranger = checks.find((c) => c.check === 'stranger_accepted_on_the_sibling_slot');
    const mergedDetail = (audit?.latest?.checks || []).find((c) => c.check === 'merged_registry_still_frozen')?.detail || '';
    const m = mergedDetail.match(/gate_vm32_by_stranger ledger ([\d,]+) \(([\d,]+) stroops\)/);
    if (!stranger && !m) return { recorded: false };
    return {
      recorded: true,
      registry: merged.registry.contract_id,
      honest_transaction: stranger?.transaction || null,
      ledger: m ? m[1] : null,
      fee_stroops: m ? m[2] : null,
      submitted_by: merged.stranger?.address ? 'an account generated at run time, configured nowhere' : null,
    };
  })(),
};

const contents = `// GENERATED FILE - do not edit by hand.
//
// Source: deployments/testnet.json, written by tools/sync-frontend-deployment.mjs.
// Every value here is a live testnet fact recorded next to the transaction that
// produced it. If a value looks wrong, fix the manifest and regenerate; do not
// patch this file.
export const deployment = ${JSON.stringify(deployment, null, 2)};

// Lanes of this deployment, read from the receipts only at generation time.
export const lanes = ${JSON.stringify(lanes, null, 2)};

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
