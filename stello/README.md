# Stello inside Lumen Gate

Inbound path: a TRY bank transfer becomes a Soroban `on_deposit` call with
the USDC already in the contract.

**This uses Stello, Seyit Ali Değirmen’s kit**
([`sayweer/stello`](https://github.com/sayweer/stello),
docs [stello-web-rho.vercel.app/en](https://stello-web-rho.vercel.app/en),
npm `stello-sdk`).
Stellar ambassador **Ezgin Akyürek** reviewed this integration; it was fixed
together with those who recommended it.

The live console is `/stello/`. It talks to Stello’s shared testnet router
and the published piggy-bank example (**route 2**). Lumen Gate has not
registered its own route yet; `stello/contracts/deposit_target` is the
app-side contract, unwired on-chain.

Honest limits, from Stello’s own docs:

- Stellar **testnet** only
- **Mock** Turkish anchor: bank transfers and KYC are simulated
- The **relay is a trusted party**
- Not a Lumen Gate 1.0 settlement claim (no BLS, no gateway mint)

```bash
cd stello/web && npm install && npm run dev
# http://127.0.0.1:5175/stello/
# or via the 1.0 proxy: http://127.0.0.1:5173/stello/
```
