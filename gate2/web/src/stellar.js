import {
  SorobanRpc,
  Contract,
  scValToNative,
  nativeToScVal,
  Address,
  TransactionBuilder,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import { CONFIG } from "./config.js";

const server = new SorobanRpc.Server(CONFIG.rpcUrl);

// Read-only contract call: simulate with the deployer account as the
// source (it is funded and public; no signature, no tx is ever sent).
export async function readContract(contractId, method, args = []) {
  const contract = new Contract(contractId);
  const scArgs = args.map((a) => a.scVal !== undefined ? a.scVal : nativeToScVal(a.value, a.type));
  const raw = contract.call(method, ...scArgs);
  const account = await server.getAccount(CONFIG.deployerPublicKey);
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

// Horizon: does this Stellar account already trust the native USDC?
export async function hasUsdcTrustline(g) {
  const res = await fetch(`${CONFIG.horizonUrl}/accounts/${g}`);
  if (res.status === 404) return { exists: false, trusted: false };
  if (!res.ok) throw new Error(`horizon ${res.status}`);
  const data = await res.json();
  const trusted = (data.balances || []).some(
    (b) => b.asset_type === "credit_alphanum4" && b.asset_code === "USDC" && b.asset_issuer === CONFIG.usdc
  );
  return { exists: true, trusted, balances: data.balances };
}

// ---- Freighter: three provider shapes + a late-injection watcher ----
export function getFreighter() {
  if (window.freighter?.signTransaction) return window.freighter;
  if (window.freighterApi?.signTransaction) return window.freighterApi;
  const sep43 = window.stellar?._wallets?.find?.((w) => /freighter/i.test(w.name || w.id || ""));
  if (sep43?.signTransaction) return sep43;
  return null;
}

export function watchFreighter(cb) {
  let done = false;
  const fire = () => {
    if (done) return;
    const f = getFreighter();
    if (f) {
      done = true;
      cb(f);
    }
  };
  fire();
  if (!done) {
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
  return () => {};
}

export async function freighterConnect(f) {
  if (f.isConnected) {
    const ok = await f.isConnected();
    const connected = typeof ok === "object" && ok !== null ? ok.isConnected : ok;
    if (!connected) throw new Error("Freighter bagli degil");
  }
  const raw = await f.getAddress();
  const addr = typeof raw === "string" ? raw : raw?.address;
  if (!addr) throw new Error("Freighter adres vermedi");
  return addr;
}

// Send a real signed tx (claim_tier) through Freighter.
export async function sendWithFreighter(f, contractId, method, args = []) {
  const contract = new Contract(contractId);
  const scArgs = args.map((a) => (a.scVal !== undefined ? a.scVal : nativeToScVal(a.value, a.type)));
  const raw = contract.call(method, ...scArgs);
  const addr = await freighterConnect(f);
  const account = await server.getAccount(addr);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: CONFIG.networkPassphrase,
  })
    .addOperation(raw)
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) return { ok: false, error: sim.error };
  const prepared = SorobanRpc.assembleTransaction(tx, sim).build();
  const signedXdr = await f.signTransaction(prepared.toEnvelope().toXDR("base64"), {
    address: addr,
    networkPassphrase: CONFIG.networkPassphrase,
  });
  const signed = typeof signedXdr === "string" ? signedXdr : signedXdr?.signedTxXdr || signedXdr?.xdr;
  const sent = await server.sendTransaction(
    TransactionBuilder.fromXDR(signed, CONFIG.networkPassphrase)
  );
  return { ok: sent.status === "PENDING" || !!sent.hash, hash: sent.hash, status: sent.status };
}
