// Soroban helpers for Lumen Gate - hardened
import * as StellarSdk from '@stellar/stellar-sdk';
// Node's Buffer is a global in Node and *absent* in the browser: every
// hex/utf8 bytes call below referenced a bare `Buffer` that only existed
// because the module was first exercised from Node harnesses. In the browser
// each of those lines threw `ReferenceError: Buffer is not defined` before a
// single byte reached the network, which is how the burn button could look
// "dead" while actually being broken. The buffer package is already in the
// tree (stellar-base depends on it); importing it here makes the module work
// in both worlds.
import { Buffer } from 'buffer';

const RPC_URL = import.meta.env.VITE_RPC_URL || 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = StellarSdk.Networks.TESTNET;

export const server = new StellarSdk.SorobanRpc.Server(RPC_URL);

/**
 * Encodes a 32-byte hex value for a parameter the contracts declare `BytesN<32>`.
 *
 * The encoding is `scvBytes`, and that is not a guess: it was checked against
 * the LIVE deployed settlement_gateway on Stellar testnet by simulating
 * `burn_and_relay` both ways. `scvBytes` decodes and the call runs into the
 * contract body; the `scvVec` of 32 `scvU32` values that a reading of the
 * type name suggests traps the VM instead (`Error(WasmVm, InvalidAction)`,
 * "UnreachableCodeReached") before a single line of the contract executes.
 * The repo's own live-verified readers - api/finality.js against the deployed
 * registry, tools/mint-flow-live.js against the deployed gateway - encode it
 * the same way, and their receipts are in deployments/.
 *
 * So: do not "fix" this into a vector. A `BytesN<32>` argument travels as
 * bytes and the host validates the length.
 */
export function bytesN32ScVal(hex: string) {
  const raw = String(hex || '').trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(raw)) {
    throw new Error(`a BytesN<32> argument must be exactly 32 bytes of hex (64 characters); got "${String(hex)}"`);
  }
  return StellarSdk.xdr.ScVal.scvBytes(Buffer.from(raw, 'hex'));
}

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
  const account = new StellarSdk.Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '0');
  const contract = new StellarSdk.Contract(registryId);
  // is_finalized(domain: BytesN<32>, height: u64). See bytesN32ScVal for why a
  // BytesN<32> argument travels as bytes and not as a vector.
  const domainBytes = bytesN32ScVal(domainKey);
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
  const account = new StellarSdk.Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '0');
  const contract = new StellarSdk.Contract(registryId);
  const domainBytes = bytesN32ScVal(domainKey);
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
  const account = new StellarSdk.Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '0');
  const contract = new StellarSdk.Contract(registryId);
  const domainBytes = bytesN32ScVal(domainKey);
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
      bytesN32ScVal(targetDomainHex),
      StellarSdk.nativeToScVal(expiryHeight, {type: 'u64'})
    ))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (StellarSdk.SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`the gateway refused the burn before it was ever signed: ${explainSimulation(sim)}`);
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
      StellarSdk.xdr.ScVal.scvBytes(Buffer.from(merkleProofHex, 'hex')), // declared `Bytes`
      new StellarSdk.Address(asset).toScVal(),
      StellarSdk.nativeToScVal(amount, {type: 'i128'}),
      new StellarSdk.Address(recipient).toScVal()
    ))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (StellarSdk.SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`the gateway refused the inbound finalize: ${explainSimulation(sim)}`);
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
 * Reads the signed XDR out of whatever a wallet handed back.
 *
 * Freighter's answer changed shape across versions: older builds return the XDR
 * string, current ones return `{signedTxXdr}`. Both are handled in one place
 * because every signing path in this file needs the same thing, and a path that
 * guessed at the shape was a path that reported "no signed transaction" for a
 * signature the user had actually made.
 */
export function signedXdrFrom(answer: any): string {
  if (typeof answer === 'string') return answer;
  const xdr = answer && (answer.signedTxXdr || answer.signedTxXdrBase64 || answer.xdr);
  if (typeof xdr !== 'string' || !xdr) {
    // The official module answers an error object rather than an XDR string, and
    // that object carries the wallet's own words. An error object is not a
    // signature: say what the wallet said instead of submitting "" and letting
    // the network invent a reason.
    const reason = (answer && answer.error && (answer.error.message || answer.error)) || (answer && answer.message);
    throw new Error(reason
      ? `the wallet refused to sign: ${reason}`
      : 'the wallet returned no signed transaction; if it showed a prompt, it was declined');
  }
  return xdr;
}

/**
 * Signs the anchor's SEP-10 challenge.
 *
 * The challenge arrives as base64 XDR. It is parsed, signed by the user, and
 * handed back as XDR: this code never mutates the transaction it was given
 * beyond adding a signature, because an anchor verifies a signature over the
 * exact transaction it issued.
 *
 * `provider` is the wallet door the console already found. It is a parameter
 * rather than a lookup because the lookup this function used to do - and only
 * ever did - was `window.freighterApi || window.freighter || window.stellar...`.
 * Current Freighter builds inject nothing onto `window`; the npm module speaks to
 * the content script over postMessage. So the console could connect a wallet and
 * read balances through the module, and then this function would still say
 * "Freighter is not available to sign the challenge" - which is how the
 * Authenticate button looked dead to a reader holding an unlocked wallet. The
 * window shapes are still tried, as a fallback, for the builds that do inject.
 *
 * `passphrase` is the network the ANCHOR named in its challenge response, not a
 * constant here. Freighter refuses to sign for a passphrase that does not match
 * the network it is pointed at, so hardcoding testnet would break an anchor on
 * any other network - and the anchor tells us which one it means.
 */
export async function signAnchorChallenge(
  challengeXdr: string,
  account: string,
  provider?: any,
  passphrase: string = NETWORK_PASSPHRASE
): Promise<string> {
  const transaction = StellarSdk.TransactionBuilder.fromXDR(challengeXdr, passphrase);
  // The provider the connect flow verified is the one that signs: the caller
  // passes it in (it may be the official @stellar/freighter-api module, which
  // exposes no window global), with the legacy injected globals as fallback.
  const freighter = provider
    || (window as any).freighterApi
    || (window as any).freighter
    || (window as any).stellar?.freighter
    || (window as any).stellar?.Freighter;
  if (!freighter || typeof freighter.signTransaction !== 'function') {
    throw new Error('no wallet is available to sign the challenge; connect Freighter first');
  }
  const signed = await freighter.signTransaction(transaction.toXDR(), {
    networkPassphrase: passphrase,
    address: account,
  });
  return signedXdrFrom(signed);
}

/**
 * Builds the payment the anchor asked for: the asset, the treasury, the amount,
 * and the memo the anchor will match on.
 *
 * Returns the transaction *unsigned*, so the caller can hand exactly these bytes
 * to the wallet. Nothing is submitted from here.
 *
 * The asset code comes from the anchor. It used to be the literal 'USDC' no
 * matter what the anchor had said, with only the issuer taken from the response:
 * an anchor exiting any other asset would have been paid in USDC, and the
 * payment would have been refused or, worse, accepted as the wrong asset.
 */
export async function buildAnchorPaymentTx(
  destination: string,
  amount: string,
  assetIssuer: string | undefined,
  memo: string,
  source: string,
  assetCode: string = 'USDC'
): Promise<any> {
  const horizon = new StellarSdk.Horizon.Server(HORIZON_URL);
  const account = await horizon.loadAccount(source);
  const code = String(assetCode || 'USDC').trim();
  if (!/^[A-Za-z0-9]{1,12}$/.test(code)) {
    throw new Error(`the anchor named an asset code this cannot build a payment for: "${code}"`);
  }
  if (code !== 'XLM' && !assetIssuer) {
    throw new Error(`the anchor named ${code} but no issuer, so there is no asset to pay`);
  }
  const asset = code === 'XLM'
    ? StellarSdk.Asset.native()
    : new StellarSdk.Asset(code, assetIssuer || USDC_ISSUER_FALLBACK);
  if (!/^\d+$/.test(String(memo))) {
    throw new Error(`the anchor asked for a memo of type id; "${memo}" is not numeric`);
  }
  if (!/^\d+(\.\d{1,7})?$/.test(String(amount))) {
    throw new Error(`the anchor asked for an amount this cannot send: "${amount}"`);
  }
  return new StellarSdk.TransactionBuilder(account, { fee: '10000', networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(StellarSdk.Operation.payment({ destination, asset, amount }))
    .addMemo(StellarSdk.Memo.id(String(memo)))
    .setTimeout(60)
    .build();
}

/**
 * The reason Horizon gave for refusing a transaction.
 *
 * Horizon answers a refused transaction with HTTP 400, and this SDK turns that
 * into a THROWN AxiosError rather than a response object with
 * `successful: false` - verified against the live testnet with a payment that
 * cannot be funded. The reason lives in the problem document hanging off the
 * error, and `extras.result_codes` is the part that tells a reader WHICH
 * precondition they missed (`op_underfunded`, `op_no_trust`, `tx_bad_seq`).
 */
function horizonRefusal(error: any): { detail: string; codes: any; hash: string | null; status: number | null } {
  const response = error && error.response;
  const data = (response && response.data) || null;
  const status = response && typeof response.status === 'number' ? response.status : null;
  if (!data) {
    return { detail: String((error && error.message) || error), codes: null, hash: null, status };
  }
  const codes = data.extras && data.extras.result_codes ? data.extras.result_codes : null;
  const parts: string[] = [];
  if (codes && codes.transaction) parts.push(String(codes.transaction));
  if (codes && codes.operations) parts.push(([] as any).concat(codes.operations).join(', '));
  const detail = parts.length
    ? parts.join(': ')
    : String(data.detail || data.title || (status ? `Horizon answered ${status}` : 'Horizon refused the transaction'));
  return { detail, codes, hash: typeof data.hash === 'string' ? data.hash : null, status };
}

/**
 * Submits an already-signed classic transaction to Horizon AND says whether the
 * ledger accepted it.
 *
 * It used to return `result.hash` unconditionally. A hash exists for a
 * transaction that FAILED too, so a payment the network refused could be
 * reported to the reader as "Paid the anchor" - the worst possible answer from a
 * button that moves money. Both refusal shapes are handled now: the thrown one
 * this SDK actually produces, and the returned one it documents.
 */
export async function submitClassic(signedXdr: string): Promise<{ hash: string; ledger: number | null }> {
  const horizon = new StellarSdk.Horizon.Server(HORIZON_URL);
  const transaction = StellarSdk.TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
  let result: any;
  try {
    result = await horizon.submitTransaction(transaction as any);
  } catch (error) {
    const refusal = horizonRefusal(error);
    const failure: any = new Error(`the ledger rejected the payment (${refusal.detail})`);
    failure.hash = refusal.hash;
    failure.codes = refusal.codes;
    failure.status = refusal.status;
    throw failure;
  }
  if (!result.successful) {
    const codes = result.extras && result.extras.result_codes;
    const detail = codes
      ? `${codes.transaction || 'transaction'}${codes.operations ? ': ' + ([] as any).concat(codes.operations).join(', ') : ''}`
      : 'Horizon returned the transaction without marking it successful';
    const failure: any = new Error(`the ledger rejected the payment (${detail})`);
    failure.hash = result.hash || null;
    failure.codes = codes || null;
    throw failure;
  }
  return { hash: result.hash, ledger: typeof result.ledger === 'number' ? result.ledger : null };
}

/**
 * Turns a failed simulation into something a person can act on.
 *
 * The RPC's `error` field is the host's own dump: a `HostError` line followed by
 * the diagnostic event log, newest first. Printing it as JSON - which is what the
 * burn button did - produced a wall of escaped text in the console log, so a
 * reader who hit a perfectly ordinary state (no trustline for the wrapped asset)
 * could not tell that from a broken deployment, and the button read as dead.
 *
 * The root cause is the DEEPEST diagnostic, which in a newest-first log is the
 * last entry carrying a human sentence, so that is the one lifted out. Verified
 * against the live testnet gateway: for an account with no wrapped-asset
 * trustline this returns "trustline entry is missing for account", which is
 * exactly the thing the reader needs to know.
 */
export function explainSimulation(sim: any): string {
  const raw = String((sim && sim.error) || '');
  if (!raw) return 'the RPC reported a simulation failure without saying why';
  const headMatch = /(HostError:\s*Error\([^)]*\)|HostError:[^\n]*)/.exec(raw);
  const head = headMatch ? headMatch[1].trim() : raw.split('\n')[0].slice(0, 120);

  // Every diagnostic payload, in the order the log gives them (newest first).
  const payloads = [...raw.matchAll(/data:\s*(.+)$/gm)].map((m) => m[1].trim());
  const sentenceOf = (payload: string): string | null => {
    // data:["trustline entry is missing for account", G...]
    const led = /^\[\s*"([^"]{4,})"/.exec(payload);
    if (led) return led[1];
    // data:"escalating error to VM trap from failed host function call: call"
    const quoted = /^"([^"]{4,})"$/.exec(payload);
    if (quoted) return quoted[1];
    return null;
  };
  let cause: string | null = null;
  for (let i = payloads.length - 1; i >= 0; i -= 1) {
    const sentence = sentenceOf(payloads[i]);
    if (sentence) { cause = sentence; break; }
  }
  const detail = cause || payloads[payloads.length - 1] || raw.slice(0, 240);
  return `${head} - ${String(detail).slice(0, 240)}`;
}

/** Submits an already-signed Soroban transaction to the RPC. Does not wait. */
export async function submitSoroban(signedXdr: string): Promise<any> {
  const transaction = StellarSdk.TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
  return server.sendTransaction(transaction as any);
}

/**
 * What Horizon says about a transaction hash, or null when it does not know yet.
 *
 * This is the verdict source, and the choice is not stylistic: the RPC's own
 * `getTransaction` throws out of this SDK's XDR parser on the current testnet
 * (`TypeError: Bad union switch: 4`, from parseTransactionInfo) for a
 * transaction that Horizon reports as successful. Polling it therefore never
 * yields a verdict, and a console that polled it announced "still pending" for a
 * burn that had already landed on the ledger - which reads exactly like a button
 * that does nothing. Horizon answers plain JSON with `successful` and `ledger`,
 * so it is asked first and the RPC is only a fallback for a deployment that
 * cannot reach Horizon at all.
 */
async function ledgerVerdict(hash: string): Promise<{ status: string; ledger: number | null; detail: string | null } | null> {
  try {
    const response = await fetch(`${HORIZON_URL}/transactions/${encodeURIComponent(hash)}`);
    if (response.status === 404) return null; // not indexed yet
    if (response.ok) {
      const body: any = await response.json();
      const codes = body.result_codes || null;
      const detail = codes
        ? [codes.transaction, ...([] as any).concat(codes.operations || [])].filter(Boolean).join(': ')
        : null;
      return {
        status: body.successful ? 'SUCCESS' : 'FAILED',
        ledger: typeof body.ledger === 'number' ? body.ledger : null,
        detail,
      };
    }
  } catch {
    // Horizon unreachable: fall through to the RPC rather than giving up.
  }
  try {
    const found: any = await server.getTransaction(hash);
    const status = found && found.status;
    if (status === 'SUCCESS' || status === 'FAILED') {
      return {
        status,
        ledger: typeof found.ledger === 'number' ? found.ledger : null,
        detail: status === 'FAILED' && found.resultXdr ? describeResultXdr(found.resultXdr) : null,
      };
    }
  } catch {
    // the parser failure documented above; a transient RPC error is not a verdict
  }
  return null;
}

/**
 * Submits an already-signed Soroban transaction and waits for the ledger's own
 * verdict.
 *
 * `sendTransaction` only reports that the RPC accepted the transaction for
 * inclusion; its status is PENDING at that moment. Treating PENDING as done -
 * which is what the burn button did - meant the console announced success, read
 * the balances back before the ledger had applied anything, showed numbers that
 * had not moved, and left the reader concluding the button does nothing. A
 * submission is not an outcome. This waits for one and reports which it got.
 *
 * On timeout it says so honestly rather than claiming either result: the
 * transaction may still land, and the hash is returned so it can be looked up.
 */
export async function submitSorobanAndConfirm(
  signedXdr: string,
  { timeoutMs = 90000, pollMs = 1500 }: { timeoutMs?: number; pollMs?: number } = {}
): Promise<{ hash: string; status: string; ledger: number | null; timedOut: boolean }> {
  const sent: any = await submitSoroban(signedXdr);
  const hash = sent && sent.hash;
  if (!hash) throw new Error(`the RPC accepted nothing: ${JSON.stringify(sent).slice(0, 300)}`);
  if (sent.status && sent.status !== 'PENDING' && sent.status !== 'SUCCESS') {
    throw new Error(`the RPC refused the submission: ${sent.errorResult ? JSON.stringify(sent.errorResult) : sent.status}`);
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const verdict = await ledgerVerdict(hash);
    if (verdict && verdict.status === 'SUCCESS') {
      return { hash, status: 'SUCCESS', ledger: verdict.ledger, timedOut: false };
    }
    if (verdict && verdict.status === 'FAILED') {
      const failure: any = new Error(`the ledger rejected the transaction (${verdict.detail || 'no result code was given'})`);
      failure.hash = hash;
      throw failure;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return { hash, status: 'PENDING', ledger: null, timedOut: true };
}

/**
 * Names a transaction result code from its XDR.
 *
 * A raw `resultXdr` is 200 bytes of base64 to a reader. The top-level code
 * (`txFAILED`, `txBAD_SEQ`, `txINSUFFICIENT_BALANCE`) is one lookup away and is
 * usually enough to know which of the three things went wrong: the transaction,
 * the account, or the contract. Anything deeper is left to the explorer, which
 * is better at it than this file would be.
 */
export function describeResultXdr(resultXdr: string): string {
  try {
    const parsed = StellarSdk.xdr.TransactionResult.fromXDR(resultXdr, 'base64');
    const code = parsed.result().code();
    return code && code.name ? String(code.name) : 'unknown result code';
  } catch {
    return 'an undecodable result';
  }
}
