'use strict';

// GET /api/finality[?height=N]
//
// A live read straight from the deployed registry, executed as a Soroban
// simulation. Nothing is cached and nothing is trusted from this repository:
// the answer comes from the contract's own state, which is the point of
// putting the settlement rule in a contract instead of in a server.

const StellarSdk = require('@stellar/stellar-sdk');
const { loadManifest, contractId, send, sendError} = require('./_shared');

const RPC_URL = process.env.RPC_URL || 'https://soroban-testnet.stellar.org';
const PLACEHOLDER_SOURCE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

function toHex(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('hex');
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  return String(value);
}

function decodeRecord(native) {
  if (!native || typeof native !== 'object') return native ?? null;
  const out = {};
  for (const [key, value] of Object.entries(native)) {
    if (key === 'adapter_id' || key === 'last_root' || key === 'last_event_root' || key === 'state_root' || key === 'event_root') {
      out[key] = toHex(value);
    } else if (typeof value === 'bigint') {
      out[key] = value.toString();
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = decodeRecord(value);
    } else {
      out[key] = Array.isArray(value) ? value.map((item) => (typeof item === 'bigint' ? item.toString() : item)) : value;
    }
  }
  return out;
}

module.exports = async function handler(req, res) {
  const manifest = loadManifest();
  if (!manifest) {
    sendError(res, 500, 'manifest_unavailable', 'deployments/testnet.json could not be read');
    return;
  }
  const registryId = contractId(manifest, 'finality_registry');
  const domainKey = manifest.domain?.domain_key;
  if (!registryId || !domainKey) {
    sendError(res, 500, 'deployment_incomplete', 'registry id or domain key missing from the manifest');
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const heightParam = url.searchParams.get('height');
  if (heightParam !== null && !/^\d{1,9}$/.test(heightParam)) {
    sendError(res, 400, 'invalid_height', 'height must be a positive integer');
    return;
  }

  try {
    const server = new StellarSdk.SorobanRpc.Server(RPC_URL);
    // Simulation only needs a syntactically valid source account; it must not
    // depend on a funded key, or a read would require someone's money.
    const source = new StellarSdk.Account(PLACEHOLDER_SOURCE, '0');
    const contract = new StellarSdk.Contract(registryId);
    const domainScVal = StellarSdk.xdr.ScVal.scvBytes(Buffer.from(domainKey, 'hex'));

    const call = heightParam
      ? contract.call('get_finalized_full', domainScVal, StellarSdk.nativeToScVal(BigInt(heightParam), { type: 'u64' }))
      : contract.call('get_last_finalized', domainScVal);

    const tx = new StellarSdk.TransactionBuilder(source, {
      fee: '1000000',
      networkPassphrase: StellarSdk.Networks.TESTNET,
    })
      .addOperation(call)
      .setTimeout(30)
      .build();

    const simulation = await server.simulateTransaction(tx);
    if (StellarSdk.SorobanRpc.Api.isSimulationError(simulation)) {
      sendError(res, 502, 'simulation_failed', 'the registry simulation did not answer', { upstream: simulation.error });
      return;
    }
    const retval = simulation.result && simulation.result.retval;
    const native = retval ? StellarSdk.scValToNative(retval) : null;

    send(
      res,
      200,
      {
        source: 'deployed contract, read by simulation',
        registry: registryId,
        domain_key: domainKey,
        query: heightParam ? `get_finalized_full(height=${heightParam})` : 'get_last_finalized',
        record: decodeRecord(native),
        found: native !== null && native !== undefined,
        latest_ledger: simulation.latestLedger || null,
        cost: simulation.cost ? { cpu_insns: String(simulation.cost.cpuInsns), mem_bytes: String(simulation.cost.memBytes) } : null,
      },
      0
    );
  } catch (error) {
    sendError(res, 500, 'finality_read_failed', 'the finality read failed', {
      upstream: String(error && error.message ? error.message : error),
    });
  }
};
