//! Registry schema fixtures parser.
//!
//! Validates that synthetic JSON fixtures for each supported `schema_version`
//! parse against current `#[contracttype]` structs without a live network.
//!
//! Additive fields (e.g. `metadata`) are modelled as `Option<T>` with `default`
//! so old fixtures (no key) map to `None` and new fixtures map to `Some`.

#[cfg(not(target_arch = "wasm32"))]
extern crate std;

#[cfg(not(target_arch = "wasm32"))]
use std::string::String as StdString;
#[cfg(not(target_arch = "wasm32"))]
use std::vec::Vec as StdVec;
#[cfg(not(target_arch = "wasm32"))]
use std::format;
#[cfg(not(target_arch = "wasm32"))]
use std::string::ToString;

// --- Error type with actionable hints -----------------------------------

#[cfg(not(target_arch = "wasm32"))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FixtureError {
    MissingField { field: StdString, file: StdString },
    TypeMismatch { field: StdString, expected: StdString, got: StdString, file: StdString },
    InvalidValue { field: StdString, reason: StdString, file: StdString },
    UnknownVersion { version: u32, file: StdString },
    JsonParse { msg: StdString, file: StdString },
}

#[cfg(not(target_arch = "wasm32"))]
impl std::fmt::Display for FixtureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FixtureError::MissingField { field, file } => write!(
                f,
                "fixture '{}' missing required field '{}' – regen: pnpm fixtures:gen (or cargo run -p registry-fixture-gen)",
                file, field
            ),
            FixtureError::TypeMismatch { field, expected, got, file } => write!(
                f,
                "fixture '{}' field '{}': expected {}, got {} – regen: pnpm fixtures:gen",
                file, field, expected, got
            ),
            FixtureError::InvalidValue { field, reason, file } => write!(
                f,
                "fixture '{}' field '{}' invalid: {} – regen: pnpm fixtures:gen",
                file, field, reason
            ),
            FixtureError::UnknownVersion { version, file } => write!(
                f,
                "fixture '{}' has unsupported schema_version {} – update schema_versions.json and regen: pnpm fixtures:gen",
                file, version
            ),
            FixtureError::JsonParse { msg, file } => write!(
                f,
                "fixture '{}' JSON parse failed: {} – regen: pnpm fixtures:gen; ensure JSON is truncated? check 'value' is object",
                file, msg
            ),
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl std::error::Error for FixtureError {}

// --- Fixture structs (serde mirrors of contracttypes) --------------------

#[cfg(not(target_arch = "wasm32"))]
use serde::{Deserialize, Serialize};

#[cfg(not(target_arch = "wasm32"))]
fn deserialize_i128_string<'de, D>(deserializer: D) -> Result<i128, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let s = StdString::deserialize(deserializer)?;
    s.parse::<i128>().map_err(serde::de::Error::custom)
}

#[cfg(not(target_arch = "wasm32"))]
fn deserialize_optional_i128_string<'de, D>(deserializer: D) -> Result<Option<i128>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let opt = Option::<StdString>::deserialize(deserializer)?;
    match opt {
        None => Ok(None),
        Some(s) => s.parse::<i128>().map(Some).map_err(serde::de::Error::custom),
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn deserialize_u64_string_or_number<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v = serde_json::Value::deserialize(deserializer)?;
    match v {
        serde_json::Value::Number(n) => n
            .as_u64()
            .ok_or_else(|| serde::de::Error::custom(format!("expected u64, got {}", n))),
        serde_json::Value::String(s) => s.parse::<u64>().map_err(serde::de::Error::custom),
        other => Err(serde::de::Error::custom(format!(
            "invalid type: {}, expected u64",
            other
        ))),
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn is_valid_stellar_address(s: &str) -> bool {
    if s.len() != 56 {
        return false;
    }
    if !s.starts_with('G') {
        return false;
    }
    // Stellar public keys are G + 55 base32 chars A-Z2-7
    s[1..].chars().all(|c| matches!(c, 'A'..='Z' | '2'..='7'))
}

#[cfg(not(target_arch = "wasm32"))]
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct FixturePatron {
    pub creator_share: u32,
    pub investor_share: u32,
    pub treasury_share: u32,
    pub creator_addr: StdString,
    pub investor_addr: StdString,
    pub treasury_addr: StdString,
}

#[cfg(not(target_arch = "wasm32"))]
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct FixtureKernel {
    #[serde(deserialize_with = "deserialize_i128_string")]
    #[serde(serialize_with = "serialize_i128_string")]
    pub approval_threshold: i128,
    #[serde(deserialize_with = "deserialize_i128_string")]
    #[serde(serialize_with = "serialize_i128_string")]
    pub gtm_budget: i128,
    #[serde(deserialize_with = "deserialize_i128_string")]
    #[serde(serialize_with = "serialize_i128_string")]
    pub min_patron_pulse: i128,
}

#[cfg(not(target_arch = "wasm32"))]
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct FixturePulse {
    #[serde(deserialize_with = "deserialize_i128_string")]
    #[serde(serialize_with = "serialize_i128_string")]
    pub total_supply: i128,
    #[serde(deserialize_with = "deserialize_i128_string")]
    #[serde(serialize_with = "serialize_i128_string")]
    pub price_usd_cents: i128,
    pub token_symbol: StdString,
}

#[cfg(not(target_arch = "wasm32"))]
fn serialize_i128_string<S>(v: &i128, s: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    s.serialize_str(&v.to_string())
}

#[cfg(not(target_arch = "wasm32"))]
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct FixtureTalos {
    pub id: u32,
    pub name: StdString,
    pub category: StdString,
    pub description: StdString,
    pub creator: StdString,
    pub patron: FixturePatron,
    pub kernel: FixtureKernel,
    pub pulse: FixturePulse,
    #[serde(deserialize_with = "deserialize_u64_string_or_number")]
    pub created_at: u64,
    pub active: bool,
    // additive field – old fixtures omit, new fixtures set Some
    #[serde(default)]
    pub metadata: Option<StdString>,
}

#[cfg(not(target_arch = "wasm32"))]
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct FixtureNameRecord {
    pub name: StdString,
    pub talos_id: u32,
}

#[cfg(not(target_arch = "wasm32"))]
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct FixtureTalosName {
    pub talos_id: u32,
    pub name: StdString,
}

#[cfg(not(target_arch = "wasm32"))]
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct FixtureCreatorOf {
    pub talos_id: u32,
    pub creator: StdString,
}

#[cfg(not(target_arch = "wasm32"))]
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct FixtureTimelockConfig {
    pub min_delay: u64,
    pub grace_period: u64,
}

#[cfg(not(target_arch = "wasm32"))]
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct FixtureGovernanceBundle {
    pub protocol_wallet: StdString,
    pub protocol_fee_bps: u32,
    pub pending_admin: Option<StdString>,
    pub next_talos_id: u32,
    pub next_timelock_id: u32,
    pub timelock_config: Option<FixtureTimelockConfig>,
}

// --- Envelope -----------------------------------------------------------

#[cfg(not(target_arch = "wasm32"))]
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FixtureMeta {
    pub schema_version: u32,
    pub contract: StdString,
    pub kind: StdString,
    #[serde(default)]
    pub additive_fields: StdVec<StdString>,
}

#[cfg(not(target_arch = "wasm32"))]
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FixtureEnvelope<T> {
    pub meta: FixtureMeta,
    pub storage_key: serde_json::Value,
    pub value: T,
}

// --- Parsers with actionable errors -------------------------------------

#[cfg(not(target_arch = "wasm32"))]
fn map_serde_error(err: serde_json::Error, file: &str) -> FixtureError {
    let msg = err.to_string();
    // Heuristic to surface missing field vs type mismatch
    if msg.contains("missing field") {
        // extract field name between `"` or `'`
        let field = msg
            .split('`')
            .nth(1)
            .or_else(|| msg.split('"').nth(1))
            .unwrap_or("unknown")
            .to_string();
        return FixtureError::MissingField {
            field,
            file: file.to_string(),
        };
    }
    if msg.contains("invalid type") || msg.contains("expected") {
        return FixtureError::TypeMismatch {
            field: "unknown".to_string(),
            expected: "see schema".to_string(),
            got: msg.clone(),
            file: file.to_string(),
        };
    }
    FixtureError::JsonParse {
        msg,
        file: file.to_string(),
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub fn parse_talos_fixture(json: &str, file: &str) -> Result<FixtureTalos, FixtureError> {
    // First try envelope with generic value, then direct value for malformed case
    let val: serde_json::Value = serde_json::from_str(json).map_err(|e| FixtureError::JsonParse {
        msg: e.to_string(),
        file: file.to_string(),
    })?;
    // If value is a string like "TRUNCATED_NOT_AN_OBJECT", fail with TypeMismatch
    if let Some(v) = val.get("value") {
        if v.is_string() {
            return Err(FixtureError::TypeMismatch {
                field: "value".to_string(),
                expected: "object with Talos fields".to_string(),
                got: v.to_string(),
                file: file.to_string(),
            });
        }
        // Extract meta version check
        if let Some(meta) = val.get("meta").and_then(|m| m.get("schema_version")).and_then(|v| v.as_u64()) {
            if meta != 1 && meta != 2 {
                return Err(FixtureError::UnknownVersion {
                    version: meta as u32,
                    file: file.to_string(),
                });
            }
        }
        // Deserialize inner value
        let inner = val.get("value").cloned().unwrap_or(val.clone());
        let talos: FixtureTalos = serde_json::from_value(inner).map_err(|e| map_serde_error(e, file))?;
        validate_talos(&talos, file)?;
        return Ok(talos);
    }
    let talos: FixtureTalos = serde_json::from_str(json).map_err(|e| map_serde_error(e, file))?;
    validate_talos(&talos, file)?;
    Ok(talos)
}

#[cfg(not(target_arch = "wasm32"))]
pub fn validate_talos(t: &FixtureTalos, file: &str) -> Result<(), FixtureError> {
    if t.name.is_empty() {
        return Err(FixtureError::InvalidValue {
            field: "name".to_string(),
            reason: "must be non-empty".to_string(),
            file: file.to_string(),
        });
    }
    if !is_valid_stellar_address(&t.creator) {
        return Err(FixtureError::InvalidValue {
            field: "creator".to_string(),
            reason: format!("expected valid G...56 address, got '{}'", t.creator),
            file: file.to_string(),
        });
    }
    for (field, addr) in [
        ("patron.creator_addr", &t.patron.creator_addr),
        ("patron.investor_addr", &t.patron.investor_addr),
        ("patron.treasury_addr", &t.patron.treasury_addr),
    ] {
        if !is_valid_stellar_address(addr) {
            return Err(FixtureError::InvalidValue {
                field: field.to_string(),
                reason: format!("expected valid G...56 address, got '{}'", addr),
                file: file.to_string(),
            });
        }
    }
    let total = t.patron.creator_share + t.patron.investor_share + t.patron.treasury_share;
    if total != 100 {
        return Err(FixtureError::InvalidValue {
            field: "patron.*_share".to_string(),
            reason: format!("shares must sum to 100, got {}", total),
            file: file.to_string(),
        });
    }
    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
pub fn parse_name_record_fixture(json: &str, file: &str) -> Result<FixtureNameRecord, FixtureError> {
    let val: serde_json::Value = serde_json::from_str(json).map_err(|e| FixtureError::JsonParse {
        msg: e.to_string(),
        file: file.to_string(),
    })?;
    let inner = val.get("value").cloned().unwrap_or(val);
    let rec: FixtureNameRecord = serde_json::from_value(inner).map_err(|e| map_serde_error(e, file))?;
    validate_name(&rec.name, file)?;
    Ok(rec)
}

#[cfg(not(target_arch = "wasm32"))]
pub fn parse_talos_name_fixture(json: &str, file: &str) -> Result<FixtureTalosName, FixtureError> {
    let val: serde_json::Value = serde_json::from_str(json).map_err(|e| FixtureError::JsonParse {
        msg: e.to_string(),
        file: file.to_string(),
    })?;
    let inner = val.get("value").cloned().unwrap_or(val);
    let rec: FixtureTalosName = serde_json::from_value(inner).map_err(|e| map_serde_error(e, file))?;
    validate_name(&rec.name, file)?;
    Ok(rec)
}

#[cfg(not(target_arch = "wasm32"))]
fn validate_name(name: &str, file: &str) -> Result<(), FixtureError> {
    if name.len() < 3 || name.len() > 32 {
        return Err(FixtureError::InvalidValue {
            field: "name".to_string(),
            reason: format!("length must be 3..32, got {}", name.len()),
            file: file.to_string(),
        });
    }
    if name.starts_with('-') || name.ends_with('-') {
        return Err(FixtureError::InvalidValue {
            field: "name".to_string(),
            reason: "must not start or end with '-'".to_string(),
            file: file.to_string(),
        });
    }
    if name.contains("--") {
        return Err(FixtureError::InvalidValue {
            field: "name".to_string(),
            reason: "must not contain consecutive '--'".to_string(),
            file: file.to_string(),
        });
    }
    if !name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        return Err(FixtureError::InvalidValue {
            field: "name".to_string(),
            reason: "must be lowercase alphanumeric + hyphen".to_string(),
            file: file.to_string(),
        });
    }
    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
pub fn parse_creator_of_fixture(json: &str, file: &str) -> Result<FixtureCreatorOf, FixtureError> {
    let val: serde_json::Value = serde_json::from_str(json).map_err(|e| FixtureError::JsonParse {
        msg: e.to_string(),
        file: file.to_string(),
    })?;
    let inner = val.get("value").cloned().unwrap_or(val);
    let rec: FixtureCreatorOf = serde_json::from_value(inner).map_err(|e| map_serde_error(e, file))?;
    if !is_valid_stellar_address(&rec.creator) {
        return Err(FixtureError::InvalidValue {
            field: "creator".to_string(),
            reason: format!("expected valid G...56, got '{}'", rec.creator),
            file: file.to_string(),
        });
    }
    Ok(rec)
}

#[cfg(not(target_arch = "wasm32"))]
pub fn parse_timelock_config_fixture(json: &str, file: &str) -> Result<Option<FixtureTimelockConfig>, FixtureError> {
    let val: serde_json::Value = serde_json::from_str(json).map_err(|e| FixtureError::JsonParse {
        msg: e.to_string(),
        file: file.to_string(),
    })?;
    let inner = val.get("value").cloned().unwrap_or(val);
    if inner.is_null() {
        return Ok(None);
    }
    let cfg: FixtureTimelockConfig = serde_json::from_value(inner).map_err(|e| map_serde_error(e, file))?;
    Ok(Some(cfg))
}

#[cfg(not(target_arch = "wasm32"))]
pub fn parse_governance_fixture(json: &str, file: &str) -> Result<FixtureGovernanceBundle, FixtureError> {
    let val: serde_json::Value = serde_json::from_str(json).map_err(|e| FixtureError::JsonParse {
        msg: e.to_string(),
        file: file.to_string(),
    })?;
    let inner = val.get("value").cloned().unwrap_or(val);
    let gov: FixtureGovernanceBundle = serde_json::from_value(inner).map_err(|e| map_serde_error(e, file))?;
    if !is_valid_stellar_address(&gov.protocol_wallet) {
        return Err(FixtureError::InvalidValue {
            field: "protocol_wallet".to_string(),
            reason: format!("expected valid G...56, got '{}'", gov.protocol_wallet),
            file: file.to_string(),
        });
    }
    if gov.protocol_fee_bps > 10000 {
        return Err(FixtureError::InvalidValue {
            field: "protocol_fee_bps".to_string(),
            reason: "must be <= 10000".to_string(),
            file: file.to_string(),
        });
    }
    Ok(gov)
}

// --- Helper to load fixture via include_str for compile-time embedding ----

#[cfg(not(target_arch = "wasm32"))]
pub fn fixture_path_for_test(relative: &str) -> StdString {
    // Helper for error messages – not a filesystem read, just echo
    relative.to_string()
}
