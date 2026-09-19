'use strict';

// GET /api/status
//
// The single call the console makes on load: what is deployed, what is live
// right now, and what this particular deployment is allowed to do.

const { loadManifest, loadAuditRecord, contractId, send, fetchJson, capabilities } = require('./_shared');

const RPC_URL = process.env.RPC_URL || 'https://soroban-testnet.stellar.org';
const HORIZON_URL = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';

module.exports = async function handler(req, res) {
  const manifest = loadManifest();
  if (!manifest) {
    send(res, 500, { error: 'manifest_unavailable', why: 'deployments/testnet.json could not be read' });
    return;
  }

  const registryId = contractId(manifest, 'finality_registry');
  const gatewayId = contractId(manifest, 'settlement_gateway');
  const tokenId = contractId(manifest, 'wrapped_asset_sac');
  const issuer = manifest.contracts?.wrapped_asset_sac?.issuer || null;
  const audit = loadAuditRecord();

  // Soroban RPC is JSON-RPC: a bare GET only proves the host answers, so the
  // live check is a real getLatestLedger call.
  const ledger = await (async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      const response = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestLedger', params: {} }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const body = await response.json();
      return body.result ? body.result.sequence : null;
    } catch {
      return null;
    }
  })();

  const account = issuer ? await fetchJson(`${HORIZON_URL}/accounts/${issuer}`, { timeoutMs: 6000 }) : null;

  send(
    res,
    200,
    {
      network: manifest.network,
      protocol_version_at_deploy: manifest.protocol_version_at_deploy,
      generated_at: new Date().toISOString(),
      contracts: {
        registry: registryId,
        gateway: gatewayId,
        wrapped_asset: tokenId,
        issuer,
        asset: manifest.contracts?.wrapped_asset_sac?.asset || 'wSRC',
      },
      domain: {
        name: manifest.domain?.name,
        key: manifest.domain?.domain_key,
        adapter_id: manifest.domain?.adapter_id,
        state: manifest.domain?.state,
        machine_approved: manifest.domain?.machine_approved,
        bls_policy: manifest.domain?.bls_policy,
      },
      target_domain: manifest.target_domain,
      chain: {
        rpc: RPC_URL,
        horizon: HORIZON_URL,
        latest_ledger: ledger,
        issuer_xlm: account && account.ok
          ? (account.body.balances || []).find((b) => b.asset_type === 'native')?.balance || null
          : null,
      },
      audit: audit
        ? {
            last_check: audit.latest?.finished_at || null,
            result: `${audit.latest?.checks_passed ?? '?'}/${audit.latest?.checks_total ?? '?'}`,
            all_passed: Boolean(audit.latest?.all_passed),
            rounds_recorded: Array.isArray(audit.history) ? audit.history.length : 0,
          }
        : null,
      receipts: manifest.receipts || {},
      gasless: manifest.gasless || null,
      capabilities: capabilities(),
      honesty: {
        source_chain: 'simulated locally; the Stellar side is not',
        zk_lane: 'statement proof (quorum + root binding), not a zkVM and not a signature verifier',
        findings_recorded: Array.isArray(manifest.findings) ? manifest.findings.length : 0,
        known_simplifications: Array.isArray(manifest.known_simplifications) ? manifest.known_simplifications.length : 0,
      },
    },
    0
  );
};
