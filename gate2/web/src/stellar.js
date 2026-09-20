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
} from "@stellar/stellar-sdk";
import { CONFIG } from "./config.js";

const server = new SorobanRpc.Server(CONFIG.rpcUrl);
const horizon = new Horizon.Server(CONFIG.horizonUrl);
const USDC = new Asset("USDC", CONFIG.usdcIssuer);
export const EXPLORER_TX = "https://stellar.expert/explorer/testnet/tx/";
export const EXPLORER_ACCOUNT = "https://stellar.expert/explorer/testnet/account/";

export async function readContract(contractId, method, args = []) {
  const contract = new Contract(contractId);
  const scArgs = args.map((a) => (a.scVal !== undefined ? a.scVal : nativeToScVal(a.value, a.type)));
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
  const raw = f.getAddress ? await f.getAddress() : await f.getPublicKey();
  const addr = typeof raw === "string" ? raw : raw?.address || raw?.publicKey;
  if (!addr) throw new Error("Freighter adres vermedi");
  return addr;
}

async function signXdr(f, xdr, addr) {
  const signedXdr = await f.signTransaction(xdr, {
    address: addr,
    networkPassphrase: CONFIG.networkPassphrase,
  });
  const signed = typeof signedXdr === "string" ? signedXdr : signedXdr?.signedTxXdr || signedXdr?.xdr;
  if (!signed) throw new Error("Freighter imzali XDR dondurmedi");
  return signed;
}

export async function waitSoroban(hash, timeoutMs = 45000) {
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

export async function sendWithFreighter(f, contractId, method, args = []) {
  const contract = new Contract(contractId);
  const scArgs = args.map((a) => (a.scVal !== undefined ? a.scVal : nativeToScVal(a.value, a.type)));
  const raw = contract.call(method, ...scArgs);
  const addr = await freighterConnect(f);
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

export async function openUsdcTrustline(f) {
  const addr = await freighterConnect(f);
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
  return { ok: Boolean(result.hash || result.successful), hash: result.hash, result };
}
