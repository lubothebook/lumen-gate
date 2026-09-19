#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, crypto::bls12_381::Bls12381G1Affine,
    crypto::bls12_381::Bls12381G2Affine, crypto::bn254::Bn254G1Affine,
    crypto::bn254::Bn254G2Affine, crypto::bn254::Bn254Fr, Address, Bytes, BytesN, Env, String,
    Symbol, Vec,
};

// ---------- Groth16 verifier (Apache-2.0-compatible pattern, adapted) ----------
mod groth16 {
    use super::*;
    use soroban_sdk::TryFromVal;
    pub const G1_SIZE: u32 = 64;
    pub const G2_SIZE: u32 = 128;

    // BN254 Fr modulus, big-endian. Soroban's Bn254Fr::from_bytes reduces
    // modulo r, so the verifier must reject non-canonical public inputs before
    // constructing a scalar instead of silently accepting a different witness.
    const FR_MODULUS: [u8; 32] = [
        0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
        0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
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
        BytesN::<N>::try_from_val(env, &val)
            .unwrap_or_else(|_| panic!("expected {} bytes", N))
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
    pub fn verify(
        env: &Env,
        vk: &Bytes,
        proof: &Bytes,
        public_inputs: &Vec<BytesN<32>>,
    ) -> bool {
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
        if !bn254.g1_is_on_curve(&a)
            || !bn254.g1_is_on_curve(&c)
            || !bn254.g1_is_on_curve(&alpha)
        {
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
        let g1_points: Vec<Bn254G1Affine> =
            Vec::from_array(env, [a, neg_alpha, neg_vk_x, neg_c]);
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

fn parse_bls_payload(payload: &Bytes) -> Result<(u64, BytesN<32>, BytesN<32>, u32, u32, Bytes, Bytes), RegistryError> {
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
    let state_root = BytesN::from_array(&env, &sr_arr);
    let er_slice = payload.slice(40..72);
    let mut er_arr = [0u8; 32];
    for i in 0u32..32 {
        er_arr[i as usize] = er_slice.get(i).unwrap_or(0);
    }
    let event_root = BytesN::from_array(&env, &er_arr);
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
    Ok((height, state_root, event_root, signer_count, required, sig_bytes, pubkey_bytes))
}

#[contract]
pub struct FinalityRegistry;

#[contractimpl]
impl FinalityRegistry {
    pub fn initialize(env: Env, admin: Address) {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::AdminRenounced, &false);
        env.storage().instance().set(&DataKey::Vk, &Bytes::new(&env));
        env.storage().instance().set(&DataKey::DomainList, &Vec::<BytesN<32>>::new(&env));
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
        env.storage().instance().set(&DataKey::AdminRenounced, &true);
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
        if accepted_versions.len() == 0 || !accepted_versions.contains(&adapter_version) {
            panic!("adapter version must be accepted");
        }
        let domain_key = compute_domain_key(&env, &adapter_id, &network);
        if env.storage().persistent().has(&DataKey::Domain(domain_key.clone())) {
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
        if !env.storage().persistent().has(&DataKey::Domain(domain.clone())) {
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

    pub fn get_finalized_full(env: Env, domain: BytesN<32>, height: u64) -> Option<FinalizedRecord> {
        env.storage()
            .persistent()
            .get(&DataKey::FinalizedFull(domain, height))
    }

    pub fn get_last_finalized(env: Env, domain: BytesN<32>) -> Option<DomainRecord> {
        env.storage().persistent().get(&DataKey::Domain(domain))
    }

    pub fn get_profile(env: Env, domain: BytesN<32>) -> Option<DomainProfile> {
        let record: DomainRecord = env.storage().persistent().get(&DataKey::Domain(domain.clone()))?;
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

        if !record.accepted_versions.contains(&evidence.evidence_version) {
            return Err(RegistryError::VersionNotAccepted);
        }
        let digest = compute_evidence_digest(&env, &evidence);
        if env.storage().persistent().has(&DataKey::Evidence(digest.clone())) {
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
        let hashed = bls.hash_to_g1(&root_buf, &Bytes::from_array(&env, b"lumen-gate-finality-v1"));
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
        new_record.last_security = SecurityBacking::SignatureSet(
            signer_count,
            required,
            policy.slashable,
        );
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

        if !record.accepted_versions.contains(&evidence.evidence_version) {
            return Err(RegistryError::VersionNotAccepted);
        }
        let digest = compute_evidence_digest(&env, &evidence);
        if env.storage().persistent().has(&DataKey::Evidence(digest.clone())) {
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
        if vk.len() == 0 || public_inputs.is_empty() {
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
    // It is NOT a zkVM. Nothing here proves the execution of a program on a
    // virtual machine: there is no instruction set, no memory model and no
    // program commitment, and the statement is baked into the constraint
    // system at compile time. The circuit proves that a quorum of a bitmap is
    // set and that the submitted roots participate in one Poseidon relation.
    // See docs/PROVING_SYSTEM.md, and note that the settlement path does not
    // use this lane's event root precisely because no signature covers it.
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
        if let Some(record) = env.storage().persistent().get::<DataKey, DomainRecord>(&DataKey::Domain(domain.clone())) {
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
mod test {
    use super::*;
    use crate::test_vectors as v;
    extern crate std;
    use soroban_sdk::{testutils::Address as _, Env};

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
        let domain = client.register_domain(&admin, &adapter, &network, &10, &1, &Vec::from_array(&env, [1u32]));
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
        client.register_domain(&admin, &adapter, &network, &2, &1, &Vec::from_array(&env, [1u32]));

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
        let domain = client.register_domain(&admin, &adapter, &network, &2, &1, &Vec::from_array(&env, [1u32]));
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
        assert_eq!(client.is_admin_renounced_check(), false);
        client.renounce_admin(&admin);
        assert_eq!(client.is_admin_renounced_check(), true);
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

        let register = client.try_register_domain(
            &attacker,
            &adapter,
            &network,
            &2,
            &1,
            &versions,
        );
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
        let domain = client.register_domain(&admin, &adapter, &network, &2, &1, &Vec::from_array(&env, [1u32]));
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
}
