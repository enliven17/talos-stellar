use soroban_sdk::{contract, contractimpl, panic_with_error, Address, Env, IntoVal, String, Symbol, Vec, BytesN};

use crate::events::{emit_name_fee_paid, emit_name_registered, emit_registry_updated};
use crate::interface::{CONTRACT_VERSION, features_list, version_supports, INTERFACE_ID};
use crate::pause::{PAUSE_NAME_CONFIG, PAUSE_NAME_REGISTRATION};
use crate::types::{DataKey, NamesPage, MAX_REVERSE_PAGE_SIZE, MAX_REVERSE_SCAN_WINDOW, EVENT_SCHEMA_VERSION};
use crate::validation::{canonicalize_name, validate_name};
use pause_control;
use ttl_manager;

#[contract]
pub struct TalosNameService;

#[contractimpl]
impl TalosNameService {
    /// Register a name for a Talos.
    ///
    /// # Arguments
    /// * `e` - Soroban environment
    /// * `owner` - The address authorizing this name registration
    /// * `talos_id` - The Talos ID to associate with the name
    /// * `name` - Human-readable name (3-32 chars, lowercase alphanumeric + hyphens).
    ///            Leading/trailing whitespace is trimmed and uppercase ASCII letters
    ///            are lowercased before validation so "Vega", "VEGA", and " vega "
    ///            all register as "vega".
    pub fn register_name(e: Env, owner: Address, talos_id: u32, name: String) {
        pause_control::check_not_paused(&e, PAUSE_NAME_REGISTRATION);

        owner.require_auth();

        // Canonicalize before validation so callers using mixed-case or
        // whitespace-padded names receive identical on-chain state as those
        // using the already-canonical form.
        let name = canonicalize_name(&e, &name);

        if !validate_name(&name) {
            panic!("Invalid name. Must be 3-32 chars, lowercase alphanumeric + hyphens, no consecutive hyphens.");
        }

        if e.storage()
            .persistent()
            .get::<_, u32>(&DataKey::NameRecord(name.clone()))
            .is_some()
        {
            panic!("Name already taken");
        }

        let registry_contract: Address = e
            .storage()
            .persistent()
            .get(&DataKey::RegistryContract)
            .expect("Registry contract not initialized");

        let creator: Option<Address> = e.invoke_contract(
            &registry_contract,
            &soroban_sdk::Symbol::new(&e, "creator_of"),
            soroban_sdk::vec![&e, talos_id.into_val(&e)],
        );

        if creator != Some(owner.clone()) {
            panic_with_error!(&e, crate::types::ContractError::UnauthorizedCaller);
        }

        // Retrieve the old name via TalosName(talos_id) and delete NameRecord(old_name)
        // to prevent dangling records when changing names.
        if let Some(old_name) = e
            .storage()
            .persistent()
            .get::<_, String>(&DataKey::TalosName(talos_id))
        {
            e.storage()
                .persistent()
                .remove(&DataKey::NameRecord(old_name));
        }

        // Store mappings
        e.storage()
            .persistent()
            .set(&DataKey::NameRecord(name.clone()), &talos_id);
        e.storage()
            .persistent()
            .set(&DataKey::TalosName(talos_id), &name);

        emit_name_registered(&e, talos_id, name, owner);
    }

    pub fn initialize(e: Env, registry_id: Address, admin: Address, name_fee: i128) {
        if e.storage()
            .persistent()
            .get::<_, Address>(&DataKey::RegistryContract)
            .is_some()
        {
            panic_with_error!(&e, crate::types::ContractError::AlreadyInitialized);
        }
        if name_fee < 0 {
            panic!("name_fee must be non-negative");
        }

        e.storage()
            .persistent()
            .set(&DataKey::RegistryContract, &registry_id);
        e.storage().persistent().set(&DataKey::Admin, &admin);
        e.storage()
            .persistent()
            .set(&DataKey::NameFeeAmount, &name_fee);
    }

    /// Return the current name registration fee amount, or 0 if unconfigured.
    pub fn name_fee(e: Env) -> i128 {
        e.storage()
            .persistent()
            .get(&DataKey::NameFeeAmount)
            .unwrap_or(0)
    }

    /// Return the configured admin, if any.
    pub fn admin(e: Env) -> Option<Address> {
        e.storage().persistent().get(&DataKey::Admin)
    }

    /// Canonicalize a name the same way `register_name` does before storing it.
    ///
    /// Off-chain callers should use this to derive the canonical form without
    /// incurring a full registration. The result is the exact string that will
    /// be stored on-chain when the same input is passed to `register_name`.
    ///
    /// Rules (applied in order):
    ///   1. Trim leading/trailing ASCII whitespace.
    ///   2. Lowercase ASCII uppercase letters (A-Z → a-z).
    ///
    /// # Panics
    /// - `"Name cannot be empty after canonicalization"` — if input is all whitespace.
    /// - `"Name exceeds maximum input length for canonicalization"` — if input > 64 bytes.
    pub fn canonicalize(e: Env, name: String) -> String {
        canonicalize_name(&e, &name)
    }

    /// Update the name-registration fee. Only the configured admin may call this.
    pub fn set_name_fee(e: Env, new_fee: i128) {
        if new_fee < 0 {
            panic!("name_fee must be non-negative");
        }
        let admin: Address = e
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("admin not set");
        admin.require_auth();
        e.storage()
            .persistent()
            .set(&DataKey::NameFeeAmount, &new_fee);
    }

    /// Register a name AND pay the registration fee with an allowlisted asset.
    ///
    /// In addition to the authorization and registry checks in `register_name`, this
    /// entry-point enforces that:
    ///   1. `asset` is allowlisted in the registry (cross-contract `is_asset_allowed`)
    ///   2. `payer` authorizes a transfer of exactly `name_fee` tokens → Admin
    ///   3. `owner` still authorizes the NAME update itself
    ///
    /// If the asset was removed from the registry allowlist after initialization,
    /// this call panics before any funds move — so an attacker cannot pay with a
    /// mintable/bogus token.
    pub fn register_name_with_fee(
        e: Env,
        owner: Address,
        talos_id: u32,
        name: String,
        payer: Address,
        asset: Address,
    ) {
        // First run the plain name registration logic.
        Self::register_name(e.clone(), owner.clone(), talos_id, name.clone());

        let fee: i128 = e
            .storage()
            .persistent()
            .get(&DataKey::NameFeeAmount)
            .unwrap_or(0);
        if fee <= 0 {
            return;
        }

        let registry_contract: Address = e
            .storage()
            .persistent()
            .get(&DataKey::RegistryContract)
            .expect("Registry contract not initialized");
        let admin: Address = e
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("admin not set");

        // Cross-contract call: verify asset is allowlisted in TalosRegistry.
        let allowed: bool = e.invoke_contract(
            &registry_contract,
            &soroban_sdk::Symbol::new(&e, "is_asset_allowed"),
            soroban_sdk::vec![&e, asset.clone().into_val(&e)],
        );
        if !allowed {
            panic!("Asset not in registry allowlist; cannot pay name fee");
        }

        payer.require_auth();

        let token = soroban_sdk::token::TokenClient::new(&e, &asset);
        token.transfer(&payer, &admin, &fee);

        emit_name_fee_paid(&e, talos_id, &payer, &asset, fee);
    }

    /// Set or transfer admin role for TalosNameService.
    pub fn set_admin(e: Env, new_admin: Address) {
        crate::timelock::set_admin(&e, new_admin);
    }

    /// Update the registered TalosRegistry contract address.
    ///
    /// Requires admin authorization. If timelock is enabled (`min_delay > 0`),
    /// this action must be scheduled and executed via `execute_action`.
    ///
    /// **Deprecation:** When timelock is enabled, this direct path is
    /// rejected with a privacy-safe `dep_path` event before panicking.
    /// Callers should `schedule_action(SetRegistryContract(..), delay)`
    /// and `execute_action` after the ETA.
    pub fn set_registry_contract(e: Env, new_registry_id: Address) {
        pause_control::check_not_paused(&e, PAUSE_NAME_CONFIG);

        let admin: Address = e
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Admin not configured");
        admin.require_auth();

        let config = Self::get_timelock_config(e.clone());
        if config.min_delay > 0 {
            crate::events::emit_deprecated_call(
                &e,
                crate::interface::DEPRECATED_DIRECT_ADMIN[0].0,
                crate::interface::DEPRECATED_DIRECT_ADMIN[0].1,
            );
            panic_with_error!(&e, crate::types::ContractError::TimelockEnabled);
        }

        let old: Address = e
            .storage()
            .persistent()
            .get(&DataKey::RegistryContract)
            .expect("Registry contract not initialized");

        e.storage()
            .persistent()
            .set(&DataKey::RegistryContract, &new_registry_id);

        emit_registry_updated(&e, old, new_registry_id);
    }

    // ── Timelock Administration ─────────────────────────────────────

    /// Configure timelock parameter settings (`min_delay` and `grace_period`).
    pub fn set_timelock_config(e: Env, min_delay: u64, grace_period: u64) {
        crate::timelock::set_timelock_config(&e, min_delay, grace_period);
    }

    /// Retrieve active timelock configuration.
    pub fn get_timelock_config(e: Env) -> crate::admin::TimelockConfig {
        crate::timelock::get_timelock_config_owned(e)
    }

    /// Schedule an administrative action for future execution.
    pub fn schedule_action(e: Env, action: crate::admin::AdminAction, delay: u64) -> u64 {
        crate::timelock::schedule_action(&e, action, delay)
    }

    /// Execute a scheduled action after its timelock ETA has matured.
    pub fn execute_action(e: Env, proposal_id: u64) {
        crate::timelock::execute_action(&e, proposal_id);
    }

    /// Cancel a scheduled action.
    pub fn cancel_action(e: Env, proposal_id: u64) {
        crate::timelock::cancel_action(&e, proposal_id);
    }

    /// Retrieve a timelock proposal by ID.
    pub fn get_timelock_proposal(e: Env, proposal_id: u64) -> Option<crate::admin::TimelockProposal> {
        crate::timelock::get_timelock_proposal(&e, proposal_id)
    }

    // ── Emergency Pause Controls ──────────────────────────────────────

    /// Pause a single write-path domain, blocking it while leaving all
    /// reads fully functional. See `TalosRegistry::pause` for full semantics
    /// (duration rules, idempotency, admin-lock protection) — identical here.
    ///
    /// # Panics
    /// - `Admin not configured` — if `set_admin` has not been called.
    /// - `ContractError::NotAdminOrGuardian` — unauthorized caller.
    /// - `ContractError::DomainLockedByAdmin` — a guardian attempted to
    ///   overwrite an admin-established pause.
    /// - `ContractError::InvalidPauseDuration` — duration out of bounds.
    pub fn pause(e: Env, caller: Address, domain: crate::types::PauseDomain, duration: u64) {
        crate::pause::pause(&e, caller, domain, duration);
    }

    /// Lift an active pause on `domain`. Idempotent no-op if not paused.
    ///
    /// # Authorization
    /// Only the current admin may unpause, regardless of who set the pause.
    pub fn unpause(e: Env, domain: crate::types::PauseDomain) {
        crate::pause::unpause(&e, domain);
    }

    /// Returns `true` if `domain` is currently paused (and not yet expired).
    pub fn is_paused(e: Env, domain: crate::types::PauseDomain) -> bool {
        crate::pause::is_paused(&e, domain)
    }

    /// Full observability view of a domain's pause status.
    pub fn pause_info(e: Env, domain: crate::types::PauseDomain) -> crate::types::PauseInfo {
        crate::pause::pause_info(&e, domain)
    }

    /// Register a guardian address authorized to trigger (but never lift)
    /// bounded-duration pauses. Idempotent; bounded to `MAX_GUARDIANS`.
    ///
    /// # Authorization
    /// Requires current admin authorization.
    pub fn add_guardian(e: Env, guardian: Address) {
        crate::pause::add_guardian(&e, guardian);
    }

    /// Revoke a guardian's pause authority. Idempotent.
    ///
    /// # Authorization
    /// Requires current admin authorization.
    pub fn remove_guardian(e: Env, guardian: Address) {
        crate::pause::remove_guardian(&e, guardian);
    }

    /// Check whether `addr` currently holds guardian pause authority.
    pub fn is_guardian(e: Env, addr: Address) -> bool {
        crate::pause::is_guardian(&e, addr)
    }

    /// List all currently registered guardians (bounded to `MAX_GUARDIANS`).
    pub fn list_guardians(e: Env) -> Vec<Address> {
        crate::pause::list_guardians(&e)
    }

    // ── Scoped Emergency Pause Controls ──────────────────────────────

    /// Pause a domain. Only the admin can pause.
    pub fn pause_domain(e: Env, domain_id: u32, duration: u64) {
        crate::pause::pause_domain(&e, domain_id, duration);
    }

    /// Unpause a domain. Only the admin can unpause.
    pub fn unpause_domain(e: Env, domain_id: u32) {
        crate::pause::unpause_domain(&e, domain_id);
    }

    /// Check whether a domain is paused (expires elapsed pauses first).
    pub fn is_domain_paused(e: Env, domain_id: u32) -> bool {
        crate::pause::is_domain_paused_scoped(&e, domain_id)
    }

    /// Get the pause status for a domain.
    pub fn get_domain_pause_status(e: Env, domain_id: u32) -> Option<pause_control::PauseStatus> {
        crate::pause::get_domain_pause_status(&e, domain_id)
    }

    // ── Interface Query Methods ───────────────────────────────────────

    /// Return the contract's interface version as `(major, minor, patch)`.
    ///
    /// The value is a compile-time constant baked into the WASM binary.
    /// It is **not** stored in ledger state and cannot be altered by any
    /// administrator, upgrade, or cross-contract call after deployment.
    ///
    /// Clients should call this method to verify ABI compatibility before
    /// invoking other entry-points. A change in `major` signals a breaking
    /// change; a change in `minor` adds new entry-points while remaining
    /// backwards compatible; `patch` carries bug-fixes only.
    ///
    /// # Returns
    /// `(major: u32, minor: u32, patch: u32)` — currently `(1, 4, 0)`.
    pub fn version(_e: Env) -> (u32, u32, u32) {
        CONTRACT_VERSION
    }

    /// Return the contract's 32-byte stable interface identifier.
    ///
    /// Derived from `(INTERFACE_NAMESPACE, CONTRACT_VERSION)` and
    /// documented as a golden vector in tests. Cross-contract
    /// callers use it to confirm they are talking to a Talos v1
    /// name service before invoking entry-points.
    pub fn interface_id(e: Env) -> BytesN<32> {
        BytesN::from_array(&e, &INTERFACE_ID)
    }

    /// Return the canonical deployment-manifest digest for this contract.
    ///
    /// This additive read-only query re-derives a stable digest from the
    /// interface ID, semver, capability list, and event schema version. It
    /// never stores any data in state and therefore remains safe for repeated
    /// operator verification and compatibility checks.
    pub fn deployment_manifest_digest(e: Env) -> BytesN<32> {
        let mut payload = soroban_sdk::Bytes::new(&e);
        payload.append(&soroban_sdk::Bytes::from_array(&e, &INTERFACE_ID));
        payload.extend_from_slice(&CONTRACT_VERSION.0.to_be_bytes());
        payload.extend_from_slice(&CONTRACT_VERSION.1.to_be_bytes());
        payload.extend_from_slice(&CONTRACT_VERSION.2.to_be_bytes());

        for feature in features_list() {
            let bytes = feature.as_bytes();
            payload.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
            payload.extend_from_slice(bytes);
        }

        payload.extend_from_slice(&EVENT_SCHEMA_VERSION.major.to_be_bytes());
        payload.extend_from_slice(&EVENT_SCHEMA_VERSION.minor.to_be_bytes());

        e.crypto().sha256(&payload).to_bytes()
    }

    /// Return `true` when the deployed semver supports the requested
    /// `(major, minor, patch)` floor. See `version_supports` for the
    /// exact rule.
    pub fn supports_version(e: Env, major: u32, minor: u32, patch: u32) -> bool {
        let _ = e;
        version_supports(CONTRACT_VERSION, (major, minor, patch))
    }

    /// Return the list of capability symbols supported by this contract.
    ///
    /// Capabilities are stable feature markers; adding a new one bumps
    /// the contract's `minor`, removing or renaming one bumps `major`.
    pub fn interface_features(e: Env) -> Vec<Symbol> {
        let caps = features_list();
        let mut out = Vec::new(&e);
        for cap in caps {
            out.push_back(Symbol::new(&e, cap));
        }
        out
    }

    /// Reported count of deprecated direct-admin paths. See
    /// `DEPRECATED_DIRECT_ADMIN` for the actual entries.
    pub fn deprecated_entry_count(_e: Env) -> u32 {
        crate::interface::DEPRECATED_DIRECT_ADMIN.len() as u32
    }

    /// Verify that the configured `RegistryContract` exposes the
    /// `TalosRegistry` interface and supports version `(1, 1, 0)` or
    /// higher.
    ///
    /// This is a self-service compatibility check performed via two
    /// cross-contract invokes (`interface_id` and `version`). Privacy
    /// is preserved: only the binary compatibility result and the
    /// remote semver tuple are recorded in logs, never any caller or
    /// value data.
    ///
    /// Emits `compat_ok` on success and `compat_err` on failure (with
    /// either the async flag or the offending version tuple).
    ///
    /// # Panics
    /// Panics with `"Registry contract not initialized"` if `initialize`
    /// has not yet pinned a registry address.
    pub fn assert_registry_compatible(e: Env) -> bool {
        let registry: Address = e
            .storage()
            .persistent()
            .get(&DataKey::RegistryContract)
            .expect("Registry contract not initialized");
        crate::interface::check_registry_compatible(&e, &registry, true)
    }

    /// Return the event-schema version expected by off-chain indexers.
    ///
    /// This is a pure read. Indexers should reject a deployment when its
    /// major version differs from the version they support.
    pub fn event_schema_version(_e: Env) -> crate::types::EventSchemaVersion {
        if EVENT_SCHEMA_VERSION.major != 1 {
            panic!("Unsupported event schema major version");
        }
        EVENT_SCHEMA_VERSION
    }

    // ── Read Methods ────────────────────────────────────────────────

    /// Resolve a name to a Talos ID.
    /// Returns None if the name doesn't exist.
    pub fn resolve_name(e: Env, name: String) -> Option<u32> {
        // Canonicalize so "Vega" and "vega" resolve to the same record.
        let name = canonicalize_name(&e, &name);
        e.storage().persistent().get(&DataKey::NameRecord(name))
    }

    /// Get the name associated with a Talos ID.
    /// Returns None if the Talos has no name.
    pub fn name_of(e: Env, talos_id: u32) -> Option<String> {
        e.storage().persistent().get(&DataKey::TalosName(talos_id))
    }

    /// Paginated reverse-lookup: return a page of `(talos_id, name)` entries.
    ///
    /// Scans the reverse mapping `TalosName(id)` for Talos IDs in the
    /// half-open range `[start_id, start_id + limit)`, collecting only the
    /// IDs that have a registered name. IDs with no name entry are silently
    /// skipped and **not** counted against the page size.
    ///
    /// # Arguments
    /// * `start_id` — first Talos ID to include in the scan (inclusive cursor).
    ///   Pass `1` for the first page, or the `next_start` value from a previous
    ///   response to continue paging.
    /// * `limit` — maximum number of results to return per page.
    ///   Clamped to `[1, MAX_REVERSE_PAGE_SIZE]`; callers that supply a value
    ///   outside this range receive a page bounded by the clamped limit.
    ///
    /// # Returns
    /// A [`NamesPage`] value with:
    /// * `items` — up to `limit` `(talos_id, name)` tuples in ascending
    ///   `talos_id` order.
    /// * `next_start` — the first ID of the next page, or `0` when the scan
    ///   reached the end of the range without finding more names.
    ///
    /// # Privacy
    /// This read path accesses only stored name strings (no payment proofs,
    /// seeds, secrets, or caller data) and emits no events.
    ///
    /// # Boundary / missing-data behaviour
    /// * `start_id == 0` is treated as `1` (IDs begin at 1 by convention).
    /// * A `start_id` larger than any registered ID returns an empty page with
    ///   `next_start == 0`.
    /// * The scan is bounded to `start_id + MAX_REVERSE_SCAN_WINDOW` regardless
    ///   of `limit`, preventing unbounded ledger reads.
    pub fn names_page(e: Env, start_id: u32, limit: u32) -> NamesPage {
        // Clamp start
        let effective_start = if start_id == 0 { 1u32 } else { start_id };

        // Clamp limit
        let effective_limit = limit.max(1).min(MAX_REVERSE_PAGE_SIZE);

        let mut items: Vec<(u32, String)> = Vec::new(&e);
        let mut collected: u32 = 0;
        let scan_end = effective_start.saturating_add(MAX_REVERSE_SCAN_WINDOW);

        let mut cursor = effective_start;
        while cursor < scan_end && collected < effective_limit {
            if let Some(name) = e
                .storage()
                .persistent()
                .get::<_, String>(&DataKey::TalosName(cursor))
            {
                items.push_back((cursor, name));
                collected += 1;
            }
            cursor = cursor.saturating_add(1);
            if cursor == 0 {
                // u32 overflow guard
                break;
            }
        }

        // Determine next_start: the first id of the next page, or 0 at end.
        let next_start = if cursor < scan_end && collected == effective_limit {
            cursor
        } else {
            0u32
        };

        NamesPage { items, next_start }
    }

    /// Check if a name is available.
    pub fn is_name_available(e: Env, name: String) -> bool {
        // Canonicalize before availability check so mixed-case inputs agree
        // with the stored canonical form.
        let name = canonicalize_name(&e, &name);
        if !validate_name(&name) {
            return false;
        }
        e.storage()
            .persistent()
            .get::<_, u32>(&DataKey::NameRecord(name))
            .is_none()
    }

    /// Check if a Talos has a registered name.
    pub fn has_name(e: Env, talos_id: u32) -> bool {
        e.storage()
            .persistent()
            .get::<_, String>(&DataKey::TalosName(talos_id))
            .is_some()
    }

    // ── Storage TTL Management ───────────────────────────────────

    /// Touch a name record and its reverse mapping to reset Soroban TTL.
    pub fn touch_name(e: Env, name: String) -> bool {
        let key = DataKey::NameRecord(name.clone());
        let talos_id: u32 = e.storage().persistent().get(&key).expect("Name not found");
        let current_ledger = e.ledger().sequence();
        let last_touched: u32 = e
            .storage()
            .persistent()
            .get(&DataKey::LastTouched(talos_id))
            .unwrap_or(0);

        if ttl_manager::needs_touch(last_touched, current_ledger) {
            e.storage().persistent().set(&key, &talos_id);
            // Touch reverse mapping too
            let rev_key = DataKey::TalosName(talos_id);
            if let Some(n) = e.storage().persistent().get::<_, String>(&rev_key) {
                e.storage().persistent().set(&rev_key, &n);
            }
            e.storage()
                .persistent()
                .set(&DataKey::LastTouched(talos_id), &current_ledger);
            ttl_manager::emit_ttl_touched(&e, "name_record", 2);
            true
        } else {
            false
        }
    }

    /// Batch-touch admin keys plus name records for talos IDs (admin only).
    ///
    /// The name-record sweep is bounded by the renewal age window; use
    /// [`TalosNameService::extend_ttl_batch`] to pass explicit bounds and a
    /// per-call key cap.
    ///
    /// # Authorization
    /// Requires the admin to sign.
    pub fn touch_all_ttl(e: Env, max_talos_id: u32) -> u32 {
        pause_control::check_not_paused(&e, PAUSE_NAME_CONFIG);

        let admin: Address = e
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Admin not configured");
        admin.require_auth();

        let mut touched = 0u32;

        // Administrative keys carry no age marker, so they are refreshed
        // unconditionally (historical behaviour).
        if let Some(addr) = e.storage().persistent().get::<_, Address>(&DataKey::Admin) {
            e.storage().persistent().set(&DataKey::Admin, &addr);
            touched += 1;
        }
        if let Some(reg) = e
            .storage()
            .persistent()
            .get::<_, Address>(&DataKey::RegistryContract)
        {
            e.storage()
                .persistent()
                .set(&DataKey::RegistryContract, &reg);
            touched += 1;
        }

        let sweep = Self::sweep_name_records(
            &e,
            &ttl_manager::TtlBounds::renewal(),
            1..max_talos_id.saturating_add(1),
        );
        touched += sweep.touched;

        ttl_manager::emit_ttl_batch(&e, touched, touched, 0);
        touched
    }

    /// Batched TTL extension with explicit age and work bounds.
    ///
    /// Sweeps name records for talos ids `[1, min(max_talos_id, 1 + limit))`,
    /// clipped to [`ttl_manager::DEFAULT_MAX_BATCH_KEYS`] ids per call, and
    /// re-writes only the records whose age in ledgers falls inside
    /// `[min_age, max_age]`. Records outside the window are reported as
    /// `skipped`; ids without a name record are ignored.
    ///
    /// The two administrative keys (`Admin`, `RegistryContract`) have no age
    /// marker and stay on [`TalosNameService::touch_all_ttl`], which refreshes
    /// them unconditionally.
    ///
    /// Returns `(touched, skipped)`.
    ///
    /// # Panics
    /// - `"Domain is paused"` — when the name-config domain is paused.
    /// - `"Admin not configured"` — if `initialize` has not been called.
    /// - `"ttl bounds: ..."` — static diagnostic for malformed bounds
    ///   (`min_age > max_age`, `max_keys` of 0, or `max_keys` above
    ///   [`ttl_manager::MAX_BATCH_KEYS`]). Diagnostics are compile-time
    ///   constants and never embed caller or storage data.
    ///
    /// # Authorization
    /// Requires the admin to sign.
    pub fn extend_ttl_batch(
        e: Env,
        max_talos_id: u32,
        limit: u32,
        min_age: u32,
        max_age: u32,
    ) -> (u32, u32) {
        pause_control::check_not_paused(&e, PAUSE_NAME_CONFIG);

        let admin: Address = e
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("Admin not configured");
        admin.require_auth();

        let bounds =
            ttl_manager::TtlBounds::new(min_age, max_age, ttl_manager::DEFAULT_MAX_BATCH_KEYS);
        let range = ttl_manager::bounded_range(1, limit, &bounds, max_talos_id.saturating_add(1))
            .unwrap_or_else(|err| panic!("{}", err.message()));

        let sweep = Self::sweep_name_records(&e, &bounds, range);
        sweep.emit(&e);
        (sweep.touched, sweep.skipped)
    }

    /// Shared bounded sweep behind `touch_all_ttl` / `extend_ttl_batch`.
    ///
    /// Re-writes the forward and reverse mapping for every talos id in `range`
    /// whose age falls inside `bounds`, refreshes the `LastTouched` marker, and
    /// returns the accumulator. Ids without a name record are neither touched
    /// nor skipped. Callers emit their own `ttl_batch` event: `touch_all_ttl`
    /// keeps its historical `(touched, touched, 0)` payload, while
    /// `extend_ttl_batch` reports `(total, touched, skipped)`.
    fn sweep_name_records(
        e: &Env,
        bounds: &ttl_manager::TtlBounds,
        range: core::ops::Range<u32>,
    ) -> ttl_manager::BatchSweep {
        let current_ledger = e.ledger().sequence();
        let mut sweep = ttl_manager::BatchSweep::empty();

        for tid in range {
            let name: String = match e
                .storage()
                .persistent()
                .get::<_, String>(&DataKey::TalosName(tid))
            {
                Some(name) => name,
                None => {
                    sweep.record(ttl_manager::EntryOutcome::Absent);
                    continue;
                }
            };
            let last_touched: u32 = e
                .storage()
                .persistent()
                .get(&DataKey::LastTouched(tid))
                .unwrap_or(0);

            if ttl_manager::should_extend(last_touched, current_ledger, bounds) {
                let name_key = DataKey::NameRecord(name.clone());
                if let Some(rec_id) = e.storage().persistent().get::<_, u32>(&name_key) {
                    e.storage().persistent().set(&name_key, &rec_id);
                }
                e.storage()
                    .persistent()
                    .set(&DataKey::TalosName(tid), &name);
                e.storage()
                    .persistent()
                    .set(&DataKey::LastTouched(tid), &current_ledger);
                sweep.record(ttl_manager::EntryOutcome::Touched);
            } else {
                sweep.record(ttl_manager::EntryOutcome::Skipped);
            }
        }

        sweep
    }

    /// Query storage health by scanning name records for tracked talos IDs.
    ///
    /// `max_talos_id` is the upper bound of talos IDs to scan (e.g. from the
    /// registry's `next_talos_id`). Returns `(min_age, max_age, keys_below_warn,
    /// keys_below_crit, total)`. Emits `ttl_warn` if any entry is at risk.
    pub fn get_storage_health(e: Env, max_talos_id: u32) -> (u32, u32, u32, u32, u32) {
        let mut health = ttl_manager::KeyHealth::empty();
        let current_ledger = e.ledger().sequence();

        for tid in 1..=max_talos_id {
            if e.storage().persistent().has(&DataKey::TalosName(tid)) {
                let last_touched: u32 = e
                    .storage()
                    .persistent()
                    .get(&DataKey::LastTouched(tid))
                    .unwrap_or(0);
                health.observe(ttl_manager::age_ledgers(last_touched, current_ledger));
            }
        }

        if health.needs_immediate_attention() {
            ttl_manager::emit_ttl_warning(
                &e,
                "name_record",
                health.keys_below_crit,
                health.max_age,
            );
        }
        if health.is_empty() {
            (0, 0, 0, 0, 0)
        } else {
            (
                health.min_age,
                health.max_age,
                health.keys_below_warn,
                health.keys_below_crit,
                health.total_keys,
            )
        }
    }
}
