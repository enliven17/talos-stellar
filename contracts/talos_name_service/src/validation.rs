//! Name validation and canonicalization for Talos names.
//!
//! Rules:
//! - 3-32 characters
//! - Lowercase alphanumeric + hyphens only
//! - No consecutive hyphens
//! - No leading or trailing hyphens
//! - Canonicalization: trim whitespace + lowercase

use soroban_sdk::{Env, String};

/// Validate a name according to Talos naming rules.
///
/// Rules:
/// - Length: 3-32 characters
/// - Characters: lowercase alphanumeric (a-z, 0-9) and hyphens (-)
/// - No consecutive hyphens
/// - No leading or trailing hyphens
pub fn validate_name(name: &String) -> bool {
    let len = name.len();
    if len < 3 || len > 32 {
        return false;
    }

    // Stack-allocate a buffer since max length is 32 (no_std safe)
    let mut buf = [0u8; 32];
    name.copy_into_slice(&mut buf[..len as usize]);

    if buf[0] == b'-' || buf[(len - 1) as usize] == b'-' {
        return false;
    }

    let mut prev_hyphen = false;
    for i in 0..len as usize {
        let b = buf[i];
        if b.is_ascii_lowercase() || b.is_ascii_digit() {
            prev_hyphen = false;
        } else if b == b'-' {
            if prev_hyphen {
                return false;
            }
            prev_hyphen = true;
        } else {
            return false;
        }
    }

    true
}

/// Canonicalize a caller-supplied name before validation and storage.
///
/// Canonicalization rules (applied left-to-right, in order):
///   1. **Trim** leading and trailing ASCII whitespace (space U+0020, tab U+0009,
///      newline U+000A, carriage-return U+000D).
///   2. **Lowercase** any ASCII uppercase letters (A-Z → a-z).
///
/// After canonicalization the result is a valid candidate for `validate_name`.
/// Callers that pass an already-lowercase, no-whitespace name observe no change.
///
/// # Panics
/// Panics with `"Name cannot be empty after canonicalization"` if the input is
/// all whitespace or empty — a privacy-safe error with no caller-supplied value.
///
/// # no_std compatibility
/// Operates entirely on a 64-byte stack buffer (max name byte length after
/// trim is bounded at 32; input is capped at 64 bytes to absorb leading/trailing
/// whitespace without heap allocation).
pub fn canonicalize_name(env: &Env, name: &String) -> String {
    let raw_len = name.len() as usize;
    // Allocate a buffer large enough for the raw input plus whitespace slack.
    // Names are bounded at 32 bytes; with up to 16 bytes of surrounding whitespace
    // the raw input is at most 64 bytes before we even look at it.
    const BUF: usize = 64;
    if raw_len > BUF {
        panic!("Name exceeds maximum input length for canonicalization");
    }
    let mut buf = [0u8; BUF];
    name.copy_into_slice(&mut buf[..raw_len]);

    // Step 1: find trim boundaries (ASCII whitespace only)
    let mut start = 0usize;
    let mut end = raw_len;
    while start < end && matches!(buf[start], b' ' | b'\t' | b'\n' | b'\r') {
        start += 1;
    }
    while end > start && matches!(buf[end - 1], b' ' | b'\t' | b'\n' | b'\r') {
        end -= 1;
    }

    if start == end {
        panic!("Name cannot be empty after canonicalization");
    }

    // Step 2: lowercase in-place
    let mut out = [0u8; 32];
    let trimmed_len = end - start;
    if trimmed_len > 32 {
        panic!("Name exceeds maximum byte length after canonicalization");
    }
    for (i, b) in buf[start..end].iter().enumerate() {
        out[i] = b.to_ascii_lowercase();
    }

    String::from_bytes(env, &out[..trimmed_len])
}
