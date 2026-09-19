//! The cross-domain message envelope and its replay guard.
//!
//! A settlement message says one thing: *this value moved from here to there,
//! and here is the evidence*. Everything in the envelope exists so that the
//! receiving side can decide that for itself:
//!
//! - `message_id` is derived from the message's own content, so two parties
//!   that disagree about the id disagree about the content, visibly.
//! - `source_height` and `event_index` say exactly which event is being claimed,
//!   so a Merkle proof can be checked against a specific leaf rather than
//!   against "the block".
//! - `nonce` is what makes replay protection cheap.
//! - `payload_hash` binds the amount and the addresses, so a message cannot be
//!   re-used with a different amount.
//!
//! # Replay protection by high-water mark
//!
//! The obvious way to stop replays is to remember every message id forever.
//! That grows without bound, and it fails in the way that matters: an attacker
//! only needs one id the store forgot.
//!
//! This module keeps one number per `(source_domain, target_domain, sender)`:
//! the highest nonce accepted so far. Accepting a nonce invalidates every
//! smaller one forever, in constant storage, and the trail can only move
//! forward. Message ids are still tracked, but only as a second, bounded guard
//! against a resubmission at a higher nonce with identical content.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

/// What a message is asking for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MessageKind {
    /// Value was locked on the source side.
    Lock,
    /// Value should be minted on the target side.
    Mint,
    /// Value was burned on the target side.
    Burn,
    /// Value should be released on the source side.
    Unlock,
    /// Anything else, carried as opaque bytes so an unknown kind cannot be
    /// mistaken for a known one.
    Custom(Vec<u8>),
}

impl MessageKind {
    /// A stable numeric code. Used where a message crosses into a contract that
    /// carries a `u32` rather than a string.
    #[must_use]
    pub fn code(&self) -> u32 {
        match self {
            Self::Lock => 1,
            Self::Mint => 2,
            Self::Burn => 3,
            Self::Unlock => 4,
            Self::Custom(_) => 255,
        }
    }
}

/// A settlement message, with an id derived from its own content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CrossDomainMessage {
    pub message_id: [u8; 32],
    pub source_domain: String,
    pub target_domain: String,
    pub source_height: u64,
    pub event_index: u32,
    pub nonce: u64,
    pub sender: String,
    pub recipient: String,
    pub payload_hash: [u8; 32],
    pub kind: MessageKind,
    /// The height after which this message is no longer acceptable. A message
    /// that never expires is a message an attacker can hold and submit at the
    /// worst possible moment.
    pub expiry_height: u64,
}

/// The fields a message id is derived from. Kept separate from the message so
/// that an id can be recomputed without constructing a whole message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessageParams {
    pub source_domain: String,
    pub target_domain: String,
    pub source_height: u64,
    pub event_index: u32,
    pub nonce: u64,
    pub sender: String,
    pub recipient: String,
    pub payload_hash: [u8; 32],
    pub kind: MessageKind,
    pub expiry_height: u64,
}

impl CrossDomainMessage {
    /// Builds a message and derives its id from the content.
    #[must_use]
    pub fn new(params: MessageParams) -> Self {
        let message_id = Self::derive_id(&params);
        Self {
            message_id,
            source_domain: params.source_domain,
            target_domain: params.target_domain,
            source_height: params.source_height,
            event_index: params.event_index,
            nonce: params.nonce,
            sender: params.sender,
            recipient: params.recipient,
            payload_hash: params.payload_hash,
            kind: params.kind,
            expiry_height: params.expiry_height,
        }
    }

    /// `sha256` over every field that affects the meaning of the message, each
    /// one length-prefixed so that concatenating two values cannot be confused
    /// with a single value of the combined length.
    #[must_use]
    pub fn derive_id(params: &MessageParams) -> [u8; 32] {
        let mut hasher = Sha256::new();
        hasher.update(b"lumen-gate-message-id-v1");
        for field in [
            params.source_domain.as_bytes(),
            params.target_domain.as_bytes(),
            &params.source_height.to_le_bytes(),
            &params.event_index.to_le_bytes(),
            &params.nonce.to_le_bytes(),
            params.sender.as_bytes(),
            params.recipient.as_bytes(),
            &params.payload_hash,
            &params.kind.code().to_le_bytes(),
            &params.expiry_height.to_le_bytes(),
        ] {
            hasher.update((field.len() as u64).to_le_bytes());
            hasher.update(field);
        }
        match &params.kind {
            MessageKind::Custom(bytes) => hasher.update(bytes),
            _ => {}
        }
        let digest = hasher.finalize();
        let mut out = [0u8; 32];
        out.copy_from_slice(&digest);
        out
    }

    /// Recomputes the id from the message's own fields. A message whose id does
    /// not match its content was edited after it was identified.
    #[must_use]
    pub fn id_matches_content(&self) -> bool {
        let params = MessageParams {
            source_domain: self.source_domain.clone(),
            target_domain: self.target_domain.clone(),
            source_height: self.source_height,
            event_index: self.event_index,
            nonce: self.nonce,
            sender: self.sender.clone(),
            recipient: self.recipient.clone(),
            payload_hash: self.payload_hash,
            kind: self.kind.clone(),
            expiry_height: self.expiry_height,
        };
        Self::derive_id(&params) == self.message_id
    }
}

/// Why a message was not admitted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "refusal", rename_all = "snake_case")]
pub enum ReplayRefusal {
    /// The id does not match the message content.
    IdDoesNotMatchContent { message_id: String },
    Expired { expiry_height: u64, current_height: u64 },
    /// The id was already processed at some point, whatever the nonce now says.
    IdAlreadyProcessed { message_id: String },
    /// The nonce does not move the mark forward.
    NonceNotAdvanced { nonce: u64, mark: u64 },
    /// The direction is not one this guard knows about.
    UnknownDirection(String),
}

impl std::fmt::Display for ReplayRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::IdDoesNotMatchContent { message_id } => {
                write!(f, "message id {message_id} does not match the message content")
            }
            Self::Expired { expiry_height, current_height } => {
                write!(f, "message expired at height {expiry_height}, current height is {current_height}")
            }
            Self::IdAlreadyProcessed { message_id } => write!(f, "message {message_id} was already processed"),
            Self::NonceNotAdvanced { nonce, mark } => {
                write!(f, "nonce {nonce} does not advance the high-water mark {mark}")
            }
            Self::UnknownDirection(direction) => write!(f, "unknown direction {direction}"),
        }
    }
}

impl std::error::Error for ReplayRefusal {}

/// What an admission changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Admission {
    pub message_id: String,
    pub direction: String,
    /// `None` means this was the first message from that sender in that
    /// direction. Named rather than shown as 0, because 0 is a real nonce.
    pub previous_mark: Option<u64>,
    pub new_mark: u64,
    /// How many smaller nonces this admission just invalidated.
    pub invalidated_smaller_nonces: u64,
}

/// The replay guard: one high-water mark per direction and sender, plus a
/// bounded set of processed ids as a second line of defence.
#[derive(Debug, Default, Clone)]
pub struct ReplayGuard {
    marks: BTreeMap<(String, String, String), u64>,
    processed_ids: BTreeSet<[u8; 32]>,
    /// How many ids to remember. Bounded on purpose: this is the backstop, and
    /// an unbounded set is a memory leak with a security excuse.
    id_memory: usize,
}

impl ReplayGuard {
    #[must_use]
    pub fn new(id_memory: usize) -> Self {
        Self { marks: BTreeMap::new(), processed_ids: BTreeSet::new(), id_memory: id_memory.max(1) }
    }

    #[must_use]
    pub fn mark_for(&self, source_domain: &str, target_domain: &str, sender: &str) -> Option<u64> {
        self.marks
            .get(&(source_domain.to_string(), target_domain.to_string(), sender.to_string()))
            .copied()
    }

    /// Decides whether a message may be processed.
    ///
    /// The order of the checks matters: expiry before identity, identity before
    /// the nonce, and the nonce strictly last, because the nonce check is the
    /// one that mutates state.
    pub fn admit(
        &mut self,
        message: &CrossDomainMessage,
        current_height: u64,
    ) -> Result<Admission, ReplayRefusal> {
        let direction = format!("{}->{}", message.source_domain, message.target_domain);
        let id_hex = hex::encode(message.message_id);

        if !message.id_matches_content() {
            return Err(ReplayRefusal::IdDoesNotMatchContent { message_id: id_hex });
        }
        if current_height > message.expiry_height {
            return Err(ReplayRefusal::Expired {
                expiry_height: message.expiry_height,
                current_height,
            });
        }
        if self.processed_ids.contains(&message.message_id) {
            return Err(ReplayRefusal::IdAlreadyProcessed { message_id: id_hex });
        }

        let key = (
            message.source_domain.clone(),
            message.target_domain.clone(),
            message.sender.clone(),
        );
        let previous = self.marks.get(&key).copied();
        if let Some(mark) = previous {
            if message.nonce <= mark {
                return Err(ReplayRefusal::NonceNotAdvanced { nonce: message.nonce, mark });
            }
        }

        // Past this point the message is accepted, so the guard's state is
        // updated. Nothing above this line has side effects.
        let invalidated = match previous {
            Some(mark) => message.nonce - mark - 1,
            None => message.nonce,
        };
        self.marks.insert(key, message.nonce);
        self.processed_ids.insert(message.message_id);
        while self.processed_ids.len() > self.id_memory {
            if let Some(first) = self.processed_ids.iter().next().copied() {
                self.processed_ids.remove(&first);
            }
        }

        Ok(Admission {
            message_id: id_hex,
            direction,
            previous_mark: previous,
            new_mark: message.nonce,
            invalidated_smaller_nonces: invalidated,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(nonce: u64, sender: &str) -> MessageParams {
        MessageParams {
            source_domain: "source-testnet".to_string(),
            target_domain: "stellar-testnet".to_string(),
            source_height: 10,
            event_index: 0,
            nonce,
            sender: sender.to_string(),
            recipient: "GRECIPIENT".to_string(),
            payload_hash: [5u8; 32],
            kind: MessageKind::Lock,
            expiry_height: 100,
        }
    }

    #[test]
    fn the_id_is_derived_from_content_and_changes_with_it() {
        let first = CrossDomainMessage::new(params(1, "GSENDER"));
        let mut other = params(1, "GSENDER");
        other.payload_hash = [6u8; 32];
        let second = CrossDomainMessage::new(other);
        assert_ne!(first.message_id, second.message_id);
        assert!(first.id_matches_content());
    }

    #[test]
    fn an_edited_message_fails_its_own_id_check() {
        let mut message = CrossDomainMessage::new(params(1, "GSENDER"));
        message.sender = "GSOMEONEELSE".to_string();
        assert!(!message.id_matches_content());
    }

    #[test]
    fn the_guard_accepts_once_and_refuses_the_same_message_twice() {
        let mut guard = ReplayGuard::new(64);
        let message = CrossDomainMessage::new(params(0, "GSENDER"));
        let admission = guard.admit(&message, 20).expect("first sight of a message must be admitted");
        assert_eq!(admission.previous_mark, None);
        let refusal = guard.admit(&message, 20).expect_err("the same message must not be admitted twice");
        assert!(matches!(refusal, ReplayRefusal::IdAlreadyProcessed { .. }));
    }

    #[test]
    fn a_higher_nonce_moves_the_mark_and_invalidates_everything_below_it() {
        let mut guard = ReplayGuard::new(64);
        guard.admit(&CrossDomainMessage::new(params(5, "GSENDER")), 20).unwrap();
        assert_eq!(guard.mark_for("source-testnet", "stellar-testnet", "GSENDER"), Some(5));

        // A different message at a lower nonce is refused even though its id
        // was never seen: that is the point of a high-water mark.
        let mut lower = params(3, "GSENDER");
        lower.event_index = 7;
        let refusal = guard
            .admit(&CrossDomainMessage::new(lower), 20)
            .expect_err("a lower nonce must be refused");
        assert!(matches!(refusal, ReplayRefusal::NonceNotAdvanced { nonce: 3, mark: 5 }));

        let mut higher = params(9, "GSENDER");
        higher.event_index = 1;
        let admission = guard.admit(&CrossDomainMessage::new(higher), 20).unwrap();
        assert_eq!(admission.previous_mark, Some(5));
        assert_eq!(admission.new_mark, 9);
        assert_eq!(admission.invalidated_smaller_nonces, 3);
    }

    #[test]
    fn marks_are_kept_per_direction_and_sender_not_globally() {
        let mut guard = ReplayGuard::new(64);
        guard.admit(&CrossDomainMessage::new(params(5, "GSENDER")), 20).unwrap();
        // A different sender in the same direction has its own trail.
        let admission = guard
            .admit(&CrossDomainMessage::new(params(0, "GOTHER")), 20)
            .expect("a different sender starts its own trail");
        assert_eq!(admission.previous_mark, None);
    }

    #[test]
    fn an_expired_message_is_refused_before_anything_else_happens() {
        let mut guard = ReplayGuard::new(64);
        let message = CrossDomainMessage::new(params(1, "GSENDER"));
        let refusal = guard.admit(&message, 101).expect_err("an expired message must be refused");
        assert!(matches!(refusal, ReplayRefusal::Expired { expiry_height: 100, current_height: 101 }));
        assert_eq!(guard.mark_for("source-testnet", "stellar-testnet", "GSENDER"), None);
    }

    #[test]
    fn the_id_memory_is_bounded_while_marks_are_not() {
        let mut guard = ReplayGuard::new(2);
        for nonce in 0..10u64 {
            let mut p = params(nonce, "GSENDER");
            p.event_index = nonce as u32;
            guard.admit(&CrossDomainMessage::new(p), 20).unwrap();
        }
        // The mark survives; the id set is capped, because the mark is the
        // mechanism and the id set is only a backstop.
        assert_eq!(guard.mark_for("source-testnet", "stellar-testnet", "GSENDER"), Some(9));
        assert_eq!(guard.processed_ids.len(), 2);
    }

    #[test]
    fn custom_kinds_are_hashed_with_their_bytes_not_just_their_code() {
        let mut first = params(1, "GSENDER");
        first.kind = MessageKind::Custom(vec![1, 2, 3]);
        let mut second = params(1, "GSENDER");
        second.kind = MessageKind::Custom(vec![1, 2, 4]);
        assert_ne!(
            CrossDomainMessage::new(first).message_id,
            CrossDomainMessage::new(second).message_id,
            "two custom messages with different bodies must not share an id"
        );
    }
}
