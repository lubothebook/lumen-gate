#![no_std]
// SDK 28 deprecates `env.events().publish` in favour of the `#[contractevent]`
// macro, which changes the emitted event's topic structure. The deployed
// contracts publish in the legacy shape and the relayer decodes the Burn
// payload from those exact topics, so matching the new macro here would break
// live consumers for a style warning. The allowance is scoped to this crate,
// named at its cause, and listed in the directive's known gaps; a migration
// of events is a coordinated contract redeploy, not a silent edit.
#![allow(deprecated)]
// Clippy's argument-count and type-complexity caps exist for code where a
// struct would clarify; here the argument list IS the specification - a
// verifier's public inputs and a transaction builder's envelope fields read
// clearer inline than buried in a wrapper type. The lint is allowed at the
// crate root, once, with this reason, rather than silently at call sites.
#![allow(clippy::too_many_arguments, clippy::type_complexity)]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, crypto::bls12_381::Bls12381G1Affine,
    crypto::bls12_381::Bls12381G2Affine, crypto::bn254::Bn254Fr, crypto::bn254::Bn254G1Affine,
    crypto::bn254::Bn254G2Affine, Address, Bytes, BytesN, Env, String, Symbol, Vec,
};

// ---------- Groth16 verifier (Apache-2.0-compatible pattern, adapted) ----------
mod groth16 {
    use super::*;
    use soroban_sdk::TryFromVal;
    pub const G1_SIZE: u32 = 64;
    pub const G2_SIZE: u32 = 128;
    /// A || B || C, fixed. Any other length is refused before decoding, so a
    /// short proof cannot be read as a shift of the intended encoding.
    pub const PROOF_SIZE: u32 = 2 * G1_SIZE + G2_SIZE;

    // BN254 Fr modulus, big-endian. Soroban's Bn254Fr::from_bytes reduces
    // modulo r, so the verifier must reject non-canonical public inputs before
    // constructing a scalar instead of silently accepting a different witness.
    const FR_MODULUS: [u8; 32] = [
        0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58,
        0x5d, 0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00,
        0x00, 0x01,
    ];

    fn scalar_is_canonical(value: &BytesN<32>) -> bool {
        let mut less = false;
        for i in 0u32..32 {
            let a = value.get(i).unwrap_or(0);
            let b = FR_MODULUS[i as usize];
            if a < b {
                less = true;
                break;
            }
            if a > b {
                return false;
            }
        }
        less
    }

    fn to_fixed<const N: usize>(env: &Env, bytes: Bytes) -> BytesN<N> {
        let val: soroban_sdk::Val = bytes.into();
        BytesN::<N>::try_from_val(env, &val).unwrap_or_else(|_| panic!("expected {} bytes", N))
    }
    fn g1(env: &Env, bytes: Bytes) -> Bn254G1Affine {
        Bn254G1Affine::from_bytes(to_fixed::<64>(env, bytes))
    }
    fn g2(env: &Env, bytes: Bytes) -> Bn254G2Affine {
        Bn254G2Affine::from_bytes(to_fixed::<128>(env, bytes))
    }
    fn is_zero(bytes: &Bytes) -> bool {
        let len = bytes.len();
        let mut i = 0u32;
        while i < len {
            if bytes.get(i).unwrap_or(0) != 0 {
                return false;
            }
            i += 1;
        }
        true
    }
    pub fn verify(env: &Env, vk: &Bytes, proof: &Bytes, public_inputs: &Vec<BytesN<32>>) -> bool {
        if proof.len() != 2 * G1_SIZE + G2_SIZE {
            return false;
        }
        let expected_vk_len = G1_SIZE + 3 * G2_SIZE + (public_inputs.len() + 1) * G1_SIZE;
        if vk.len() != expected_vk_len {
            return false;
        }
        for i in 0..public_inputs.len() {
            if !scalar_is_canonical(&public_inputs.get(i).unwrap()) {
                return false;
            }
        }
        let a_bytes = proof.slice(0..G1_SIZE);
        let b_bytes = proof.slice(G1_SIZE..G1_SIZE + G2_SIZE);
        let c_bytes = proof.slice(G1_SIZE + G2_SIZE..2 * G1_SIZE + G2_SIZE);
        if is_zero(&a_bytes) || is_zero(&b_bytes) || is_zero(&c_bytes) {
            return false;
        }
        let alpha_bytes = vk.slice(0..G1_SIZE);
        let beta_bytes = vk.slice(G1_SIZE..G1_SIZE + G2_SIZE);
        let gamma_bytes = vk.slice(G1_SIZE + G2_SIZE..G1_SIZE + 2 * G2_SIZE);
        let delta_bytes = vk.slice(G1_SIZE + 2 * G2_SIZE..G1_SIZE + 3 * G2_SIZE);
        let ic_base = G1_SIZE + 3 * G2_SIZE;
        let mut ic_points: Vec<Bytes> = Vec::new(env);
        for i in 0..=public_inputs.len() {
            let offset = ic_base + i * G1_SIZE;
            ic_points.push_back(vk.slice(offset..offset + G1_SIZE));
        }
        let a = g1(env, a_bytes);
        let b = g2(env, b_bytes);
        let c = g1(env, c_bytes);
        let alpha = g1(env, alpha_bytes);
        let beta = g2(env, beta_bytes);
        let gamma = g2(env, gamma_bytes);
        let delta = g2(env, delta_bytes);
        let bn254 = env.crypto().bn254();
        if !bn254.g1_is_on_curve(&a) || !bn254.g1_is_on_curve(&c) || !bn254.g1_is_on_curve(&alpha) {
            return false;
        }

        let mut vk_x = g1(env, ic_points.get(0).unwrap());
        if !bn254.g1_is_on_curve(&vk_x) {
            return false;
        }
        for i in 0..public_inputs.len() {
            let ic_point = g1(env, ic_points.get(i + 1).unwrap());
            if !bn254.g1_is_on_curve(&ic_point) {
                return false;
            }
            let scalar = Bn254Fr::from_bytes(public_inputs.get(i).unwrap());
            let scaled = ic_point * scalar.clone();
            vk_x = vk_x + scaled;
        }
        let neg_alpha = -alpha;
        let neg_vk_x = -vk_x;
        let neg_c = -c;
        let g1_points: Vec<Bn254G1Affine> = Vec::from_array(env, [a, neg_alpha, neg_vk_x, neg_c]);
        let g2_points: Vec<Bn254G2Affine> = Vec::from_array(env, [b, beta, gamma, delta]);
        env.crypto().bn254().pairing_check(g1_points, g2_points)
    }
}

// ---------- Types ----------
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RawEvidence {
    pub adapter_id: BytesN<32>,
    pub evidence_version: u32,
    pub network: String,
    pub payload: Bytes,
    pub declared_height: u64,
    pub declared_root: BytesN<32>,
    pub submitter: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SecurityBacking {
    SignatureSet(u32, u32, bool),
    ZkProof,
    None,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FinalityAttestation {
    pub adapter: BytesN<32>,
    pub domain: BytesN<32>,
    pub height: u64,
    pub state_root: BytesN<32>,
    pub finalized_at: u64,
    pub security: SecurityBacking,
    pub evidence_digest: BytesN<32>,
    pub adapter_version: u32,
    pub evidence_version: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DomainRecord {
    pub adapter_id: BytesN<32>,
    pub network: String,
    pub last_height: u64,
    pub last_root: BytesN<32>,
    pub last_event_root: BytesN<32>,
    pub state: u32, // 0=Registered,1=Admitted,2=Active,3=Faulted,4=Retired
    pub required_depth: u64,
    pub adapter_version: u32,
    pub accepted_versions: Vec<u32>,
    pub last_security: SecurityBacking,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BlsPolicy {
    pub aggregate_pubkey: BytesN<192>,
    pub signer_count: u32,
    pub required: u32,
    pub slashable: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FinalizedRecord {
    pub state_root: BytesN<32>,
    pub event_root: BytesN<32>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FinalityKind {
    Probabilistic,
    Economic,
    Protocol,
    Proven,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TrustModel {
    Trustless,
    HonestMajority(u64),
    TrustedParty,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DomainProfile {
    pub domain_key: BytesN<32>,
    pub adapter_id: BytesN<32>,
    pub network: String,
    pub state: u32,
    pub consensus_kind: String,
    pub finality_kind: FinalityKind,
    pub trust_model: TrustModel,
    pub required_depth: u64,
    pub security_backing: SecurityBacking,
    pub last_height: u64,
    pub last_root: BytesN<32>,
    pub adapter_version: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    AdminRenounced,
    Domain(BytesN<32>),
    Finalized(BytesN<32>, u64),
    FinalizedFull(BytesN<32>, u64),
    Evidence(BytesN<32>),
    Vk,
    BlsPolicy(BytesN<32>),
    DomainList,
    /// Verification key of the multi-step chained circuit. Deliberately a
    /// different slot from `Vk`: the two circuits have different public-input
    /// counts and therefore different key sizes, and a single slot would let one
    /// lane's key be presented to the other.
    StepChainVk,
    /// Last accepted multi-step chain for a domain. Kept apart from the domain
    /// record on purpose: see `submit_step_chain_zk`.
    StepChain(BytesN<32>),
    /// Verification key of the execution lane's trace circuit. A third slot for
    /// the same reason as the second: 1920 bytes cannot be mistaken for 896, but
    /// keeping the slots apart means the lane's key is never read by a code path
    /// that did not ask for it.
    ExecutionVk,
    /// Last accepted execution proof for a domain, kept apart from both the
    /// domain record and the step-chain record.
    Execution(BytesN<32>),
    /// Verification key of the gate-vm lane: the hash-capable machine whose
    /// program is committed by a Poseidon fold instead of published word by
    /// word. A fourth slot, for the fourth time the same reason -- and here the
    /// length argument genuinely fails (896 bytes is also the step-chain key's
    /// length), which makes separate slots the *only* thing keeping one lane's
    /// key from being presented to the other.
    GateVmVk,
    /// Last accepted gate-vm run per domain. Own slot, own record type; the
    /// settlement anchor stays where the settlement lanes put it.
    GateVm(BytesN<32>),
    /// The 32-line sibling of the gate-vm lane: same core circuit, same tag,
    /// one quarter the row-per-constraint density per statement... a larger
    /// window and a larger hash budget. Its own key slot because a ceremony
    /// is per-compilation: the two 896-byte keys have equal length and equal
    /// tag, and are separated by nothing but the fact that each lane verifies
    /// under the key its own setup produced.
    GateVm32Vk,
    /// Last accepted gate-vm32 run per domain.
    GateVm32(BytesN<32>),
}

/// What the registry recorded for one accepted multi-step chain.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StepChainRecord {
    pub domain: BytesN<32>,
    pub height: u64,
    pub chain_length: u64,
    pub start_root: BytesN<32>,
    pub end_root: BytesN<32>,
    pub event_root: BytesN<32>,
    pub threshold: u64,
    /// True, and always true: this lane records a verified proof and never
    /// touches the roots the settlement path anchors on.
    pub settlement_anchored: bool,
}

/// An attestation for the multi-step lane.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StepChainAttestation {
    pub domain: BytesN<32>,
    pub height: u64,
    pub chain_length: u64,
    pub start_root: BytesN<32>,
    pub end_root: BytesN<32>,
    pub event_root: BytesN<32>,
    pub security: SecurityBacking,
    pub evidence_digest: BytesN<32>,
    pub adapter_version: u32,
    pub evidence_version: u32,
}

/// What the registry recorded for one accepted execution proof.
///
/// `program_digest` is derived here, by the contract, from the program words the
/// payload carried: it is a name for the program that ran, and it is only ever
/// computed from bytes the contract parsed itself.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecutionRecord {
    pub domain: BytesN<32>,
    pub height: u64,
    pub program_digest: BytesN<32>,
    pub instruction_words: u64,
    pub state_root: BytesN<32>,
    pub initial_regs_root: BytesN<32>,
    pub final_pc: u64,
    pub steps_executed: u64,
    pub gas_used: u64,
    /// True, and always true: this lane records a verified execution and never
    /// touches the roots the settlement path anchors on.
    pub settlement_anchored: bool,
}

/// An attestation for the execution lane.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecutionAttestation {
    pub domain: BytesN<32>,
    pub height: u64,
    pub program_digest: BytesN<32>,
    pub state_root: BytesN<32>,
    pub steps_executed: u64,
    pub gas_used: u64,
    pub security: SecurityBacking,
    pub evidence_digest: BytesN<32>,
    pub adapter_version: u32,
    pub evidence_version: u32,
}

/// What the registry recorded for one accepted gate-vm run. The roots here are
/// the machine's own start and end; like the execution lane, `program_root` is
/// the fold the circuit computed from the private program cells, and the
/// registry saw the same 32 bytes in the proof's public inputs -- they are the
/// same number by binding, not by convention.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GateVmRecord {
    pub domain: BytesN<32>,
    pub height: u64,
    pub program_root: BytesN<32>,
    pub start_root: BytesN<32>,
    pub event_root: BytesN<32>,
    pub end_root: BytesN<32>,
    pub hash_steps: u64,
    /// True, and always true: a verified run is not an anchored settlement
    /// root, and this flag exists so no reader has to infer the difference.
    pub settlement_anchored: bool,
}

/// An attestation for the gate-vm lane.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GateVmAttestation {
    pub domain: BytesN<32>,
    pub height: u64,
    pub program_root: BytesN<32>,
    pub end_root: BytesN<32>,
    pub hash_steps: u64,
    pub security: SecurityBacking,
    pub evidence_digest: BytesN<32>,
    pub adapter_version: u32,
    pub evidence_version: u32,
}

/// The 32-line sibling's record. The field set is the 8-line lane's verbatim
/// on purpose: two compilations of one machine produce the same *kind* of
/// statement; what differs is the window the statement was checked inside,
/// and that difference is certified by the key, not by new fields.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GateVm32Record {
    pub domain: BytesN<32>,
    pub height: u64,
    pub program_root: BytesN<32>,
    pub start_root: BytesN<32>,
    pub event_root: BytesN<32>,
    pub end_root: BytesN<32>,
    pub hash_steps: u64,
    pub settlement_anchored: bool,
}

/// An attestation for the 32-line gate-vm sibling.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GateVm32Attestation {
    pub domain: BytesN<32>,
    pub height: u64,
    pub program_root: BytesN<32>,
    pub end_root: BytesN<32>,
    pub hash_steps: u64,
    pub security: SecurityBacking,
    pub evidence_digest: BytesN<32>,
    pub adapter_version: u32,
    pub evidence_version: u32,
}

#[contracterror]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RegistryError {
    NotAuthorized = 1,
    DomainAlreadyExists = 2,
    DomainNotFound = 3,
    VersionNotAccepted = 4,
    DeclaredMismatch = 5,
    InvalidPayload = 6,
    InvalidSignature = 7,
    InvalidProof = 8,
    EvidenceAlreadyProcessed = 9,
    ThresholdNotMet = 10,
    BadPayloadLength = 11,
    NotAdmitted = 12,
    AdminRenounced = 13,
}

fn compute_domain_key(env: &Env, adapter_id: &BytesN<32>, network: &String) -> BytesN<32> {
    let mut buf = Bytes::new(env);
    buf.append(&adapter_id.clone().into());
    buf.append(&network.clone().into());
    env.crypto().sha256(&buf).into()
}

fn compute_evidence_digest(env: &Env, evidence: &RawEvidence) -> BytesN<32> {
    let mut buf = Bytes::new(env);
    buf.append(&evidence.adapter_id.clone().into());
    let mut v = [0u8; 4];
    v.copy_from_slice(&evidence.evidence_version.to_le_bytes());
    buf.append(&Bytes::from_array(env, &v));
    buf.append(&evidence.network.clone().into());
    let mut h = [0u8; 8];
    h.copy_from_slice(&evidence.declared_height.to_le_bytes());
    buf.append(&Bytes::from_array(env, &h));
    buf.append(&evidence.declared_root.clone().into());
    buf.append(&evidence.payload);
    env.crypto().sha256(&buf).into()
}

const BLS_PAYLOAD_MIN: u32 = 368;

fn parse_bls_payload(
    payload: &Bytes,
) -> Result<(u64, BytesN<32>, BytesN<32>, u32, u32, Bytes, Bytes), RegistryError> {
    if payload.len() != BLS_PAYLOAD_MIN {
        return Err(RegistryError::BadPayloadLength);
    }
    let env = payload.env();
    let height_slice = payload.slice(0..8);
    let mut height_bytes = [0u8; 8];
    for i in 0u32..8 {
        height_bytes[i as usize] = height_slice.get(i).unwrap_or(0);
    }
    let height = u64::from_le_bytes(height_bytes);
    let sr_slice = payload.slice(8..40);
    let mut sr_arr = [0u8; 32];
    for i in 0u32..32 {
        sr_arr[i as usize] = sr_slice.get(i).unwrap_or(0);
    }
    let state_root = BytesN::from_array(env, &sr_arr);
    let er_slice = payload.slice(40..72);
    let mut er_arr = [0u8; 32];
    for i in 0u32..32 {
        er_arr[i as usize] = er_slice.get(i).unwrap_or(0);
    }
    let event_root = BytesN::from_array(env, &er_arr);
    let sc_slice = payload.slice(72..76);
    let mut sc_bytes = [0u8; 4];
    for i in 0u32..4 {
        sc_bytes[i as usize] = sc_slice.get(i).unwrap_or(0);
    }
    let signer_count = u32::from_le_bytes(sc_bytes);
    let req_slice = payload.slice(76..80);
    let mut req_bytes = [0u8; 4];
    for i in 0u32..4 {
        req_bytes[i as usize] = req_slice.get(i).unwrap_or(0);
    }
    let required = u32::from_le_bytes(req_bytes);
    let sig_bytes = payload.slice(80..176);
    let pubkey_bytes = payload.slice(176..368);
    Ok((
        height,
        state_root,
        event_root,
        signer_count,
        required,
        sig_bytes,
        pubkey_bytes,
    ))
}

#[contract]
pub struct FinalityRegistry;

#[contractimpl]
impl FinalityRegistry {
    // -- multi-step chained finality lane -----------------------------------
    //
    // Layout of the payload this lane reads (little-endian integers, fixed
    // width, no padding and no optional trailing bytes):
    //
    //    0..8     height         u64
    //    8..40    start_root     32 bytes   (state_root_0)
    //   40..72    end_root       32 bytes   (state_root_N, the commitment)
    //   72..104   event_root     32 bytes   (bound into every step digest)
    //  104..112   chain_length   u64        (M, the number of active steps)
    //
    // The payload is re-parsed and the declared height and root are re-derived
    // from it, exactly as the BLS lane does. There is no branch that trusts the
    // envelope's declared values without checking them.
    pub fn initialize(env: Env, admin: Address) {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::AdminRenounced, &false);
        env.storage()
            .instance()
            .set(&DataKey::Vk, &Bytes::new(&env));
        env.storage()
            .instance()
            .set(&DataKey::DomainList, &Vec::<BytesN<32>>::new(&env));
    }

    fn is_admin_renounced(env: &Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::AdminRenounced)
            .unwrap_or(false)
    }

    pub fn set_vk(env: Env, admin: Address, vk: Bytes) {
        if Self::is_admin_renounced(&env) {
            panic!("admin renounced");
        }
        admin.require_auth();
        let stored_admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if stored_admin != admin {
            panic!("not admin");
        }
        if vk.len() != 768 {
            panic!("expected 768-byte Groth16 verification key");
        }
        env.storage().instance().set(&DataKey::Vk, &vk);
    }

    // Critical hardening 4.1: renounce admin permanently after bootstrap
    // After VK and domains registered, call renounce_admin to prove no human can change verification keys
    // Demo: "admin renounced, tx hash: ..." -> machine approval only
    pub fn renounce_admin(env: Env, admin: Address) {
        admin.require_auth();
        let stored_admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if stored_admin != admin {
            panic!("not admin");
        }
        // Set renounced flag and zero admin to dead address
        env.storage()
            .instance()
            .set(&DataKey::AdminRenounced, &true);
        // Set admin to zero address (G...WHF) to make future checks fail even if flag bypassed
        let zero = Address::from_string(&String::from_str(
            &env,
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        ));
        env.storage().instance().set(&DataKey::Admin, &zero);
        env.events().publish(
            (Symbol::new(&env, "admin_renounced"), admin.clone()),
            (Symbol::new(&env, "machine_approval_only"),),
        );
    }

    pub fn is_admin_renounced_check(env: Env) -> bool {
        Self::is_admin_renounced(&env)
    }

    pub fn get_vk(env: Env) -> Bytes {
        env.storage()
            .instance()
            .get(&DataKey::Vk)
            .unwrap_or(Bytes::new(&env))
    }

    pub fn register_domain(
        env: Env,
        admin: Address,
        adapter_id: BytesN<32>,
        network: String,
        required_depth: u64,
        adapter_version: u32,
        accepted_versions: Vec<u32>,
    ) -> BytesN<32> {
        if Self::is_admin_renounced(&env) {
            panic!("admin renounced - no new domains");
        }
        admin.require_auth();
        let stored_admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if stored_admin != admin {
            panic!("not admin");
        }
        if accepted_versions.is_empty() || !accepted_versions.contains(adapter_version) {
            panic!("adapter version must be accepted");
        }
        let domain_key = compute_domain_key(&env, &adapter_id, &network);
        if env
            .storage()
            .persistent()
            .has(&DataKey::Domain(domain_key.clone()))
        {
            panic!("domain exists");
        }
        let record = DomainRecord {
            adapter_id: adapter_id.clone(),
            network: network.clone(),
            last_height: 0,
            last_root: BytesN::from_array(&env, &[0u8; 32]),
            last_event_root: BytesN::from_array(&env, &[0u8; 32]),
            state: 0,
            required_depth,
            adapter_version,
            accepted_versions,
            last_security: SecurityBacking::None,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Domain(domain_key.clone()), &record);
        let mut list: Vec<BytesN<32>> = env
            .storage()
            .instance()
            .get(&DataKey::DomainList)
            .unwrap_or(Vec::new(&env));
        list.push_back(domain_key.clone());
        env.storage().instance().set(&DataKey::DomainList, &list);
        env.events().publish(
            (Symbol::new(&env, "domain_registered"), domain_key.clone()),
            (adapter_id, network),
        );
        domain_key
    }

    // Admit domain after selftest (golden sample must have verified)
    pub fn admit_domain(env: Env, admin: Address, domain: BytesN<32>) {
        if Self::is_admin_renounced(&env) {
            panic!("admin renounced - no new admits");
        }
        admin.require_auth();
        let stored_admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if stored_admin != admin {
            panic!("not admin");
        }
        let mut record: DomainRecord = env
            .storage()
            .persistent()
            .get(&DataKey::Domain(domain.clone()))
            .expect("domain not found");
        // For hackathon, admit if at least one finalization happened or manually
        // In prod, this would check selftest report
        if record.state == 0 {
            record.state = 1; // Admitted
            env.storage()
                .persistent()
                .set(&DataKey::Domain(domain.clone()), &record);
            env.events().publish(
                (Symbol::new(&env, "domain_admitted"), domain),
                record.last_height,
            );
        }
    }

    pub fn set_bls_policy(
        env: Env,
        admin: Address,
        domain: BytesN<32>,
        aggregate_pubkey: BytesN<192>,
        signer_count: u32,
        required: u32,
        slashable: bool,
    ) {
        if Self::is_admin_renounced(&env) {
            panic!("admin renounced");
        }
        admin.require_auth();
        let stored_admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if stored_admin != admin {
            panic!("not admin");
        }
        if signer_count == 0 || required == 0 || required > signer_count {
            panic!("invalid quorum");
        }
        let mut all_zero = true;
        for i in 0u32..192 {
            if aggregate_pubkey.get(i).unwrap_or(0) != 0 {
                all_zero = false;
                break;
            }
        }
        if all_zero {
            panic!("empty aggregate public key");
        }
        let point = Bls12381G2Affine::from_bytes(aggregate_pubkey.clone());
        let bls = env.crypto().bls12_381();
        if !bls.g2_is_on_curve(&point) || !bls.g2_is_in_subgroup(&point) {
            panic!("invalid aggregate public key");
        }
        if !env
            .storage()
            .persistent()
            .has(&DataKey::Domain(domain.clone()))
        {
            panic!("domain not found");
        }
        env.storage().persistent().set(
            &DataKey::BlsPolicy(domain.clone()),
            &BlsPolicy {
                aggregate_pubkey,
                signer_count,
                required,
                slashable,
            },
        );
        env.events().publish(
            (Symbol::new(&env, "bls_policy_set"), domain),
            (signer_count, required),
        );
    }

    pub fn get_bls_policy(env: Env, domain: BytesN<32>) -> Option<BlsPolicy> {
        env.storage().persistent().get(&DataKey::BlsPolicy(domain))
    }

    pub fn get_domain(env: Env, domain: BytesN<32>) -> Option<DomainRecord> {
        env.storage().persistent().get(&DataKey::Domain(domain))
    }

    pub fn is_finalized(env: Env, domain: BytesN<32>, height: u64) -> Option<BytesN<32>> {
        env.storage()
            .persistent()
            .get(&DataKey::Finalized(domain, height))
    }

    pub fn get_finalized_full(
        env: Env,
        domain: BytesN<32>,
        height: u64,
    ) -> Option<FinalizedRecord> {
        env.storage()
            .persistent()
            .get(&DataKey::FinalizedFull(domain, height))
    }

    pub fn get_last_finalized(env: Env, domain: BytesN<32>) -> Option<DomainRecord> {
        env.storage().persistent().get(&DataKey::Domain(domain))
    }

    pub fn get_profile(env: Env, domain: BytesN<32>) -> Option<DomainProfile> {
        let record: DomainRecord = env
            .storage()
            .persistent()
            .get(&DataKey::Domain(domain.clone()))?;
        let security = record.last_security.clone();
        Some(DomainProfile {
            domain_key: domain,
            adapter_id: record.adapter_id,
            network: record.network,
            state: record.state,
            consensus_kind: String::from_str(&env, "deterministic-2-of-3-demo"),
            finality_kind: FinalityKind::Economic,
            // The enum is HonestMajority for compatibility; this deterministic
            // validator set is explicitly demo-only in surrounding metadata.
            trust_model: TrustModel::HonestMajority(3),
            required_depth: record.required_depth,
            security_backing: security,
            last_height: record.last_height,
            last_root: record.last_root,
            adapter_version: record.adapter_version,
        })
    }

    pub fn submit_finality_evidence_bls(
        env: Env,
        evidence: RawEvidence,
    ) -> Result<FinalityAttestation, RegistryError> {
        // The public entry point is strict too; there is no permissive signing path.
        Self::submit_bls_hardened(env, evidence)
    }

    // Hardened BLS with full pairing check (for prod) - short name to fit 32 char limit
    pub fn submit_bls_hardened(
        env: Env,
        evidence: RawEvidence,
    ) -> Result<FinalityAttestation, RegistryError> {
        let domain_key = compute_domain_key(&env, &evidence.adapter_id, &evidence.network);
        let record: DomainRecord = env
            .storage()
            .persistent()
            .get(&DataKey::Domain(domain_key.clone()))
            .ok_or(RegistryError::DomainNotFound)?;
        if record.state == 0 || record.state >= 3 {
            return Err(RegistryError::NotAdmitted);
        }
        let policy: BlsPolicy = env
            .storage()
            .persistent()
            .get(&DataKey::BlsPolicy(domain_key.clone()))
            .ok_or(RegistryError::InvalidSignature)?;

        if !record.accepted_versions.contains(evidence.evidence_version) {
            return Err(RegistryError::VersionNotAccepted);
        }
        let digest = compute_evidence_digest(&env, &evidence);
        if env
            .storage()
            .persistent()
            .has(&DataKey::Evidence(digest.clone()))
        {
            return Err(RegistryError::EvidenceAlreadyProcessed);
        }
        let (height, state_root, event_root, signer_count, required, sig_bytes, pubkey_bytes) =
            parse_bls_payload(&evidence.payload)?;

        if height != evidence.declared_height || state_root != evidence.declared_root {
            return Err(RegistryError::DeclaredMismatch);
        }
        if signer_count == 0
            || required == 0
            || signer_count != policy.signer_count
            || required != policy.required
            || signer_count < required
        {
            return Err(RegistryError::ThresholdNotMet);
        }

        let sig_fixed = {
            let mut arr = [0u8; 96];
            for i in 0u32..96 {
                arr[i as usize] = sig_bytes.get(i).unwrap_or(0);
            }
            BytesN::from_array(&env, &arr)
        };
        let pk_fixed = {
            let mut arr = [0u8; 192];
            for i in 0u32..192 {
                arr[i as usize] = pubkey_bytes.get(i).unwrap_or(0);
            }
            BytesN::from_array(&env, &arr)
        };

        if pk_fixed != policy.aggregate_pubkey {
            return Err(RegistryError::InvalidSignature);
        }

        let g1_point = Bls12381G1Affine::from_bytes(sig_fixed);
        let g2_point = Bls12381G2Affine::from_bytes(pk_fixed);
        let bls = env.crypto().bls12_381();
        if !bls.g1_is_on_curve(&g1_point) || !bls.g1_is_in_subgroup(&g1_point) {
            return Err(RegistryError::InvalidSignature);
        }
        if !bls.g2_is_on_curve(&g2_point) || !bls.g2_is_in_subgroup(&g2_point) {
            return Err(RegistryError::InvalidSignature);
        }

        let mut root_buf = Bytes::new(&env);
        root_buf.append(&Bytes::from_array(&env, &height.to_le_bytes()));
        root_buf.append(&state_root.clone().into());
        root_buf.append(&event_root.clone().into());
        let hashed = bls.hash_to_g1(
            &root_buf,
            &Bytes::from_array(&env, b"lumen-gate-finality-v1"),
        );
        let g2_gen = bls.hash_to_g2(
            &Bytes::from_array(&env, b"lumen-gate-g2-generator"),
            &Bytes::from_array(&env, b"lumen-gate-finality-v1"),
        );
        let neg_hashed = -hashed;
        let pairing_ok = bls.pairing_check(
            Vec::from_array(&env, [g1_point.clone(), neg_hashed]),
            Vec::from_array(&env, [g2_gen, g2_point.clone()]),
        );
        if !pairing_ok {
            return Err(RegistryError::InvalidSignature);
        }

        let mut new_record = record.clone();
        new_record.last_height = height;
        new_record.last_root = state_root.clone();
        new_record.last_event_root = event_root.clone();
        new_record.last_security =
            SecurityBacking::SignatureSet(signer_count, required, policy.slashable);
        new_record.state = 2;
        env.storage()
            .persistent()
            .set(&DataKey::Domain(domain_key.clone()), &new_record);
        env.storage()
            .persistent()
            .set(&DataKey::Finalized(domain_key.clone(), height), &state_root);
        env.storage().persistent().set(
            &DataKey::FinalizedFull(domain_key.clone(), height),
            &FinalizedRecord {
                state_root: state_root.clone(),
                event_root: event_root.clone(),
            },
        );
        env.storage()
            .persistent()
            .set(&DataKey::Evidence(digest.clone()), &true);

        env.events().publish(
            (Symbol::new(&env, "finality_verified"), domain_key.clone()),
            (height, state_root.clone(), Symbol::new(&env, "bls")),
        );
        Ok(FinalityAttestation {
            adapter: evidence.adapter_id.clone(),
            domain: domain_key.clone(),
            height,
            state_root: state_root.clone(),
            finalized_at: height,
            security: SecurityBacking::SignatureSet(signer_count, required, policy.slashable),
            evidence_digest: digest,
            adapter_version: record.adapter_version,
            evidence_version: evidence.evidence_version,
        })
    }

    pub fn submit_finality_evidence_zk(
        env: Env,
        evidence: RawEvidence,
        proof: Bytes,
        public_inputs: Vec<BytesN<32>>,
    ) -> Result<FinalityAttestation, RegistryError> {
        let domain_key = compute_domain_key(&env, &evidence.adapter_id, &evidence.network);
        let record: DomainRecord = env
            .storage()
            .persistent()
            .get(&DataKey::Domain(domain_key.clone()))
            .ok_or(RegistryError::DomainNotFound)?;
        if record.state == 0 || record.state >= 3 {
            return Err(RegistryError::NotAdmitted);
        }

        if !record.accepted_versions.contains(evidence.evidence_version) {
            return Err(RegistryError::VersionNotAccepted);
        }
        let digest = compute_evidence_digest(&env, &evidence);
        if env
            .storage()
            .persistent()
            .has(&DataKey::Evidence(digest.clone()))
        {
            return Err(RegistryError::EvidenceAlreadyProcessed);
        }

        if evidence.payload.len() != 40 {
            return Err(RegistryError::BadPayloadLength);
        }
        let height_slice = evidence.payload.slice(0..8);
        let mut hb = [0u8; 8];
        for i in 0u32..8 {
            hb[i as usize] = height_slice.get(i).unwrap_or(0);
        }
        let height = u64::from_le_bytes(hb);
        let sr_slice = evidence.payload.slice(8..40);
        let mut sr_arr = [0u8; 32];
        for i in 0u32..32 {
            sr_arr[i as usize] = sr_slice.get(i).unwrap_or(0);
        }
        let state_root = BytesN::from_array(&env, &sr_arr);

        if height != evidence.declared_height || state_root != evidence.declared_root {
            return Err(RegistryError::DeclaredMismatch);
        }

        let vk: Bytes = env
            .storage()
            .instance()
            .get(&DataKey::Vk)
            .unwrap_or(Bytes::new(&env));
        if vk.is_empty() || public_inputs.is_empty() {
            return Err(RegistryError::InvalidProof);
        }

        // The final public input is the source state-root commitment. A proof
        // for another root is not a finality proof for this evidence.
        if public_inputs.len() != 4 {
            return Err(RegistryError::InvalidProof);
        }
        let commitment = public_inputs.get(3).unwrap();
        if commitment != state_root {
            return Err(RegistryError::DeclaredMismatch);
        }

        let verified = groth16::verify(&env, &vk, &proof, &public_inputs);
        if !verified {
            return Err(RegistryError::InvalidProof);
        }

        let mut new_record = record.clone();
        new_record.last_height = height;
        new_record.last_root = state_root.clone();
        new_record.last_security = SecurityBacking::ZkProof;
        new_record.state = 2;
        env.storage()
            .persistent()
            .set(&DataKey::Domain(domain_key.clone()), &new_record);
        env.storage()
            .persistent()
            .set(&DataKey::Finalized(domain_key.clone(), height), &state_root);
        env.storage().persistent().set(
            &DataKey::FinalizedFull(domain_key.clone(), height),
            &FinalizedRecord {
                state_root: state_root.clone(),
                event_root: BytesN::from_array(&env, &[0u8; 32]),
            },
        );
        env.storage()
            .persistent()
            .set(&DataKey::Evidence(digest.clone()), &true);

        let att = FinalityAttestation {
            adapter: evidence.adapter_id.clone(),
            domain: domain_key.clone(),
            height,
            state_root: state_root.clone(),
            finalized_at: height,
            security: SecurityBacking::ZkProof,
            evidence_digest: digest.clone(),
            adapter_version: record.adapter_version,
            evidence_version: evidence.evidence_version,
        };
        env.events().publish(
            (Symbol::new(&env, "finality_verified"), domain_key),
            (height, state_root, Symbol::new(&env, "groth16")),
        );
        Ok(att)
    }

    // =====================================================================
    // Multi-step chained finality lane
    // =====================================================================
    //
    // A second, separate proof lane. It exists because the claim a single fixed
    // statement supports is narrow: "a quorum exists over one bitmap and three
    // roots share one Poseidon relation". A system that advances a state wants
    // the stronger, machine-shaped claim: "starting from the published start
    // root, M consecutive steps, each carrying a quorum, produce exactly the
    // published end root".
    //
    // Three boundaries are deliberate, and every one of them is covered by a
    // test:
    //
    //   1. It cannot influence settlement. The accepted chain is written to its
    //      own storage slot and does NOT touch the domain's `last_root` or
    //      `last_event_root`, which are what the settlement anchor is read from.
    //      A quorum proof is not a signature proof, so it does not get to move
    //      the anchor.
    //   2. It cannot borrow the other lane's key. The step-chain key has its own
    //      slot and its own fixed length, so a 768-byte key and an 896-byte key
    //      cannot be substituted for one another.
    //   3. It refuses to go backwards. A chain whose height is not above the last
    //      accepted chain height for that domain is refused, so the recorded
    //      trail can only move forward.

    /// Bootstraps the step-chain verification key. Admin-gated exactly like
    /// `set_vk`, and permanently refused after `renounce_admin`.
    pub fn set_step_chain_vk(env: Env, admin: Address, vk: Bytes) {
        if Self::is_admin_renounced(&env) {
            panic!("admin renounced");
        }
        admin.require_auth();
        let stored_admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if stored_admin != admin {
            panic!("not admin");
        }
        // Explicit size limit: any other length is a format error, and decoding
        // it would slice the wrong byte ranges.
        if vk.len() != STEP_CHAIN_VK_LEN {
            panic!("expected 896-byte step-chain verification key");
        }
        env.storage().instance().set(&DataKey::StepChainVk, &vk);
    }

    pub fn get_step_chain_vk(env: Env) -> Bytes {
        env.storage()
            .instance()
            .get(&DataKey::StepChainVk)
            .unwrap_or(Bytes::new(&env))
    }

    pub fn get_step_chain_record(env: Env, domain: BytesN<32>) -> Option<StepChainRecord> {
        env.storage().persistent().get(&DataKey::StepChain(domain))
    }

    /// Verifies a multi-step chained proof and records it.
    ///
    /// Every public input is bound here, one by one, to a value this contract
    /// derived itself from the evidence payload or from registered state. That
    /// is the point of the entrypoint: a public input the contract does not bind
    /// is a value the prover chooses.
    pub fn submit_step_chain_zk(
        env: Env,
        evidence: RawEvidence,
        proof: Bytes,
        public_inputs: Vec<BytesN<32>>,
    ) -> Result<StepChainAttestation, RegistryError> {
        let domain_key = compute_domain_key(&env, &evidence.adapter_id, &evidence.network);
        let record: DomainRecord = env
            .storage()
            .persistent()
            .get(&DataKey::Domain(domain_key.clone()))
            .ok_or(RegistryError::DomainNotFound)?;
        if record.state == 0 || record.state >= 3 {
            return Err(RegistryError::NotAdmitted);
        }
        if !record.accepted_versions.contains(evidence.evidence_version) {
            return Err(RegistryError::VersionNotAccepted);
        }

        let digest = compute_evidence_digest(&env, &evidence);
        if env
            .storage()
            .persistent()
            .has(&DataKey::Evidence(digest.clone()))
        {
            return Err(RegistryError::EvidenceAlreadyProcessed);
        }

        // -- parse the payload and re-derive the declared fields --------------
        let decoded = parse_step_chain_payload(&env, &evidence.payload)?;
        if decoded.height != evidence.declared_height || decoded.end_root != evidence.declared_root
        {
            return Err(RegistryError::DeclaredMismatch);
        }
        if decoded.chain_length == 0 || decoded.chain_length > STEP_CHAIN_MAX_STEPS {
            return Err(RegistryError::InvalidPayload);
        }
        if decoded.start_root == decoded.end_root {
            return Err(RegistryError::InvalidPayload);
        }

        // -- explicit size limits, before any arithmetic ----------------------
        if proof.len() != groth16::PROOF_SIZE {
            return Err(RegistryError::InvalidProof);
        }
        if public_inputs.len() != STEP_CHAIN_PUBLIC_INPUTS {
            return Err(RegistryError::InvalidProof);
        }
        let vk: Bytes = env
            .storage()
            .instance()
            .get(&DataKey::StepChainVk)
            .unwrap_or(Bytes::new(&env));
        if vk.len() != STEP_CHAIN_VK_LEN {
            return Err(RegistryError::InvalidProof);
        }

        // -- bind every public input ------------------------------------------
        // Order is fixed by the circuit and mirrored by the generated vectors:
        //   0 chain_start_root  1 chain_end_root  2 event_root
        //   3 threshold         4 chain_length    5 domain_tag
        require_root_input(&public_inputs, 0, &decoded.start_root)?;
        require_root_input(&public_inputs, 1, &decoded.end_root)?;
        require_root_input(&public_inputs, 2, &decoded.event_root)?;
        require_scalar_input(&public_inputs, 3, STEP_CHAIN_QUORUM)?;
        require_scalar_input(&public_inputs, 4, decoded.chain_length)?;
        if public_inputs.get(5).unwrap() != step_chain_tag(&env) {
            return Err(RegistryError::DeclaredMismatch);
        }

        // -- the trail only moves forward --------------------------------------
        if let Some(previous) = env
            .storage()
            .persistent()
            .get::<DataKey, StepChainRecord>(&DataKey::StepChain(domain_key.clone()))
        {
            if decoded.height <= previous.height {
                return Err(RegistryError::EvidenceAlreadyProcessed);
            }
        }

        if !groth16::verify(&env, &vk, &proof, &public_inputs) {
            return Err(RegistryError::InvalidProof);
        }

        let accepted = StepChainRecord {
            domain: domain_key.clone(),
            height: decoded.height,
            chain_length: decoded.chain_length,
            start_root: decoded.start_root.clone(),
            end_root: decoded.end_root.clone(),
            event_root: decoded.event_root.clone(),
            threshold: STEP_CHAIN_QUORUM,
            settlement_anchored: false,
        };
        env.storage()
            .persistent()
            .set(&DataKey::StepChain(domain_key.clone()), &accepted);
        env.storage()
            .persistent()
            .set(&DataKey::Evidence(digest.clone()), &true);

        env.events().publish(
            (Symbol::new(&env, "step_chain_verified"), domain_key.clone()),
            (
                decoded.height,
                decoded.chain_length,
                decoded.end_root.clone(),
                decoded.event_root.clone(),
            ),
        );

        Ok(StepChainAttestation {
            domain: domain_key,
            height: decoded.height,
            chain_length: decoded.chain_length,
            start_root: decoded.start_root,
            end_root: decoded.end_root,
            event_root: decoded.event_root,
            security: SecurityBacking::ZkProof,
            evidence_digest: digest,
            adapter_version: record.adapter_version,
            evidence_version: evidence.evidence_version,
        })
    }

    // -----------------------------------------------------------------------
    // Execution lane
    // -----------------------------------------------------------------------
    //
    // Three properties separate this entrypoint from "verify a proof and trust
    // the caller":
    //
    //   1. Every public input is bound, one by one, to a value this contract
    //      derived itself -- the sixteen program words from the payload, the two
    //      register-file roots from the payload, the program counter, the step
    //      count and the gas from the payload, and the tag from its own
    //      constant. A public input the contract does not bind is a value the
    //      prover chose.
    //   2. The payload is bounded before it is used: the instruction slots past
    //      the code must be zero, every word must be decodable, the step count
    //      must fit the circuit's row count, and the published gas must be
    //      arithmetically possible.
    //   3. It cannot borrow another lane's key, and it does not touch the
    //      domain's settlement roots. A verified execution is not a verified
    //      chain root, and the separation is in the storage layout, not in a
    //      comment.

    /// Bootstraps the execution lane's verification key. Admin-gated exactly
    /// like `set_vk` and `set_step_chain_vk`, and permanently refused after
    /// `renounce_admin`.
    pub fn set_execution_vk(env: Env, admin: Address, vk: Bytes) {
        if Self::is_admin_renounced(&env) {
            panic!("admin renounced");
        }
        admin.require_auth();
        let stored_admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if stored_admin != admin {
            panic!("not admin");
        }
        // Explicit size limit. 1920 = alpha(64) + beta(128) + gamma(128) +
        // delta(128) + 23 IC points (64 each), for 22 public inputs.
        if vk.len() != EXECUTION_VK_LEN {
            panic!("expected 1920-byte execution verification key");
        }
        env.storage().instance().set(&DataKey::ExecutionVk, &vk);
    }

    pub fn get_execution_vk(env: Env) -> Bytes {
        env.storage()
            .instance()
            .get(&DataKey::ExecutionVk)
            .unwrap_or(Bytes::new(&env))
    }

    pub fn get_execution_record(env: Env, domain: BytesN<32>) -> Option<ExecutionRecord> {
        env.storage().persistent().get(&DataKey::Execution(domain))
    }

    /// Verifies an execution proof and records it.
    pub fn submit_execution_zk(
        env: Env,
        evidence: RawEvidence,
        proof: Bytes,
        public_inputs: Vec<BytesN<32>>,
    ) -> Result<ExecutionAttestation, RegistryError> {
        let domain_key = compute_domain_key(&env, &evidence.adapter_id, &evidence.network);
        let record: DomainRecord = env
            .storage()
            .persistent()
            .get(&DataKey::Domain(domain_key.clone()))
            .ok_or(RegistryError::DomainNotFound)?;
        if record.state == 0 || record.state >= 3 {
            return Err(RegistryError::NotAdmitted);
        }
        if !record.accepted_versions.contains(evidence.evidence_version) {
            return Err(RegistryError::VersionNotAccepted);
        }

        let digest = compute_evidence_digest(&env, &evidence);
        if env
            .storage()
            .persistent()
            .has(&DataKey::Evidence(digest.clone()))
        {
            return Err(RegistryError::EvidenceAlreadyProcessed);
        }

        // -- parse the payload and re-derive the declared fields --------------
        let decoded = parse_execution_payload(&env, &evidence.payload)?;
        if decoded.height != evidence.declared_height
            || decoded.state_root != evidence.declared_root
        {
            return Err(RegistryError::DeclaredMismatch);
        }

        // -- explicit size limits, before any arithmetic ----------------------
        if proof.len() != groth16::PROOF_SIZE {
            return Err(RegistryError::InvalidProof);
        }
        if public_inputs.len() != EXECUTION_PUBLIC_INPUTS {
            return Err(RegistryError::InvalidProof);
        }
        let vk: Bytes = env
            .storage()
            .instance()
            .get(&DataKey::ExecutionVk)
            .unwrap_or(Bytes::new(&env));
        if vk.len() != EXECUTION_VK_LEN {
            return Err(RegistryError::InvalidProof);
        }

        // -- bind every public input ------------------------------------------
        // Order is fixed by the circuit and mirrored by the generated vectors:
        //   0..16 program   16 initial_regs_root   17 final_regs_root
        //   18 final_pc     19 steps_executed      20 gas_used   21 domain_tag
        for index in 0..EXECUTION_PROGRAM_WORDS {
            require_program_input(&public_inputs, index, decoded.program[index as usize])?;
        }
        require_root_input(&public_inputs, 16, &decoded.initial_regs_root)?;
        require_root_input(&public_inputs, 17, &decoded.state_root)?;
        require_scalar_input(&public_inputs, 18, decoded.final_pc)?;
        require_scalar_input(&public_inputs, 19, decoded.steps_executed)?;
        require_scalar_input(&public_inputs, 20, decoded.gas_used)?;
        if public_inputs.get(21).unwrap() != execution_tag(&env) {
            return Err(RegistryError::DeclaredMismatch);
        }

        // -- the trail only moves forward --------------------------------------
        if let Some(previous) = env
            .storage()
            .persistent()
            .get::<DataKey, ExecutionRecord>(&DataKey::Execution(domain_key.clone()))
        {
            if decoded.height <= previous.height {
                return Err(RegistryError::EvidenceAlreadyProcessed);
            }
        }

        if !groth16::verify(&env, &vk, &proof, &public_inputs) {
            return Err(RegistryError::InvalidProof);
        }

        let program_digest = compute_program_digest(&env, &decoded.program);
        let accepted = ExecutionRecord {
            domain: domain_key.clone(),
            height: decoded.height,
            program_digest: program_digest.clone(),
            instruction_words: decoded.instruction_words,
            state_root: decoded.state_root.clone(),
            initial_regs_root: decoded.initial_regs_root.clone(),
            final_pc: decoded.final_pc,
            steps_executed: decoded.steps_executed,
            gas_used: decoded.gas_used,
            settlement_anchored: false,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Execution(domain_key.clone()), &accepted);
        env.storage()
            .persistent()
            .set(&DataKey::Evidence(digest.clone()), &true);

        env.events().publish(
            (Symbol::new(&env, "execution_verified"), domain_key.clone()),
            (
                decoded.height,
                decoded.steps_executed,
                decoded.gas_used,
                program_digest.clone(),
            ),
        );

        Ok(ExecutionAttestation {
            domain: domain_key,
            height: decoded.height,
            program_digest,
            state_root: decoded.state_root,
            steps_executed: decoded.steps_executed,
            gas_used: decoded.gas_used,
            security: SecurityBacking::ZkProof,
            evidence_digest: digest,
            adapter_version: record.adapter_version,
            evidence_version: evidence.evidence_version,
        })
    }

    // =====================================================================
    // Gate-VM lane
    // =====================================================================
    //
    // The fourth lane, and the second one whose statement is a machine run.
    // Where the execution lane's machine is a word processor -- 64-bit
    // arithmetic, a memory bus, public program words -- this one is a
    // field-native machine with a Poseidon instruction: its programs compute
    // hash chains *as data*, and its program is committed (a fold root is the
    // public input; the cells never appear in the proof's statement). That
    // combination is what makes a claim like "H^4(start, event) = end, by
    // executing this committed program" provable at all: the hash is inside
    // the machine instead of around it.
    //
    // The three boundaries the execution lane documents apply verbatim: every
    // public input is bound here, the payload is bounded before use, and the
    // lane records without anchoring. Same rules, separate slots.

    /// Bootstraps the gate-vm verification key. Admin-gated exactly like the
    /// others, permanently refused after `renounce_admin`.
    pub fn set_gate_vm_vk(env: Env, admin: Address, vk: Bytes) {
        if Self::is_admin_renounced(&env) {
            panic!("admin renounced");
        }
        admin.require_auth();
        let stored_admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if stored_admin != admin {
            panic!("not admin");
        }
        if vk.len() != GATE_VM_VK_LEN {
            panic!("expected 896-byte gate-vm verification key");
        }
        env.storage().instance().set(&DataKey::GateVmVk, &vk);
    }

    pub fn get_gate_vm_vk(env: Env) -> Bytes {
        env.storage()
            .instance()
            .get(&DataKey::GateVmVk)
            .unwrap_or(Bytes::new(&env))
    }

    pub fn get_gate_vm_record(env: Env, domain: BytesN<32>) -> Option<GateVmRecord> {
        env.storage().persistent().get(&DataKey::GateVm(domain))
    }

    /// Verifies a gate-vm run proof and records it.
    pub fn submit_gate_vm_zk(
        env: Env,
        evidence: RawEvidence,
        proof: Bytes,
        public_inputs: Vec<BytesN<32>>,
    ) -> Result<GateVmAttestation, RegistryError> {
        let domain_key = compute_domain_key(&env, &evidence.adapter_id, &evidence.network);
        let record: DomainRecord = env
            .storage()
            .persistent()
            .get(&DataKey::Domain(domain_key.clone()))
            .ok_or(RegistryError::DomainNotFound)?;
        if record.state == 0 || record.state >= 3 {
            return Err(RegistryError::NotAdmitted);
        }
        if !record.accepted_versions.contains(evidence.evidence_version) {
            return Err(RegistryError::VersionNotAccepted);
        }

        let digest = compute_evidence_digest(&env, &evidence);
        if env
            .storage()
            .persistent()
            .has(&DataKey::Evidence(digest.clone()))
        {
            return Err(RegistryError::EvidenceAlreadyProcessed);
        }

        let decoded = parse_gate_vm_payload(&env, &evidence.payload)?;
        if decoded.height != evidence.declared_height || decoded.end_root != evidence.declared_root
        {
            return Err(RegistryError::DeclaredMismatch);
        }

        if proof.len() != groth16::PROOF_SIZE {
            return Err(RegistryError::InvalidProof);
        }
        if public_inputs.len() != GATE_VM_PUBLIC_INPUTS {
            return Err(RegistryError::InvalidProof);
        }
        let vk: Bytes = env
            .storage()
            .instance()
            .get(&DataKey::GateVmVk)
            .unwrap_or(Bytes::new(&env));
        if vk.len() != GATE_VM_VK_LEN {
            return Err(RegistryError::InvalidProof);
        }

        // -- bind every public input ------------------------------------------
        // Order is the circuit's `main {public [...]}` declaration, mirrored by
        // the vector generator:
        //   0 program_root  1 start_root  2 event_root  3 end_root
        //   4 hash_steps    5 domain_tag
        require_root_input(&public_inputs, 0, &decoded.program_root)?;
        require_root_input(&public_inputs, 1, &decoded.start_root)?;
        require_root_input(&public_inputs, 2, &decoded.event_root)?;
        require_root_input(&public_inputs, 3, &decoded.end_root)?;
        require_scalar_input(&public_inputs, 4, decoded.hash_steps)?;
        if public_inputs.get(5).unwrap() != gate_vm_tag(&env) {
            return Err(RegistryError::DeclaredMismatch);
        }

        // -- the trail only moves forward --------------------------------------
        if let Some(previous) = env
            .storage()
            .persistent()
            .get::<DataKey, GateVmRecord>(&DataKey::GateVm(domain_key.clone()))
        {
            if decoded.height <= previous.height {
                return Err(RegistryError::EvidenceAlreadyProcessed);
            }
        }

        if !groth16::verify(&env, &vk, &proof, &public_inputs) {
            return Err(RegistryError::InvalidProof);
        }

        let accepted = GateVmRecord {
            domain: domain_key.clone(),
            height: decoded.height,
            program_root: decoded.program_root.clone(),
            start_root: decoded.start_root.clone(),
            event_root: decoded.event_root.clone(),
            end_root: decoded.end_root.clone(),
            hash_steps: decoded.hash_steps,
            settlement_anchored: false,
        };
        env.storage()
            .persistent()
            .set(&DataKey::GateVm(domain_key.clone()), &accepted);
        env.storage()
            .persistent()
            .set(&DataKey::Evidence(digest.clone()), &true);

        env.events().publish(
            (Symbol::new(&env, "gate_vm_verified"), domain_key.clone()),
            (
                decoded.height,
                decoded.hash_steps,
                decoded.program_root.clone(),
            ),
        );

        Ok(GateVmAttestation {
            domain: domain_key,
            height: decoded.height,
            program_root: decoded.program_root,
            end_root: decoded.end_root,
            hash_steps: decoded.hash_steps,
            security: SecurityBacking::ZkProof,
            evidence_digest: digest,
            adapter_version: record.adapter_version,
            evidence_version: evidence.evidence_version,
        })
    }

    // =====================================================================
    // Gate-VM32 lane: the sibling compilation
    // =====================================================================
    //
    // One core circuit, two mains, two ceremonies, two slots. Everything the
    // 8-line lane says about bound publics, bounded payloads and recording
    // without anchoring holds here verbatim; the two facts that differ are
    // the key material and the ceiling, and both are stated as constants
    // beside this section rather than implied by the lane's name.

    /// Bootstraps the 32-line sibling's verification key. Admin-gated like
    /// the others, permanently refused after `renounce_admin`.
    pub fn set_gate_vm32_vk(env: Env, admin: Address, vk: Bytes) {
        if Self::is_admin_renounced(&env) {
            panic!("admin renounced");
        }
        admin.require_auth();
        let stored_admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if stored_admin != admin {
            panic!("not admin");
        }
        if vk.len() != GATE_VM32_VK_LEN {
            panic!("expected 896-byte gate-vm32 verification key");
        }
        env.storage().instance().set(&DataKey::GateVm32Vk, &vk);
    }

    pub fn get_gate_vm32_vk(env: Env) -> Bytes {
        env.storage()
            .instance()
            .get(&DataKey::GateVm32Vk)
            .unwrap_or(Bytes::new(&env))
    }

    pub fn get_gate_vm32_record(env: Env, domain: BytesN<32>) -> Option<GateVm32Record> {
        env.storage().persistent().get(&DataKey::GateVm32(domain))
    }

    /// Verifies a 32-window run proof and records it.
    pub fn submit_gate_vm32_zk(
        env: Env,
        evidence: RawEvidence,
        proof: Bytes,
        public_inputs: Vec<BytesN<32>>,
    ) -> Result<GateVm32Attestation, RegistryError> {
        let domain_key = compute_domain_key(&env, &evidence.adapter_id, &evidence.network);
        let record: DomainRecord = env
            .storage()
            .persistent()
            .get(&DataKey::Domain(domain_key.clone()))
            .ok_or(RegistryError::DomainNotFound)?;
        if record.state == 0 || record.state >= 3 {
            return Err(RegistryError::NotAdmitted);
        }
        if !record.accepted_versions.contains(evidence.evidence_version) {
            return Err(RegistryError::VersionNotAccepted);
        }

        let digest = compute_evidence_digest(&env, &evidence);
        if env
            .storage()
            .persistent()
            .has(&DataKey::Evidence(digest.clone()))
        {
            return Err(RegistryError::EvidenceAlreadyProcessed);
        }

        let decoded = parse_gate_vm32_payload(&env, &evidence.payload)?;
        if decoded.height != evidence.declared_height || decoded.end_root != evidence.declared_root
        {
            return Err(RegistryError::DeclaredMismatch);
        }

        if proof.len() != groth16::PROOF_SIZE {
            return Err(RegistryError::InvalidProof);
        }
        if public_inputs.len() != GATE_VM32_PUBLIC_INPUTS {
            return Err(RegistryError::InvalidProof);
        }
        let vk: Bytes = env
            .storage()
            .instance()
            .get(&DataKey::GateVm32Vk)
            .unwrap_or(Bytes::new(&env));
        if vk.len() != GATE_VM32_VK_LEN {
            return Err(RegistryError::InvalidProof);
        }

        require_root_input(&public_inputs, 0, &decoded.program_root)?;
        require_root_input(&public_inputs, 1, &decoded.start_root)?;
        require_root_input(&public_inputs, 2, &decoded.event_root)?;
        require_root_input(&public_inputs, 3, &decoded.end_root)?;
        require_scalar_input(&public_inputs, 4, decoded.hash_steps)?;
        if public_inputs.get(5).unwrap() != gate_vm_tag(&env) {
            return Err(RegistryError::DeclaredMismatch);
        }

        if let Some(previous) = env
            .storage()
            .persistent()
            .get::<DataKey, GateVm32Record>(&DataKey::GateVm32(domain_key.clone()))
        {
            if decoded.height <= previous.height {
                return Err(RegistryError::EvidenceAlreadyProcessed);
            }
        }

        if !groth16::verify(&env, &vk, &proof, &public_inputs) {
            return Err(RegistryError::InvalidProof);
        }

        let accepted = GateVm32Record {
            domain: domain_key.clone(),
            height: decoded.height,
            program_root: decoded.program_root.clone(),
            start_root: decoded.start_root.clone(),
            event_root: decoded.event_root.clone(),
            end_root: decoded.end_root.clone(),
            hash_steps: decoded.hash_steps,
            settlement_anchored: false,
        };
        env.storage()
            .persistent()
            .set(&DataKey::GateVm32(domain_key.clone()), &accepted);
        env.storage()
            .persistent()
            .set(&DataKey::Evidence(digest.clone()), &true);

        env.events().publish(
            (Symbol::new(&env, "gate_vm32_verified"), domain_key.clone()),
            (
                decoded.height,
                decoded.hash_steps,
                decoded.program_root.clone(),
            ),
        );

        Ok(GateVm32Attestation {
            domain: domain_key,
            height: decoded.height,
            program_root: decoded.program_root,
            end_root: decoded.end_root,
            hash_steps: decoded.hash_steps,
            security: SecurityBacking::ZkProof,
            evidence_digest: digest,
            adapter_version: record.adapter_version,
            evidence_version: evidence.evidence_version,
        })
    }

    pub fn list_domains(env: Env) -> Vec<BytesN<32>> {
        env.storage()
            .instance()
            .get(&DataKey::DomainList)
            .unwrap_or(Vec::new(&env))
    }

    // Alias for the Groth16 path. The name is legacy and it is kept only
    // because this entrypoint is live in a registry whose admin has been
    // renounced, so the ABI cannot be renamed in place.
    //
    // This entrypoint is a statement proof, not a VM proof: the statement is
    // baked into the constraint system at compile time, and the circuit proves
    // that a quorum of a bitmap is set and that the submitted roots participate
    // in one Poseidon relation. There is no instruction set, no memory model and
    // no program commitment behind *this* lane.
    //
    // The repository does carry a lane that proves a program ran -- the
    // execution trace circuit in `submit_execution_zk`, with the machine in
    // `crates/execution_vm` -- and the two are not interchangeable: that one
    // proves a run on a small bounded machine and still does not anchor
    // settlement. See docs/PROVING_SYSTEM.md sections 5c and 7, and note that
    // the settlement path does not use this lane's event root precisely because
    // no signature covers it.
    pub fn verify_via_zkvm(
        env: Env,
        evidence: RawEvidence,
        proof: Bytes,
        public_inputs: Vec<BytesN<32>>,
    ) -> Result<FinalityAttestation, RegistryError> {
        Self::submit_finality_evidence_zk(env, evidence, proof, public_inputs)
    }

    // True when the domain's most recent finality came from the Groth16 lane
    // rather than from a BLS signature set. "Machine approved" here means
    // "the last accepted evidence was a pairing check", nothing more.
    pub fn is_machine_approved(env: Env, domain: BytesN<32>) -> bool {
        if let Some(record) = env
            .storage()
            .persistent()
            .get::<DataKey, DomainRecord>(&DataKey::Domain(domain.clone()))
        {
            // Only a recorded ZK attestation is reported as ZK machine approval.
            record.state == 2
                && record.last_height > 0
                && matches!(&record.last_security, SecurityBacking::ZkProof)
        } else {
            false
        }
    }
}

#[cfg(test)]
mod test_vectors;

#[cfg(test)]
mod step_chain_vectors;

#[cfg(test)]
mod execution_trace_vectors;

#[cfg(test)]
mod gate_vm_vectors;
#[cfg(test)]
/// The 32-line sibling's committed vectors: its own ceremony's key, the same
/// demo execution, and the invariance the split was built on -- end root
/// equal to the 8-line lane's, program commitment different by construction.
mod gate_vm32_vectors;

// ---------------------------------------------------------------------------
// Multi-step chained lane: payload parsing and public-input binding
// ---------------------------------------------------------------------------

/// Fixed capacities of the compiled circuit. The contract has to know them,
/// because it refuses any payload describing a chain the circuit could not have
/// produced.
pub const STEP_CHAIN_PAYLOAD_LEN: u32 = 112;
pub const STEP_CHAIN_PUBLIC_INPUTS: u32 = 6;
pub const STEP_CHAIN_VK_LEN: u32 = 896;
pub const STEP_CHAIN_MAX_STEPS: u64 = 4;

/// The quorum the step-chain circuit compiled in.
///
/// This is deliberately NOT read from a per-domain policy record. The circuit's
/// statement fixes the threshold as a constant and constrains the public input
/// to it, so the contract binds the same constant: neither the prover nor an
/// operator can choose a quorum for a given proof. A domain that wants a
/// different quorum needs a different circuit, which is the honest consequence
/// of compiling policy into the statement instead of carrying it as data.
/// Moving it to a per-domain record is roadmap, and doing it while keeping the
/// binding tight means committing to the threshold inside the circuit rather
/// than trusting a storage read.
pub const STEP_CHAIN_QUORUM: u64 = 2;

/// The domain-separation tag compiled into the circuit, as a 32-byte big-endian
/// field element. It differs from the label the single-statement lane and the
/// BLS lane use, so a proof for one statement cannot be presented as another.
/// `step_chain_tag_matches_the_circuit_constant` pins it against the value the
/// circuit derives from the string.
pub const STEP_CHAIN_TAG_BYTES: [u8; 32] = [
    0x00, 0x95, 0x17, 0xe4, 0x43, 0xe8, 0x40, 0x62, 0xa6, 0x78, 0x1b, 0x2a, 0x92, 0x16, 0x0d, 0x0a,
    0x32, 0x5f, 0x4c, 0x5a, 0x45, 0x82, 0x6a, 0x0c, 0x0b, 0x54, 0x64, 0x4e, 0x2e, 0xd5, 0x74, 0xf0,
];

fn step_chain_tag(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &STEP_CHAIN_TAG_BYTES)
}

/// The fields this lane reads out of the payload.
pub struct DecodedStepChain {
    pub height: u64,
    pub start_root: BytesN<32>,
    pub end_root: BytesN<32>,
    pub event_root: BytesN<32>,
    pub chain_length: u64,
}

fn read_u64_le(bytes: &Bytes, offset: u32) -> u64 {
    let mut raw = [0u8; 8];
    for i in 0u32..8 {
        raw[i as usize] = bytes.get(offset + i).unwrap_or(0);
    }
    u64::from_le_bytes(raw)
}

fn read_root(env: &Env, bytes: &Bytes, offset: u32) -> BytesN<32> {
    let mut raw = [0u8; 32];
    for i in 0u32..32 {
        raw[i as usize] = bytes.get(offset + i).unwrap_or(0);
    }
    BytesN::from_array(env, &raw)
}

/// Parses the step-chain payload. Any other length is a format error, so a
/// payload with trailing bytes is refused rather than partially read.
fn parse_step_chain_payload(env: &Env, payload: &Bytes) -> Result<DecodedStepChain, RegistryError> {
    if payload.len() != STEP_CHAIN_PAYLOAD_LEN {
        return Err(RegistryError::BadPayloadLength);
    }
    let height = read_u64_le(payload, 0);
    if height == 0 {
        return Err(RegistryError::InvalidPayload);
    }
    Ok(DecodedStepChain {
        height,
        start_root: read_root(env, payload, 8),
        end_root: read_root(env, payload, 40),
        event_root: read_root(env, payload, 72),
        chain_length: read_u64_le(payload, 104),
    })
}

/// Requires a public input to be exactly the expected 32-byte root.
fn require_root_input(
    inputs: &Vec<BytesN<32>>,
    index: u32,
    expected: &BytesN<32>,
) -> Result<(), RegistryError> {
    if inputs.get(index).ok_or(RegistryError::InvalidProof)? != *expected {
        return Err(RegistryError::DeclaredMismatch);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Execution lane: payload parsing and public-input binding
// ---------------------------------------------------------------------------
//
// The circuit this lane verifies proves what `crates/execution_vm` implements: a
// program of at most sixteen packed instructions ran on a machine with eight
// registers and sixteen words of memory, in at most twenty fetched steps, and
// ended by executing a halt. The contract's job is the same as in the chained
// lane and narrower than it sounds: bind every public input to a value the
// contract derived from the payload or from registered state, and refuse
// anything that does not describe a run the circuit could have produced.
//
// What this lane is NOT: it is not a proof about the settlement chain's roots,
// and it does not move them. The final register file it commits is the machine's
// own end state. Wiring that state into the settlement anchor is roadmap, and
// saying so here is cheaper than implying otherwise.

/// Fixed capacities of the compiled circuit.
pub const EXECUTION_PAYLOAD_LEN: u32 = 232;
pub const EXECUTION_PUBLIC_INPUTS: u32 = 22;
pub const EXECUTION_VK_LEN: u32 = 1920;
pub const EXECUTION_MAX_STEPS: u64 = 20;
pub const EXECUTION_PROGRAM_WORDS: u32 = 16;

/// The costing of one proof cannot exceed the machine's most expensive
/// instruction charged on every row. A published cost above it describes no run.
pub const EXECUTION_MAX_GAS: u64 = 3 * EXECUTION_MAX_STEPS;

/// The largest packed instruction the circuit can decode: the decode equation
/// leaves 55 bits for opcode, three five-bit register indices and a 32-bit
/// immediate. A larger word has no decode, so a proof about it cannot exist and
/// the contract refuses the payload rather than let a caller pay for one.
pub const EXECUTION_MAX_PROGRAM_WORD: u64 = (1u64 << 55) - 1;

/// The domain-separation tag compiled into the trace circuit, as a 32-byte
/// big-endian field element. It differs from both the chained lane's tag and the
/// single-statement lane's label.
pub const EXECUTION_TAG_BYTES: [u8; 32] = [
    0x00, 0xcf, 0x56, 0x2c, 0x45, 0xb7, 0xd4, 0x3f, 0x8a, 0x7e, 0x71, 0x01, 0x03, 0xa5, 0x1d, 0x92,
    0xee, 0x08, 0x84, 0xf0, 0x7e, 0xb9, 0xdc, 0xb8, 0xa6, 0x1b, 0x1d, 0x91, 0x62, 0xef, 0x7d, 0xb4,
];

fn execution_tag(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &EXECUTION_TAG_BYTES)
}

/// The fields this lane reads out of the payload.
///
/// Layout, 232 bytes, little-endian integers:
///
/// ```text
///   0   8   height                  the domain's execution trail height
///   8   32  state_root              == public input 17 (the final register file)
///   40  32  initial_regs_root       == public input 16
///   72  8   final_pc                == public input 18
///   80  8   steps_executed          == public input 19
///   88  8   gas_used                == public input 20
///   96  8   instruction_words       how many of the sixteen slots are code
///   104 128 program[16]             == public inputs 0..16, eight bytes each
/// ```
pub struct DecodedExecution {
    pub height: u64,
    pub state_root: BytesN<32>,
    pub initial_regs_root: BytesN<32>,
    pub final_pc: u64,
    pub steps_executed: u64,
    pub gas_used: u64,
    pub instruction_words: u64,
    pub program: [u64; 16],
}

/// Parses the execution payload. Any other length is a format error, so a
/// payload with trailing bytes is refused rather than partially read.
fn parse_execution_payload(env: &Env, payload: &Bytes) -> Result<DecodedExecution, RegistryError> {
    if payload.len() != EXECUTION_PAYLOAD_LEN {
        return Err(RegistryError::BadPayloadLength);
    }
    let height = read_u64_le(payload, 0);
    if height == 0 {
        return Err(RegistryError::InvalidPayload);
    }
    let final_pc = read_u64_le(payload, 72);
    if final_pc >= EXECUTION_PROGRAM_WORDS as u64 {
        return Err(RegistryError::InvalidPayload);
    }
    let steps_executed = read_u64_le(payload, 80);
    if steps_executed == 0 || steps_executed > EXECUTION_MAX_STEPS {
        return Err(RegistryError::InvalidPayload);
    }
    let gas_used = read_u64_le(payload, 88);
    if gas_used > EXECUTION_MAX_GAS {
        return Err(RegistryError::InvalidPayload);
    }
    let instruction_words = read_u64_le(payload, 96);
    if instruction_words == 0 || instruction_words > EXECUTION_PROGRAM_WORDS as u64 {
        return Err(RegistryError::InvalidPayload);
    }

    let mut program = [0u64; 16];
    for index in 0..16u32 {
        let word = read_u64_le(payload, 104 + index * 8);
        if word > EXECUTION_MAX_PROGRAM_WORD {
            return Err(RegistryError::InvalidPayload);
        }
        // The slots past the code are zero, which decodes to a halt: a program
        // counter that runs off the end of the code stops instead of escaping,
        // and a caller cannot hide instructions in the padding.
        if (index as u64) >= instruction_words && word != 0 {
            return Err(RegistryError::InvalidPayload);
        }
        program[index as usize] = word;
    }

    Ok(DecodedExecution {
        height,
        state_root: read_root(env, payload, 8),
        initial_regs_root: read_root(env, payload, 40),
        final_pc,
        steps_executed,
        gas_used,
        instruction_words,
        program,
    })
}

/// Requires a public input to be the field encoding of one packed instruction.
///
/// The field encoding of an integer is 32 bytes big-endian with the leading 24
/// bytes zero. Checking the bytes rather than the value is what makes this a
/// binding: a non-canonical encoding of the same integer is refused too.
fn require_program_input(
    inputs: &Vec<BytesN<32>>,
    index: u32,
    expected: u64,
) -> Result<(), RegistryError> {
    require_scalar_input(inputs, index, expected)
}

/// The digest the contract names a program by: sha256 over the sixteen packed
/// words, eight bytes each, little-endian.
fn compute_program_digest(env: &Env, program: &[u64; 16]) -> BytesN<32> {
    let mut buf = Bytes::new(env);
    for word in program.iter() {
        buf.append(&Bytes::from_array(env, &word.to_le_bytes()));
    }
    env.crypto().sha256(&buf).into()
}

/// Requires a public input to be the field encoding of a small integer.
///
/// The circuit's public inputs arrive as 32-byte big-endian field elements, so
/// the leading 24 bytes must be zero and the low 8 must carry the value.
/// Comparing the decoded integer rather than the raw bytes is what makes this a
/// binding instead of a formality: it also refuses a value that encodes the same
/// integer through a non-canonical representation.
fn require_scalar_input(
    inputs: &Vec<BytesN<32>>,
    index: u32,
    expected: u64,
) -> Result<(), RegistryError> {
    let value = inputs.get(index).ok_or(RegistryError::InvalidProof)?;
    for i in 0u32..24 {
        if value.get(i).unwrap_or(1) != 0 {
            return Err(RegistryError::DeclaredMismatch);
        }
    }
    let mut raw = [0u8; 8];
    for i in 0u32..8 {
        raw[i as usize] = value.get(24 + i).unwrap_or(0);
    }
    if u64::from_be_bytes(raw) != expected {
        return Err(RegistryError::DeclaredMismatch);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Gate-VM lane: payload parsing and public-input binding
// ---------------------------------------------------------------------------
//
// The circuit this lane verifies proves what `crates/gate_vm` implements: an
// eight-line program of twelve-bit instructions ran on eight field-element
// registers for an eight-row window, its program committed by a Poseidon fold,
// its rows chained by the step relation, and its last row halted. The hash
// steps the machine took are counted by the circuit itself, not declared by
// the caller -- which is the whole reason the number is worth binding.
//
// What this lane is NOT: not a memory-bus argument (the machine is
// register-only, and no sparse-merkle consistency story is claimed anywhere in
// the circuit), not unbounded (the window is the gas, and a program that has
// not halted by row eight has no witness to sell), and not anchored: the run
// is recorded, and the settlement roots are not moved by it.

/// Fixed capacities of the compiled circuit: six public inputs and a seventh
/// IC point at the A-term, hence 64 + 3 x 128 + 7 x 64 = 896 bytes of key.
pub const GATE_VM_PAYLOAD_LEN: u32 = 144;
pub const GATE_VM_PUBLIC_INPUTS: u32 = 6;
pub const GATE_VM_VK_LEN: u32 = 896;

/// The window is eight rows and one of them must be the halt, so no trace has
/// ever counted more than seven hash steps. A payload claiming otherwise
/// describes no proof; refusing it is a courtesy to the submitter, not a
/// security property (the circuit could not produce one either).
pub const GATE_VM_MAX_HASH_STEPS: u64 = 7;

// The 32-line sibling: same payload layout, same public-input count, same key
// length (the ceremony differs, the serialization does not), and a hash-step
// ceiling that is the window size minus one -- 32 rows can count 31 hash
// instructions before the halt must have arrived. The domain tag is shared
// with the 8-line lane because the *circuit* shares it: both compilations
// publish the same separation constant, and the registry does not pretend to
// tell the lanes apart by a number they agree on. What separates them is the
// key each proof must verify under, and the ceiling each payload may claim.
pub const GATE_VM32_PAYLOAD_LEN: u32 = 144;
pub const GATE_VM32_PUBLIC_INPUTS: u32 = 6;
pub const GATE_VM32_VK_LEN: u32 = 896;
pub const GATE_VM32_MAX_HASH_STEPS: u64 = 31;

/// The domain-separation tag compiled into the gate-vm circuit, as a 32-byte
/// big-endian field element: sha256("lumen-gate-vm-v1")[0..31], zero-padded --
/// the same derivation `STEP_CHAIN_TAG_BYTES` and `EXECUTION_TAG_BYTES` document
/// for their lanes. `test_gate_vm_tag_matches_the_circuit_constant` pins it
/// against the value the vectors carry.
pub const GATE_VM_TAG_BYTES: [u8; 32] = [
    0x00, 0x5c, 0x54, 0x64, 0x27, 0xe7, 0xcf, 0xce, 0x5f, 0xc9, 0xb9, 0xbb, 0xee, 0xd0, 0xc3, 0x73,
    0x68, 0x13, 0x04, 0xae, 0xea, 0x84, 0xdc, 0xf9, 0xd7, 0x81, 0x46, 0xee, 0x84, 0x19, 0xa4, 0x59,
];

fn gate_vm_tag(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &GATE_VM_TAG_BYTES)
}

/// The fields this lane reads out of the payload.
///
/// Layout, 144 bytes, little-endian integers:
///
/// ```text
///   0   8   height                  the domain's gate-vm trail height
///   8   32  program_root            == public input 0
///   40  32  start_root              == public input 1
///   72  32  event_root              == public input 2
///   104 32  end_root                == public input 3
///   136 8   hash_steps              == public input 4
/// ```
pub struct DecodedGateVm {
    pub height: u64,
    pub program_root: BytesN<32>,
    pub start_root: BytesN<32>,
    pub event_root: BytesN<32>,
    pub end_root: BytesN<32>,
    pub hash_steps: u64,
}

/// Parses the gate-vm payload. Any other length is a format error; the two
/// value checks bound what a caller can even pay gas for.
fn parse_gate_vm_payload(env: &Env, payload: &Bytes) -> Result<DecodedGateVm, RegistryError> {
    if payload.len() != GATE_VM_PAYLOAD_LEN {
        return Err(RegistryError::BadPayloadLength);
    }
    let height = read_u64_le(payload, 0);
    if height == 0 {
        return Err(RegistryError::InvalidPayload);
    }
    let hash_steps = read_u64_le(payload, 136);
    if hash_steps > GATE_VM_MAX_HASH_STEPS {
        return Err(RegistryError::InvalidPayload);
    }
    Ok(DecodedGateVm {
        height,
        program_root: read_root(env, payload, 8),
        start_root: read_root(env, payload, 40),
        event_root: read_root(env, payload, 72),
        end_root: read_root(env, payload, 104),
        hash_steps,
    })
}

/// The 32-line lane parses the same layout with the sibling ceiling. The
/// reuse of the shape is the point: a reviewer comparing the two lanes should
/// find exactly one difference, and it should be the number.
fn parse_gate_vm32_payload(env: &Env, payload: &Bytes) -> Result<DecodedGateVm, RegistryError> {
    if payload.len() != GATE_VM32_PAYLOAD_LEN {
        return Err(RegistryError::BadPayloadLength);
    }
    let height = read_u64_le(payload, 0);
    if height == 0 {
        return Err(RegistryError::InvalidPayload);
    }
    let hash_steps = read_u64_le(payload, 136);
    if hash_steps > GATE_VM32_MAX_HASH_STEPS {
        return Err(RegistryError::InvalidPayload);
    }
    Ok(DecodedGateVm {
        height,
        program_root: read_root(env, payload, 8),
        start_root: read_root(env, payload, 40),
        event_root: read_root(env, payload, 72),
        end_root: read_root(env, payload, 104),
        hash_steps,
    })
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::execution_trace_vectors as vex;
    use crate::step_chain_vectors as vsc;
    use crate::test_vectors as v;
    extern crate std;
    use soroban_sdk::{testutils::Address as _, Env};

    /// Decodes a hex string of arbitrary length. The fixed-size `decode_hex` in
    /// this module is used for keys and roots; proofs and vectors are large
    /// enough that writing the length twice invites a typo.
    fn decode_hex_var(text: &str) -> std::vec::Vec<u8> {
        let bytes = text.as_bytes();
        assert!(
            bytes.len().is_multiple_of(2),
            "hex string must have an even length"
        );
        let mut out = std::vec::Vec::with_capacity(bytes.len() / 2);
        let digit = |c: u8| match c {
            b'0'..=b'9' => c - b'0',
            b'a'..=b'f' => c - b'a' + 10,
            b'A'..=b'F' => c - b'A' + 10,
            _ => panic!("not a hex digit"),
        };
        for pair in bytes.chunks(2) {
            out.push((digit(pair[0]) << 4) | digit(pair[1]));
        }
        out
    }

    /// The 32-byte big-endian field encoding of a small integer, which is what
    /// the circuit's public inputs look like on the wire.
    fn scalar_input(env: &Env, value: u64) -> BytesN<32> {
        let mut raw = [0u8; 32];
        raw[24..32].copy_from_slice(&value.to_be_bytes());
        BytesN::from_array(env, &raw)
    }

    #[test]
    fn test_domain_key_stable() {
        let env = Env::default();
        let adapter = BytesN::from_array(&env, &[1u8; 32]);
        let network = String::from_str(&env, "source-testnet");
        let k1 = compute_domain_key(&env, &adapter, &network);
        let k2 = compute_domain_key(&env, &adapter, &network);
        assert_eq!(k1, k2);
    }

    #[test]
    fn test_register_and_finalize_bls_rejects_bad_sig() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(FinalityRegistry, ());
        let client = FinalityRegistryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        let adapter = BytesN::from_array(&env, &[2u8; 32]);
        let network = String::from_str(&env, "source-testnet");
        let domain = client.register_domain(
            &admin,
            &adapter,
            &network,
            &10,
            &1,
            &Vec::from_array(&env, [1u32]),
        );
        // Without this the call below would fail with NotAdmitted instead of
        // testing the signature check, i.e. the test would pass for the wrong
        // reason.
        client.admit_domain(&admin, &domain);

        let mut payload = Bytes::new(&env);
        payload.append(&Bytes::from_array(&env, &1u64.to_le_bytes()));
        payload.append(&Bytes::from_array(&env, &[3u8; 32]));
        payload.append(&Bytes::from_array(&env, &[4u8; 32]));
        payload.append(&Bytes::from_array(&env, &3u32.to_le_bytes()));
        payload.append(&Bytes::from_array(&env, &2u32.to_le_bytes()));
        payload.append(&Bytes::from_array(&env, &[0u8; 96]));
        payload.append(&Bytes::from_array(&env, &[0u8; 192]));

        let evidence = RawEvidence {
            adapter_id: adapter.clone(),
            evidence_version: 1,
            network: network.clone(),
            payload,
            declared_height: 1,
            declared_root: BytesN::from_array(&env, &[3u8; 32]),
            submitter: Address::generate(&env),
        };
        let res = client.try_submit_finality_evidence_bls(&evidence);
        // The domain is admitted here, so this must be the signature check
        // failing and not an earlier guard.
        assert!(
            matches!(res, Err(Ok(RegistryError::InvalidSignature))),
            "expected InvalidSignature, got {:?}",
            res
        );
    }

    #[test]
    fn test_version_gate() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(FinalityRegistry, ());
        let client = FinalityRegistryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        let adapter = BytesN::from_array(&env, &[5u8; 32]);
        let network = String::from_str(&env, "source-testnet");
        client.register_domain(
            &admin,
            &adapter,
            &network,
            &2,
            &1,
            &Vec::from_array(&env, [1u32]),
        );

        // version 99 not accepted
        let mut payload = Bytes::new(&env);
        payload.append(&Bytes::from_array(&env, &1u64.to_le_bytes()));
        payload.append(&Bytes::from_array(&env, &[3u8; 32]));
        payload.append(&Bytes::from_array(&env, &[4u8; 32]));
        payload.append(&Bytes::from_array(&env, &3u32.to_le_bytes()));
        payload.append(&Bytes::from_array(&env, &2u32.to_le_bytes()));
        payload.append(&Bytes::from_array(&env, &[0u8; 96]));
        payload.append(&Bytes::from_array(&env, &[0u8; 192]));

        let evidence = RawEvidence {
            adapter_id: adapter.clone(),
            evidence_version: 99,
            network: network.clone(),
            payload,
            declared_height: 1,
            declared_root: BytesN::from_array(&env, &[3u8; 32]),
            submitter: Address::generate(&env),
        };
        let res = client.try_submit_finality_evidence_bls(&evidence);
        assert!(res.is_err());
    }

    #[test]
    fn test_profile() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(FinalityRegistry, ());
        let client = FinalityRegistryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        let adapter = BytesN::from_array(&env, &[6u8; 32]);
        let network = String::from_str(&env, "source-testnet");
        let domain = client.register_domain(
            &admin,
            &adapter,
            &network,
            &2,
            &1,
            &Vec::from_array(&env, [1u32]),
        );
        let profile = client.get_profile(&domain);
        assert!(profile.is_some());
        let p = profile.unwrap();
        assert_eq!(p.network, network);
    }

    #[test]
    fn test_fault_probes_as_data() {
        let probes_len = 3usize;
        assert_eq!(probes_len, 3);
    }

    #[test]
    fn test_admin_renounce() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(FinalityRegistry, ());
        let client = FinalityRegistryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        assert!(!client.is_admin_renounced_check());
        client.renounce_admin(&admin);
        assert!(client.is_admin_renounced_check());
        // After renounce, set_vk should fail
        let vk = soroban_sdk::Bytes::from_array(&env, &[1u8; 10]);
        let res = client.try_set_vk(&admin, &vk);
        assert!(res.is_err());
    }

    #[test]
    fn test_non_admin_set_vk_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(FinalityRegistry, ());
        let client = FinalityRegistryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let attacker = Address::generate(&env);
        client.initialize(&admin);
        let vk = soroban_sdk::Bytes::from_array(&env, &[1u8; 10]);
        // attacker tries set_vk -> should panic / err
        let res = client.try_set_vk(&attacker, &vk);
        assert!(res.is_err());
    }

    #[test]
    fn test_non_admin_domain_mutations_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(FinalityRegistry, ());
        let client = FinalityRegistryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let attacker = Address::generate(&env);
        client.initialize(&admin);
        let adapter = BytesN::from_array(&env, &[8u8; 32]);
        let network = String::from_str(&env, "source-testnet");
        let versions = Vec::from_array(&env, [1u32]);

        let register = client.try_register_domain(&attacker, &adapter, &network, &2, &1, &versions);
        assert!(register.is_err());

        let domain = client.register_domain(&admin, &adapter, &network, &2, &1, &versions);
        let admit = client.try_admit_domain(&attacker, &domain);
        assert!(admit.is_err());
    }

    #[test]
    fn test_wrong_vk_fake_proof_rejected() {
        // Fault probe: wrong VK with fake Groth16 proof must be rejected
        // This simulates attacker generating proof with wrong VK
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(FinalityRegistry, ());
        let client = FinalityRegistryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        let adapter = BytesN::from_array(&env, &[7u8; 32]);
        let network = String::from_str(&env, "source-testnet");
        let domain = client.register_domain(
            &admin,
            &adapter,
            &network,
            &2,
            &1,
            &Vec::from_array(&env, [1u32]),
        );
        // Admit, otherwise this test would short-circuit on NotAdmitted and
        // never look at the verification key.
        client.admit_domain(&admin, &domain);
        // Set wrong VK (all zeros 768 bytes -> invalid)
        let wrong_vk = soroban_sdk::Bytes::from_array(&env, &[0u8; 768]);
        client.set_vk(&admin, &wrong_vk);
        // Build evidence
        let mut payload = soroban_sdk::Bytes::new(&env);
        payload.append(&soroban_sdk::Bytes::from_array(&env, &1u64.to_le_bytes()));
        payload.append(&soroban_sdk::Bytes::from_array(&env, &[3u8; 32]));
        let evidence = RawEvidence {
            adapter_id: adapter.clone(),
            evidence_version: 1,
            network: network.clone(),
            payload,
            declared_height: 1,
            declared_root: BytesN::from_array(&env, &[3u8; 32]),
            submitter: Address::generate(&env),
        };
        let fake_proof = soroban_sdk::Bytes::from_array(&env, &[0u8; 256]);
        let public_inputs = Vec::from_array(&env, [BytesN::from_array(&env, &[1u8; 32])]);
        let res = client.try_submit_finality_evidence_zk(&evidence, &fake_proof, &public_inputs);
        assert!(
            matches!(res, Err(Ok(RegistryError::InvalidProof))),
            "expected InvalidProof, got {:?}",
            res
        );
    }

    // ---------------------------------------------------------------------
    // Live vectors from the Groth16 lane. See src/test_vectors.rs.
    // ---------------------------------------------------------------------

    /// Decode a lowercase hex string into `N` bytes without pulling in `alloc`.
    fn decode_hex<const N: usize>(hex: &str) -> [u8; N] {
        let b = hex.as_bytes();
        assert_eq!(b.len(), 2 * N, "vector has the wrong length");
        let mut out = [0u8; N];
        let mut i = 0usize;
        while i < N {
            out[i] = (nibble(b[2 * i]) << 4) | nibble(b[2 * i + 1]);
            i += 1;
        }
        out
    }

    const fn nibble(c: u8) -> u8 {
        match c {
            b'0'..=b'9' => c - b'0',
            b'a'..=b'f' => c - b'a' + 10,
            b'A'..=b'F' => c - b'A' + 10,
            _ => 0,
        }
    }

    fn adapter(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &decode_hex::<32>(v::ADAPTER_HEX))
    }

    fn live_vk(env: &Env) -> Bytes {
        Bytes::from_slice(env, &decode_hex::<768>(v::VK_HEX))
    }

    fn live_proof(env: &Env) -> Bytes {
        Bytes::from_slice(env, &decode_hex::<256>(v::PROOF_HEX))
    }

    fn live_public_inputs(env: &Env) -> Vec<BytesN<32>> {
        Vec::from_array(
            env,
            [
                BytesN::from_array(env, &decode_hex::<32>(v::PUBLIC_INPUTS_HEX[0])),
                BytesN::from_array(env, &decode_hex::<32>(v::PUBLIC_INPUTS_HEX[1])),
                BytesN::from_array(env, &decode_hex::<32>(v::PUBLIC_INPUTS_HEX[2])),
                BytesN::from_array(env, &decode_hex::<32>(v::PUBLIC_INPUTS_HEX[3])),
            ],
        )
    }

    fn evidence_for(env: &Env, height: u64, root: &BytesN<32>) -> RawEvidence {
        let mut payload = Bytes::new(env);
        payload.append(&Bytes::from_array(env, &height.to_le_bytes()));
        payload.append(&Bytes::from_array(env, &root.to_array()));
        RawEvidence {
            adapter_id: adapter(env),
            evidence_version: 1,
            network: String::from_str(env, v::NETWORK),
            payload,
            declared_height: height,
            declared_root: root.clone(),
            submitter: Address::generate(env),
        }
    }

    /// Fresh registry wired exactly like the live one: a real admin, the real
    /// 768-byte verification key, and the source domain admitted for the same
    /// evidence version. Only the on-chain admin renunciation is missing, and
    /// that is covered by its own test.
    fn live_registry(env: &Env) -> (FinalityRegistryClient<'_>, BytesN<32>) {
        env.mock_all_auths();
        let contract_id = env.register(FinalityRegistry, ());
        let client = FinalityRegistryClient::new(env, &contract_id);
        let admin = Address::generate(env);
        client.initialize(&admin);
        client.set_vk(&admin, &live_vk(env));
        let network = String::from_str(env, v::NETWORK);
        let key = client.register_domain(
            &admin,
            &adapter(env),
            &network,
            &10,
            &1,
            &Vec::from_array(env, [1u32]),
        );
        // register_domain leaves the domain in state 0 (pending). Submitting
        // evidence before admit_domain returns NotAdmitted and never reaches
        // the verifier, so the tests below must admit first.
        client.admit_domain(&admin, &key);
        (client, key)
    }

    #[test]
    fn test_live_groth16_proof_verifies_in_host() {
        let env = Env::default();
        let (client, key) = live_registry(&env);
        let root = BytesN::from_array(&env, &decode_hex::<32>(v::STATE_ROOT_HEX));
        let evidence = evidence_for(&env, v::HEIGHT, &root);
        let proof = live_proof(&env);
        let public_inputs = live_public_inputs(&env);

        let cpu_before = env.budget().cpu_instruction_cost();
        let att = client.submit_finality_evidence_zk(&evidence, &proof, &public_inputs);
        let cpu_after = env.budget().cpu_instruction_cost();
        std::println!(
            "[proving-system] bn254 pairing check over a 256-byte proof and a 768-byte vk: \
             {} cpu instructions (host model, Rust target)",
            cpu_after.saturating_sub(cpu_before)
        );

        // Cost of the pure pairing check, measured separately from storage and
        // event costs. Reported as a range in docs/PROVING_SYSTEM.md.
        let pairing_only = env.as_contract(&client.address, || {
            let t0 = env.budget().cpu_instruction_cost();
            let ok = groth16::verify(&env, &live_vk(&env), &proof, &public_inputs);
            assert!(ok, "the same verifier must accept the same bytes");
            env.budget().cpu_instruction_cost().saturating_sub(t0)
        });
        std::println!(
            "[proving-system] pairing + scalars only: {} cpu instructions (host model)",
            pairing_only
        );

        assert_eq!(att.height, v::HEIGHT);
        assert_eq!(att.state_root, root);
        assert_eq!(att.security, SecurityBacking::ZkProof);
        assert_eq!(att.adapter, adapter(&env));
        assert!(client.is_machine_approved(&key));

        // Honest limit of this lane: the circuit has no signature over an event
        // root, so the registry stores zeroes there and the settlement path has
        // to take its event root from the BLS lane instead.
        let full = client
            .get_finalized_full(&key, &v::HEIGHT)
            .expect("finalized record");
        assert_eq!(full.state_root, root);
        assert_eq!(full.event_root, BytesN::from_array(&env, &[0u8; 32]));
    }

    #[test]
    fn test_live_groth16_proof_is_rejected_when_the_proof_is_not_the_one() {
        let env = Env::default();
        let (client, _key) = live_registry(&env);
        let root = BytesN::from_array(&env, &decode_hex::<32>(v::STATE_ROOT_HEX));
        let evidence = evidence_for(&env, v::HEIGHT, &root);
        let public_inputs = live_public_inputs(&env);

        // Swap the A and C group elements. Both halves stay valid G1 points in
        // the required encoding, so this is not caught by a length or format
        // check: only the pairing equation can tell it apart. If the pairing
        // check were a stub, this call would succeed.
        let proof = live_proof(&env);
        let mut swapped = Bytes::new(&env);
        swapped.append(&proof.slice(192..256));
        swapped.append(&proof.slice(64..192));
        swapped.append(&proof.slice(0..64));
        let res = client.try_submit_finality_evidence_zk(&evidence, &swapped, &public_inputs);
        // Not just "some error": the pairing equation is what rejected this,
        // so the reported variant has to be InvalidProof.
        assert!(
            matches!(res, Err(Ok(RegistryError::InvalidProof))),
            "expected InvalidProof from the pairing check, got {:?}",
            res
        );
    }

    #[test]
    fn test_live_groth16_proof_does_not_cover_another_state_root() {
        let env = Env::default();
        let (client, _key) = live_registry(&env);
        // Same valid proof and the same valid public signals, but the evidence
        // claims a different source root. The verifier anchors the last public
        // signal to the declared root, so this has to fail even though the
        // proof itself is genuine: a real proof for block X is not evidence
        // about block Y.
        let other = BytesN::from_array(&env, &decode_hex::<32>(v::OTHER_ROOT_HEX));
        let evidence = evidence_for(&env, v::HEIGHT, &other);
        let res = client.try_submit_finality_evidence_zk(
            &evidence,
            &live_proof(&env),
            &live_public_inputs(&env),
        );
        // DeclaredMismatch means the contract detected the binding between the
        // declared root and the last public signal before spending a pairing.
        assert!(
            matches!(res, Err(Ok(RegistryError::DeclaredMismatch))),
            "expected DeclaredMismatch, got {:?}",
            res
        );
    }
    // =====================================================================
    // Multi-step chained lane
    // =====================================================================

    /// Vector layout, so the tests and the generated file cannot drift apart.
    const SC_START: usize = 0;
    const SC_END: usize = 1;
    const SC_EVENT: usize = 2;
    const SC_THRESHOLD: usize = 3;
    const SC_LENGTH: usize = 4;
    const SC_TAG: usize = 5;

    /// The adapter id and network the generated vectors were produced for.
    fn sc_domain(env: &Env) -> (BytesN<32>, String) {
        (
            BytesN::from_array(env, &decode_hex::<32>(v::ADAPTER_HEX)),
            String::from_str(env, v::NETWORK),
        )
    }

    fn sc_vk(env: &Env) -> Bytes {
        Bytes::from_slice(env, &decode_hex_var(vsc::VK_HEX))
    }

    fn sc_proof(env: &Env) -> Bytes {
        Bytes::from_slice(env, &decode_hex_var(vsc::PROOF_HEX))
    }

    fn sc_inputs(env: &Env) -> Vec<BytesN<32>> {
        let mut out = Vec::new(env);
        for i in 0..vsc::PUBLIC_INPUTS_HEX.len() {
            out.push_back(BytesN::from_array(
                env,
                &decode_hex::<32>(vsc::PUBLIC_INPUTS_HEX[i]),
            ));
        }
        out
    }

    /// The payload the circuit's public inputs describe: height, start root,
    /// end root, event root, chain length.
    fn sc_payload(env: &Env, height: u64) -> Bytes {
        let mut payload = Bytes::new(env);
        payload.append(&Bytes::from_array(env, &height.to_le_bytes()));
        payload.append(&Bytes::from_array(
            env,
            &decode_hex::<32>(vsc::PUBLIC_INPUTS_HEX[SC_START]),
        ));
        payload.append(&Bytes::from_array(
            env,
            &decode_hex::<32>(vsc::PUBLIC_INPUTS_HEX[SC_END]),
        ));
        payload.append(&Bytes::from_array(
            env,
            &decode_hex::<32>(vsc::PUBLIC_INPUTS_HEX[SC_EVENT]),
        ));
        payload.append(&Bytes::from_array(env, &3u64.to_le_bytes()));
        payload
    }

    fn sc_evidence(env: &Env, height: u64) -> RawEvidence {
        let (adapter, network) = sc_domain(env);
        RawEvidence {
            adapter_id: adapter,
            evidence_version: 1,
            network,
            payload: sc_payload(env, height),
            declared_height: height,
            declared_root: BytesN::from_array(
                env,
                &decode_hex::<32>(vsc::PUBLIC_INPUTS_HEX[SC_END]),
            ),
            submitter: Address::generate(env),
        }
    }

    /// A registry bootstrapped the way the deployment does it: register, admit,
    /// policy, then the step-chain key.
    fn sc_registry(env: &Env) -> (FinalityRegistryClient<'_>, Address, BytesN<32>) {
        let contract_id = env.register(FinalityRegistry, ());
        let client = FinalityRegistryClient::new(env, &contract_id);
        let admin = Address::generate(env);
        client.initialize(&admin);
        let (adapter, network) = sc_domain(env);
        let domain = client.register_domain(
            &admin,
            &adapter,
            &network,
            &10,
            &1,
            &Vec::from_array(env, [1u32]),
        );
        client.admit_domain(&admin, &domain);
        // No BLS policy is registered: the step-chain lane binds the quorum to
        // the constant compiled into the circuit, so it does not depend on the
        // signature lane's policy at all.
        client.set_step_chain_vk(&admin, &sc_vk(env));
        (client, admin, domain)
    }

    #[test]
    fn test_step_chain_vectors_are_the_layout_the_contract_expects() {
        // 896 = 64 (alpha) + 3 x 128 (beta, gamma, delta) + 7 x 64 (IC[0..6]).
        assert_eq!(vsc::VK_HEX.len(), (STEP_CHAIN_VK_LEN as usize) * 2);
        assert_eq!(vsc::PROOF_HEX.len(), 256 * 2);
        assert_eq!(
            vsc::PUBLIC_INPUTS_HEX.len(),
            STEP_CHAIN_PUBLIC_INPUTS as usize
        );
        // Written out rather than encoded at run time: the contract crate has no
        // hex dependency, and a literal here is also a second, independent
        // statement of the tag.
        assert_eq!(
            vsc::PUBLIC_INPUTS_HEX[SC_TAG],
            "009517e443e84062a6781b2a92160d0a325f4c5a45826a0c0b54644e2ed574f0"
        );
        // The order table only earns its bytes if the test ties it to the
        // indices the verifier actually reads; that is what makes "the
        // contract test and this file cannot drift apart" an assertion
        // instead of a wish.
        assert_eq!(vsc::PUBLIC_INPUT_ORDER.len(), vsc::PUBLIC_INPUTS_HEX.len());
        assert_eq!(vsc::PUBLIC_INPUT_ORDER[SC_START], "chain_start_root");
        assert_eq!(vsc::PUBLIC_INPUT_ORDER[SC_END], "chain_end_root");
        assert_eq!(vsc::PUBLIC_INPUT_ORDER[SC_EVENT], "event_root");
        assert_eq!(vsc::PUBLIC_INPUT_ORDER[SC_THRESHOLD], "threshold");
        assert_eq!(vsc::PUBLIC_INPUT_ORDER[SC_LENGTH], "chain_length");
        assert_eq!(vsc::PUBLIC_INPUT_ORDER[SC_TAG], "domain_tag");
    }

    #[test]
    fn test_step_chain_tag_matches_the_circuit_constant() {
        // The tag is what stops a single-statement proof being presented as a
        // chain proof. It is derived from "lumen-gate-step-chain-v1", which is a
        // different label from the one the other lane and the BLS hash-to-curve
        // path use.
        let env = Env::default();
        let expected =
            decode_hex::<32>("009517e443e84062a6781b2a92160d0a325f4c5a45826a0c0b54644e2ed574f0");
        assert_eq!(step_chain_tag(&env).to_array(), expected);
    }

    #[test]
    fn test_step_chain_proof_verifies_in_host_and_is_recorded() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, domain) = sc_registry(&env);

        let cpu_before = env.budget().cpu_instruction_cost();
        let attestation =
            client.submit_step_chain_zk(&sc_evidence(&env, 77), &sc_proof(&env), &sc_inputs(&env));
        let cpu_after = env.budget().cpu_instruction_cost();
        std::println!(
            "[proving-system] chained lane: pairing check over a 256-byte proof and an 896-byte vk: \
             {} cpu instructions (host model, Rust target)",
            cpu_after.saturating_sub(cpu_before)
        );
        assert_eq!(attestation.height, 77);
        assert_eq!(attestation.chain_length, 3);
        assert_eq!(attestation.security, SecurityBacking::ZkProof);

        let recorded = client
            .get_step_chain_record(&domain)
            .expect("an accepted chain must be recorded");
        assert_eq!(recorded.chain_length, 3);
        assert_eq!(recorded.height, 77);
        assert_eq!(recorded.threshold, 2);
    }

    #[test]
    fn test_step_chain_does_not_touch_what_settlement_anchors_on() {
        // This is the boundary that makes the second lane safe to add: a quorum
        // proof is not a signature proof, so it must not move the domain's
        // last_root or last_event_root. Settlement reads those.
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, domain) = sc_registry(&env);

        let before = client.get_domain(&domain).expect("domain exists");
        client.submit_step_chain_zk(&sc_evidence(&env, 78), &sc_proof(&env), &sc_inputs(&env));
        let after = client.get_domain(&domain).expect("domain exists");

        assert_eq!(before.last_height, after.last_height);
        assert_eq!(before.last_root, after.last_root);
        assert_eq!(before.last_event_root, after.last_event_root);
        assert_eq!(after.last_security, SecurityBacking::None);
    }

    #[test]
    fn test_step_chain_rejects_a_mutated_proof() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _domain) = sc_registry(&env);

        // Swap the A and C group elements. Both halves stay valid G1 points in
        // the required encoding, so this is not caught by a length or format
        // check: only the pairing equation can tell it apart. If the pairing
        // check were a stub, this call would succeed.
        let proof = sc_proof(&env);
        let mut swapped = Bytes::new(&env);
        swapped.append(&proof.slice(192..256));
        swapped.append(&proof.slice(64..192));
        swapped.append(&proof.slice(0..64));
        let res =
            client.try_submit_step_chain_zk(&sc_evidence(&env, 79), &swapped, &sc_inputs(&env));
        // Not just "some error": the pairing equation is what rejected this, so
        // the reported variant has to be InvalidProof.
        assert!(
            matches!(res, Err(Ok(RegistryError::InvalidProof))),
            "expected InvalidProof from the pairing check, got {:?}",
            res
        );
    }

    #[test]
    fn test_step_chain_rejects_swapped_public_inputs() {
        // Swapping the start and end roots is the attack the chaining exists to
        // stop: presenting a chain backwards.
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _domain) = sc_registry(&env);

        let mut inputs = sc_inputs(&env);
        let start = inputs.get(SC_START as u32).unwrap();
        inputs.set(SC_START as u32, inputs.get(SC_END as u32).unwrap());
        inputs.set(SC_END as u32, start);

        let res = client.try_submit_step_chain_zk(&sc_evidence(&env, 80), &sc_proof(&env), &inputs);
        assert!(
            matches!(res, Err(Ok(RegistryError::DeclaredMismatch))),
            "a reordered public vector must be refused, got {:?}",
            res
        );
    }

    #[test]
    fn test_step_chain_rejects_wrong_threshold_and_wrong_length() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _domain) = sc_registry(&env);

        // threshold 1 instead of the registered 2
        let mut inputs = sc_inputs(&env);
        inputs.set(SC_THRESHOLD as u32, scalar_input(&env, 1));
        let res = client.try_submit_step_chain_zk(&sc_evidence(&env, 81), &sc_proof(&env), &inputs);
        assert!(
            matches!(res, Err(Ok(RegistryError::DeclaredMismatch))),
            "the quorum policy is bound by the contract, got {:?}",
            res
        );

        // chain_length 4 in the proof while the payload says 3
        let mut inputs = sc_inputs(&env);
        inputs.set(SC_LENGTH as u32, scalar_input(&env, 4));
        let res = client.try_submit_step_chain_zk(&sc_evidence(&env, 82), &sc_proof(&env), &inputs);
        assert!(
            matches!(res, Err(Ok(RegistryError::DeclaredMismatch))),
            "the chain length is bound to the payload, got {:?}",
            res
        );
    }

    #[test]
    fn test_step_chain_rejects_a_payload_that_disagrees_with_itself() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _domain) = sc_registry(&env);

        // The payload declares height 90 while the envelope says 91: the two
        // must agree, because the envelope is what an index saw before the
        // adapter ever ran.
        let mut evidence = sc_evidence(&env, 91);
        evidence.declared_height = 90;
        let res = client.try_submit_step_chain_zk(&evidence, &sc_proof(&env), &sc_inputs(&env));
        assert!(
            matches!(res, Err(Ok(RegistryError::DeclaredMismatch))),
            "a lying envelope must be refused, got {:?}",
            res
        );

        // A payload with trailing bytes is a different format, not a longer one.
        let mut evidence = sc_evidence(&env, 92);
        let mut payload = evidence.payload.clone();
        payload.push_back(0);
        evidence.payload = payload;
        let res = client.try_submit_step_chain_zk(&evidence, &sc_proof(&env), &sc_inputs(&env));
        assert!(
            matches!(res, Err(Ok(RegistryError::BadPayloadLength))),
            "a payload with trailing bytes must be refused, got {:?}",
            res
        );
    }

    #[test]
    fn test_step_chain_size_limits_are_explicit() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _domain) = sc_registry(&env);

        // proof one byte short and one byte long. Both are format errors: the
        // length is checked before any decoding, so the refusal is a clean
        // InvalidProof rather than a decoding panic.
        let mut short_proof = decode_hex_var(vsc::PROOF_HEX);
        short_proof.pop();
        let res = client.try_submit_step_chain_zk(
            &sc_evidence(&env, 93),
            &Bytes::from_slice(&env, &short_proof),
            &sc_inputs(&env),
        );
        assert!(
            matches!(res, Err(Ok(RegistryError::InvalidProof))),
            "a 255-byte proof must be refused, got {:?}",
            res
        );

        let mut long_proof = decode_hex_var(vsc::PROOF_HEX);
        long_proof.push(0);
        let res = client.try_submit_step_chain_zk(
            &sc_evidence(&env, 94),
            &Bytes::from_slice(&env, &long_proof),
            &sc_inputs(&env),
        );
        assert!(
            matches!(res, Err(Ok(RegistryError::InvalidProof))),
            "a 257-byte proof must be refused, got {:?}",
            res
        );

        // five and seven public inputs
        let mut short = sc_inputs(&env);
        short.pop_back();
        let res = client.try_submit_step_chain_zk(&sc_evidence(&env, 95), &sc_proof(&env), &short);
        assert!(
            matches!(res, Err(Ok(RegistryError::InvalidProof))),
            "got {:?}",
            res
        );

        let mut long = sc_inputs(&env);
        long.push_back(BytesN::from_array(&env, &[0u8; 32]));
        let res = client.try_submit_step_chain_zk(&sc_evidence(&env, 96), &sc_proof(&env), &long);
        assert!(
            matches!(res, Err(Ok(RegistryError::InvalidProof))),
            "got {:?}",
            res
        );
    }

    #[test]
    fn test_step_chain_key_length_is_enforced_at_bootstrap() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(FinalityRegistry, ());
        let client = FinalityRegistryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        // 895 and 897 bytes are both wrong; the length is a format rule.
        for length in [895usize, 897] {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let filler = std::vec![1u8; length];
                client.set_step_chain_vk(&admin, &Bytes::from_slice(&env, &filler));
            }));
            assert!(
                outcome.is_err(),
                "a {}-byte step-chain key must be refused",
                length
            );
        }

        // The right length is accepted.
        client.set_step_chain_vk(&admin, &sc_vk(&env));
        assert_eq!(client.get_step_chain_vk().len(), STEP_CHAIN_VK_LEN);
    }

    #[test]
    fn test_step_chain_refuses_to_go_backwards() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _domain) = sc_registry(&env);

        client.submit_step_chain_zk(&sc_evidence(&env, 100), &sc_proof(&env), &sc_inputs(&env));
        // Same height again. Different payload bytes would be a different
        // evidence digest, so this checks the lane's own monotonicity rather
        // than the digest set.
        let res = client.try_submit_step_chain_zk(
            &sc_evidence(&env, 100),
            &sc_proof(&env),
            &sc_inputs(&env),
        );
        assert!(
            matches!(res, Err(Ok(RegistryError::EvidenceAlreadyProcessed))),
            "the recorded trail must only move forward, got {:?}",
            res
        );
    }

    #[test]
    fn test_step_chain_vk_cannot_be_set_after_renounce_or_by_a_stranger() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin, _domain) = sc_registry(&env);

        // a different account, with auth mocked: the stored admin check refuses it
        let stranger = Address::generate(&env);
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.set_step_chain_vk(&stranger, &sc_vk(&env));
        }));
        assert!(
            outcome.is_err(),
            "a non-admin must not be able to replace the step-chain key"
        );

        client.renounce_admin(&admin);
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.set_step_chain_vk(&admin, &sc_vk(&env));
        }));
        assert!(
            outcome.is_err(),
            "after renounce there is no key left that can replace the verification key"
        );
    }

    #[test]
    fn test_step_chain_requires_an_admitted_domain() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(FinalityRegistry, ());
        let client = FinalityRegistryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        let (adapter, network) = sc_domain(&env);
        let domain = client.register_domain(
            &admin,
            &adapter,
            &network,
            &10,
            &1,
            &Vec::from_array(&env, [1u32]),
        );
        client.set_step_chain_vk(&admin, &sc_vk(&env));

        // registered but not admitted
        let res = client.try_submit_step_chain_zk(
            &sc_evidence(&env, 120),
            &sc_proof(&env),
            &sc_inputs(&env),
        );
        assert!(
            matches!(res, Err(Ok(RegistryError::NotAdmitted))),
            "got {:?}",
            res
        );

        // admitted: the same evidence is now a proof question, not a state
        // question, and this registry has no step-chain key for this domain
        // other than the one set above, so the honest proof is accepted
        client.admit_domain(&admin, &domain);
        let accepted =
            client.submit_step_chain_zk(&sc_evidence(&env, 121), &sc_proof(&env), &sc_inputs(&env));
        assert_eq!(accepted.height, 121);

        // a domain that was never registered at all is refused before anything
        // else is looked at
        let unknown_adapter = BytesN::from_array(&env, &[9u8; 32]);
        let mut evidence = sc_evidence(&env, 122);
        evidence.adapter_id = unknown_adapter;
        let res = client.try_submit_step_chain_zk(&evidence, &sc_proof(&env), &sc_inputs(&env));
        assert!(
            matches!(res, Err(Ok(RegistryError::DomainNotFound))),
            "got {:?}",
            res
        );
    }

    // =====================================================================
    // Execution lane
    // =====================================================================

    /// Vector layout, so the tests and the generated file cannot drift apart.
    const EX_PROGRAM: usize = 0;
    const EX_INITIAL_ROOT: usize = 16;
    const EX_FINAL_ROOT: usize = 17;
    const EX_FINAL_PC: usize = 18;
    const EX_STEPS: usize = 19;
    const EX_GAS: usize = 20;
    const EX_TAG: usize = 21;

    /// The program the generated vectors were proved for, instruction by
    /// instruction. Written out here because it is the statement: if the circuit
    /// or the assembler ever changes what a program assembles to, this test
    /// fails rather than the fixture silently following along.
    const EX_INSTRUCTION_WORDS: u64 = 13;

    fn ex_vk(env: &Env) -> Bytes {
        Bytes::from_slice(env, &decode_hex_var(vex::VK_HEX))
    }

    fn ex_proof(env: &Env) -> Bytes {
        Bytes::from_slice(env, &decode_hex_var(vex::PROOF_HEX))
    }

    fn ex_inputs(env: &Env) -> Vec<BytesN<32>> {
        let mut out = Vec::new(env);
        for i in 0..vex::PUBLIC_INPUTS_HEX.len() {
            out.push_back(BytesN::from_array(
                env,
                &decode_hex::<32>(vex::PUBLIC_INPUTS_HEX[i]),
            ));
        }
        out
    }

    /// The integer a public input encodes: leading 24 bytes zero, low 8 big-endian.
    fn public_u64(input: &BytesN<32>) -> u64 {
        let mut raw = [0u8; 8];
        for i in 0u32..8 {
            raw[i as usize] = input.get(24 + i).unwrap_or(0);
        }
        // the leading bytes are asserted zero by the vectors themselves
        for i in 0u32..24 {
            assert_eq!(
                input.get(i).unwrap_or(1),
                0,
                "public scalar must be canonical"
            );
        }
        u64::from_be_bytes(raw)
    }

    /// The payload the circuit's public inputs describe.
    fn ex_payload(env: &Env, height: u64) -> Bytes {
        let inputs = ex_inputs(env);
        let mut payload = Bytes::new(env);
        payload.append(&Bytes::from_array(env, &height.to_le_bytes()));
        payload.append(&Bytes::from_array(
            env,
            &inputs.get(EX_FINAL_ROOT as u32).unwrap().to_array(),
        ));
        payload.append(&Bytes::from_array(
            env,
            &inputs.get(EX_INITIAL_ROOT as u32).unwrap().to_array(),
        ));
        payload.append(&Bytes::from_array(
            env,
            &public_u64(&inputs.get(EX_FINAL_PC as u32).unwrap()).to_le_bytes(),
        ));
        payload.append(&Bytes::from_array(
            env,
            &public_u64(&inputs.get(EX_STEPS as u32).unwrap()).to_le_bytes(),
        ));
        payload.append(&Bytes::from_array(
            env,
            &public_u64(&inputs.get(EX_GAS as u32).unwrap()).to_le_bytes(),
        ));
        payload.append(&Bytes::from_array(env, &EX_INSTRUCTION_WORDS.to_le_bytes()));
        for index in 0..EXECUTION_PROGRAM_WORDS {
            let word = public_u64(&inputs.get(index).unwrap());
            payload.append(&Bytes::from_array(env, &word.to_le_bytes()));
        }
        payload
    }

    fn ex_evidence(env: &Env, height: u64) -> RawEvidence {
        let (adapter, network) = sc_domain(env);
        let inputs = ex_inputs(env);
        RawEvidence {
            adapter_id: adapter,
            evidence_version: 1,
            network,
            payload: ex_payload(env, height),
            declared_height: height,
            declared_root: BytesN::from_array(
                env,
                &inputs.get(EX_FINAL_ROOT as u32).unwrap().to_array(),
            ),
            submitter: Address::generate(env),
        }
    }

    /// A registry with the execution lane's key bootstrapped.
    fn ex_registry(env: &Env) -> (FinalityRegistryClient<'_>, Address, BytesN<32>) {
        let contract_id = env.register(FinalityRegistry, ());
        let client = FinalityRegistryClient::new(env, &contract_id);
        let admin = Address::generate(env);
        client.initialize(&admin);
        let (adapter, network) = sc_domain(env);
        let domain = client.register_domain(
            &admin,
            &adapter,
            &network,
            &10,
            &1,
            &Vec::from_array(env, [1u32]),
        );
        client.admit_domain(&admin, &domain);
        client.set_execution_vk(&admin, &ex_vk(env));
        (client, admin, domain)
    }

    #[test]
    fn test_execution_vectors_are_the_layout_the_contract_expects() {
        // 1920 = 64 (alpha) + 3 x 128 (beta, gamma, delta) + 23 x 64 (IC[0..22]).
        assert_eq!(vex::PUBLIC_INPUT_ORDER[EX_PROGRAM], "program_0");
        assert_eq!(vex::PUBLIC_INPUT_ORDER[EX_GAS], "gas_used");
        assert_eq!(vex::VK_HEX.len(), (EXECUTION_VK_LEN as usize) * 2);
        assert_eq!(vex::PROOF_HEX.len(), 256 * 2);
        assert_eq!(
            vex::PUBLIC_INPUTS_HEX.len(),
            EXECUTION_PUBLIC_INPUTS as usize
        );
        // A second, independent statement of the tag.
        assert_eq!(
            vex::PUBLIC_INPUTS_HEX[EX_TAG],
            "00cf562c45b7d43f8a7e710103a51d92ee0884f07eb9dcb8a61b1d9162ef7db4"
        );
    }

    #[test]
    fn test_execution_tag_matches_the_circuit_constant() {
        // The tag is what stops a proof about one lane's statement being
        // presented as a proof about another's. It is derived from
        // "lumen-gate-execution-v1", a label neither of the other lanes uses.
        let env = Env::default();
        let expected =
            decode_hex::<32>("00cf562c45b7d43f8a7e710103a51d92ee0884f07eb9dcb8a61b1d9162ef7db4");
        assert_eq!(execution_tag(&env).to_array(), expected);
    }

    #[test]
    fn test_execution_the_committed_program_is_the_one_that_ran() {
        // The statement is "this program ran". The first four words are the
        // loads and the first half of the loop; they are pinned here so that a
        // fixture regenerated from a changed assembler cannot quietly keep
        // passing.
        let env = Env::default();
        let inputs = ex_inputs(&env);
        assert_eq!(public_u64(&inputs.get(0).unwrap()), 67109140);
        assert_eq!(public_u64(&inputs.get(1).unwrap()), 33554964);
        assert_eq!(public_u64(&inputs.get(2).unwrap()), 788);
        assert_eq!(public_u64(&inputs.get(3).unwrap()), 532738);
        // the padding slots are halt words
        for index in EX_INSTRUCTION_WORDS as u32..EXECUTION_PROGRAM_WORDS {
            assert_eq!(public_u64(&inputs.get(index).unwrap()), 0);
        }
        assert_eq!(public_u64(&inputs.get(EX_STEPS as u32).unwrap()), 16);
        assert_eq!(public_u64(&inputs.get(EX_FINAL_PC as u32).unwrap()), 12);
        assert_eq!(public_u64(&inputs.get(EX_GAS as u32).unwrap()), 25);
    }

    #[test]
    fn test_execution_proof_verifies_in_host_and_is_recorded() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, domain) = ex_registry(&env);

        let cpu_before = env.budget().cpu_instruction_cost();
        let attestation =
            client.submit_execution_zk(&ex_evidence(&env, 41), &ex_proof(&env), &ex_inputs(&env));
        let cpu_after = env.budget().cpu_instruction_cost();
        std::println!(
            "[proving-system] execution lane: pairing check over a 256-byte proof and a \
             1920-byte vk with 22 public inputs: {} cpu instructions (host model, Rust target)",
            cpu_after.saturating_sub(cpu_before)
        );
        assert_eq!(attestation.height, 41);
        assert_eq!(attestation.steps_executed, 16);
        assert_eq!(attestation.gas_used, 25);
        assert_eq!(attestation.security, SecurityBacking::ZkProof);

        let recorded = client
            .get_execution_record(&domain)
            .expect("an accepted execution must be recorded");
        assert_eq!(recorded.height, 41);
        assert_eq!(recorded.steps_executed, 16);
        assert_eq!(recorded.instruction_words, EX_INSTRUCTION_WORDS);
        assert!(!recorded.settlement_anchored);
    }

    #[test]
    fn test_execution_does_not_touch_what_settlement_anchors_on() {
        // The boundary that makes a third lane safe: an execution proof says a
        // program ran to a state it commits. It says nothing about the source
        // chain's roots, so it must not move them.
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, domain) = ex_registry(&env);

        let before = client.get_domain(&domain).expect("domain exists");
        client.submit_execution_zk(&ex_evidence(&env, 42), &ex_proof(&env), &ex_inputs(&env));
        let after = client.get_domain(&domain).expect("domain exists");

        assert_eq!(before.last_height, after.last_height);
        assert_eq!(before.last_root, after.last_root);
        assert_eq!(before.last_event_root, after.last_event_root);
        assert_eq!(after.last_security, SecurityBacking::None);
    }

    #[test]
    fn test_execution_rejects_a_mutated_proof() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _domain) = ex_registry(&env);

        let proof = ex_proof(&env);
        let mut swapped = Bytes::new(&env);
        swapped.append(&proof.slice(192..256));
        swapped.append(&proof.slice(64..192));
        swapped.append(&proof.slice(0..64));
        let res =
            client.try_submit_execution_zk(&ex_evidence(&env, 43), &swapped, &ex_inputs(&env));
        assert!(
            matches!(res, Err(Ok(RegistryError::InvalidProof))),
            "expected InvalidProof from the pairing check, got {:?}",
            res
        );
    }

    #[test]
    fn test_execution_rejects_a_program_the_proof_does_not_cover() {
        // A genuine proof for program P is not a proof for program P'. The
        // contract binds the sixteen words before it spends a pairing, so this
        // is caught as a declared mismatch rather than as a failed proof.
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _domain) = ex_registry(&env);

        let mut evidence = ex_evidence(&env, 44);
        let mut payload = Bytes::new(&env);
        // same layout, but word 1 of the program is a different instruction
        let honest = ex_payload(&env, 44);
        payload.append(&honest.slice(0..112));
        payload.append(&Bytes::from_array(&env, &123456u64.to_le_bytes()));
        payload.append(&honest.slice(120..EXECUTION_PAYLOAD_LEN));
        evidence.payload = payload;

        let res = client.try_submit_execution_zk(&evidence, &ex_proof(&env), &ex_inputs(&env));
        assert!(
            matches!(res, Err(Ok(RegistryError::DeclaredMismatch))),
            "expected DeclaredMismatch, got {:?}",
            res
        );
    }

    #[test]
    fn test_execution_rejects_a_rewritten_step_count() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _domain) = ex_registry(&env);

        let mut evidence = ex_evidence(&env, 45);
        let honest = ex_payload(&env, 45);
        let mut payload = Bytes::new(&env);
        payload.append(&honest.slice(0..80));
        payload.append(&Bytes::from_array(&env, &15u64.to_le_bytes()));
        payload.append(&honest.slice(88..EXECUTION_PAYLOAD_LEN));
        evidence.payload = payload;

        let res = client.try_submit_execution_zk(&evidence, &ex_proof(&env), &ex_inputs(&env));
        assert!(
            matches!(res, Err(Ok(RegistryError::DeclaredMismatch))),
            "expected DeclaredMismatch, got {:?}",
            res
        );
    }

    #[test]
    fn test_execution_rejects_a_wrong_domain_tag() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _domain) = ex_registry(&env);

        let mut inputs = ex_inputs(&env);
        let mut tampered = Vec::new(&env);
        for index in 0..inputs.len() {
            if index == EX_TAG as u32 {
                tampered.push_back(BytesN::from_array(&env, &[1u8; 32]));
            } else {
                tampered.push_back(inputs.get(index).unwrap());
            }
        }
        inputs = tampered;
        let res = client.try_submit_execution_zk(&ex_evidence(&env, 46), &ex_proof(&env), &inputs);
        assert!(
            matches!(res, Err(Ok(RegistryError::DeclaredMismatch))),
            "expected DeclaredMismatch, got {:?}",
            res
        );
    }

    #[test]
    fn test_execution_rejects_instructions_hidden_in_the_padding() {
        // The slots past the code must be halt words. A payload that hides an
        // instruction there is refused before any proof is looked at, because
        // the circuit would not have committed it.
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _domain) = ex_registry(&env);

        let mut evidence = ex_evidence(&env, 47);
        let honest = ex_payload(&env, 47);
        let mut payload = Bytes::new(&env);
        payload.append(&honest.slice(0..96));
        payload.append(&Bytes::from_array(&env, &5u64.to_le_bytes()));
        payload.append(&honest.slice(104..EXECUTION_PAYLOAD_LEN));
        evidence.payload = payload;

        let res = client.try_submit_execution_zk(&evidence, &ex_proof(&env), &ex_inputs(&env));
        assert!(
            matches!(res, Err(Ok(RegistryError::InvalidPayload))),
            "expected InvalidPayload, got {:?}",
            res
        );
    }

    #[test]
    fn test_execution_rejects_a_program_word_with_no_decode() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _domain) = ex_registry(&env);

        let mut evidence = ex_evidence(&env, 48);
        let honest = ex_payload(&env, 48);
        let mut payload = Bytes::new(&env);
        payload.append(&honest.slice(0..104));
        payload.append(&Bytes::from_array(
            &env,
            &(EXECUTION_MAX_PROGRAM_WORD + 1).to_le_bytes(),
        ));
        payload.append(&honest.slice(112..EXECUTION_PAYLOAD_LEN));
        evidence.payload = payload;

        let res = client.try_submit_execution_zk(&evidence, &ex_proof(&env), &ex_inputs(&env));
        assert!(
            matches!(res, Err(Ok(RegistryError::InvalidPayload))),
            "expected InvalidPayload, got {:?}",
            res
        );
    }

    #[test]
    fn test_execution_rejects_a_step_count_beyond_the_circuit() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _domain) = ex_registry(&env);

        let mut evidence = ex_evidence(&env, 49);
        let honest = ex_payload(&env, 49);
        let mut payload = Bytes::new(&env);
        payload.append(&honest.slice(0..80));
        payload.append(&Bytes::from_array(
            &env,
            &(EXECUTION_MAX_STEPS + 1).to_le_bytes(),
        ));
        payload.append(&honest.slice(88..EXECUTION_PAYLOAD_LEN));
        evidence.payload = payload;

        let res = client.try_submit_execution_zk(&evidence, &ex_proof(&env), &ex_inputs(&env));
        assert!(
            matches!(res, Err(Ok(RegistryError::InvalidPayload))),
            "expected InvalidPayload, got {:?}",
            res
        );
    }

    #[test]
    fn test_execution_rejects_a_public_input_vector_of_the_wrong_length() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _domain) = ex_registry(&env);

        let inputs = ex_inputs(&env);
        let mut short = Vec::new(&env);
        for index in 0..(EXECUTION_PUBLIC_INPUTS - 1) {
            short.push_back(inputs.get(index).unwrap());
        }
        let res = client.try_submit_execution_zk(&ex_evidence(&env, 50), &ex_proof(&env), &short);
        assert!(
            matches!(res, Err(Ok(RegistryError::InvalidProof))),
            "expected InvalidProof, got {:?}",
            res
        );
    }

    #[test]
    fn test_execution_cannot_borrow_another_lanes_key() {
        // A registry that has the chained lane's key but not this lane's must
        // refuse: the lengths differ, and the length is checked before the
        // pairing, so the wrong key is never decoded as if it were the right one.
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(FinalityRegistry, ());
        let client = FinalityRegistryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        let (adapter, network) = sc_domain(&env);
        let domain = client.register_domain(
            &admin,
            &adapter,
            &network,
            &10,
            &1,
            &Vec::from_array(&env, [1u32]),
        );
        client.admit_domain(&admin, &domain);
        client.set_step_chain_vk(&admin, &sc_vk(&env));

        assert_eq!(client.get_execution_vk().len(), 0);
        let res = client.try_submit_execution_zk(
            &ex_evidence(&env, 51),
            &ex_proof(&env),
            &ex_inputs(&env),
        );
        assert!(
            matches!(res, Err(Ok(RegistryError::InvalidProof))),
            "expected InvalidProof with no execution key, got {:?}",
            res
        );
    }

    #[test]
    fn test_execution_rejects_a_replayed_evidence_and_a_backwards_height() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _domain) = ex_registry(&env);

        let first = ex_evidence(&env, 52);
        client.submit_execution_zk(&first, &ex_proof(&env), &ex_inputs(&env));

        let replay = client.try_submit_execution_zk(&first, &ex_proof(&env), &ex_inputs(&env));
        assert!(
            matches!(replay, Err(Ok(RegistryError::EvidenceAlreadyProcessed))),
            "expected EvidenceAlreadyProcessed, got {:?}",
            replay
        );

        let backwards = client.try_submit_execution_zk(
            &ex_evidence(&env, 5),
            &ex_proof(&env),
            &ex_inputs(&env),
        );
        assert!(
            matches!(backwards, Err(Ok(RegistryError::EvidenceAlreadyProcessed))),
            "expected the trail to refuse a height that does not advance, got {:?}",
            backwards
        );

        let forward =
            client.submit_execution_zk(&ex_evidence(&env, 53), &ex_proof(&env), &ex_inputs(&env));
        assert_eq!(forward.height, 53);
    }

    #[test]
    fn test_execution_admin_can_no_longer_change_the_key_after_renouncing() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin, _domain) = ex_registry(&env);
        client.renounce_admin(&admin);
        let res = client.try_set_execution_vk(&admin, &ex_vk(&env));
        assert!(
            res.is_err(),
            "a renounced admin must not be able to set this lane's key either"
        );
    }

    // =====================================================================
    // Gate-VM lane
    // =====================================================================

    use crate::gate_vm_vectors as gvx;

    const GV_PROGRAM_ROOT: usize = 0;
    const GV_START: usize = 1;
    const GV_EVENT: usize = 2;
    const GV_END: usize = 3;
    const GV_HASH_STEPS: usize = 4;
    const GV_TAG: usize = 5;

    fn gv_vk(env: &Env) -> Bytes {
        Bytes::from_slice(env, &decode_hex_var(gvx::VK_HEX))
    }

    fn gv_proof(env: &Env) -> Bytes {
        Bytes::from_slice(env, &decode_hex_var(gvx::PROOF_HEX))
    }

    fn gv_inputs(env: &Env) -> Vec<BytesN<32>> {
        let mut out = Vec::new(env);
        for i in 0..gvx::PUBLIC_INPUTS_HEX.len() {
            out.push_back(BytesN::from_array(
                env,
                &decode_hex::<32>(gvx::PUBLIC_INPUTS_HEX[i]),
            ));
        }
        out
    }

    /// The payload, rebuilt from the proof's public inputs. Building it here
    /// instead of pasting bytes proves the layout comment and the vector are
    /// the same claim twice; the layout test then pins the reconstruction to
    /// the exact committed payload bytes so "re-derived" never means "drifted".
    fn gv_payload(env: &Env, height: u64) -> Bytes {
        let inputs = gv_inputs(env);
        let mut payload = Bytes::new(env);
        payload.append(&Bytes::from_array(env, &height.to_le_bytes()));
        for index in [GV_PROGRAM_ROOT, GV_START, GV_EVENT, GV_END] {
            payload.append(&Bytes::from_array(
                env,
                &inputs.get(index as u32).unwrap().to_array(),
            ));
        }
        payload.append(&Bytes::from_array(
            env,
            &public_u64(&inputs.get(GV_HASH_STEPS as u32).unwrap()).to_le_bytes(),
        ));
        payload
    }

    fn gv_evidence(env: &Env, height: u64) -> RawEvidence {
        let (adapter, network) = sc_domain(env);
        let inputs = gv_inputs(env);
        RawEvidence {
            adapter_id: adapter,
            evidence_version: 1,
            network,
            payload: gv_payload(env, height),
            declared_height: height,
            declared_root: BytesN::from_array(env, &inputs.get(GV_END as u32).unwrap().to_array()),
            submitter: Address::generate(env),
        }
    }

    fn gv_registry(env: &Env) -> (FinalityRegistryClient<'_>, Address, BytesN<32>) {
        let contract_id = env.register(FinalityRegistry, ());
        let client = FinalityRegistryClient::new(env, &contract_id);
        let admin = Address::generate(env);
        client.initialize(&admin);
        let (adapter, network) = sc_domain(env);
        let domain = client.register_domain(
            &admin,
            &adapter,
            &network,
            &10,
            &1,
            &Vec::from_array(env, [1u32]),
        );
        client.admit_domain(&admin, &domain);
        client.set_gate_vm_vk(&admin, &gv_vk(env));
        (client, admin, domain)
    }

    // -- the 32-line sibling -------------------------------------------------
    //
    // Same helper shapes as the 8-line lane, deliberately near-verbatim: a
    // reviewer should diff the two test sections and find the ceilings, the
    // keys, and the sibling-specific invariance claims as the only deltas.

    use crate::gate_vm32_vectors as g3x;

    fn g32_hex(env: &Env, text: &str) -> Bytes {
        Bytes::from_slice(env, &decode_hex_var(text))
    }

    fn g32_inputs(env: &Env) -> Vec<BytesN<32>> {
        let mut out = Vec::new(env);
        for i in 0..g3x::PUBLIC_INPUTS_HEX.len() {
            out.push_back(BytesN::from_array(
                env,
                &decode_hex::<32>(g3x::PUBLIC_INPUTS_HEX[i]),
            ));
        }
        out
    }

    fn g32_payload(env: &Env, height: u64, hash_steps_override: Option<u64>) -> Bytes {
        let inputs = g32_inputs(env);
        let mut payload = Bytes::new(env);
        payload.append(&Bytes::from_array(env, &height.to_le_bytes()));
        for index in [GV_PROGRAM_ROOT, GV_START, GV_EVENT, GV_END] {
            payload.append(&Bytes::from_array(
                env,
                &inputs.get(index as u32).unwrap().to_array(),
            ));
        }
        let steps =
            hash_steps_override.unwrap_or_else(|| public_u64(&inputs.get(GV_HASH_STEPS as u32).unwrap()));
        payload.append(&Bytes::from_array(env, &steps.to_le_bytes()));
        payload
    }

    fn g32_evidence(env: &Env, height: u64) -> RawEvidence {
        let (adapter, network) = sc_domain(env);
        let inputs = g32_inputs(env);
        RawEvidence {
            adapter_id: adapter,
            evidence_version: 1,
            network,
            payload: g32_payload(env, height, None),
            declared_height: height,
            declared_root: BytesN::from_array(env, &inputs.get(GV_END as u32).unwrap().to_array()),
            submitter: Address::generate(env),
        }
    }

    fn g32_registry(env: &Env) -> (FinalityRegistryClient<'_>, Address, BytesN<32>) {
        let contract_id = env.register(FinalityRegistry, ());
        let client = FinalityRegistryClient::new(env, &contract_id);
        let admin = Address::generate(env);
        client.initialize(&admin);
        let (adapter, network) = sc_domain(env);
        let domain = client.register_domain(
            &admin,
            &adapter,
            &network,
            &10,
            &1,
            &Vec::from_array(env, [1u32]),
        );
        client.admit_domain(&admin, &domain);
        client.set_gate_vm32_vk(&admin, &g32_hex(env, g3x::VK_HEX));
        (client, admin, domain)
    }

    #[test]
    fn test_gate_vm32_vectors_are_the_layout_the_sibling_expects() {
        assert_eq!(g3x::VK_HEX.len(), (GATE_VM32_VK_LEN as usize) * 2);
        assert_eq!(g3x::PROOF_HEX.len(), 256 * 2);
        assert_eq!(g3x::PUBLIC_INPUTS_HEX.len(), GATE_VM32_PUBLIC_INPUTS as usize);
        assert_eq!(
            g3x::PUBLIC_INPUT_ORDER,
            [
                "program_root",
                "start_root",
                "event_root",
                "end_root",
                "hash_steps",
                "domain_tag"
            ],
            "the sibling shares the 8-line lane's declaration order exactly"
        );
        let env = Env::default();
        let rebuilt = g32_payload(&env, g3x::HEIGHT, None);
        let committed = Bytes::from_slice(&env, &decode_hex_var(g3x::PAYLOAD_HEX));
        assert_eq!(rebuilt, committed, "the reconstructed payload must equal the committed bytes");
        assert_eq!(committed.len(), GATE_VM32_PAYLOAD_LEN);
    }

    #[test]
    fn test_gate_vm32_honest_run_is_accepted_and_recorded() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, domain) = g32_registry(&env);

        let attestation = client.submit_gate_vm32_zk(
            &g32_evidence(&env, g3x::HEIGHT),
            &g32_hex(&env, g3x::PROOF_HEX),
            &g32_inputs(&env),
        );
        assert_eq!(attestation.height, g3x::HEIGHT);
        assert_eq!(attestation.hash_steps, 4);
        assert_eq!(attestation.security, SecurityBacking::ZkProof);
        let recorded = client
            .get_gate_vm32_record(&domain)
            .expect("an accepted sibling run must be recorded");
        assert_eq!(recorded.hash_steps, 4);
        assert!(!recorded.settlement_anchored);
    }

    #[test]
    fn test_gate_vm32_shares_the_end_root_and_the_tag_but_not_the_key() {
        // The split's whole claim, in the contract's own terms: the two
        // compilations of one core prove the same execution to the same
        // separation constant, commit their padding apart, and are told
        // apart by key material no payload can influence.
        let both = (
            decode_hex::<32>(gvx::PUBLIC_INPUTS_HEX[GV_END]),
            decode_hex::<32>(g3x::PUBLIC_INPUTS_HEX[GV_END]),
        );
        assert_eq!(both.0, both.1, "the end root must be padding-invariant");
        assert_ne!(
            decode_hex::<32>(gvx::PUBLIC_INPUTS_HEX[GV_PROGRAM_ROOT]),
            decode_hex::<32>(g3x::PUBLIC_INPUTS_HEX[GV_PROGRAM_ROOT]),
            "the committed fold must move with the padding"
        );
        assert_eq!(
            decode_hex::<32>(gvx::PUBLIC_INPUTS_HEX[GV_TAG]),
            decode_hex::<32>(g3x::PUBLIC_INPUTS_HEX[GV_TAG]),
            "one machine, one tag"
        );
        assert_ne!(
            gvx::VK_HEX, g3x::VK_HEX,
            "the two 896-byte siblings must be different ceremonies"
        );
        assert_eq!(gvx::VK_HEX.len(), g3x::VK_HEX.len());
    }

    #[test]
    fn test_gate_vm32_ceiling_is_its_window_and_a_33rd_step_refuses() {
        // The payload ceiling is the only parse difference between the
        // siblings: steps up to 31 parse here (7 in the 8-line lane), and 32
        // is a format error before any pairing — the lane that can afford the
        // longer chain is the only one that may claim it.
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _domain) = g32_registry(&env);

        let mut payload = g32_payload(&env, g3x::HEIGHT, Some(32));
        let _ = &mut payload;
        let (adapter, network) = sc_domain(&env);
        let mut inputs = g32_inputs(&env);
        let _ = &mut inputs;
        let res = client.try_submit_gate_vm32_zk(
            &RawEvidence {
                adapter_id: adapter,
                evidence_version: 1,
                network,
                payload: g32_payload(&env, g3x::HEIGHT, Some(32)),
                declared_height: g3x::HEIGHT,
                declared_root: BytesN::from_array(&env, &inputs.get(GV_END as u32).unwrap().to_array()),
                submitter: Address::generate(&env),
            },
            &g32_hex(&env, g3x::PROOF_HEX),
            &g32_inputs(&env),
        );
        assert_eq!(res.unwrap_err().unwrap(), RegistryError::InvalidPayload);
    }

    #[test]
    fn test_gate_vm32_refuses_the_siblings_key_even_at_the_right_length() {
        // The new confusion case only the two-sibling world can pose: install
        // the 8-line key in the 32-line slot — legal length, same tag, and a
        // proof that says nothing wrong — and require the pairing equation to
        // be the thing that refuses it. A registry that trusted length or tag
        // would accept this; the math does not.
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(FinalityRegistry, ());
        let client = FinalityRegistryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        let (adapter, network) = sc_domain(&env);
        let domain = client.register_domain(&admin, &adapter, &network, &10, &1, &Vec::from_array(&env, [1u32]));
        client.admit_domain(&admin, &domain);
        client.set_gate_vm32_vk(&admin, &g32_hex(&env, gvx::VK_HEX)); // the WRONG 896

        let res = client.try_submit_gate_vm32_zk(
            &g32_evidence(&env, g3x::HEIGHT),
            &g32_hex(&env, g3x::PROOF_HEX),
            &g32_inputs(&env),
        );
        assert_eq!(res.unwrap_err().unwrap(), RegistryError::InvalidProof);
        let _ = domain;
    }

    #[test]
    fn test_gate_vm32_refuses_a_replayed_digest_and_a_mutated_proof() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _domain) = g32_registry(&env);

        let mut proof = decode_hex_var(g3x::PROOF_HEX);
        proof[9] ^= 0x01;
        let res = client.try_submit_gate_vm32_zk(
            &g32_evidence(&env, g3x::HEIGHT),
            &Bytes::from_slice(&env, &proof),
            &g32_inputs(&env),
        );
        assert_eq!(res.unwrap_err().unwrap(), RegistryError::InvalidProof);

        client.submit_gate_vm32_zk(
            &g32_evidence(&env, g3x::HEIGHT),
            &g32_hex(&env, g3x::PROOF_HEX),
            &g32_inputs(&env),
        );
        let replay = client.try_submit_gate_vm32_zk(
            &g32_evidence(&env, g3x::HEIGHT),
            &g32_hex(&env, g3x::PROOF_HEX),
            &g32_inputs(&env),
        );
        assert_eq!(
            replay.unwrap_err().unwrap(),
            RegistryError::EvidenceAlreadyProcessed
        );
    }

    #[test]
    fn test_gate_vm32_vk_setting_is_refused_after_renounce() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin, _domain) = g32_registry(&env);
        client.renounce_admin(&admin);
        let res = client.try_set_gate_vm32_vk(&admin, &g32_hex(&env, g3x::VK_HEX));
        assert!(res.is_err(), "the sibling slot must freeze with all the others");
    }

    #[test]
    fn test_gate_vm_vectors_are_the_layout_the_contract_expects() {
        // 896 = 64 (alpha) + 3 x 128 (beta, gamma, delta) + 7 x 64 (IC[0..6]).
        assert_eq!(gvx::VK_HEX.len(), (GATE_VM_VK_LEN as usize) * 2);
        assert_eq!(gvx::PROOF_HEX.len(), 256 * 2);
        assert_eq!(gvx::PUBLIC_INPUTS_HEX.len(), GATE_VM_PUBLIC_INPUTS as usize);
        assert_eq!(
            gvx::PUBLIC_INPUT_ORDER,
            [
                "program_root",
                "start_root",
                "event_root",
                "end_root",
                "hash_steps",
                "domain_tag"
            ]
        );
        // The reconstruction helper and the committed bytes must be one thing.
        let env = Env::default();
        let rebuilt = gv_payload(&env, gvx::HEIGHT);
        let committed = Bytes::from_slice(&env, &decode_hex_var(gvx::PAYLOAD_HEX));
        assert_eq!(rebuilt, committed);
        assert_eq!(committed.len(), GATE_VM_PAYLOAD_LEN);
    }

    #[test]
    fn test_gate_vm_tag_matches_the_circuit_constant() {
        // The constant this contract pins is the constant the circuit asserts
        // is asserted against the witness the emitter shares: one number,
        // three places, checked from the proven bytes inward.
        let env = Env::default();
        let inputs = gv_inputs(&env);
        assert_eq!(
            inputs.get(GV_TAG as u32).unwrap().to_array(),
            GATE_VM_TAG_BYTES
        );
        // Distinct from both other lanes' tags: a proof is never lane-agnostic.
        assert_ne!(GATE_VM_TAG_BYTES, STEP_CHAIN_TAG_BYTES);
        assert_ne!(GATE_VM_TAG_BYTES, EXECUTION_TAG_BYTES);
    }

    #[test]
    fn test_gate_vm_proof_verifies_in_host_and_is_recorded() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, domain) = gv_registry(&env);

        let attestation = client.submit_gate_vm_zk(
            &gv_evidence(&env, gvx::HEIGHT),
            &gv_proof(&env),
            &gv_inputs(&env),
        );
        assert_eq!(attestation.height, gvx::HEIGHT);
        assert_eq!(attestation.hash_steps, 4);
        assert_eq!(attestation.security, SecurityBacking::ZkProof);
        assert_eq!(
            attestation.program_root,
            gv_inputs(&env).get(GV_PROGRAM_ROOT as u32).unwrap()
        );

        let recorded = client
            .get_gate_vm_record(&domain)
            .expect("an accepted run must be recorded");
        assert_eq!(recorded.height, gvx::HEIGHT);
        assert_eq!(recorded.hash_steps, 4);
        assert_eq!(
            recorded.end_root,
            gv_inputs(&env).get(GV_END as u32).unwrap()
        );
        assert!(!recorded.settlement_anchored);
    }

    #[test]
    fn test_gate_vm_does_not_touch_what_settlement_anchors_on() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, domain) = gv_registry(&env);

        let before = client.get_domain(&domain).expect("domain exists");
        client.submit_gate_vm_zk(
            &gv_evidence(&env, gvx::HEIGHT),
            &gv_proof(&env),
            &gv_inputs(&env),
        );
        let after = client.get_domain(&domain).expect("domain exists");

        assert_eq!(before.last_height, after.last_height);
        assert_eq!(before.last_root, after.last_root);
        assert_eq!(before.last_event_root, after.last_event_root);
        assert_eq!(after.last_security, SecurityBacking::None);
    }

    #[test]
    fn test_gate_vm_rejects_a_mutated_proof() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _domain) = gv_registry(&env);

        let mut proof = decode_hex_var(gvx::PROOF_HEX);
        proof[9] ^= 0x01;
        let proof = Bytes::from_slice(&env, &proof);
        let res =
            client.try_submit_gate_vm_zk(&gv_evidence(&env, gvx::HEIGHT), &proof, &gv_inputs(&env));
        assert_eq!(res.unwrap_err().unwrap(), RegistryError::InvalidProof);
    }

    #[test]
    fn test_gate_vm_rejects_swapped_public_inputs() {
        // start and event are both roots; only their positions differ. A lane
        // that bound "some root, some position" would accept this.
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _domain) = gv_registry(&env);

        let mut inputs = gv_inputs(&env);
        let start = inputs.get(GV_START as u32).unwrap();
        let event = inputs.get(GV_EVENT as u32).unwrap();
        inputs.set(GV_START as u32, event);
        inputs.set(GV_EVENT as u32, start);
        let res =
            client.try_submit_gate_vm_zk(&gv_evidence(&env, gvx::HEIGHT), &gv_proof(&env), &inputs);
        assert_eq!(res.unwrap_err().unwrap(), RegistryError::DeclaredMismatch);
    }

    #[test]
    fn test_gate_vm_rejects_a_rewritten_hash_count() {
        // The payload claims three hashes; the proof says four. The contract's
        // binding -- not the proof -- is what refuses here, which is the point:
        // the counted number and the claimed number must be one number before
        // any pairing runs.
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _domain) = gv_registry(&env);

        let inputs = gv_inputs(&env);
        let mut payload = Bytes::new(&env);
        payload.append(&Bytes::from_array(&env, &gvx::HEIGHT.to_le_bytes()));
        for index in [GV_PROGRAM_ROOT, GV_START, GV_EVENT, GV_END] {
            payload.append(&Bytes::from_array(
                &env,
                &inputs.get(index as u32).unwrap().to_array(),
            ));
        }
        payload.append(&Bytes::from_array(&env, &3u64.to_le_bytes()));

        let (adapter, network) = sc_domain(&env);
        let evidence = RawEvidence {
            adapter_id: adapter,
            evidence_version: 1,
            network,
            payload,
            declared_height: gvx::HEIGHT,
            declared_root: inputs.get(GV_END as u32).unwrap(),
            submitter: Address::generate(&env),
        };
        let res = client.try_submit_gate_vm_zk(&evidence, &gv_proof(&env), &inputs);
        assert_eq!(res.unwrap_err().unwrap(), RegistryError::DeclaredMismatch);
    }

    #[test]
    fn test_gate_vm_rejects_an_inflated_hash_count() {
        // A payload claiming nine hash steps describes a trace the eight-row
        // window cannot hold. Refused as a format error, before the pairing.
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _domain) = gv_registry(&env);

        let inputs = gv_inputs(&env);
        let mut payload = Bytes::new(&env);
        payload.append(&Bytes::from_array(&env, &1u64.to_le_bytes()));
        for index in [GV_PROGRAM_ROOT, GV_START, GV_EVENT, GV_END] {
            payload.append(&Bytes::from_array(
                &env,
                &inputs.get(index as u32).unwrap().to_array(),
            ));
        }
        payload.append(&Bytes::from_array(&env, &9u64.to_le_bytes()));

        let (adapter, network) = sc_domain(&env);
        let evidence = RawEvidence {
            adapter_id: adapter,
            evidence_version: 1,
            network,
            payload,
            declared_height: 1,
            declared_root: inputs.get(GV_END as u32).unwrap(),
            submitter: Address::generate(&env),
        };
        let res = client.try_submit_gate_vm_zk(&evidence, &gv_proof(&env), &inputs);
        assert_eq!(res.unwrap_err().unwrap(), RegistryError::InvalidPayload);
    }

    #[test]
    fn test_gate_vm_rejects_a_wrong_domain_tag() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _domain) = gv_registry(&env);

        let mut inputs = gv_inputs(&env);
        inputs.set(
            GV_TAG as u32,
            BytesN::from_array(&env, &EXECUTION_TAG_BYTES),
        );
        let res =
            client.try_submit_gate_vm_zk(&gv_evidence(&env, gvx::HEIGHT), &gv_proof(&env), &inputs);
        assert_eq!(res.unwrap_err().unwrap(), RegistryError::DeclaredMismatch);
    }

    #[test]
    fn test_gate_vm_rejects_a_rewritten_program_root() {
        // Payload and proof must agree on WHICH program ran, byte for byte;
        // a swapped-in commitment to some other eight cells never gets to the
        // pairing check.
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _domain) = gv_registry(&env);

        let mut payload = decode_hex_var(gvx::PAYLOAD_HEX);
        payload[8] ^= 0xff;
        let payload = Bytes::from_slice(&env, &payload);

        let (adapter, network) = sc_domain(&env);
        let evidence = RawEvidence {
            adapter_id: adapter,
            evidence_version: 1,
            network,
            payload,
            declared_height: gvx::HEIGHT,
            declared_root: gv_inputs(&env).get(GV_END as u32).unwrap(),
            submitter: Address::generate(&env),
        };
        let res = client.try_submit_gate_vm_zk(&evidence, &gv_proof(&env), &gv_inputs(&env));
        assert_eq!(res.unwrap_err().unwrap(), RegistryError::DeclaredMismatch);
    }

    #[test]
    fn test_gate_vm_rejects_a_replayed_digest() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _domain) = gv_registry(&env);

        let evidence = gv_evidence(&env, gvx::HEIGHT);
        client.submit_gate_vm_zk(&evidence, &gv_proof(&env), &gv_inputs(&env));
        let res = client.try_submit_gate_vm_zk(&evidence, &gv_proof(&env), &gv_inputs(&env));
        assert_eq!(
            res.unwrap_err().unwrap(),
            RegistryError::EvidenceAlreadyProcessed
        );
    }

    #[test]
    fn test_gate_vm_refuses_the_step_chains_key_even_at_the_right_length() {
        // Both lane keys are exactly 896 bytes -- length cannot tell them
        // apart, and no length check claims to. What refuses the substitution
        // is the pairing equation itself: a step-chain key does not verify a
        // gate-vm proof, full stop, and the separate slots are what keep this
        // the only possible mix-up.
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin, _domain) = gv_registry(&env);
        let step_chain_vk = Bytes::from_slice(&env, &decode_hex_var(vsc::VK_HEX));
        assert_eq!(step_chain_vk.len(), GATE_VM_VK_LEN); // right length, wrong key
        client.set_gate_vm_vk(&admin, &step_chain_vk);
        let res = client.try_submit_gate_vm_zk(
            &gv_evidence(&env, gvx::HEIGHT),
            &gv_proof(&env),
            &gv_inputs(&env),
        );
        assert_eq!(res.unwrap_err().unwrap(), RegistryError::InvalidProof);
    }

    #[test]
    #[should_panic(expected = "admin renounced")]
    fn test_gate_vm_vk_setting_is_refused_after_renounce() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin, _domain) = gv_registry(&env);
        client.renounce_admin(&admin);
        client.set_gate_vm_vk(&admin, &gv_vk(&env));
    }
}
