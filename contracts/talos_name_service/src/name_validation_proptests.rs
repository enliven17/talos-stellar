//! Property tests for name canonicalisation and validation (issue #1006).
//!
//! The rules under test (`canonicalize_name`, `validate_name`):
//!
//! * `canonicalize_name` trims ASCII whitespace (space, tab, line feed,
//!   carriage return) and lowercases ASCII `A-Z`. It panics, with a fixed
//!   message, when the input is longer than 64 bytes, when nothing is left
//!   after trimming, or when more than 32 bytes are left.
//! * `validate_name` accepts 3 to 32 bytes of `a-z`, `0-9` and `-`, with no
//!   leading, trailing or consecutive hyphen.
//!
//! Each property is checked against an independent reference written here
//! from that description alone, so the tests compare two implementations
//! instead of the contract against itself.
//!
//! Every suite uses a fixed seed and no failure-persistence file, so a run is
//! reproducible on any machine and in CI. When a property fails, proptest
//! prints the shrunk input; the matching example belongs in the deterministic
//! tests at the bottom of this file.

extern crate std;

use super::*;
use proptest::{
    collection::vec,
    prelude::*,
    test_runner::{Config, RngAlgorithm, TestRng, TestRunner},
};
use soroban_sdk::{testutils::Address as _, Address, Env, String};
use std::{
    boxed::Box,
    panic::{catch_unwind, AssertUnwindSafe},
    string::String as StdString,
    vec::Vec,
};

/// Seed for every suite below. Changing it changes the generated inputs, so it
/// is a constant and not derived from the clock.
const SEED: [u8; 32] = *b"talos-name-service-fuzz-seed-v01";

const MSG_TOO_LONG_INPUT: &str = "Name exceeds maximum input length for canonicalization";
const MSG_EMPTY: &str = "Name cannot be empty after canonicalization";
const MSG_TOO_LONG_TRIMMED: &str = "Name exceeds maximum byte length after canonicalization";
const MSG_INVALID: &str =
    "Invalid name. Must be 3-32 chars, lowercase alphanumeric + hyphens, no consecutive hyphens.";

/// Every message `register_name` may fail with for a malformed name.
const DOCUMENTED_NAME_MESSAGES: [&str; 4] = [
    MSG_TOO_LONG_INPUT,
    MSG_EMPTY,
    MSG_TOO_LONG_TRIMMED,
    MSG_INVALID,
];

fn runner(cases: u32) -> TestRunner {
    TestRunner::new_with_rng(
        Config {
            cases,
            failure_persistence: None,
            ..Config::default()
        },
        TestRng::from_seed(RngAlgorithm::ChaCha, &SEED),
    )
}

// ── Independent reference ───────────────────────────────────────────

fn is_ws(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r')
}

/// The documented outcome of canonicalising `raw`.
#[derive(Debug, PartialEq, Eq, Clone)]
enum Canon {
    Ok(Vec<u8>),
    Panics(&'static str),
}

fn reference_canonicalize(raw: &[u8]) -> Canon {
    if raw.len() > 64 {
        return Canon::Panics(MSG_TOO_LONG_INPUT);
    }
    let start = raw.iter().position(|&b| !is_ws(b));
    let Some(start) = start else {
        return Canon::Panics(MSG_EMPTY);
    };
    let end = raw.iter().rposition(|&b| !is_ws(b)).unwrap() + 1;
    let trimmed = &raw[start..end];
    if trimmed.len() > 32 {
        return Canon::Panics(MSG_TOO_LONG_TRIMMED);
    }
    Canon::Ok(trimmed.iter().map(|b| b.to_ascii_lowercase()).collect())
}

fn reference_is_valid(name: &[u8]) -> bool {
    if name.len() < 3 || name.len() > 32 {
        return false;
    }
    if name[0] == b'-' || name[name.len() - 1] == b'-' {
        return false;
    }
    if name.windows(2).any(|w| w == b"--") {
        return false;
    }
    name.iter()
        .all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

// ── Helpers over the contract ───────────────────────────────────────

fn soroban(env: &Env, bytes: &[u8]) -> String {
    String::from_bytes(env, bytes)
}

fn bytes_of(s: &String) -> Vec<u8> {
    let mut out = std::vec![0u8; s.len() as usize];
    s.copy_into_slice(&mut out);
    out
}

fn panic_message(payload: Box<dyn std::any::Any + Send>) -> StdString {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).into()
    } else if let Some(s) = payload.downcast_ref::<StdString>() {
        s.clone()
    } else {
        "<non-string panic payload>".into()
    }
}

/// Runs `canonicalize_name` and reports the outcome in the reference's terms.
fn actual_canonicalize(env: &Env, raw: &[u8]) -> Canon {
    let input = soroban(env, raw);
    match catch_unwind(AssertUnwindSafe(|| canonicalize_name(env, &input))) {
        Ok(out) => Canon::Ok(bytes_of(&out)),
        Err(payload) => {
            let message = panic_message(payload);
            let known = [MSG_TOO_LONG_INPUT, MSG_EMPTY, MSG_TOO_LONG_TRIMMED]
                .into_iter()
                .find(|m| *m == message)
                .unwrap_or_else(|| {
                    panic!("canonicalize_name panicked with an unrelated message: {message:?}")
                });
            Canon::Panics(known)
        }
    }
}

// ── Input strategies ────────────────────────────────────────────────

/// A name the rules accept: 3 to 32 bytes, no leading, trailing or doubled hyphen.
fn valid_name() -> impl Strategy<Value = StdString> {
    // Alphanumeric runs joined by single hyphens, then clipped to length.
    (prop::collection::vec("[a-z0-9]{1,8}", 1..=8), any::<bool>()).prop_filter_map(
        "valid length",
        |(parts, _)| {
            let joined = parts.join("-");
            if (3..=32).contains(&joined.len()) {
                Some(joined)
            } else if joined.len() > 32 {
                let clipped = StdString::from(joined[..32].trim_end_matches('-'));
                (clipped.len() >= 3).then_some(clipped)
            } else {
                None
            }
        },
    )
}

/// A valid name of exactly `len` bytes, for the boundary lengths.
fn valid_name_of_len(len: usize) -> impl Strategy<Value = StdString> {
    vec("[a-z0-9]", len).prop_map(|chars| chars.concat())
}

/// Random ASCII case for each letter of `name`, driven by `flips`.
fn mixed_case(name: &str, flips: &[bool]) -> StdString {
    name.chars()
        .enumerate()
        .map(|(i, c)| {
            if flips.get(i).copied().unwrap_or(false) {
                c.to_ascii_uppercase()
            } else {
                c
            }
        })
        .collect()
}

fn whitespace_run(max: usize) -> impl Strategy<Value = StdString> {
    vec(
        prop::sample::select(std::vec![' ', '\t', '\n', '\r']),
        0..=max,
    )
    .prop_map(|chars| chars.into_iter().collect())
}

/// Arbitrary bytes, including everything Soroban's `String` allows: it does
/// not require UTF-8, so non-UTF-8 byte sequences are legal inputs.
fn arbitrary_bytes(max: usize) -> impl Strategy<Value = Vec<u8>> {
    vec(any::<u8>(), 0..=max)
}

/// Bytes drawn from the characters the rules care about, so the interesting
/// boundaries (whitespace, hyphens, case, digits) are hit far more often than
/// uniform random bytes would hit them.
fn rule_alphabet_bytes(max: usize) -> impl Strategy<Value = Vec<u8>> {
    vec(
        prop::sample::select(std::vec![
            b' ', b'\t', b'\n', b'\r', b'-', b'-', b'a', b'z', b'A', b'Z', b'0', b'9', b'_', b'.',
            0x0b, 0x0c, 0x00, 0xc3, 0xa9, 0xff,
        ]),
        0..=max,
    )
}

/// UTF-8 text with multi-byte characters (2, 3 and 4 bytes each).
fn multibyte_text(max_chars: usize) -> impl Strategy<Value = Vec<u8>> {
    vec(
        prop::sample::select(std::vec![
            'a', 'b', '1', '-', ' ', 'é', 'ß', 'я', '中', '名', '😀', '🚀'
        ]),
        0..=max_chars,
    )
    .prop_map(|chars| chars.into_iter().collect::<StdString>().into_bytes())
}

/// Any of the families above, so one suite covers all of them.
fn any_input() -> impl Strategy<Value = Vec<u8>> {
    prop_oneof![
        arbitrary_bytes(80),
        rule_alphabet_bytes(80),
        multibyte_text(24),
        valid_name().prop_map(StdString::into_bytes),
        (valid_name(), whitespace_run(20), whitespace_run(20))
            .prop_map(|(n, a, b)| std::format!("{a}{n}{b}").into_bytes()),
    ]
}

// ── Properties ──────────────────────────────────────────────────────

#[test]
fn canonicalize_matches_the_reference_for_every_input() {
    let env = Env::default();
    runner(1024)
        .run(&any_input(), |raw| {
            prop_assert_eq!(
                actual_canonicalize(&env, &raw),
                reference_canonicalize(&raw)
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn canonicalize_is_idempotent() {
    let env = Env::default();
    runner(1024)
        .run(&any_input(), |raw| {
            if let Canon::Ok(once) = actual_canonicalize(&env, &raw) {
                // The output is itself a valid input, and canonicalising it
                // again changes nothing.
                prop_assert_eq!(actual_canonicalize(&env, &once), Canon::Ok(once.clone()));
            }
            Ok(())
        })
        .unwrap();
}

#[test]
fn canonicalize_output_has_no_edge_whitespace_and_no_uppercase() {
    let env = Env::default();
    runner(1024)
        .run(&any_input(), |raw| {
            if let Canon::Ok(out) = actual_canonicalize(&env, &raw) {
                prop_assert!(!out.is_empty() && out.len() <= 32);
                prop_assert!(!is_ws(out[0]) && !is_ws(out[out.len() - 1]));
                prop_assert!(!out.iter().any(u8::is_ascii_uppercase));
                // Everything that is not an ASCII letter survives untouched,
                // including multi-byte sequences.
                let lower_raw: Vec<u8> = raw.iter().map(|b| b.to_ascii_lowercase()).collect();
                prop_assert!(
                    lower_raw.windows(out.len()).any(|w| w == out.as_slice()),
                    "output must be a contiguous slice of the lowercased input"
                );
            }
            Ok(())
        })
        .unwrap();
}

#[test]
fn validate_name_matches_the_reference_and_never_panics() {
    let env = Env::default();
    runner(2048)
        .run(&any_input(), |bytes| {
            let input = soroban(&env, &bytes);
            let actual = catch_unwind(AssertUnwindSafe(|| validate_name(&input)))
                .expect("validate_name must never panic");
            prop_assert_eq!(actual, reference_is_valid(&bytes));
            Ok(())
        })
        .unwrap();
}

#[test]
fn every_generated_valid_name_passes_validation() {
    let env = Env::default();
    runner(1024)
        .run(&valid_name(), |name| {
            prop_assert!(reference_is_valid(name.as_bytes()));
            prop_assert!(validate_name(&soroban(&env, name.as_bytes())));
            Ok(())
        })
        .unwrap();
}

#[test]
fn decorated_valid_names_canonicalise_to_the_core_and_pass_validation() {
    let env = Env::default();
    let strategy = (
        valid_name(),
        whitespace_run(16),
        whitespace_run(16),
        vec(any::<bool>(), 32),
    );
    runner(1024)
        .run(&strategy, |(core, lead, trail, flips)| {
            let decorated = std::format!("{lead}{}{trail}", mixed_case(&core, &flips));
            // 32 + 16 + 16 is the most this strategy builds, which is exactly
            // the 64-byte input limit.
            let canonical = canonicalize_name(&env, &soroban(&env, decorated.as_bytes()));
            prop_assert_eq!(bytes_of(&canonical), core.clone().into_bytes());
            prop_assert!(validate_name(&canonical));
            Ok(())
        })
        .unwrap();
}

#[test]
fn names_of_every_boundary_length_are_accepted_or_rejected_by_length_alone() {
    let env = Env::default();
    for len in [1usize, 2, 3, 4, 31, 32, 33, 40, 64, 65] {
        runner(64)
            .run(&valid_name_of_len(len), |name| {
                let expected = (3..=32).contains(&len);
                prop_assert_eq!(validate_name(&soroban(&env, name.as_bytes())), expected);
                Ok(())
            })
            .unwrap();
    }
}

#[test]
fn hyphen_placement_decides_validity() {
    let env = Env::default();
    // 3 to 10 characters from {a, 1, -}: dense in hyphen edge cases.
    let strategy = vec(prop::sample::select(std::vec![b'a', b'1', b'-']), 3..=10);
    runner(2048)
        .run(&strategy, |bytes| {
            let expected = bytes[0] != b'-'
                && bytes[bytes.len() - 1] != b'-'
                && !bytes.windows(2).any(|w| w == b"--");
            prop_assert_eq!(validate_name(&soroban(&env, &bytes)), expected);
            Ok(())
        })
        .unwrap();
}

#[test]
fn multibyte_text_is_never_a_valid_name() {
    let env = Env::default();
    let strategy = vec(
        prop::sample::select(std::vec!['é', 'ß', 'я', '中', '名', '😀', '🚀']),
        1..=8,
    )
    .prop_map(|chars| chars.into_iter().collect::<StdString>());
    runner(512)
        .run(&strategy, |text| {
            // Even when the byte length falls inside 3..=32 the bytes are not
            // ASCII, so validation must reject them.
            let bytes = text.as_bytes();
            prop_assert!(!validate_name(&soroban(&env, bytes)));
            // Mixed with valid characters the result is still rejected.
            let mixed = std::format!("ab{text}cd");
            prop_assert!(!validate_name(&soroban(&env, mixed.as_bytes())));
            Ok(())
        })
        .unwrap();
}

// ── Public entry points ─────────────────────────────────────────────

fn client_env() -> (Env, TalosNameServiceClient<'static>, Address) {
    let env = Env::default();
    let registry = env.register_contract(None, talos_registry::TalosRegistry);
    let admin = Address::generate(&env);
    let id = env.register_contract(None, TalosNameService);
    let client = TalosNameServiceClient::new(&env, &id);
    client.initialize(&registry, &admin, &0i128);
    (env, client, id)
}

/// A name that is not registered is available exactly when it is valid after
/// canonicalisation, and asking never fails, whatever the bytes are.
#[test]
fn is_name_available_never_panics_and_agrees_with_the_rules() {
    let (env, client, _) = client_env();
    runner(512)
        .run(&any_input(), |raw| {
            let input = soroban(&env, &raw);
            let answer = client.is_name_available(&input);
            let expected = match reference_canonicalize(&raw) {
                Canon::Ok(canonical) => reference_is_valid(&canonical),
                Canon::Panics(_) => false,
            };
            prop_assert_eq!(answer, expected, "input bytes: {:?}", raw);
            Ok(())
        })
        .unwrap();
}

/// Nothing is registered, so every lookup is "not found" and never an error.
#[test]
fn resolve_name_never_panics_for_any_input() {
    let (env, client, _) = client_env();
    runner(512)
        .run(&any_input(), |raw| {
            prop_assert_eq!(client.resolve_name(&soroban(&env, &raw)), None);
            Ok(())
        })
        .unwrap();
}

/// A malformed name given to `register_name` is rejected with one of the
/// messages the contract documents, never with an unrelated panic.
#[test]
fn register_name_rejects_malformed_names_with_a_documented_message() {
    let strategy =
        any_input().prop_filter("malformed only", |raw| match reference_canonicalize(raw) {
            Canon::Ok(canonical) => !reference_is_valid(&canonical),
            Canon::Panics(_) => true,
        });
    runner(256)
        .run(&strategy, |raw| {
            // A panic caught inside `as_contract` leaves its frame on the host's
            // call stack, so a shared environment would hit the host's depth
            // limit after a few dozen cases. Each case therefore gets its own.
            let (env, _client, id) = client_env();
            env.mock_all_auths();
            let owner = Address::generate(&env);
            let input = soroban(&env, &raw);
            let outcome = catch_unwind(AssertUnwindSafe(|| {
                env.as_contract(&id, || {
                    TalosNameService::register_name(env.clone(), owner.clone(), 1, input.clone())
                })
            }));
            let payload = match outcome {
                Ok(()) => {
                    return Err(TestCaseError::fail(std::format!(
                        "register_name accepted a malformed name: {raw:?}"
                    )))
                }
                Err(payload) => payload,
            };
            let message = panic_message(payload);
            prop_assert!(
                DOCUMENTED_NAME_MESSAGES.contains(&message.as_str()),
                "unrelated panic {message:?} for input {raw:?}"
            );
            // The documented message also has to be the right one.
            let expected = match reference_canonicalize(&raw) {
                Canon::Panics(m) => m,
                Canon::Ok(_) => MSG_INVALID,
            };
            prop_assert_eq!(message.as_str(), expected);
            Ok(())
        })
        .unwrap();
}

// ── Deterministic examples ──────────────────────────────────────────
//
// Fixed inputs for the boundaries the properties explore, so a failure here
// is readable without reading generated data, and so each fixed bug has a
// regression test that does not depend on the seed.

fn names(env: &Env, raw: &[u8]) -> String {
    soroban(env, raw)
}

#[test]
fn length_boundaries() {
    let env = Env::default();
    assert!(!validate_name(&names(&env, b"ab")));
    assert!(validate_name(&names(&env, b"abc")));
    assert!(validate_name(&names(&env, &[b'a'; 32])));
    assert!(!validate_name(&names(&env, &[b'a'; 33])));
    assert!(!validate_name(&names(&env, b"")));
}

#[test]
fn multibyte_names_are_rejected_even_inside_the_length_window() {
    let env = Env::default();
    // "éa" is 3 bytes, "名名名" is 9, eight emoji are exactly 32.
    assert!(!validate_name(&names(&env, "éa".as_bytes())));
    assert!(!validate_name(&names(&env, "名名名".as_bytes())));
    assert!(!validate_name(&names(&env, "😀😀😀😀😀😀😀😀".as_bytes())));
    assert_eq!("😀😀😀😀😀😀😀😀".len(), 32);
}

#[test]
fn non_utf8_bytes_are_rejected_without_panicking() {
    let env = Env::default();
    assert!(!validate_name(&names(&env, &[0xff, 0xfe, 0xfd])));
    assert!(!validate_name(&names(&env, &[b'a', 0x00, b'b'])));
}

#[test]
fn canonicalize_is_a_no_op_on_a_canonical_maximum_length_name() {
    let env = Env::default();
    let name = [b'a'; 32];
    assert_eq!(
        actual_canonicalize(&env, &name),
        Canon::Ok(name.to_vec()),
        "a 32-byte canonical name must pass through unchanged"
    );
}

#[test]
fn canonicalize_trims_up_to_the_64_byte_input_limit() {
    let env = Env::default();
    // 16 bytes of whitespace on each side of a 32-byte name is exactly 64.
    let mut raw = std::vec![b' '; 16];
    raw.extend_from_slice(&[b'A'; 32]);
    raw.extend_from_slice(&[b'\t'; 16]);
    assert_eq!(raw.len(), 64);
    assert_eq!(
        actual_canonicalize(&env, &raw),
        Canon::Ok(std::vec![b'a'; 32])
    );
    // One more byte tips it over.
    raw.push(b' ');
    assert_eq!(
        actual_canonicalize(&env, &raw),
        Canon::Panics(MSG_TOO_LONG_INPUT)
    );
}

#[test]
fn canonicalize_rejects_a_33_byte_core_and_an_empty_core() {
    let env = Env::default();
    assert_eq!(
        actual_canonicalize(&env, &[b'a'; 33]),
        Canon::Panics(MSG_TOO_LONG_TRIMMED)
    );
    assert_eq!(actual_canonicalize(&env, b""), Canon::Panics(MSG_EMPTY));
    assert_eq!(
        actual_canonicalize(&env, b" \t\r\n "),
        Canon::Panics(MSG_EMPTY)
    );
}

#[test]
fn only_four_ascii_whitespace_bytes_are_trimmed() {
    let env = Env::default();
    // Vertical tab and form feed are whitespace in some definitions but are
    // not in this contract's, so they stay and make the name invalid.
    assert_eq!(
        actual_canonicalize(&env, b"\x0babc\x0c"),
        Canon::Ok(b"\x0babc\x0c".to_vec())
    );
    assert!(!validate_name(&names(&env, b"\x0babc\x0c")));
}

#[test]
fn hyphen_edge_positions() {
    let env = Env::default();
    for (name, valid) in [
        (&b"a-b"[..], true),
        (b"a-b-c", true),
        (b"-ab", false),
        (b"ab-", false),
        (b"a--b", false),
        (b"---", false),
        (b"a-", false),
        (b"1-1", true),
    ] {
        assert_eq!(validate_name(&names(&env, name)), valid, "{name:?}");
    }
}

// Regression tests for the read paths. `canonicalize_name` panics for input
// that cannot be a name, which is right for `register_name` and `canonicalize`
// but turned two read-only calls into failures: `is_name_available` is
// documented to answer `false` for an invalid name, and `resolve_name` to
// answer `None` for a name that does not exist.

#[test]
fn is_name_available_answers_false_for_input_that_cannot_be_canonicalised() {
    let (env, client, _) = client_env();
    assert!(!client.is_name_available(&names(&env, b"")));
    assert!(!client.is_name_available(&names(&env, b"   \t\n")));
    assert!(!client.is_name_available(&names(&env, &[b'a'; 33])));
    assert!(!client.is_name_available(&names(&env, &[b'a'; 64])));
    assert!(!client.is_name_available(&names(&env, &[b'a'; 65])));
    // Still true for a valid, unregistered name.
    assert!(client.is_name_available(&names(&env, b"  Vega  ")));
}

#[test]
fn resolve_name_answers_none_for_input_that_cannot_be_canonicalised() {
    let (env, client, _) = client_env();
    assert_eq!(client.resolve_name(&names(&env, b"")), None);
    assert_eq!(client.resolve_name(&names(&env, b"   \t\n")), None);
    assert_eq!(client.resolve_name(&names(&env, &[b'a'; 33])), None);
    assert_eq!(client.resolve_name(&names(&env, &[b'a'; 65])), None);
}

#[test]
fn canonicalize_and_register_still_reject_those_inputs_loudly() {
    let (env, client, id) = client_env();
    env.mock_all_auths();
    // The public `canonicalize` entry point keeps its documented panics.
    assert!(client.try_canonicalize(&names(&env, b"")).is_err());
    assert!(client.try_canonicalize(&names(&env, &[b'a'; 33])).is_err());
    assert!(client.try_canonicalize(&names(&env, &[b'a'; 65])).is_err());
    // And registering a too-long name is still refused.
    let owner = Address::generate(&env);
    let refused = catch_unwind(AssertUnwindSafe(|| {
        env.as_contract(&id, || {
            TalosNameService::register_name(env.clone(), owner.clone(), 1, names(&env, &[b'a'; 33]))
        })
    }));
    assert!(refused.is_err());
}
