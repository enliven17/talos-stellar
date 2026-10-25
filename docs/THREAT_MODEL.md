# Threat Model: Keys, Payments, and Admin Operations

This document describes the security assumptions, threat actors, attack vectors, and mitigations for key management, payment operations, and administrative functions in the TALOS protocol.

## Scope

This threat model covers:

- **Key Management**: API keys (legacy and scoped), Stellar wallet keys, request signing keys, and agent secrets
- **Payment Operations**: x402 payment headers, Stellar transfers, revenue distributions, and buybacks
- **Admin Operations**: Governance proposals, configuration changes, key rotation, and privileged API endpoints

## Assumptions

### Infrastructure Assumptions

- The TALOS web API runs in a hardened cloud environment with standard security controls (firewalls, VPC, etc.)
- Stellar network assumes standard Soroban contract security assumptions
- Database (PostgreSQL) is accessed via encrypted connections
- Secrets are stored encrypted at rest (AES-256-GCM for agent secrets, bcrypt/scrypt for API keys)
- All network traffic is TLS 1.3+

### Trust Boundaries

| Component | Trusted | Notes |
|-----------|---------|-------|
| Web API Server | Yes | Operator-controlled infrastructure |
| Stellar Network | Yes | Decentralized, but assumes protocol correctness |
| Prime-Agent (operator-hosted) | Yes | Operator-controlled runtime |
| Prime-Agent (user-hosted) | Partial | User-controlled, but validated via checkpoints |
| Stellar Wallet (operator) | Yes | Operator-controlled custody |
| Stellar Wallet (user) | No | User-controlled, untrusted environment |
| Web Browser (user) | No | Untrusted client environment |

## Threat Actors

| Actor | Motivation | Capabilities | Mitigation Focus |
|-------|------------|---------------|-----------------|
| **External Attacker** | Financial gain, disruption | Network access, public API, limited knowledge | Authentication, rate limiting, input validation |
| **Compromised User** | Financial gain, credential theft | User's wallet keys, agent credentials | Scoped keys, audit logging, transaction limits |
| **Malicious Insider** | Sabotage, theft, espionage | Admin access, infrastructure access | Separation of duties, audit logs, MFA |
| **Supply Chain Attacker** | Persistence, backdoor | Code injection, dependency compromise | Code review, dependency pinning, SBOM |
| **Stellar Network Attacker** | MEV, front-running | Transaction mempool visibility | Nonce management, timeout windows |

## Threat Analysis

### 1. Key Management

#### 1.1 API Key Compromise

**Threat**: Attacker obtains a scoped or legacy API key through:
- Log leakage (plaintext keys in logs)
- Database breach (if keys not properly hashed)
- Client-side exposure (browser storage, git history)
- Social engineering

**Impact**:
- Unauthorized API access
- Activity posting on behalf of agent
- Revenue manipulation
- Configuration changes

**Mitigations**:
- ✅ Scoped keys (`tak_*`) are SHA-256 hashed in database (`tls_api_keys`)
- ✅ Legacy keys (`tlk_*`) are being phased out; migration path documented
- ✅ API keys are never logged in plaintext (audit logs use keyId only)
- ✅ Web UI does not display raw keys after creation
- ⚠️ Legacy keys stored in plaintext in `tls_talos.apiKey` (migration required)
- ⚠️ Keys may be exposed in environment variables or git history (operator responsibility)

**Residual Risk**: Medium. Legacy keys remain a vulnerability until fully migrated.

#### 1.2 Stellar Key Compromise

**Threat**: Attacker obtains Stellar secret key through:
- Compromised prime-agent host
- Environment variable leakage
- Backup exposure
- Hardware wallet theft

**Impact**:
- Unauthorized transfers
- Agent wallet draining
- Governance proposal manipulation
- Signature forgery

**Mitigations**:
- ✅ Prime-agent supports encrypted secret rotation (AES-256-GCM, separate keyring)
- ✅ Keyring stored in `TALOS_SECRET_KEYRING` environment variable (operator-managed)
- ✅ Secrets never logged in plaintext
- ✅ Nonce-based request signing prevents replay attacks
- ✅ Hardware wallet support via SDK `RequestSigner` interface
- ⚠️ Keys in memory during operation (inevitable, but minimal exposure window)
- ⚠️ Backup security is operator responsibility

**Residual Risk**: Low-Medium. Depends on operator's key management practices.

#### 1.3 Request Signing Key Compromise

**Threat**: Attacker compromises the signing key used for SDK request authentication:
- Key theft from custody service
- Hardware wallet compromise
- Key extraction from process memory

**Impact**:
- Request forgery
- Bypass of API key authentication
- Unauthorized operations with trusted signature

**Mitigations**:
- ✅ Signature includes timestamp and nonce (prevents replay)
- ✅ Server-side nonce replay protection
- ✅ Canonicalization prevents tampering with request body/headers
- ✅ Signature verification on critical operations
- ✅ Key rotation supported via `keyId` field
- ⚠️ Nonce cache may be lost on server restart (requires durable storage for full protection)

**Residual Risk**: Low. Replay protection and canonicalization provide strong defenses.

### 2. Payment Operations

#### 2.1 Payment Header Forgery (x402)

**Threat**: Attacker forges x402 payment header to:
- Underpay for agent services
- Replay valid payments
- Manipulate payment metadata

**Impact**:
- Financial loss for operators
- Service theft
- Revenue underreporting

**Mitigations**:
- ✅ x402 header includes cryptographic signature from Stellar network
- ✅ Server validates payment against Stellar ledger
- ✅ Nonce-based operation tracking prevents replay
- ✅ Payment amount validated against expected pricing
- ✅ Stellar transaction hash pinned to operation
- ⚠️ Race condition between payment and operation completion (idempotency key required)

**Residual Risk**: Low. Stellar signature validation provides strong assurance.

#### 2.2 Unauthorized Transfers

**Threat**: Attacker initiates unauthorized Stellar transfers:
- Via compromised agent credentials
- Via governance proposal manipulation
- Via API endpoint abuse

**Impact**:
- Wallet draining
- Fund misappropriation
- Reputational damage

**Mitigations**:
- ✅ Transfer requires agent ownership verification
- ✅ Operator must approve transfers via governance
- ✅ Scoped keys separate `wallet:sign` from other operations
- ✅ Audit log records all transfer attempts
- ✅ Transfer limits enforced (if configured)
- ⚠️ No multi-sig requirement for single-operator agents
- ⚠️ Transfer authorization depends on correct key scoping

**Residual Risk**: Medium. Depends on operator's key scoping and governance practices.

#### 2.3 Revenue Distribution Manipulation

**Threat**: Attacker manipulates revenue distribution:
- False revenue reporting
- Diverting distributions
- Manipulating buyback calculations

**Impact**:
- Financial loss for token holders
- Incorrect governance rewards
- Regulatory compliance issues

**Mitigations**:
- ✅ Revenue endpoints require `revenue:write` scope
- ✅ Revenue must be validated against on-chain data
- ✅ Distributions follow smart contract rules
- ✅ Audit log captures all revenue operations
- ✅ Buyback validated against treasury balance
- ⚠️ No third-party oracle for revenue validation (self-reported)
- ⚠️ Potential for revenue overstatement if agent compromised

**Residual Risk**: Medium. Revenue validation depends on operator honesty and agent security.

### 3. Admin Operations

#### 3.1 Governance Proposal Manipulation

**Threat**: Attacker manipulates governance proposals:
- Submitting malicious proposals
- Front-running proposal votes
- Quorum manipulation

**Impact**:
- Unauthorized parameter changes
- Contract upgrades
- Treasury misappropriation

**Mitigations**:
- ✅ Proposals require signature from authorized key
- ✅ Voting requires token ownership
- ✅ Quorum thresholds enforced by smart contract
- ✅ Timelock on proposal execution
- ✅ Audit log records all proposals and votes
- ⚠️ Whale attacks possible if token distribution is concentrated
- ⚠️ No proposal content validation beyond signature

**Residual Risk**: Low-Medium. Smart contract enforces quorum and timelock, but governance centralization is a risk.

#### 3.2 Configuration Tampering

**Threat**: Attacker modifies agent configuration:
- Via compromised admin API key
- Via direct database access
- Via environment variable injection

**Impact**:
- Agent behavior changes
- Service disruption
- Security bypasses

**Mitigations**:
- ✅ Admin operations require `admin` or `settings:write` scope
- ✅ Configuration changes logged to audit trail
- ✅ Critical config changes may require governance approval
- ✅ Database access restricted to application layer
- ⚠️ No config change approval workflow (immediate effect)
- ⚠️ Database admin access has full config modification capability

**Residual Risk**: Medium. Depends on database access controls and key scoping.

#### 3.3 Key Rotation Attacks

**Threat**: Attacker interferes with key rotation:
- Rolling back to compromised keys
- Preventing rotation of compromised keys
- Injecting attacker-controlled keys

**Impact**:
- Persistent access after compromise
- Denial of service
- Credential substitution

**Mitigations**:
- ✅ Secret rotation uses CAS (Compare-And-Swap) operations
- ✅ Rollback checkpoints allow recovery from bad rotations
- ✅ Audit log records all rotation events
- ✅ Keyring managed via environment variable (not in database)
- ✅ Dual-read allows fallback to previous version during rotation
- ⚠️ No automatic key expiration (manual rotation required)
- ⚠️ Keyring compromise requires operator intervention

**Residual Risk**: Low. CAS operations and audit logging provide strong protection.

## Cross-Cutting Concerns

### Audit Logging

**Current State**:
- ✅ All authenticated requests logged to `tls_api_audit_logs`
- ✅ Audit logs include talosId, method, path, statusCode, denialReason, scopesRequired, ipAddress
- ✅ Key IDs logged, but not raw keys
- ⚠️ Audit logs may be tampered with by database admin
- ⚠️ No immutable append-only log (write-ahead log not cryptographically chained)

**Recommendations**:
- Consider append-only log storage (e.g., CloudTrail, immutable S3)
- Implement log forwarding to external SIEM
- Add cryptographic chaining to audit log entries
- Regular audit log integrity checks

### Rate Limiting

**Current State**:
- ✅ Rate limiting documented in `web/RATE_LIMITING.md`
- ✅ Per-IP and per-key rate limits
- ⚠️ Rate limits may be bypassed via distributed attack
- ⚠️ No adaptive rate limiting based on threat signals

**Recommendations**:
- Implement distributed rate limiting (Redis-based)
- Add IP reputation scoring
- Implement challenge-response for suspicious traffic
- Rate limit sensitive operations (transfers, config changes) more aggressively

### Input Validation

**Current State**:
- ✅ Name validation uses shared vectors (contract, SDK, web)
- ✅ Stellar address validation
- ✅ Amount validation for payments
- ⚠️ No general-purpose input sanitization framework
- ⚠️ Some validation logic duplicated across contract, SDK, and web

**Recommendations**:
- Centralize validation logic in shared library
- Implement schema validation for all API inputs
- Add fuzzing for validation functions
- Regular security audits of validation logic

## Incident Response

### Key Compromise Response

1. **Immediate Actions**:
   - Revoke compromised key via API
   - Rotate all keys that share the same compromise vector
   - Review audit logs for unauthorized activity
   - Notify affected users (if applicable)

2. **Investigation**:
   - Determine compromise vector (logs, access patterns)
   - Assess scope of unauthorized access
   - Identify data exfiltration or financial impact

3. **Recovery**:
   - Generate new keys with strong entropy
   - Update all affected configurations
   - Verify new keys are working correctly
   - Monitor for suspicious activity post-rotation

### Payment Anomaly Response

1. **Immediate Actions**:
   - Freeze affected agent wallet (if possible)
   - Pause revenue distributions
   - Flag transactions for investigation

2. **Investigation**:
   - Review Stellar ledger for unauthorized transfers
   - Correlate with API audit logs
   - Identify compromised credentials

3. **Recovery**:
   - Recover funds if possible (Stellar clawback not available)
   - Update transfer limits and approval workflows
   - Implement additional monitoring

### Admin Compromise Response

1. **Immediate Actions**:
   - Revoke all admin keys
   - Temporarily suspend admin operations
   - Escalate to governance for emergency proposals

2. **Investigation**:
   - Review admin activity logs
   - Assess configuration changes
   - Identify unauthorized modifications

3. **Recovery**:
   - Restore configuration from backup
   - Generate new admin keys with MFA
   - Implement additional approval workflows

## Security Recommendations

### High Priority

1. **Complete legacy key migration** - Remove all plaintext `tlk_*` keys from database
2. **Implement durable nonce storage** - Prevent replay attacks across server restarts
3. **Add multi-sig for critical operations** - Require multiple approvals for transfers and config changes
4. **Implement audit log immutability** - Prevent log tampering by privileged insiders

### Medium Priority

5. **Add automatic key expiration** - Enforce regular key rotation
6. **Implement distributed rate limiting** - Prevent distributed brute force attacks
7. **Add revenue validation oracles** - Prevent false revenue reporting
8. **Implement governance proposal content validation** - Prevent malicious proposals

### Low Priority

9. **Add hardware wallet enforcement** - Require hardware wallet for high-value operations
10. **Implement transaction monitoring** - Real-time anomaly detection for payments
11. **Add security headers** - CSP, HSTS, etc. for web UI
12. **Regular penetration testing** - Quarterly external security assessments

## Compliance Considerations

### Data Protection

- API keys and secrets are encrypted at rest
- Audit logs contain IP addresses (consider GDPR implications)
- No PII stored in database (except email if operator provides it)

### Financial Regulations

- Revenue distributions may require reporting (operator responsibility)
- Treasury operations may be subject to financial regulations
- Consider implementing KYC/AML for high-value operations

### Audit Trail

- All authenticated operations logged
- Audit logs retained per operator policy
- Consider implementing log retention policies for compliance

## References

- [SDK Request Signing](./sdk-request-signing.md)
- [Scoped API Keys](../web/SCOPED_KEYS.md)
- [Prime-Agent Secret Rotation](./prime-agent-secret-rotation.md)
- [Webhook Delivery Security](./webhook-delivery.md)
- [Replay Protection](./replay.md)

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-10-17 | Initial threat model for keys, payments, and admin operations |
