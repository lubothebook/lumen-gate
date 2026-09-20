// Fetch contract WASM from testnet, parse "contractspecv0" (V0 spec) manually.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const server = new (require('@stellar/stellar-sdk').rpc.Server)('https://soroban-testnet.stellar.org');

const SC_SPEC_TYPE = ['bool','void','error','u32','i32','u64','i64','u128','i128','u256','i256','bytes','string','symbol','vec','map','tuple','bytestn','udt','result'];

class R {
  constructor(buf) { this.b = buf; this.i = 0; }
  u32() { const v = this.b.readUInt32BE(this.i); this.i += 4; return v; }
  str() { const n = this.u32(); const s = this.b.subarray(this.i, this.i + n).toString('utf8'); this.i += n; this.i += (4 - (n % 4)) % 4; return s; }
  type() {
    const t = this.u32();
    let extra = '';
    if (t === 18) extra = '<' + this.str() + '>';  // udt
    return (SC_SPEC_TYPE[t] || 'type' + t) + extra;
  }
}

async function main() {
  for (const [name, id] of process.argv.slice(2).map(t => t.split(':'))) {
    console.log('== ' + name + ' ==');
    try {
      const hex = await server.getContractWasmByContractId(id);
      const buf = Buffer.from(hex, 'hex');
      let k = 8; let spec = null;
      while (k < buf.length) {
        const cid = buf[k++];
        let size = 0, s = 0;
        for (;;) { const b = buf[k++]; size |= (b & 0x7f) << s; if (!(b & 0x80)) break; s += 7; }
        const end = k + size;
        if (cid === 0) {
          let nl = 0, s2 = 0;
          for (;;) { const b = buf[k++]; nl |= (b & 0x7f) << s2; if (!(b & 0x80)) break; s2 += 7; }
          const cname = buf.subarray(k, k + nl).toString();
          k += nl;
          if (cname === 'contractspecv0') spec = buf.subarray(k, end);
        }
        k = end;
      }
      if (!spec) { console.log('  no contractspecv0 section (wasm ' + buf.length + ' bytes)'); continue; }
      const r = new R(spec);
      const count = r.u32();
      for (let n = 0; n < count; n++) {
        const kind = r.u32();
        if (kind === 0) {
          r.str(); // doc
          const nargs = r.u32();
          const args = [];
          for (let a = 0; a < nargs; a++) { const nm = r.str(); const ty = r.type(); args.push(nm + ':' + ty); }
          const hasOut = r.u32();
          const out = hasOut ? ' -> ' + r.type() : '';
          const fname = r.str();
          console.log('  ' + fname + '(' + args.join(', ') + ')' + out);
        } else if (kind === 1) {
          r.str(); // doc
          const nf = r.u32();
          for (let f = 0; f < nf; f++) { r.str(); r.str(); r.type(); }
          r.str(); // udt name
        } else if (kind === 2) {
          r.str(); // doc
          const nc = r.u32();
          for (let c = 0; c < nc; c++) {
            r.str(); r.str();
            const ck = r.u32();
            if (ck !== 0) r.type();
          }
          r.str(); // udt name
        } else if (kind === 3 || kind === 4) {
          r.str(); // doc
          const nc = r.u32();
          for (let c = 0; c < nc; c++) { r.str(); r.str(); }
          r.str(); // udt name
        } else {
          throw new Error('unknown spec entry kind ' + kind);
        }
      }
    } catch (e) { console.log('  ERR', e.message); }
  }
}
main();
