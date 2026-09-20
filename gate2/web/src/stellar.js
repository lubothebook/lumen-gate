import {
  SorobanRpc,
  Contract,
  scValToNative,
  nativeToScVal,
  Address,
  TransactionBuilder,
  BASE_FEE,
  Asset,
  Operation,
  Horizon,
  Account,
} from "@stellar/stellar-sdk";
import {
  requestAccess as officialRequestAccess,
  getAddress as officialGetAddress,
  getNetwork as officialGetNetwork,
  signTransaction as officialSignTransaction,
  setAllowed as officialSetAllowed,
  isConnected as officialIsConnected,
} from "@stellar/freighter-api";
import { CONFIG } from "./config.js";

const server = new SorobanRpc.Server(CONFIG.rpcUrl);
const horizon = new Horizon.Server(CONFIG.horizonUrl);
const USDC = new Asset("USDC", CONFIG.usdcIssuer);
export const EXPLORER_TX = "https://stellar.expert/explorer/testnet/tx/";
export const EXPLORER_ACCOUNT = "https://stellar.expert/explorer/testnet/account/";

export async function readContract(contractId, method, args = []) {
  const contract = new Contract(contractId);
  // The type hint is an options object, not a bare string: nativeToScVal(v, "i128")
  // silently ignores the hint and encodes a BigInt as scvU64, so a contract
  // expecting i128 (the Battery's deposit/withdraw amounts) received the wrong
  // shape and the VM refused with InvalidAction before the call ever ran.
  // Passing { type } makes the hint do what its callers meant.
  const scArgs = args.map((a) => (a.scVal !== undefined ? a.scVal : nativeToScVal(a.value, { type: a.type })));
  const raw = contract.call(method, ...scArgs);
  const account = new Account(CONFIG.deployerPublicKey, "0");
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: CONFIG.networkPassphrase,
  })
    .addOperation(raw)
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    return { ok: false, error: sim.error };
  }
  let value = null;
  try {
    value = scValToNative(sim.result.retval);
  } catch {
    value = sim.result.retval;
  }
  return { ok: true, value, restore: sim.restorePreamble || null };
}

export const addrScVal = (g) => new Address(g).toScVal();

export async function hasUsdcTrustline(g) {
  const res = await fetch(`${CONFIG.horizonUrl}/accounts/${g}`);
  if (res.status === 404) return { exists: false, trusted: false, balances: [] };
  if (!res.ok) throw new Error(`horizon ${res.status}`);
  const data = await res.json();
  const trusted = (data.balances || []).some(
    (b) => b.asset_code === "USDC" && b.asset_issuer === CONFIG.usdcIssuer
  );
  return { exists: true, trusted, balances: data.balances, account: data };
}

export async function friendbot(g) {
  const res = await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(g)}`);
  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text.slice(0, 240) };
  }
  return {
    ok: res.ok,
    hash: payload.hash || payload?.result?.hash,
    payload,
    status: res.status,
  };
}

function walletAddressFrom(answer) {
  if (!answer) return null;
  if (typeof answer === "string") return answer.trim() || null;
  if (answer.error) return null;
  const candidate = answer.address || answer.publicKey || answer.public_key;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

function walletReasonFrom(answer) {
  if (!answer || typeof answer === "string") return null;
  if (answer.error) return String(answer.error.message || answer.error);
  if (answer.message && !walletAddressFrom(answer)) return String(answer.message);
  return null;
}

const officialFreighter = {
  __lumenOfficial: true,
  requestAccess: officialRequestAccess,
  getAddress: officialGetAddress,
  getNetwork: officialGetNetwork,
  signTransaction: officialSignTransaction,
  setAllowed: officialSetAllowed,
  isConnected: officialIsConnected,
};

export function embeddedFrame() {
  try { return window.top !== window.self; } catch { return true; }
}

function injectedFreighter() {
  const injected =
    window.freighterApi ||
    window.freighter ||
    window.stellar?.freighter ||
    window.stellar?.Freighter ||
    window.stellar?._wallets?.find?.((w) => /freighter/i.test(w.name || w.id || "")) ||
    null;
  if (injected && typeof injected.requestAccess === "function") return injected;
  return null;
}

/**
 * Injected window.freighterApi is the content-script door (and the harness).
 * The npm module talks over postMessage; without the content script,
 * requestAccess never opens a popup and never resolves. Docs require
 * isConnected() first in that path. Do not treat the npm wrapper itself
 * as "Freighter is here".
 */
export async function detectFreighter() {
  const injected = injectedFreighter();
  if (injected) return { installed: true, api: injected, via: "injected" };
  try {
    const status = await Promise.race([
      officialIsConnected(),
      new Promise((resolve) => setTimeout(() => resolve({ isConnected: false, timeout: true }), 2500)),
    ]);
    const installed = Boolean(status && status.isConnected);
    return { installed, api: officialFreighter, via: "official", status };
  } catch (error) {
    return { installed: false, api: officialFreighter, via: "official", error };
  }
}

export function getFreighter() {
  return injectedFreighter() || officialFreighter;
}

export function watchFreighter(cb) {
  let done = false;
  const fire = () => {
    if (done) return;
    detectFreighter().then((d) => {
      if (done) return;
      if (d.installed) {
        done = true;
        cb(d.api);
      }
    });
  };
  fire();
  const t = setInterval(fire, 400);
  const stop = setTimeout(() => {
    clearInterval(t);
    if (!done) cb(null);
  }, 8000);
  window.addEventListener("focus", fire);
  return () => {
    clearInterval(t);
    clearTimeout(stop);
  };
}

export async function freighterConnect(f) {
  if (f.__lumenOfficial && typeof f.isConnected === "function") {
    // The official module has exactly one door that opens the wallet:
    // requestAccess(). Asking it through several doors would open the popup
    // several times, so it is asked once. Without an extension it never
    // answers (the module only times out its *status* call, not its access
    // call), so the status call carries the "not installed" signal: it
    // resolves through the module's own two-second timeout, and a status
    // that arrives that slowly is that timeout. A fast status means the
    // extension is present and the access popup is the decision.
    const started = Date.now();
    try {
      const answer = await Promise.race([
        Promise.resolve()
          .then(() => f.isConnected())
          .then((status) => {
            if (status && status.isConnected) return new Promise(() => {});
            if (Date.now() - started >= 1900) {
              throw new Error("The Stellar Freighter extension is not installed. Install it, then reconnect.");
            }
            return new Promise(() => {});
          }),
        f.requestAccess(),
      ]);
      const address = walletAddressFrom(answer);
      if (!address) throw new Error(walletReasonFrom(answer) || "requestAccess returned no address");
      return address;
    } catch (error) {
      throw new Error(error && error.message ? error.message : String(error));
    }
  }
  const attempts = [];
  const doors = [
    ["requestAccess", "requestAccess", () => f.requestAccess()],
    ["getAddress", "getAddress", () => f.getAddress()],
    ["getPublicKey", "getPublicKey", () => f.getPublicKey()],
    ["setAllowed+getPublicKey", "setAllowed", async () => {
      await f.setAllowed();
      return f.getPublicKey ? f.getPublicKey() : f.getAddress();
    }],
  ];
  for (const [label, method, open] of doors) {
    if (typeof f[method] !== "function") continue;
    try {
      const answer = await open();
      const address = walletAddressFrom(answer);
      if (address) return address;
      attempts.push(`${label}: ${walletReasonFrom(answer) || "no address"}`);
    } catch (error) {
      attempts.push(`${label}: ${error && error.message ? error.message : String(error)}`);
    }
  }
  const why = attempts.length ? attempts[attempts.length - 1] : "extension returned no address";
  throw new Error(why);
}

async function signXdr(f, xdr, addr) {
  const signedXdr = await f.signTransaction(xdr, {
    address: addr,
    networkPassphrase: CONFIG.networkPassphrase,
  });
  // A wallet refusal can come back as { error } instead of a rejection;
  // reading signedTxXdr from it would hand "" to the chain, so the error
  // shape is separated before the XDR is read.
  const reason = signedXdr?.error?.message
    || (signedXdr?.error ? String(signedXdr.error) : null)
    || signedXdr?.message;
  if (reason) throw new Error(`Freighter refused to sign: ${reason}`);
  const signed = typeof signedXdr === "string" ? signedXdr : signedXdr?.signedTxXdr || signedXdr?.xdr;
  if (!signed) throw new Error("Freighter did not return a signed XDR");
  return signed;
}

// 90s, not 45: on slow testnet days the ledger takes longer than 45s to
// confirm a submitted tx, and a button that reports TIMEOUT while the tx
// lands a ledger later is lying by impatience. The wait stays bounded.
export async function waitSoroban(hash, timeoutMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await server.getTransaction(hash);
      if (r.status === "SUCCESS") return { ok: true, status: r.status, tx: r };
      if (r.status === "FAILED") return { ok: false, status: r.status, tx: r };
    } catch {
      /* NOT_FOUND while pending */
    }
    await new Promise((res) => setTimeout(res, 1200));
  }
  return { ok: false, status: "TIMEOUT" };
}

/**
 * Signs and sends one contract call with the session address Connect
 * verified. The address is a parameter, never re-asked: calling
 * requestAccess again from an action button re-opens the wallet popup (and a
 * second access request mid-page is exactly what the browser refuses), so
 * the session address is what signs.
 */
export async function sendWithFreighter(f, addr, contractId, method, args = []) {
  if (!addr) throw new Error("Connect Freighter first");
  const contract = new Contract(contractId);
  // The type hint is an options object, not a bare string: nativeToScVal(v, "i128")
  // silently ignores the hint and encodes a BigInt as scvU64, so a contract
  // expecting i128 (the Battery's deposit/withdraw amounts) received the wrong
  // shape and the VM refused with InvalidAction before the call ever ran.
  // Passing { type } makes the hint do what its callers meant.
  const scArgs = args.map((a) => (a.scVal !== undefined ? a.scVal : nativeToScVal(a.value, { type: a.type })));
  const raw = contract.call(method, ...scArgs);
  const account = await server.getAccount(addr);
  const tx = new TransactionBuilder(account, {
    fee: "100000",
    networkPassphrase: CONFIG.networkPassphrase,
  })
    .addOperation(raw)
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) return { ok: false, error: sim.error };
  const prepared = SorobanRpc.assembleTransaction(tx, sim).build();
  const signed = await signXdr(f, prepared.toEnvelope().toXDR("base64"), addr);
  const sent = await server.sendTransaction(TransactionBuilder.fromXDR(signed, CONFIG.networkPassphrase));
  if (!(sent.status === "PENDING" || sent.hash)) {
    return { ok: false, error: sent.errorResult || sent.status, hash: sent.hash, status: sent.status };
  }
  const waited = await waitSoroban(sent.hash);
  return {
    ok: waited.ok,
    hash: sent.hash,
    status: waited.status || sent.status,
    error: waited.ok ? null : waited.status,
  };
}

export async function openUsdcTrustline(f, addr) {
  if (!addr) throw new Error("Connect Freighter first");
  const account = await horizon.loadAccount(addr);
  const tx = new TransactionBuilder(account, {
    fee: "100000",
    networkPassphrase: CONFIG.networkPassphrase,
  })
    .addOperation(Operation.changeTrust({ asset: USDC }))
    .setTimeout(60)
    .build();
  const signed = await signXdr(f, tx.toXDR(), addr);
  const result = await horizon.submitTransaction(
    TransactionBuilder.fromXDR(signed, CONFIG.networkPassphrase)
  );
  // A Horizon response ALWAYS carries a hash, even when the transaction
  // failed on chain. "ok" must follow `successful`, or the UI would print
  // "Trustline opened" for a rejected tx.
  if (result.successful === true) return { ok: true, hash: result.hash, result };
  return {
    ok: false,
    hash: result.hash,
    result,
    error:
      result.exceptions ||
      "transaction was submitted but failed on chain — open the hash to inspect",
  };
}
