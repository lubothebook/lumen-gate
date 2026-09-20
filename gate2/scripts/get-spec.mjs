// Read a contract's on-chain function spec from Soroban testnet.
// Uses @stellar/stellar-base XDR exactly like the SDK's internal getContractData.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const base = require('@stellar/stellar-base');
const xdr = base.xdr;

async function getSpec(contractStrkey) {
  const key = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
    contract: new base.Address(contractStrkey).toScAddress(),
    key: xdr.ScVal.scvSymbol('spec'),
    durability: xdr.ContractDataDurability.persistent()
  }));
  const res = await fetch('https://soroban-testnet.stellar.org', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLedgerEntries', params: { keys: [key.toXDR('base64')] } })
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  const e = j.result.entries && j.result.entries[0];
  if (!e) return null;
  const fns = xdr.ContractSpec.fromXDR(e.val.contractData().val().toXDR('base64')).value;
  return fns.filter(f => f.type() === xdr.ContractSpec.FUNCTION).map(f => {
    const fn = f.value();
    const args = fn.input().map(a => a.naming().name() + ':' + a.type().xdr_name()).join(', ');
    const out = fn.output() ? ' -> ' + fn.output().type().xdr_name() : '';
    return fn.name().toString() + '(' + args + ')' + out;
  });
}

for (const [name, id] of process.argv.slice(2).map(t => t.split(':'))) {
  console.log('== ' + name + ' ==');
  try {
    const fns = await getSpec(id);
    if (!fns) console.log('  (no spec entry)');
    for (const f of fns || []) console.log('  ' + f);
  } catch (e) { console.log('  ERR', e.message); }
}
