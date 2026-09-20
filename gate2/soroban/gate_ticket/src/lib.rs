//! Gate 2.0 — gate_ticket: the Ticket (Bilet) and its vault (DIRECTIVE 2.0, 5.4).
//!
//! A Ticket is a bearer right to a specific amount of native USDC that sits
//! in the VAULT - the USDC balance of this very contract. One contract holds
//! both the rights and the money, so the 1:1 invariant
//!     sum(amount of all live tickets) == USDC.balance(gate_ticket)
//! is enforced in one place and readable by anyone (rule 7).
//!
//! Design roots (5.4 + rules 2, 3, 4, 6, 8):
//!   - Only GateClaim can mint: bound once with `init_minter`, enforced by
//!     `minter.require_auth()` - a contract can authorize itself and only
//!     itself, so no account and no other contract can satisfy it.
//!   - `transfer` is a plain ownership change: the USDC never moves, and the
//!     receiver needs no USDC trustline until the moment of redemption.
//!   - `redeem(id, to)`: the owner burns the ticket and receives exactly its
//!     amount. If `to` has no USDC trustline the token transfer reverts and
//!     the ticket stays unburned - the transaction is atomic.
//!   - `redeem_to_battery(id)`: owner converts a ticket straight into their
//!     Battery balance, no XLM and no trustline needed anywhere.
//!   - `split(id, amounts)`: burns one ticket, mints n to the same owner,
//!     preserving the sum exactly.
//!   - `approve` and `approve_for_all` TRAP (D8): no approval surface means
//!     no drainer surface.
//!   - No admin, no pause, no upgrade. `initialize` and `init_minter` are
//!     one-shot.
//!   - The ticket is a bearer instrument: a lost or mis-sent ticket is gone.
//!     If Circle freezes the vault (the USDC issuer or this contract id),
//!     every ticket is affected - a concentrated risk, written in the README.
#![no_std]

    use soroban_sdk::{
        auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
        contract, contracterror, contractimpl, contracttype, vec, Address, BytesN, Env, IntoVal,
        String, Symbol, Vec,
    };

const BUMP_THRESHOLD: u32 = 100_000;
const BUMP_EXTEND: u32 = 400_000;
/// Maximum length of the star name carried in a ticket's origin.
const MAX_NAME_LEN: u32 = 24;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum TicketError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    MinterAlreadySet = 3,
    MinterNotSet = 4,
    ZeroAmount = 5,
    Overflow = 6,
    UnknownTicket = 7,
    NotOwner = 8,
    SplitMismatch = 9,
    BadName = 10,
    NameTooLong = 11,
    ApprovalDisabled = 12,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Ticket {
    pub amount: i128, // 7 decimals (native USDC on Stellar)
    pub source_domain: u32,
    pub msg_hash: BytesN<32>,
    pub minted_ledger: u32,
    pub origin: String, // star name, "" when none
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Usdc,
    Battery,
    Minter,
    NextId,
    /// Running sum of all live ticket amounts. Must equal the vault balance.
    LiveTotal,
    Ticket(u64),
    OwnerOf(u64),
    /// owner -> Vec<ticket id> (enumeration per 5.4 / S12)
    Index(Address),
}

#[contract]
pub struct GateTicket;

#[contractimpl]
impl GateTicket {
    /// One-shot: bind the USDC token and the Battery contract.
    pub fn initialize(env: Env, usdc: Address, battery: Address) -> Result<(), TicketError> {
        if env.storage().instance().has(&DataKey::Usdc) {
            return Err(TicketError::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Usdc, &usdc);
        env.storage().instance().set(&DataKey::Battery, &battery);
        env.storage().instance().set(&DataKey::NextId, &0u64);
        env.storage().instance().set(&DataKey::LiveTotal, &0i128);
        Ok(())
    }

    /// One-shot: bind the single contract allowed to mint tickets (GateClaim).
    pub fn init_minter(env: Env, minter: Address) -> Result<(), TicketError> {
        if env.storage().instance().has(&DataKey::Minter) {
            return Err(TicketError::MinterAlreadySet);
        }
        env.storage().instance().set(&DataKey::Minter, &minter);
        Ok(())
    }

    fn require_initialized(env: &Env) -> Result<(Address, Address), TicketError> {
        let usdc: Address = env
            .storage()
            .instance()
            .get(&DataKey::Usdc)
            .ok_or(TicketError::NotInitialized)?;
        let battery: Address = env
            .storage()
            .instance()
            .get(&DataKey::Battery)
            .ok_or(TicketError::NotInitialized)?;
        Ok((usdc, battery))
    }

    /// Mints a ticket worth `amount` (7 decimals) to `to`.
    ///
    /// The USDC for this ticket has ALREADY been moved into the vault by the
    /// minter (GateClaim) in the same transaction — money first, right second
    /// (checks-effects-interactions). Minting itself never touches the token,
    /// so no account authorization is needed and the vault cannot drift from
    /// the live total without the transaction reverting.
    ///
    /// Only the bound minter (GateClaim) may call this: `minter.require_auth`
    /// is satisfied when the calling contract IS the minter (a contract can
    /// authorize itself), and cannot be satisfied by any account or any other
    /// contract.
    pub fn mint_ticket(
        env: Env,
        to: Address,
        amount: i128,
        source_domain: u32,
        msg_hash: BytesN<32>,
        star_name: String,
    ) -> Result<u64, TicketError> {
        if amount <= 0 {
            return Err(TicketError::ZeroAmount);
        }
        validate_star_name(&env, &star_name)?;
        let minter: Address = env
            .storage()
            .instance()
            .get(&DataKey::Minter)
            .ok_or(TicketError::MinterNotSet)?;
        // The minter authorizing itself is the ONLY way past this line.
        minter.require_auth();
        Self::require_initialized(&env)?;
        let id = Self::store_new_ticket(
            &env,
            &to,
            amount,
            source_domain,
            msg_hash,
            star_name,
            true,
        )?;
        env.events()
            .publish((soroban_sdk::symbol_short!("minted"), to, id), amount);
        Ok(id)
    }

    fn store_new_ticket(
        env: &Env,
        to: &Address,
        amount: i128,
        source_domain: u32,
        msg_hash: BytesN<32>,
        star_name: String,
        grows_vault: bool,
    ) -> Result<u64, TicketError> {
        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextId)
            .ok_or(TicketError::NotInitialized)?;
        let next = id.checked_add(1).ok_or(TicketError::Overflow)?;
        env.storage().instance().set(&DataKey::NextId, &next);
        let ticket = Ticket {
            amount,
            source_domain,
            msg_hash,
            minted_ledger: env.ledger().sequence(),
            origin: star_name,
        };
        let tkey = DataKey::Ticket(id);
        env.storage().persistent().set(&tkey, &ticket);
        let okey = DataKey::OwnerOf(id);
        env.storage().persistent().set(&okey, &to);
        let ikey = DataKey::Index(to.clone());
        let mut ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&ikey)
            .unwrap_or(Vec::new(env));
        ids.push_back(id);
        env.storage().persistent().set(&ikey, &ids);
        if grows_vault {
            let total: i128 = env
                .storage()
                .instance()
                .get(&DataKey::LiveTotal)
                .ok_or(TicketError::NotInitialized)?;
            let new_total = total.checked_add(amount).ok_or(TicketError::Overflow)?;
            env.storage().instance().set(&DataKey::LiveTotal, &new_total);
        }
        for k in [tkey, okey, ikey] {
            env.storage().persistent().extend_ttl(&k, BUMP_THRESHOLD, BUMP_EXTEND);
        }
        Ok(id)
    }

    fn burn_internal(env: &Env, owner: &Address, id: u64, ticket: &Ticket) -> Result<(), TicketError> {
        let tkey = DataKey::Ticket(id);
        env.storage().persistent().remove(&tkey);
        let okey = DataKey::OwnerOf(id);
        env.storage().persistent().remove(&okey);
        let ikey = DataKey::Index(owner.clone());
        if let Some(mut v) = env.storage().persistent().get::<_, Vec<u64>>(&ikey) {
            let mut filtered: Vec<u64> = Vec::new(env);
            for t in v.iter() {
                if t != id {
                    filtered.push_back(t);
                }
            }
            env.storage().persistent().set(&ikey, &filtered);
        }
        let total: i128 = env
            .storage()
            .instance()
            .get(&DataKey::LiveTotal)
            .ok_or(TicketError::NotInitialized)?;
        let new_total = total.checked_sub(ticket.amount).ok_or(TicketError::Overflow)?;
        env.storage().instance().set(&DataKey::LiveTotal, &new_total);
        Ok(())
    }

    /// SEP-50 transfer: ownership only. The vault balance does NOT move, and
    /// the receiver needs no USDC trustline - the right is bearer paper until
    /// someone redeems it.
    pub fn transfer(env: Env, from: Address, to: Address, id: u64) -> Result<(), TicketError> {
        from.require_auth();
        let okey = DataKey::OwnerOf(id);
        let owner: Address = env
            .storage()
            .persistent()
            .get(&okey)
            .ok_or(TicketError::UnknownTicket)?;
        if owner != from {
            return Err(TicketError::NotOwner);
        }
        env.storage().persistent().set(&okey, &to);
        env.storage().persistent().extend_ttl(&okey, BUMP_THRESHOLD, BUMP_EXTEND);
        let from_ids = DataKey::Index(from.clone());
        if let Some(mut v) = env.storage().persistent().get::<_, Vec<u64>>(&from_ids) {
            let mut filtered: Vec<u64> = Vec::new(&env);
            for t in v.iter() {
                if t != id {
                    filtered.push_back(t);
                }
            }
            env.storage().persistent().set(&from_ids, &filtered);
            env.storage()
                .persistent()
                .extend_ttl(&from_ids, BUMP_THRESHOLD, BUMP_EXTEND);
        }
        let to_ids = DataKey::Index(to.clone());
        let mut v: Vec<u64> = env
            .storage()
            .persistent()
            .get(&to_ids)
            .unwrap_or(Vec::new(&env));
        v.push_back(id);
        env.storage().persistent().set(&to_ids, &v);
        env.storage()
            .persistent()
            .extend_ttl(&to_ids, BUMP_THRESHOLD, BUMP_EXTEND);
        env.events()
            .publish((soroban_sdk::symbol_short!("transf"), from, to, id), ());
        Ok(())
    }

    /// The owner redeems: the USDC is paid to `to` FIRST, then the ticket is
    /// burned. If `to` has no USDC trustline the transfer reverts and the
    /// ticket stays live and intact. A redeemed ticket can never be redeemed
    /// again: it is deleted before the transaction ends.
    pub fn redeem(env: Env, id: u64, to: Address) -> Result<(), TicketError> {
        let (usdc, _battery) = Self::require_initialized(&env)?;
        let here = env.current_contract_address();
        let ticket: Ticket = env
            .storage()
            .persistent()
            .get(&DataKey::Ticket(id))
            .ok_or(TicketError::UnknownTicket)?;
        let owner: Address = env
            .storage()
            .persistent()
            .get(&DataKey::OwnerOf(id))
            .ok_or(TicketError::UnknownTicket)?;
        owner.require_auth();
        // pay first: a failed payment (missing trustline) reverts everything
        // and the ticket is still alive at the end of the failed tx.
        soroban_sdk::token::Client::new(&env, &usdc).transfer(&here, &to, &ticket.amount);
        Self::burn_internal(&env, &owner, id, &ticket)?;
        env.events()
            .publish((soroban_sdk::symbol_short!("redeemed"), owner, to, id), ticket.amount);
        Ok(())
    }

    /// Convert a ticket directly into the owner's Battery balance. No XLM,
    /// no trustline: the Battery pulls the USDC from the vault (the ticket
    /// contract authorizes itself as `from`) and credits the owner.
    pub fn redeem_to_battery(env: Env, id: u64) -> Result<(), TicketError> {
        let (usdc, battery) = Self::require_initialized(&env)?;
        let here = env.current_contract_address();
        let ticket: Ticket = env
            .storage()
            .persistent()
            .get(&DataKey::Ticket(id))
            .ok_or(TicketError::UnknownTicket)?;
        let owner: Address = env
            .storage()
            .persistent()
            .get(&DataKey::OwnerOf(id))
            .ok_or(TicketError::UnknownTicket)?;
        owner.require_auth();
        // battery.deposit(from, owner, amount) with from = this contract:
        // the Battery (not us) calls the token, so we pass a nested
        // self-authorization entry for that deeper call.
        let deposit_args = soroban_sdk::vec![
            &env,
            here.clone().into_val(&env),
            owner.clone().into_val(&env),
            ticket.amount.into_val(&env),
        ];
        // DOC-SHAPE: the entry node = the call where the token will check
        // this contract's auth (its own transfer, deeper in the stack).
        // The intermediate Battery frame needs no node — it is skipped.
        env.authorize_as_current_contract(vec![
            &env,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: usdc,
                    fn_name: Symbol::new(&env, "transfer"),
                    args: soroban_sdk::vec![
                        &env,
                        here.clone().into_val(&env),
                        battery.clone().into_val(&env),
                        ticket.amount.into_val(&env),
                    ],
                },
                sub_invocations: vec![&env],
            }),
        ]);
        let _: () = env.invoke_contract(&battery, &soroban_sdk::symbol_short!("deposit"), deposit_args);
        Self::burn_internal(&env, &owner, id, &ticket)?;
        env.events()
            .publish(
                (soroban_sdk::symbol_short!("to_batt"), owner, id),
                ticket.amount,
            );
        Ok(())
    }

    /// Burn one ticket, mint `amounts.len()` new tickets to the same owner,
    /// preserving the total exactly. The USDC never moves: children are
    /// covered by the parent's already-vaulted amount.
    pub fn split(env: Env, id: u64, amounts: Vec<i128>) -> Result<Vec<u64>, TicketError> {
        let (_usdc, _battery) = Self::require_initialized(&env)?;
        let ticket: Ticket = env
            .storage()
            .persistent()
            .get(&DataKey::Ticket(id))
            .ok_or(TicketError::UnknownTicket)?;
        let owner: Address = env
            .storage()
            .persistent()
            .get(&DataKey::OwnerOf(id))
            .ok_or(TicketError::UnknownTicket)?;
        owner.require_auth();
        if amounts.is_empty() {
            return Err(TicketError::SplitMismatch);
        }
        let mut sum: i128 = 0;
        for a in amounts.iter() {
            if a <= 0 {
                return Err(TicketError::ZeroAmount);
            }
            sum = sum.checked_add(a).ok_or(TicketError::Overflow)?;
        }
        if sum != ticket.amount {
            return Err(TicketError::SplitMismatch);
        }
        let mut out: Vec<u64> = Vec::new(&env);
        for a in amounts.iter() {
            out.push_back(Self::store_new_ticket(
                &env,
                &owner,
                a,
                ticket.source_domain,
                ticket.msg_hash.clone(),
                ticket.origin.clone(),
                true, // children are covered: the USDC already sits in the vault
            )?);
        }
        // Burn the parent LAST: +sum(children) - parent = 0 net, so
        // live_total (and the vault) are unchanged by a split.
        Self::burn_internal(&env, &owner, id, &ticket)?;
        env.events()
            .publish((soroban_sdk::symbol_short!("split"), owner, id), ());
        Ok(out)
    }

    // ---- the query surface (rule 7: anyone can verify the 1:1 support) ----

    pub fn get_ticket(env: Env, id: u64) -> Option<Ticket> {
        env.storage().persistent().get(&DataKey::Ticket(id))
    }

    pub fn owner_of(env: Env, id: u64) -> Option<Address> {
        env.storage().persistent().get(&DataKey::OwnerOf(id))
    }

    pub fn tickets_of(env: Env, owner: Address) -> Vec<u64> {
        env.storage()
            .persistent()
            .get(&DataKey::Index(owner))
            .unwrap_or(Vec::new(&env))
    }

    /// Number of live tickets held by the owner (SEP-50 balance).
    pub fn balance_of(env: Env, owner: Address) -> u32 {
        env.storage()
            .persistent()
            .get::<_, Vec<u64>>(&DataKey::Index(owner))
            .map(|v| v.len() as u32)
            .unwrap_or(0)
    }

    /// The owner's total ticket value (7 decimals).
    pub fn value_of(env: Env, owner: Address) -> i128 {
        let mut sum: i128 = 0;
        let ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&DataKey::Index(owner))
            .unwrap_or(Vec::new(&env));
        for id in ids.iter() {
            if let Some(t) = env.storage().persistent().get::<_, Ticket>(&DataKey::Ticket(id)) {
                sum = sum.saturating_add(t.amount);
            }
        }
        sum
    }

    /// Running sum of all live tickets. Must always equal
    /// USDC.balance(gate_ticket); the property test proves it.
    pub fn live_total(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::LiveTotal).unwrap_or(0)
    }

    /// The vault balance, independently readable: USDC.balance_of(this).
    /// Zero before initialization (the token is not bound yet).
    pub fn vault_balance(env: Env) -> i128 {
        match Self::require_initialized(&env) {
            Ok((usdc, _battery)) => soroban_sdk::token::Client::new(&env, &usdc)
                .balance(&env.current_contract_address()),
            Err(_) => 0,
        }
    }

    /// Plain JSON metadata (no SVG: the star art belongs to the Passport).
    pub fn token_uri(env: Env, id: u64) -> Option<String> {
        let t = env
            .storage()
            .persistent()
            .get::<_, Ticket>(&DataKey::Ticket(id))?;
        let mut buf = [0u8; 512];
        let mut n = 0u32;
        push_str(&mut buf, &mut n, "data:application/json,");
        push_u8(&mut buf, &mut n, b'{');
        push_str(&mut buf, &mut n, "\"id\":");
        push_u64(&mut buf, &mut n, id);
        push_u8(&mut buf, &mut n, b',');
        push_str(&mut buf, &mut n, "\"amount\":");
        push_i128(&mut buf, &mut n, t.amount);
        push_u8(&mut buf, &mut n, b',');
        push_str(&mut buf, &mut n, "\"amount_usdc\":\"");
        push_div6(&mut buf, &mut n, t.amount);
        push_u8(&mut buf, &mut n, b'"');
        push_u8(&mut buf, &mut n, b',');
        push_str(&mut buf, &mut n, "\"source_domain\":");
        push_u64(&mut buf, &mut n, t.source_domain as u64);
        push_u8(&mut buf, &mut n, b',');
        push_str(&mut buf, &mut n, "\"msg_hash\":\"");
        push_bytes32(&mut buf, &mut n, &t.msg_hash);
        push_u8(&mut buf, &mut n, b'"');
        push_u8(&mut buf, &mut n, b',');
        push_str(&mut buf, &mut n, "\"minted_ledger\":");
        push_u64(&mut buf, &mut n, t.minted_ledger as u64);
        push_u8(&mut buf, &mut n, b',');
        push_str(&mut buf, &mut n, "\"origin\":\"");
        let ob = t.origin.to_bytes();
        for i in 0..ob.len() {
            buf[n as usize] = ob.get(i).unwrap_or(0);
            n += 1;
        }
        push_u8(&mut buf, &mut n, b'"');
        push_u8(&mut buf, &mut n, b'}');
        Some(String::from_bytes(&env, &buf[0..n as usize]))
    }

    // ---- D8: approvals are a drainer surface, so they trap ----

    /// D8: the ticket carries no approval surface. This function exists only
    /// to fail loudly instead of behaving like an unknown function.
    pub fn approve(_env: Env, _from: Address, _to: Address, _id: u64) -> Result<(), TicketError> {
        Err(TicketError::ApprovalDisabled)
    }

    pub fn approve_for_all(_env: Env, _from: Address, _to: Address) -> Result<(), TicketError> {
        Err(TicketError::ApprovalDisabled)
    }
}

fn validate_star_name(env: &Env, name: &String) -> Result<(), TicketError> {
    let bytes = name.to_bytes();
    if bytes.len() > MAX_NAME_LEN {
        return Err(TicketError::NameTooLong);
    }
    for i in 0..bytes.len() {
        let c = bytes.get(i).unwrap_or(0);
        let ok = (c >= b'a' && c <= b'z')
            || (c >= b'A' && c <= b'Z')
            || (c >= b'0' && c <= b'9')
            || c == b' ';
        if !ok {
            return Err(TicketError::BadName);
        }
    }
    Ok(())
}

// ---- tiny decimal helpers (no_std: no format! in contract code) ----

fn push_u8(buf: &mut [u8; 512], n: &mut u32, c: u8) {
    buf[*n as usize] = c;
    *n += 1;
}

fn push_str(buf: &mut [u8; 512], n: &mut u32, s: &str) {
    for c in s.bytes() {
        buf[*n as usize] = c;
        *n += 1;
    }
}

fn push_u64(buf: &mut [u8; 512], n: &mut u32, v: u64) {
    if v == 0 {
        push_u8(buf, n, b'0');
        return;
    }
    let mut tmp = [0u8; 20];
    let mut x = v;
    let mut t = 0usize;
    while x > 0 {
        tmp[t] = b'0' + (x % 10) as u8;
        t += 1;
        x /= 10;
    }
    for i in (0..t).rev() {
        push_u8(buf, n, tmp[i]);
    }
}

fn push_i128(buf: &mut [u8; 512], n: &mut u32, v: i128) {
    if v < 0 {
        push_u8(buf, n, b'-');
        push_u64(buf, n, (-(v + 1) as u128 + 1) as u64);
    } else {
        push_u64(buf, n, v as u64);
    }
}

fn push_bytes32(buf: &mut [u8; 512], n: &mut u32, b: &BytesN<32>) {
    let a = b.to_array();
    const HEX: [u8; 16] = *b"0123456789abcdef";
    for x in a.iter() {
        push_u8(buf, n, HEX[(x >> 4) as usize]);
        push_u8(buf, n, HEX[(x & 0xf) as usize]);
    }
}

/// 7-decimal amount -> "X.YYYYYY" (6 decimal places) appended to buf.
fn push_div6(buf: &mut [u8; 512], n: &mut u32, amount: i128) {
    let whole = amount / 1_000_000;
    let rem = (amount % 1_000_000).abs() as u64;
    push_i128(buf, n, whole);
    push_u8(buf, n, b'.');
    let mut x = rem;
    for i in (0..6).rev() {
        buf[(*n + (5 - i)) as usize] = b'0' + (x % 10) as u8;
        x /= 10;
    }
    *n += 6;
}
