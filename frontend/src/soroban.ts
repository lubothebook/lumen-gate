// Soroban helpers for Lumen Gate - hardened
import * as StellarSdk from '@stellar/stellar-sdk';

const RPC_URL = import.meta.env.VITE_RPC_URL || 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = StellarSdk.Networks.TESTNET;

export const server = new StellarSdk.SorobanRpc.Server(RPC_URL);

// Real contract events via RPC
export async function getContractEvents(contractId: string, startLedger: number = 1) {
  const res = await server.getEvents({
    startLedger,
    filters: [
      {
        type: 'contract',
        contractIds: [contractId],
      }
    ],
    limit: 20,
  });
  return res;
}

// Check finality via registry is_finalized and get_finalized_full
export async function isFinalized(registryId: string, domainKey: string, height: number) {
  // Build dummy account for simulation
  const account = await server.getAccount('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF');
  const contract = new StellarSdk.Contract(registryId);
  // domainKey is hex 32 bytes -> we need to convert to ScVal BytesN
  const domainBytes = StellarSdk.xdr.ScVal.scvBytes(Buffer.from(domainKey, 'hex'));
  // Actually is_finalized expects (domain: BytesN<32>, height: u64)
  // Use nativeToScVal for height
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: '1000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call('is_finalized', domainBytes, StellarSdk.nativeToScVal(height, {type: 'u64'})))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  return sim;
}

export async function getFinalizedFull(registryId: string, domainKey: string, height: number) {
  const account = await server.getAccount('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF');
  const contract = new StellarSdk.Contract(registryId);
  const domainBytes = StellarSdk.xdr.ScVal.scvBytes(Buffer.from(domainKey, 'hex'));
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: '1000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call('get_finalized_full', domainBytes, StellarSdk.nativeToScVal(height, {type: 'u64'})))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  return sim;
}

export async function getProfile(registryId: string, domainKey: string) {
  const account = await server.getAccount('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF');
  const contract = new StellarSdk.Contract(registryId);
  const domainBytes = StellarSdk.xdr.ScVal.scvBytes(Buffer.from(domainKey, 'hex'));
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: '1000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call('get_profile', domainBytes))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  return sim;
}

export function buildRawEvidence(
  adapterId: string,
  network: string,
  payloadHex: string,
  declaredHeight: number,
  declaredRoot: string,
  submitter: string
) {
  return {
    adapter_id: adapterId,
    evidence_version: 1,
    network,
    payload: payloadHex,
    declared_height: declaredHeight,
    declared_root: declaredRoot,
    submitter,
  };
}

export async function buildBurnAndRelayTx(
  gatewayId: string,
  amount: string,
  recipientOnSource: string,
  targetDomainHex: string,
  userPublicKey: string
) {
  if (!/^[0-9a-fA-F]{64}$/.test(targetDomainHex)) {
    throw new Error('target domain must be a 32-byte hex value');
  }
  const account = await server.getAccount(userPublicKey);
  const latest = await server.getLatestLedger();
  const contract = new StellarSdk.Contract(gatewayId);
  const expiryHeight = BigInt(latest.sequence + 100);
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: '100000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(
      'burn_and_relay',
      new StellarSdk.Address(userPublicKey).toScVal(),
      StellarSdk.nativeToScVal(BigInt(amount), {type: 'i128'}),
      StellarSdk.nativeToScVal(Buffer.from(recipientOnSource, 'utf8'), {type: 'bytes'}),
      StellarSdk.xdr.ScVal.scvBytes(Buffer.from(targetDomainHex, 'hex')),
      StellarSdk.nativeToScVal(expiryHeight, {type: 'u64'})
    ))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (StellarSdk.SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`Burn simulation failed: ${JSON.stringify(sim)}`);
  }
  return StellarSdk.SorobanRpc.assembleTransaction(tx, sim).build();
}

export function parseBlsPayload(payloadHex: string) {
  const bytes = Buffer.from(payloadHex, 'hex');
  const height = bytes.readBigUInt64LE(0);
  const stateRoot = bytes.subarray(8, 40).toString('hex');
  const eventRoot = bytes.subarray(40, 72).toString('hex');
  const signerCount = bytes.readUInt32LE(72);
  const required = bytes.readUInt32LE(76);
  const sig = bytes.subarray(80, 176).toString('hex');
  const pubkey = bytes.subarray(176, 368).toString('hex');
  return { height: Number(height), stateRoot, eventRoot, signerCount, required, sig, pubkey };
}

// Merkle proof verification (client side)
export function verifyMerkleProof(leafHex: string, proofHexes: string[], rootHex: string): boolean {
  // leaf = message_id (32 bytes hex)
  // proof = array of 32-byte sibling hex
  // root = event_root hex
  // Use sorted hashing like contract
  let current = Buffer.from(leafHex, 'hex');
  for (const siblingHex of proofHexes) {
    const sibling = Buffer.from(siblingHex, 'hex');
    // sorted
    const left = Buffer.compare(current, sibling) <= 0 ? current : sibling;
    const right = Buffer.compare(current, sibling) <= 0 ? sibling : current;
    const hasher = StellarSdk.hash(Buffer.concat([left, right]));
    // Actually sha256, not Stellar hash, but for demo use sha256
    // Use simple sha256 via crypto
    // For browser, use SubtleCrypto sync? We'll use StellarSdk's hash which is sha256
    current = hasher;
  }
  return current.toString('hex') === rootHex;
}

// Anchor: fetch stellar.toml and info
export async function fetchAnchorInfo(anchorUrl: string) {
  const res = await fetch(`${anchorUrl}/.well-known/stellar.toml`);
  const text = await res.text();
  return text;
}

export async function fetchAnchorTransactions(anchorUrl: string) {
  const res = await fetch(`${anchorUrl}/info`);
  const json = await res.json();
  return json;
}

// Build finalize_inbound tx (requires Freighter)
export async function buildFinalizeInboundTx(
  gatewayId: string,
  message: any,
  merkleProofHex: string,
  asset: string,
  amount: string,
  recipient: string,
  userPublicKey: string
) {
  const account = await server.getAccount(userPublicKey);
  const contract = new StellarSdk.Contract(gatewayId);
  // message is CrossDomainMessage struct, need to convert to ScVal
  // For simplicity, we build args as nativeToScVal for each field
  // In prod, use contract spec generated client
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: '100000',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(
      'finalize_inbound',
      StellarSdk.nativeToScVal(message),
      StellarSdk.xdr.ScVal.scvBytes(Buffer.from(merkleProofHex, 'hex')),
      new StellarSdk.Address(asset).toScVal(),
      StellarSdk.nativeToScVal(amount, {type: 'i128'}),
      new StellarSdk.Address(recipient).toScVal()
    ))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (StellarSdk.SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed: ${JSON.stringify(sim)}`);
  }
  // Prepare transaction
  const prepared = StellarSdk.SorobanRpc.assembleTransaction(tx, sim).build();
  return prepared;
}

// ---------------------------------------------------------- cash-out helpers
// The withdrawal flow needs two things the rest of this file does not: a classic
// payment signed by the user's own key, and the SEP-10 challenge signed the same
// way. Neither is a contract call, so neither goes through Soroban RPC -- a
// challenge that never reaches the ledger and a payment that goes straight to
// Horizon.

const HORIZON_URL = (import.meta as any).env?.VITE_HORIZON_URL || 'https://horizon-testnet.stellar.org';
const USDC_ISSUER_FALLBACK = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

/**
 * Signs the anchor's SEP-10 challenge.
 *
 * The challenge arrives as base64 XDR. It is parsed, signed by the user, and
 * handed back as XDR: this code never mutates the transaction it was given
 * beyond adding a signature, because an anchor verifies a signature over the
 * exact transaction it issued.
 */
export async function signAnchorChallenge(challengeXdr: string, account: string): Promise<string> {
  const transaction = StellarSdk.TransactionBuilder.fromXDR(challengeXdr, NETWORK_PASSPHRASE);
  const freighter = (window as any).freighterApi
    || (window as any).freighter
    || (window as any).stellar?.freighter
    || (window as any).stellar?.Freighter;
  if (!freighter) throw new Error('Freighter is not available to sign the challenge');
  const signed = await freighter.signTransaction(transaction.toXDR(), {
    networkPassphrase: NETWORK_PASSPHRASE,
    address: account,
  });
  const xdr = typeof signed === 'string' ? signed : signed.signedTxXdr;
  if (!xdr) throw new Error('Freighter returned no signed challenge');
  return xdr;
}

/**
 * Builds the payment the anchor asked for: the asset, the treasury, the amount,
 * and the memo the anchor will match on.
 *
 * Returns the transaction *unsigned*, so the caller can hand exactly these bytes
 * to the wallet. Nothing is submitted from here.
 */
export async function buildAnchorPaymentTx(
  destination: string,
  amount: string,
  assetIssuer: string | undefined,
  memo: string,
  source: string
): Promise<any> {
  const horizon = new StellarSdk.Horizon.Server(HORIZON_URL);
  const account = await horizon.loadAccount(source);
  const asset = new StellarSdk.Asset('USDC', assetIssuer || USDC_ISSUER_FALLBACK);
  if (!/^\d+$/.test(String(memo))) {
    throw new Error(`the anchor asked for a memo of type id; "${memo}" is not numeric`);
  }
  return new StellarSdk.TransactionBuilder(account, { fee: '10000', networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(StellarSdk.Operation.payment({ destination, asset, amount }))
    .addMemo(StellarSdk.Memo.id(String(memo)))
    .setTimeout(60)
    .build();
}

/** Submits an already-signed classic transaction to Horizon. */
export async function submitClassic(signedXdr: string): Promise<string> {
  const horizon = new StellarSdk.Horizon.Server(HORIZON_URL);
  const transaction = StellarSdk.TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
  const result = await horizon.submitTransaction(transaction as any);
  return result.hash;
}

/** Submits an already-signed Soroban transaction to the RPC. */
export async function submitSoroban(signedXdr: string): Promise<any> {
  const transaction = StellarSdk.TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
  return server.sendTransaction(transaction as any);
}
