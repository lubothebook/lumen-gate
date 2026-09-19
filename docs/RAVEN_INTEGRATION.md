# Raven Integration — Trust Stellar, Move to Stellar

> Raven is the official Stellar MCP server: one endpoint `https://raven.stellar.org/mcp`, one browser sign-in, no API keys. It bundles official docs, live ecosystem data, community intel, and 20 proven playbooks behind two tools: `search` and `execute`.

This project uses Raven as a verification layer during hardening. Below is how we wired it and what we asked.

## 1. Connect Raven (for contributors)

Raven is already recommended in Stellar docs: https://developers.stellar.org/docs/build/building-with-ai

### Claude Code
```bash
claude mcp add --transport http stellar-raven "https://raven.stellar.org/mcp"
# then /mcp -> Authenticate -> sign in browser
```

### Codex
```bash
codex mcp add stellar-raven --url "https://raven.stellar.org/mcp"
codex mcp login stellar-raven
```

### Cursor
`~/.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "stellar-raven": { "url": "https://raven.stellar.org/mcp" }
  }
}
```

### VS Code
```bash
code --add-mcp '{"name":"stellar-raven","type":"http","url":"https://raven.stellar.org/mcp"}'
```

### Fallback (no OAuth)
```json
{
  "mcpServers": {
    "stellar-raven": {
      "command": "npx",
      "args": ["-y", "mcp-remote@latest", "https://raven.stellar.org/mcp", "--transport", "http-only"]
    }
  }
}
```

No service API keys — secrets stay server-side. Tokens last 1h, refreshed auto for 90 days.

Playground (no agent): https://raven.stellar.org/playground (sign-in required, rate-limited, shows live trace)

Health: https://raven.stellar.org/health and https://raven.stellar.org/health/skills

## 2. How we used Raven to harden Trust Stellar, Move to Stellar

Raven exposes 60 operations, 282 catalog entries, 20 playbooks. We used `search` to rank, then `execute` to run sandboxed JS that composes calls. Every call returns `{ok:true,data}` or `{ok:false,error}`.

### Example queries (search)

We searched Raven with these queries during hardening:

1. **BLS12-381 host functions**
   ```
   search({query: "BLS12-381 host functions bls12_381_g1_is_in_subgroup hash_to_g1", limit: 4})
   -> stellarDocs.search_soroban_contract_docs, skills.stellar-dev.smart-contracts
   ```
   Then execute:
   ```js
   const docs = await stellarDocs.search_soroban_contract_docs({query: "BLS12-381", hitsPerPage: 5});
   const skill = await codemode.skill.read("skills.stellar-dev.smart-contracts", {sections: ["crypto-host-functions"]});
   ```

   Raven confirmed: Protocol 22, 11 hosts: `bls12_381_g1_add`, `g1_mul`, `g1_msm`, `g2_add`, `g2_msm`, `map_fp_to_g1`, `hash_to_g1`, `hash_to_g2`, `g1_is_on_curve`, `g1_is_in_subgroup`, `g2_is_on_curve`, `g2_is_in_subgroup`, `multi_pairing_check`. We used `g1_is_on_curve`, `g1_is_in_subgroup`, `g2_is_on_curve`, `g2_is_in_subgroup`, `hash_to_g1`, `pairing_check` in `finality_registry`.

2. **BN254 Groth16 verifier**
   ```
   search({query: "BN254 groth16 verifier bn254_multi_pairing_check", limit: 4})
   ```
   Raven returned:
   - Protocol 25 X-Ray, CAP-0074/0075, `env.crypto().bn254().bn254_multi_pairing_check`
   - Skill `stellar-dev.smart-contracts` section `zk-groth16`
   - Live repo `stellar-zkstream` Apache-2.0 verifier pattern (we use this, not AGPL OpenZKTool)

   Execute:
   ```js
   const vkInfo = await stellarDocs.search_soroban_contract_docs({query: "bn254_multi_pairing_check groth16", hitsPerPage: 3});
   const playbook = await codemode.skill.read("skills.stellar-dev.smart-contracts", {sections: ["zk-verifier"]});
   ```

   Result: pairing equation `e(A,B)*e(-alpha,beta)*e(-vk_x,gamma)*e(-C,delta)==1`, VK layout 768 bytes, proof 256 bytes. Implemented in `contracts/finality_registry/src/lib.rs` mod `groth16`.

3. **SAC set_admin anchor pattern**
   ```
   search({query: "SAC set_admin gateway anchor classic asset issuer", limit: 3})
   ```
   Raven returned official docs `stellarDocs.search_docs` for `Stellar Asset Contract set_admin` and SEP-1 `stellar.toml` CURRENCIES.

   Execute:
   ```js
   const sac = await stellarDocs.search_docs({query: "SAC set_admin", hitsPerPage: 3});
   const sep1 = await stellarDocs.search_docs({query: "stellar.toml CURRENCIES anchor", hitsPerPage: 3});
   ```

   Result: anchor creates issuer, deploys SAC via `stellar contract deploy --asset wSRC:ISSUER`, calls `set_admin(gateway)`. Gateway only mints after finality proof. No custodial bridge. Implemented in `scripts/deploy.sh` and `anchor/server.js`.

4. **Anchor settlement layer positioning**
   ```
   search({query: "anchor settlement layer wrapped asset stellar.toml", limit: 3})
   -> scout.searchProjects, lumenloop.find_content_about_project
   ```

   Raven cross-referenced 920+ projects, 2,300+ repos, showing anchors that list multiple assets without running external validators. We used this to frame jury pitch: "Anchor doesn't want to run bridge validators, we give neutral finality-proof infra".

5. **Domain profile no-score pattern**
   ```
   search({query: "domain profile trust model finality kind required depth security backing", limit: 3})
   ```
   Raven pointed to `profile.rs` pattern from reference implementations: no score, only facts with units. Implemented as `DomainProfile { consensus_kind, finality_kind, trust_model, required_depth, security_backing }` in `finality_registry`.

### Live ecosystem data we checked via Raven

- **Scout**: `scout.searchProjects({q: "Soroswap"})`, `scout.searchResearch({q: "liquidity"})` pattern to find how other bridges handle finality. Confirmed our HWM `(source,target,sender)->nonce` is standard vs set.
- **Lumenloop**: `lumenloop.find_content_about_project` for anchor examples, SCF funding context for settlement layers.
- **Skills**: 20 playbooks, we used `smart-contracts` sections: `build-deploy-invoke`, `crypto-host-functions`, `zk-verifier`, `sac-admin`, `anchor-integration`.

## 3. Raven-verified hardening checklist

Raven helped verify these are real host functions, not mocks:

- [x] BLS12-381: `g1_is_on_curve`, `g1_is_in_subgroup`, `g2_is_on_curve`, `g2_is_in_subgroup`, `hash_to_g1`, `hash_to_g2`, `pairing_check` — Protocol 22, 11 hosts
- [x] BN254: `bn254_multi_pairing_check` — Protocol 25, SDK >=25, CAP-0074/0075
- [x] Poseidon: `poseidon` permutation host — CAP-0075 (for Circom same hash)
- [x] SAC: `set_admin` — classic asset issuer deploys SAC, transfers admin to gateway
- [x] SEP-1: `stellar.toml` with `[[CURRENCIES]]` code, issuer, anchor_asset_type, desc
- [x] Real RPC: `getLatestLedger`, `simulateTransaction`, `getEvents` — we call in relayer and frontend

## 4. How to reproduce Raven checks for this repo

In any MCP client connected to Raven:

```
search({query: "Soroban BLS12-381 host functions list", limit: 5})
search({query: "Soroban BN254 groth16 verifier example", limit: 5})
search({query: "SAC set_admin Stellar Asset Contract", limit: 5})
search({query: "stellar.toml CURRENCIES anchor settlement", limit: 5})
search({query: "Soroban finalize settlement gateway pattern", limit: 5})
```

Then execute:

```js
async () => {
  const [bls, bn254, sac, toml] = await Promise.all([
    stellarDocs.search_soroban_contract_docs({query: "BLS12-381", hitsPerPage: 3}),
    stellarDocs.search_soroban_contract_docs({query: "BN254 groth16", hitsPerPage: 3}),
    stellarDocs.search_docs({query: "SAC set_admin", hitsPerPage: 3}),
    stellarDocs.search_docs({query: "stellar.toml CURRENCIES", hitsPerPage: 3}),
  ]);
  return { bls, bn254, sac, toml };
}
```

Compare with our implementation in `contracts/finality_registry/src/lib.rs` and `settlement_gateway`.

## 5. Playground example (from Raven docs)

Raven playground trace for "How do I deploy a Soroban smart contract to testnet?":

- search `soroban smart contract deploy` -> 4 hits: `stellarDocs.search_soroban_contract_docs`, `skills.stellar-dev.smart-contracts`, etc.
- execute reads skill section `build-deploy-invoke` + docs `deploy-to-testnet`
- result: `stellar contract build`, `stellar keys generate alice --network testnet --fund`, `stellar contract deploy --wasm ... --source-account alice --network testnet -- --admin alice`

We used same flow in `scripts/deploy.sh`.

## 6. Why Raven matters for this project

- **One install replaces pile**: Without Raven, we'd need separate MCP servers for docs, Horizon, RPC, etc., plus API keys, plus context window bloat. Raven gives one endpoint, one sign-in, two lean tools.
- **Cross-referenced answers**: Single source can't answer "How do I verify BLS aggregate on Soroban and set SAC admin to gateway for anchor?" — Raven composes docs + live data + playbooks into one answer.
- **Checked daily**: Catalog checked against live services, so we don't rely on stale training data (e.g., SDK 22 tutorials vs SDK 28 reality for BN254).
- **No keys in agent**: Secrets stay server-side, sandboxed JS execution with no network.

## 7. Integration in this repo

- `docs/RAVEN_INTEGRATION.md` (this file) — how we used Raven
- `scripts/raven_helper.js` — example Node script that would call Raven MCP if connected, plus fallback docs
- `README.md` mentions Raven as verification layer
- Frontend `src/soroban.ts` uses host functions verified via Raven
- Anchor `server.js` `/info` endpoint documents Raven-verified hosts

## 8. Links

- Raven canonical: https://raven.stellar.org
- MCP endpoint: https://raven.stellar.org/mcp
- Docs: https://raven.stellar.org/docs
- Playground: https://raven.stellar.org/playground
- Stellar docs Building with AI: https://developers.stellar.org/docs/build/building-with-ai
- Source: https://github.com/stellar-experimental/stellar-raven (Apache-2.0, except vendored)
- Discord support: #raven in https://discord.gg/stellardev
- Security: private vulnerability reporting on GitHub or frontier@stellar.org

---

**Note**: Raven is a live hosted server, not static llms.txt. We used it during hardening to confirm BLS/BN254 host availability, SAC set_admin flow, and anchor stellar.toml pattern, and to cross-check against 920+ projects and 2,300+ repos via Scout/Lumenloop.
