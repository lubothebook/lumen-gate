//! The source-domain adapter boundary.
//!
//! # Why the boundary sits where it does
//!
//! An adapter is the piece of this system that knows how to read one source
//! domain's consensus evidence. The interface is deliberately not *"hand us
//! your block header"*: a header is a format, formats change, and an adapter
//! that is handed a header has to be rewritten every time the source domain
//! changes one. It is also not *"hand us a boolean"*: a boolean hides what is
//! backing the claim, and the backing is the only thing a reader needs in order
//! to judge the risk for their own use case.
//!
//! So the boundary is one step above both: raw evidence in (opaque bytes the
//! adapter alone understands, plus the two facts the network needs in order to
//! index it), and a finality attestation out (a height, a state root, when it
//! finalized in the source domain's own units, and a machine-readable statement
//! of what is backing the claim).
//!
//! # What this module refuses to contain
//!
//! - **No "assume valid" branch.** Every rejection path returns an error.
//!   There is no `unwrap_or_default`, no `unwrap_or(true)`, and no branch that
//!   treats an unparsable payload as an empty but acceptable one.
//! - **No blind trust in declared fields.** [`RawEvidence`] carries
//!   `declared_height` and `declared_root` because an index needs them before
//!   the adapter is ever invoked. The adapter re-derives both from the payload
//!   and refuses a mismatch; [`VerificationPolicy::require_declared_match`]
//!   makes that a rule of the caller rather than a good intention of this file.
//! - **No silent version drift.** An adapter declares the evidence versions it
//!   accepts and refuses anything else, instead of guessing how to read a
//!   format it was not written for.
//! - **No opinion about the domain.** Nothing here computes a score. Facts are
//!   reported with their units and the reader decides what they mean.
//!
//! The on-chain registry in this repository performs the same parsing and the
//! same re-derivation inside the contract, where the decision is actually made.
//! This crate is the off-chain half: it is what a relayer runs before spending a
//! fee, and what admission checks when a new domain is proposed. The two are
//! deliberately kept in the same shape so that a payload accepted here is the
//! payload the contract will accept, and a payload refused here never reaches a
//! ledger.

pub mod envelope;
pub mod source_chain;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// The identity of a source domain's adapter. Derived from a name so that two
/// parties who mean the same adapter compute the same id, and anybody can check
/// that a registration means what it says.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct AdapterId(pub [u8; 32]);

impl AdapterId {
    /// `sha256(name)`, and nothing else.
    ///
    /// The namespace-less form is not a stylistic choice: it is the derivation
    /// the deployed source adapter already uses, and the on-chain domain key is
    /// computed from that id. An off-chain boundary that derived ids its own way
    /// would refuse every honest message the chain accepts, so the two must
    /// agree byte for byte. `adapter_id_matches_the_deployed_domain_key` pins
    /// this against the value that is live on testnet.
    #[must_use]
    pub fn from_name(name: &str) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(name.as_bytes());
        let digest = hasher.finalize();
        let mut out = [0u8; 32];
        out.copy_from_slice(&digest);
        Self(out)
    }

    #[must_use]
    pub fn as_hex(&self) -> String {
        hex::encode(self.0)
    }
}

/// What the source side hands over.
///
/// `payload` is opaque to everyone except the adapter that declares itself for
/// it. The declared fields beside it exist so the network can index,
/// deduplicate and replay-guard evidence without invoking the adapter at all —
/// which is exactly why they must be re-derived rather than believed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawEvidence {
    /// Adapter this evidence is addressed to.
    pub adapter_id: AdapterId,
    /// The evidence format's own version, carried rather than sniffed: a
    /// version that has to be guessed can be guessed wrong, and a wrong guess
    /// silently reinterprets somebody else's consensus.
    pub evidence_version: u32,
    /// The source network name, so one adapter can serve several networks.
    pub network: String,
    /// Adapter-specific bytes.
    pub payload: Vec<u8>,
    /// Height as the submitter declared it. Verified, never trusted.
    pub declared_height: u64,
    /// State root as the submitter declared it. Verified, never trusted.
    pub declared_root: [u8; 32],
    /// Who submitted this evidence (a Stellar account in this deployment).
    pub submitter: String,
}

/// What is backing an attestation.
///
/// This is carried, not inferred, because the difference between "the signers
/// lose money if they lie" and "the signers lose nothing" is the single most
/// important fact a reader can be given, and a bare "verified" flag hides it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SecurityBacking {
    /// A signature set over the claim. `signers` counts distinct signers and
    /// `required` is the threshold the source protocol itself defines.
    SignatureSet {
        signers: u32,
        required: u32,
        total_weight: u128,
        slashable: bool,
    },
    /// Accumulated proof of work above the claimed height.
    Work { difficulty_bits: u32 },
    /// A validity proof. The system is named so a consumer can look up its
    /// assumptions instead of taking this repository's word for them.
    Zk {
        system: ProofSystem,
        public_inputs_digest: [u8; 32],
    },
    /// A fixed, permissioned authority set.
    Authority { count: u32 },
    /// Nothing cryptographic backs this claim yet. Carried rather than omitted,
    /// so that "no backing yet" is a visible state instead of a zero that
    /// reads like a small amount of backing.
    None,
}

/// Named proof systems, so the label carries a lookup key rather than a claim.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProofSystem {
    Groth16Bn254,
}

/// How the source domain treats a finalized height.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FinalityKind {
    /// Deep enough that reversal is uneconomic, never impossible.
    Probabilistic,
    /// Reversal costs a bonded amount.
    EconomicFinality,
    /// The protocol itself marks the height irreversible.
    ProtocolFinality,
    /// A proof, not a vote.
    Proven,
}

/// What an honest party has to assume for the attestation to mean anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "model", rename_all = "snake_case")]
pub enum TrustModel {
    /// Anybody with the evidence can check it; no honest party is assumed.
    Trustless,
    /// An honest majority of a known, bounded set.
    HonestMajority { set_size: u32 },
    /// A specific party must behave. Named, never hidden.
    TrustedParty,
}

/// In the source domain's own time units, with the unit's name attached so
/// nobody has to guess what a number means.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimeUnit {
    Height,
    Round,
    Slot,
    Epoch,
}

/// What the adapter returns, and the only thing a consumer needs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FinalityAttestation {
    pub adapter_id: AdapterId,
    pub adapter_version: u32,
    pub evidence_version: u32,
    /// The domain name this evidence came from.
    pub network: String,
    /// Height in the source domain's own numbering. Never rescaled into
    /// Stellar's: two chains with different block times have no honest
    /// exchange rate, and a rescaled height silently invents one.
    pub height: u64,
    pub state_root: [u8; 32],
    /// When it finalized, in [`Self::finalized_at_unit`].
    pub finalized_at: u64,
    pub finalized_at_unit: TimeUnit,
    pub security: SecurityBacking,
    /// The evidence this was derived from, so the attestation stays verifiable
    /// after the adapter is upgraded.
    pub evidence_digest: [u8; 32],
    pub submitter: String,
}

impl FinalityAttestation {
    /// The facts a domain profile is read off, in the order a reader needs
    /// them. No field answers "how good is this domain"; all of them answer
    /// "what is registered" or "what happened".
    #[must_use]
    pub fn profile_facts(&self) -> serde_json::Value {
        serde_json::json!({
            "terminal": self.finalized_at_unit.to_string(),
            "network": self.network,
            "height": self.height,
            "state_root": hex::encode(self.state_root),
            "security_backing": self.security,
            "evidence_version": self.evidence_version,
            "adapter_version": self.adapter_version,
            "submitter": self.submitter,
        })
    }
}

impl std::fmt::Display for TimeUnit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let text = match self {
            Self::Height => "height",
            Self::Round => "round",
            Self::Slot => "slot",
            Self::Epoch => "epoch",
        };
        f.write_str(text)
    }
}

/// What a caller requires of the evidence before it will act on it.
///
/// `now` is supplied by the caller rather than read from a clock: an adapter
/// that reads a wall clock cannot be replayed deterministically and cannot be
/// tested, and "this evidence is too old" is a policy decision, not a property
/// of the evidence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerificationPolicy {
    /// Refuse evidence that does not reach at least this height.
    pub min_height: u64,
    /// Refuse evidence whose declared height and root disagree with what the
    /// adapter derives from the payload.
    pub require_declared_match: bool,
    /// Refuse evidence older than this many units of the domain's own time.
    pub max_age: u64,
    pub now: u64,
    /// Refuse backing that is not slashable, without naming a system. Lets a
    /// caller say "I will not accept an unslashable signature set".
    pub require_slashable: bool,
}

impl Default for VerificationPolicy {
    fn default() -> Self {
        Self {
            min_height: 0,
            require_declared_match: true,
            max_age: u64::MAX,
            now: 0,
            require_slashable: false,
        }
    }
}

/// Every way evidence can be refused. Each variant names what was wrong, so a
/// rejection is an explanation and not just a closed door.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "refusal", rename_all = "snake_case")]
pub enum AdapterError {
    WrongAdapter {
        expected: String,
        found: String,
    },
    UnknownEvidenceVersion {
        found: u32,
        accepted: Vec<u32>,
    },
    MalformedPayload {
        reason: String,
    },
    DeclaredMismatch {
        field: String,
        declared: String,
        derived: String,
    },
    BelowMinimumHeight {
        height: u64,
        required: u64,
    },
    Stale {
        age: u64,
        max_age: u64,
    },
    UnslashableBackingRefused,
    UnsupportedBacking {
        backing: String,
    },
}

impl std::fmt::Display for AdapterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WrongAdapter { expected, found } => {
                write!(f, "evidence is addressed to adapter {found}, this adapter is {expected}")
            }
            Self::UnknownEvidenceVersion { found, accepted } => write!(
                f,
                "evidence version {found} is not one this adapter accepts ({accepted:?}); it is refused rather than reinterpreted"
            ),
            Self::MalformedPayload { reason } => write!(f, "payload could not be read: {reason}"),
            Self::DeclaredMismatch { field, declared, derived } => write!(
                f,
                "declared {field} ({declared}) does not match the value derived from the payload ({derived})"
            ),
            Self::BelowMinimumHeight { height, required } => {
                write!(f, "height {height} is below the required {required}")
            }
            Self::Stale { age, max_age } => write!(f, "evidence is {age} units old, policy allows {max_age}"),
            Self::UnslashableBackingRefused => f.write_str("policy refuses backing that cannot be slashed"),
            Self::UnsupportedBacking { backing } => {
                write!(f, "backing {backing} is not supported by this adapter")
            }
        }
    }
}

impl std::error::Error for AdapterError {}

/// What an adapter declares about itself, so a registry can record facts about
/// a domain instead of a label somebody typed.
///
/// Serialisable but not deserialisable on purpose: a descriptor is something an
/// adapter states about itself, and letting one be built by parsing a document
/// would invite a "descriptor" that no code ever claimed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AdapterDescriptor {
    pub id: AdapterId,
    pub name: &'static str,
    pub version: u32,
    pub accepted_evidence_versions: &'static [u32],
    pub finality_kind: FinalityKind,
    pub trust_model: TrustModel,
    pub evidence_format: &'static str,
    /// What this adapter does *not* claim. Kept beside what it does, because a
    /// descriptor that only lists strengths is marketing, not documentation.
    pub not_claimed: &'static [&'static str],
}

/// Raw evidence in, finality attestation out. The whole external surface of a
/// source domain is this one method.
pub trait FinalityAdapter {
    fn descriptor(&self) -> AdapterDescriptor;

    /// Checks the evidence against the adapter's own rules and the caller's
    /// policy. Returns an attestation only when both are satisfied.
    fn verify(
        &self,
        evidence: &RawEvidence,
        policy: &VerificationPolicy,
    ) -> Result<FinalityAttestation, AdapterError>;
}

/// `sha256` over the payload, used as the evidence digest in attestations.
#[must_use]
pub fn evidence_digest(payload: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(payload);
    let digest = hasher.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

pub(crate) fn refuse_mismatch(field: &str, declared: String, derived: String) -> AdapterError {
    AdapterError::DeclaredMismatch {
        field: field.to_string(),
        declared,
        derived,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adapter_id_matches_the_deployed_domain_key() {
        // This value is the adapter id registered on testnet for the admitted
        // source domain (deployments/testnet.json -> adapter_id). If this test
        // fails, the off-chain boundary has stopped agreeing with the chain and
        // would start refusing evidence the contract accepts.
        let deployed = "3dcbf6f582455337083d5f6d36721f6d63d47af0bef870a043c02aca7850dac9";
        let derived = AdapterId::from_name("source-chain-bls-v1");
        assert_eq!(derived.as_hex(), deployed);
        assert_eq!(
            AdapterId::from_name("source-chain-bls-v1"),
            derived,
            "the derivation is stable"
        );
        assert_ne!(
            AdapterId::from_name("source-chain-zk-v1"),
            derived,
            "a different name is a different domain"
        );
    }

    #[test]
    fn attestation_profile_reports_facts_with_units() {
        let attestation = FinalityAttestation {
            adapter_id: AdapterId::from_name("source-chain-bls-v1"),
            adapter_version: 1,
            evidence_version: 1,
            network: "source-testnet".to_string(),
            height: 42,
            state_root: [7u8; 32],
            finalized_at: 42,
            finalized_at_unit: TimeUnit::Height,
            security: SecurityBacking::SignatureSet {
                signers: 3,
                required: 2,
                total_weight: 3,
                slashable: false,
            },
            evidence_digest: [0u8; 32],
            submitter: "G...".to_string(),
        };
        let facts = attestation.profile_facts();
        assert_eq!(facts["terminal"], "height");
        assert_eq!(facts["height"], 42);
        // No score, no rating: a profile is facts plus their units.
        assert!(facts.get("score").is_none());
    }
}
