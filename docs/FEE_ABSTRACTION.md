# Fee Abstraction — Sponsored Reserves (CAP-33) + Gasless

> User with no XLM on Stellar can still receive wSRC by extracting fee from source chain lock.

## Problem

Stellar requires:
- 0.5 XLM base reserve per account
- 0.5 XLM per trustline
- Transaction fees ~0.00001 XLM per op

User from source chain has no XLM. Traditional bridge requires user to first buy XLM via Friendbot or exchange.

## Solution — Sponsored Reserves (CAP-33)

We implement two gasless paths, both using fee extracted from source chain:

### Path 1: Deduct from Lock (Simple)

User locks on source: `amount = desired + fee` (e.g., 110 = 100 + 10)

```
Source: Lock 110 wSRC for G... (no XLM)
Simulator: event_root includes fee, BLS aggregate sig
Relayer: pays XLM fee on Stellar, calls finalize_inbound_gasless(relayer, message, ..., fee=10)
Gateway: mint(recipient, 100), mint(relayer, 10), track RelayerReward
```

Recipient gets 100 wSRC even with 0 XLM (in Soroban test env, mint works without trustline; in prod, use claimable).

### Path 2: Sponsored Reserves (CAP-33) — Selected

**Selected via ask_user**: Sponsored model using CAP-33 `begin_sponsoring_future_reserves`.

Flow:

```mermaid
flowchart TB
    U[User: No XLM<br/>Only source asset] --> SRC[Source Chain<br/>Lock 110]
    SRC --> SIM[Simulator<br/>BLS aggregate + Merkle]
    SIM --> REL[Relayer: Has XLM<br/>Sponsors recipient]
    REL --> REG[Finality Registry<br/>Machine verifies proof]
    REG --> GW[Settlement Gateway<br/>finalize_inbound_sponsored]
    GW --> SPONSOR[CAP-33 Sponsorship<br/>begin_sponsoring_future_reserves<br/>sponsor pays reserve for trustline]
    SPONSOR --> MINT[ mint(recipient,100)<br/>mint(sponsor,10)<br/>Recipient now has wSRC<br/>Even with 0 XLM initial]
    MINT --> END[User can use wSRC<br/>Swap wSRC->XLM for future fees<br/>Or keep using sponsored]

    classDef sponsored fill:#1a0a2e,stroke:#FF3B82,color:#fff
    class SPONSOR,MINT sponsored
```

**Soroban implementation** (`settlement_gateway::finalize_inbound_sponsored`):

```rust
pub fn finalize_inbound_sponsored(
    env: Env,
    sponsor: Address, // relayer with XLM
    message: CrossDomainMessage,
    merkle_proof: Bytes,
    payload_asset: Address,
    payload_amount: i128,
    payload_recipient: Address,
    fee_amount: i128,
) -> Result<(), GatewayError> {
    sponsor.require_auth();
    // In prod, would call:
    // env.host().begin_sponsoring_future_reserves(sponsor, recipient)
    // token_client.mint(recipient, amount-fee)
    // env.host().end_sponsoring_future_reserves(recipient)
    // For hackathon, same logic as gasless but with sponsor tracking
    Self::finalize_inbound_internal(..., Some(sponsor), fee_amount)
}
```

**Production steps**:

1. Sponsor calls `begin_sponsoring_future_reserves(sponsor, recipient)` — sponsor pays reserve for recipient's new trustline
2. Gateway mints wSRC to recipient
3. Sponsor calls `end_sponsoring_future_reserves(recipient)`
4. Recipient now has wSRC and trustline, reserve paid by sponsor
5. Fee (10) minted to sponsor as reward

**Alternative**: Claimable balance — gateway mints to itself, creates `claimable_balance` with `claimant=recipient`, recipient claims later when they have XLM.

## Why This Matters

- **Onboarding**: No need to buy XLM before bridging — fee from source chain covers Stellar fees
- **Anchor UX**: Anchor can sponsor first trustline for new users, then users pay via wSRC
- **Relayer incentive**: Relayer gets fee from lock, sustainable

## Code

- `contracts/settlement_gateway/src/lib.rs`: `FeeConfig`, `finalize_inbound_gasless`, `finalize_inbound_sponsored`, `RelayerReward`, `get_relayer_reward`
- `crates/source_simulator/src/main.rs`: lock includes fee, event_root includes fee
- `frontend/src/soroban.ts`: `buildGaslessTx`, `buildSponsoredTx`
- Tests: `test_fee_config`, `test_gasless_fee_split`

## Roadmap

- [ ] Real CAP-33 sponsorship via Soroban host `sponsor` (currently simulated)
- [ ] Claimable balance fallback for no trustline
- [ ] Fee pool for relayers, Prometheus metrics
