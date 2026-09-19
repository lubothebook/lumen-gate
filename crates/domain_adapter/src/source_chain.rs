//! The adapter for this deployment's source-chain evidence.
//!
//! Payload layout, byte for byte, and it is the same layout the deployed
//! `finality_registry` contract parses before it does anything else:
//!
//! ```text
//!  0..8     height          u64, little-endian
//!  8..40    state_root      32 bytes
//! 40..72    event_root      32 bytes
//! 72..76    signer_count    u32, little-endian
//! 76..80    required        u32, little-endian
//! 80..176   aggregate sig   G1 uncompressed (96 bytes)
//! 176..368  aggregate key   G2 uncompressed (192 bytes)
//! ```
//!
//! The height and the state root are re-derived here from bytes 0..40 and
//! compared against what the submitter declared. A mismatch is a refusal, not a
//! correction: if the index and the payload disagree, one of them is lying and
//! this adapter has no way to tell which.
//!
//! What this adapter does *not* do, stated here so nobody has to infer it from
//! absence: it does not perform the pairing check. That happens inside the
//! Soroban contract, on the native host functions, where the decision is made.
//! This side checks that the evidence is well-formed, internally consistent and
//! inside the caller's policy, so that a malformed or stale payload never costs
//! anyone a fee.

use crate::{
    evidence_digest, refuse_mismatch, AdapterDescriptor, AdapterError, AdapterId, FinalityAdapter,
    FinalityAttestation, FinalityKind, ProofSystem, RawEvidence, SecurityBacking, TimeUnit,
    TrustModel, VerificationPolicy,
};

/// The adapter id of this deployment's BLS lane. The same derivation the source
/// simulator uses, so the on-chain domain key and this id agree.
pub const ADAPTER_NAME: &str = "source-chain-bls-v1";
pub const ADAPTER_VERSION: u32 = 1;
/// Only version 1 exists. A second version would be added here, never inferred.
pub const ACCEPTED_EVIDENCE_VERSIONS: &[u32] = &[1];
pub const BLS_PAYLOAD_LEN: usize = 368;

/// Reads finality evidence for the source chain's BLS lane.
#[derive(Debug, Default, Clone, Copy)]
pub struct SourceChainBlsAdapter;

/// The fields this adapter reads out of the payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedPayload {
    pub height: u64,
    pub state_root: [u8; 32],
    pub event_root: [u8; 32],
    pub signer_count: u32,
    pub required: u32,
    pub signature: Vec<u8>,
    pub aggregate_key: Vec<u8>,
}

impl SourceChainBlsAdapter {
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    /// Parses the payload. Every failure here is a typed refusal with the byte
    /// range or the reason that failed.
    pub fn decode(payload: &[u8]) -> Result<DecodedPayload, AdapterError> {
        if payload.len() != BLS_PAYLOAD_LEN {
            return Err(AdapterError::MalformedPayload {
                reason: format!(
                    "expected {BLS_PAYLOAD_LEN} bytes, found {}: the length is fixed and a payload of another size cannot be read as this format",
                    payload.len()
                ),
            });
        }

        let mut height_bytes = [0u8; 8];
        height_bytes.copy_from_slice(&payload[0..8]);
        let height = u64::from_le_bytes(height_bytes);

        let mut state_root = [0u8; 32];
        state_root.copy_from_slice(&payload[8..40]);

        let mut event_root = [0u8; 32];
        event_root.copy_from_slice(&payload[40..72]);

        let mut count_bytes = [0u8; 4];
        count_bytes.copy_from_slice(&payload[72..76]);
        let signer_count = u32::from_le_bytes(count_bytes);

        let mut required_bytes = [0u8; 4];
        required_bytes.copy_from_slice(&payload[76..80]);
        let required = u32::from_le_bytes(required_bytes);

        let signature = payload[80..176].to_vec();
        let aggregate_key = payload[176..368].to_vec();

        if height == 0 {
            return Err(AdapterError::MalformedPayload {
                reason: "height 0 cannot be finalized".to_string(),
            });
        }
        if required == 0 {
            return Err(AdapterError::MalformedPayload {
                reason: "required threshold is 0, which would make every message acceptable"
                    .to_string(),
            });
        }
        if signer_count < required {
            return Err(AdapterError::MalformedPayload {
                reason: format!("{signer_count} signers cannot satisfy a threshold of {required}"),
            });
        }
        if signature.iter().all(|byte| *byte == 0) {
            return Err(AdapterError::MalformedPayload {
                reason: "aggregate signature is all zeroes".to_string(),
            });
        }
        if aggregate_key.iter().all(|byte| *byte == 0) {
            return Err(AdapterError::MalformedPayload {
                reason: "aggregate public key is all zeroes".to_string(),
            });
        }

        Ok(DecodedPayload {
            height,
            state_root,
            event_root,
            signer_count,
            required,
            signature,
            aggregate_key,
        })
    }
}

impl FinalityAdapter for SourceChainBlsAdapter {
    fn descriptor(&self) -> AdapterDescriptor {
        AdapterDescriptor {
            id: AdapterId::from_name(ADAPTER_NAME),
            name: ADAPTER_NAME,
            version: ADAPTER_VERSION,
            accepted_evidence_versions: ACCEPTED_EVIDENCE_VERSIONS,
            finality_kind: FinalityKind::EconomicFinality,
            trust_model: TrustModel::HonestMajority { set_size: 3 },
            evidence_format: "height | state_root | event_root | signer_count | required | G1 signature | G2 aggregate key",
            not_claimed: &[
                "this adapter does not perform the pairing check; the Soroban contract does",
                "the demo validator set is 3 keys with a threshold of 2, so the honest-majority assumption is over three parties, not a production set",
                "the keys are not slashable, so nothing is lost by signing a false root",
                "the source chain in this deployment is a deterministic simulator",
            ],
        }
    }

    fn verify(
        &self,
        evidence: &RawEvidence,
        policy: &VerificationPolicy,
    ) -> Result<FinalityAttestation, AdapterError> {
        let descriptor = self.descriptor();

        // 1. Is this evidence even addressed to me?
        if evidence.adapter_id != descriptor.id {
            return Err(AdapterError::WrongAdapter {
                expected: descriptor.id.as_hex(),
                found: evidence.adapter_id.as_hex(),
            });
        }

        // 2. Is this a format version I was written for? An unknown version is
        //    refused, never reinterpreted as the version I do know.
        if !descriptor
            .accepted_evidence_versions
            .contains(&evidence.evidence_version)
        {
            return Err(AdapterError::UnknownEvidenceVersion {
                found: evidence.evidence_version,
                accepted: descriptor.accepted_evidence_versions.to_vec(),
            });
        }

        // 3. Can the payload be read at all?
        let decoded = Self::decode(&evidence.payload)?;

        // 4. Do the indexed declarations agree with the payload itself? These
        //    two fields are what the settlement layer keyed on before this
        //    adapter ran, so a disagreement means the two disagree about facts.
        if policy.require_declared_match {
            if decoded.height != evidence.declared_height {
                return Err(refuse_mismatch(
                    "height",
                    evidence.declared_height.to_string(),
                    decoded.height.to_string(),
                ));
            }
            if decoded.state_root != evidence.declared_root {
                return Err(refuse_mismatch(
                    "state_root",
                    hex::encode(evidence.declared_root),
                    hex::encode(decoded.state_root),
                ));
            }
        }

        // 5. The caller's own policy, applied to facts rather than to a label.
        if decoded.height < policy.min_height {
            return Err(AdapterError::BelowMinimumHeight {
                height: decoded.height,
                required: policy.min_height,
            });
        }
        let age = policy.now.saturating_sub(decoded.height);
        if policy.max_age != u64::MAX && age > policy.max_age {
            return Err(AdapterError::Stale {
                age,
                max_age: policy.max_age,
            });
        }
        if policy.require_slashable {
            // The demo validator set is not bonded; a caller that demands
            // slashable backing is told so here rather than after a settlement.
            return Err(AdapterError::UnslashableBackingRefused);
        }

        Ok(FinalityAttestation {
            adapter_id: descriptor.id,
            adapter_version: descriptor.version,
            evidence_version: evidence.evidence_version,
            network: evidence.network.clone(),
            height: decoded.height,
            state_root: decoded.state_root,
            finalized_at: decoded.height,
            finalized_at_unit: TimeUnit::Height,
            security: SecurityBacking::SignatureSet {
                signers: decoded.signer_count,
                required: decoded.required,
                total_weight: decoded.signer_count as u128,
                slashable: false,
            },
            evidence_digest: evidence_digest(&evidence.payload),
            submitter: evidence.submitter.clone(),
        })
    }
}

/// The ZK lane of this deployment is deliberately absent.
///
/// Its payload is a development fixture: a quorum-and-root-binding statement,
/// not a signature proof. The registry does not persist an event root from that
/// lane and settlement never anchors on it, so there is no honest adapter to
/// write for it yet — and an adapter that quietly returned an attestation would
/// be exactly the "assume valid" branch this interface exists to prevent.
#[must_use]
pub fn zk_lane_reason() -> &'static str {
    "the Groth16 lane proves a quorum and a root binding, not a signature, so it does not produce finality evidence that settlement can anchor on"
}

/// Named so a caller can report which proof systems exist without one.
#[must_use]
pub fn known_proof_systems() -> &'static [ProofSystem] {
    &[ProofSystem::Groth16Bn254]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(
        height: u64,
        state_root: [u8; 32],
        event_root: [u8; 32],
        signer_count: u32,
        required: u32,
    ) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(BLS_PAYLOAD_LEN);
        bytes.extend_from_slice(&height.to_le_bytes());
        bytes.extend_from_slice(&state_root);
        bytes.extend_from_slice(&event_root);
        bytes.extend_from_slice(&signer_count.to_le_bytes());
        bytes.extend_from_slice(&required.to_le_bytes());
        // A structurally valid signature and key: the real pairing check runs
        // on-chain, so this side only has to see non-degenerate bytes.
        bytes.extend(std::iter::repeat(1u8).take(96));
        bytes.extend(std::iter::repeat(2u8).take(192));
        bytes
    }

    fn evidence(payload: Vec<u8>, declared_height: u64, declared_root: [u8; 32]) -> RawEvidence {
        RawEvidence {
            adapter_id: AdapterId::from_name(ADAPTER_NAME),
            evidence_version: 1,
            network: "source-testnet".to_string(),
            payload,
            declared_height,
            declared_root,
            submitter: "GAUDIT".to_string(),
        }
    }

    #[test]
    fn honest_evidence_produces_an_attestation_with_its_backing_spelled_out() {
        let root = [3u8; 32];
        let proof = evidence(payload(7, root, [4u8; 32], 3, 2), 7, root);
        let attestation = SourceChainBlsAdapter::new()
            .verify(&proof, &VerificationPolicy::default())
            .expect("honest evidence must be accepted");
        assert_eq!(attestation.height, 7);
        assert_eq!(attestation.state_root, root);
        assert_eq!(attestation.finalized_at_unit, TimeUnit::Height);
        match attestation.security {
            SecurityBacking::SignatureSet {
                signers,
                required,
                slashable,
                ..
            } => {
                assert_eq!((signers, required), (3, 2));
                // The honest answer: this backing cannot be slashed, and the
                // attestation says so instead of implying otherwise.
                assert!(!slashable);
            }
            other => panic!("expected a signature set, got {other:?}"),
        }
    }

    #[test]
    fn declared_height_that_disagrees_with_the_payload_is_refused() {
        let root = [3u8; 32];
        let proof = evidence(payload(7, root, [4u8; 32], 3, 2), 8, root);
        let error = SourceChainBlsAdapter::new()
            .verify(&proof, &VerificationPolicy::default())
            .expect_err("a lying index must be refused");
        assert!(
            matches!(error, AdapterError::DeclaredMismatch { ref field, .. } if field == "height")
        );
    }

    #[test]
    fn declared_root_that_disagrees_with_the_payload_is_refused() {
        let proof = evidence(payload(7, [3u8; 32], [4u8; 32], 3, 2), 7, [9u8; 32]);
        let error = SourceChainBlsAdapter::new()
            .verify(&proof, &VerificationPolicy::default())
            .expect_err("a lying declared root must be refused");
        assert!(
            matches!(error, AdapterError::DeclaredMismatch { ref field, .. } if field == "state_root")
        );
    }

    #[test]
    fn unknown_evidence_version_is_refused_rather_than_reinterpreted() {
        let root = [3u8; 32];
        let mut proof = evidence(payload(7, root, [4u8; 32], 3, 2), 7, root);
        proof.evidence_version = 99;
        let error = SourceChainBlsAdapter::new()
            .verify(&proof, &VerificationPolicy::default())
            .expect_err("version 99 must be refused");
        assert!(matches!(
            error,
            AdapterError::UnknownEvidenceVersion { found: 99, .. }
        ));
    }

    #[test]
    fn evidence_for_another_adapter_is_refused() {
        let root = [3u8; 32];
        let mut proof = evidence(payload(7, root, [4u8; 32], 3, 2), 7, root);
        proof.adapter_id = AdapterId::from_name("some-other-domain");
        let error = SourceChainBlsAdapter::new()
            .verify(&proof, &VerificationPolicy::default())
            .expect_err("evidence addressed elsewhere must be refused");
        assert!(matches!(error, AdapterError::WrongAdapter { .. }));
    }

    #[test]
    fn zeroed_signature_and_wrong_length_payloads_are_refused() {
        let root = [3u8; 32];
        let mut zeroed = payload(7, root, [4u8; 32], 3, 2);
        for byte in zeroed.iter_mut().take(176).skip(80) {
            *byte = 0;
        }
        let error = SourceChainBlsAdapter::new()
            .verify(&evidence(zeroed, 7, root), &VerificationPolicy::default())
            .expect_err("an all-zero signature must be refused");
        assert!(matches!(error, AdapterError::MalformedPayload { .. }));

        let error = SourceChainBlsAdapter::new()
            .verify(
                &evidence(vec![0u8; 100], 7, root),
                &VerificationPolicy::default(),
            )
            .expect_err("a truncated payload must be refused");
        assert!(matches!(error, AdapterError::MalformedPayload { .. }));
    }

    #[test]
    fn a_threshold_of_zero_is_refused_even_though_it_parses() {
        let root = [3u8; 32];
        let error = SourceChainBlsAdapter::new()
            .verify(
                &evidence(payload(7, root, [4u8; 32], 3, 0), 7, root),
                &VerificationPolicy::default(),
            )
            .expect_err("a zero threshold would accept everything");
        assert!(matches!(error, AdapterError::MalformedPayload { .. }));
    }

    #[test]
    fn policy_gates_are_applied_to_facts() {
        let root = [3u8; 32];
        let proof = evidence(payload(7, root, [4u8; 32], 3, 2), 7, root);
        let adapter = SourceChainBlsAdapter::new();

        let below = VerificationPolicy {
            min_height: 8,
            ..VerificationPolicy::default()
        };
        assert!(matches!(
            adapter.verify(&proof, &below),
            Err(AdapterError::BelowMinimumHeight {
                height: 7,
                required: 8
            })
        ));

        let stale = VerificationPolicy {
            max_age: 3,
            now: 100,
            ..VerificationPolicy::default()
        };
        assert!(matches!(
            adapter.verify(&proof, &stale),
            Err(AdapterError::Stale {
                age: 93,
                max_age: 3
            })
        ));

        let slashable_only = VerificationPolicy {
            require_slashable: true,
            ..VerificationPolicy::default()
        };
        assert!(matches!(
            adapter.verify(&proof, &slashable_only),
            Err(AdapterError::UnslashableBackingRefused)
        ));
    }

    #[test]
    fn the_descriptor_states_what_it_does_not_claim() {
        let descriptor = SourceChainBlsAdapter::new().descriptor();
        assert_eq!(descriptor.accepted_evidence_versions, &[1]);
        assert_eq!(
            descriptor.trust_model,
            TrustModel::HonestMajority { set_size: 3 }
        );
        assert!(
            !descriptor.not_claimed.is_empty(),
            "a descriptor with no limits is a brochure"
        );
        assert!(descriptor
            .not_claimed
            .iter()
            .any(|line| line.contains("does not perform the pairing check")));
    }

    #[test]
    fn the_zk_lane_says_why_it_has_no_adapter() {
        assert!(zk_lane_reason().contains("not a signature"));
        assert_eq!(known_proof_systems(), &[ProofSystem::Groth16Bn254]);
    }
}
