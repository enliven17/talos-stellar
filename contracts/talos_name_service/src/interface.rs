use soroban_sdk::{symbol_short, Address, BytesN, Env, Symbol};

// ── Stable interface (v1.x.x) ──────────────────────────────────────
//
// `INTERFACE_ID` is a 32-byte content-derived identifier derived from
// `INTERFACE_NAMESPACE` and `CONTRACT_VERSION`. It MUST match the
// derived byte sequence documented in `interface_id_golden_vector_*`
// tests and in `contracts/INTERFACE.md`; a single byte change is a
// breaking ABI signal.
pub const INTERFACE_NAMESPACE: &str = "TalosNameService";

pub const INTERFACE_ID: [u8; 32] = [
    0x54, 0x61, 0x6C, 0x6F, 0x73, 0x4E, 0x61, 0x6D, // "TalosNam"
    0x65, 0x53, 0x65, 0x72, 0x76, 0x69, 0x63, 0x65, // "eService"
    // (major, minor, patch) big-endian u32s
    0x00, 0x00, 0x00, 0x01, // major = 1
    0x00, 0x00, 0x00, 0x04, // minor = 4
    0x00, 0x00, 0x00, 0x00, // patch = 0
    // reserved
    0x00, 0x00, 0x00, 0x00,
];

/// Expected `INTERFACE_ID` of the configured `RegistryContract`, mirroring
/// the bytes published by `talos_registry::INTERFACE_ID` (namespace
/// `"TalosRegistry"`, version `(1, 4, 0)`). Kept as an inline copy rather
/// than a crate dependency so this contract's ABI check has no build-time
/// coupling to the Registry crate; see the golden-vector test for the
/// independent reproduction of the byte layout.
pub const EXPECTED_REGISTRY_INTERFACE_ID: [u8; 32] = [
    0x54, 0x61, 0x6C, 0x6F, 0x73, 0x52, 0x65, 0x67, // "TalosReg"
    0x69, 0x73, 0x74, 0x72, 0x79, 0x00, 0x00, 0x00, // "istry" + zero pads
    // (major, minor, patch) big-endian u32s
    0x00, 0x00, 0x00, 0x01, // major = 1
    0x00, 0x00, 0x00, 0x04, // minor = 4
    0x00, 0x00, 0x00, 0x00, // patch = 0
    // reserved
    0x00, 0x00, 0x00, 0x00,
];

/// Capability symbols returned by `interface_features()`.
pub fn features_list() -> &'static [&'static str] {
    &[
        "name_registration", // register_name / resolve_name / is_name_available
        "name_lifecycle",    // update_name / has_name / name_of — revoke + aliasing
        "admin_transfer",    // set_admin for admin handover
        "timelock_admin",    // schedule_action / execute_action / cancel_action
        "registry_pointer",  // set_registry_contract — points to TalosRegistry
        "interface_query",   // version / interface_id / supports_version
        "cross_contract",    // invokes creator_of on the configured registry
        "paginated_reverse_lookup", // names_page — cursor-based reverse scan
        "name_canonicalization", // canonicalize() normalizes names before registration
    ]
}

/// Deprecated entry-point table (recommended replacements).
pub const DEPRECATED_DIRECT_ADMIN: &[(&str, &str)] = &[(
    "set_registry_contract (direct, pre-timelock)",
    "schedule_action(SetRegistryContract, ..) + execute_action",
)];

/// Compatibility helper: returns true if `actual` semver satisfies `required`.
///
/// Mirrors `TalosRegistry::version_supports` so callers in both modules
/// get identical answers even though no shared crate is imported:
///
/// - `major` must match exactly.
/// - `actual.minor > required.minor`        → supported.
/// - `actual.minor == required.minor` and `actual.patch >= required.patch`
///                                          → supported.
/// - `actual.minor < required.minor`        → not supported.
pub fn version_supports(actual: (u32, u32, u32), required: (u32, u32, u32)) -> bool {
    if actual.0 != required.0 {
        return false;
    }
    if actual.1 > required.1 {
        return true;
    }
    if actual.1 < required.1 {
        return false;
    }
    actual.2 >= required.2
}

/// Cross-contract compatibility helper.
///
/// Verifies that a contract registered as a `TalosRegistry` actually
/// publishes the expected `INTERFACE_ID`. Emits a `compat_ok` event
/// when the check passes and a `compat_err` event with the actual
/// interface-id bytes when it fails. Both events are privacy-safe: no
/// caller or value data is included.
///
/// Returns `true` on success; panic-or-event behaviour on failure is
/// controlled by `revert_on_mismatch` so callers may choose to log
/// instead of abort.
pub fn check_registry_compatible(
    e: &Env,
    registry: &Address,
    revert_on_mismatch: bool,
) -> bool {
    // Single atomic cross-contract read: interface ID + version tuple.
    let registry_id: BytesN<32> = e.invoke_contract(
        registry,
        &Symbol::new(e, "interface_id"),
        soroban_sdk::vec![e],
    );

    if registry_id != BytesN::from_array(e, &EXPECTED_REGISTRY_INTERFACE_ID) {
        let topics = (Symbol::new(e, "compat_err"),);
        e.events().publish(topics, ());
        if revert_on_mismatch {
            panic!("Registry interface ID mismatch: expected TalosNameService-compatible v1");
        }
        return false;
    }

    let version: (u32, u32, u32) = e.invoke_contract(
        registry,
        &Symbol::new(e, "version"),
        soroban_sdk::vec![e],
    );

    // Require the registry at major=1, minor >= 1.
    if !version_supports(version, (1, 1, 0)) {
        let topics = (Symbol::new(e, "compat_err"),);
        e.events()
            .publish(topics, (version.0, version.1, version.2));
        if revert_on_mismatch {
            panic!("Registry version too old: requires TalosRegistry >= 1.1.0");
        }
        return false;
    }

    let topics = (symbol_short!("compat_ok"),);
    e.events()
        .publish(topics, (version.0, version.1, version.2));
    true
}

// ── Contract Version Constants ─────────────────────────────────────

/// Compile-time interface version of TalosNameService.
///
/// Format: `(major, minor, patch)` following Semantic Versioning.
///
/// Bump rules:
/// - **major** — incompatible ABI change (removed/renamed entry-points, changed argument types)
/// - **minor** — backwards-compatible new entry-point or return-field added
/// - **patch** — bug-fix with no observable ABI change
///
/// This constant is embedded in the WASM binary at compile time and is
/// therefore immutable once deployed; it cannot be altered by any admin
/// call, storage write, or cross-contract invocation.
pub const CONTRACT_VERSION: (u32, u32, u32) = (1, 4, 0);
