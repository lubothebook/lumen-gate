import * as sdk from '@stellar/stellar-sdk';
const xdr = sdk.xdr;

async function getSpec(contractStrkey) {
  const idBytes = Uint8Array.from(sdk.StrKey.decodeContract(contractStrkey));
  const key = new xdr.LedgerKey([
    xdr.LedgerKey.CONTRACT_DATA,
    new xdr.LedgerKeyContractData(idBytes, new xdr.ScVal(xdr.ScVal.scvSymbol, 'spec'), 0)
  ]);
  const res = await fetch('https://soroban-testnet.stellar.org/rpc/v20/getLedgerEntries', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLedgerEntries', params: { keys: [key.toXDR('base64')] } })
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  const entry = j.result.entries && j.result.entries[0] && j.result.entries[0].data && j.result.entries[0].data.contractData;
  if (!entry) throw new Error('no spec entry');
  const fns = xdr.ContractSpec.fromXDR(entry.val.toXDR('base64')).value;
  return fns.filter(f => f.type() === xdr.ContractSpec.FUNCTION).map(f => {
    const fn = f.value();
    const args = fn.input().map(a => a.naming().name() + ':' + a.type().xdr_name()).join(', ');
    const out = fn.output() ? ' -> ' + fn.output().type().xdr_name() : '';
    return fn.name().toString() + '(' + args + ')' + out;
  });
}

for (const [name, id] of process.argv.slice(2).map(t => t.split(':'))) {
  console.log('== ' + name + ' ==');
  try { for (const f of await getSpec(id)) console.log('  ' + f); } catch (e) { console.log('  ERR', e.message); }
}
