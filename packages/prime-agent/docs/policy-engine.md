# Declarative Policy Engine

The policy engine provides a centralized, type-safe framework for gating
autonomous agent actions. It evaluates **before** payments, publishing,
fulfillment, and other consequential actions — deterministically, with
explainable decisions and audit trails.

## Quick start

The engine is **disabled by default** for backward compatibility. Enable it:

```bash
export POLICY_ENGINE_ENABLED=true
# or add to ~/.talos-agent/config.json:
# { "policy_engine_enabled": true }
```

Restart the agent. The engine loads built-in defaults and any overrides in
`~/.talos-agent/policies.json`.

## Architecture

```
ActionSpec  ──→  PolicyEngine.evaluate()  ──→  PolicyResult
                     │
                     ├── budget-guard (BLOCKER)
                     ├── approval-threshold (HIGH → ESCALATE)
                     ├── publishing-guard (MEDIUM/LOW)
                     ├── transfer-guard (HIGH)
                     └── fulfillment-guard (LOW)
```

### Key components

| Module | Purpose |
|--------|---------|
| `schema.py` | Typed dataclasses: `Policy`, `PolicyRule`, `ActionSpec`, `PolicyResult` |
| `engine.py` | Pure, deterministic evaluation. No I/O. |
| `loader.py` | Load policies from defaults, filesystem, and database |
| `middleware.py` | Integrates with the agent's tool registry |
| `simulator.py` | Dry-run evaluation for planning |

## Decisions

- **APPROVE**: Action proceeds.
- **ESCALATE**: Action requires human approval via `request_approval`.
- **DENY**: Action is blocked; the engine returns an error.

Action names must be registered with the policy engine. Gated and read-only
bypass actions retain their current categories, and existing registered tools
without an explicit policy category retain their current behavior. Any name
outside the registered action catalog is denied with an
`Unknown policy action category` reason before rule evaluation. Known actions
continue to be approved when the engine is disabled. New tools must be added
to the action catalog before they can execute through a policy-enabled registry.

## Severities

- **BLOCKER**: Hard stop. First match short-circuits with DENY.
- **HIGH**: Accumulates. Any match produces ESCALATE.
- **MEDIUM / LOW**: Advisory only — recorded in evidence but don't change the decision.

## Writing policies

Policies are JSON files or Python dataclasses. Example:

```json
{
  "policies": [
    {
      "name": "custom-transfer-guard",
      "version": "1.0.0",
      "priority": 100,
      "enabled": true,
      "rules": [
        {
          "rule_id": "no-large-weekend-transfers",
          "description": "Block large transfers on weekends",
          "conditions": [
            {"field": "action", "operator": "in", "value": ["transfer_xlm"]},
            {"field": "params.amount", "operator": "gt", "value": 1000}
          ],
          "decision": "deny",
          "severity": "blocker",
          "reason": "Transfers over 1000 XLM blocked on weekends."
        }
      ],
      "exceptions": [
        {
          "rule_id": "no-large-weekend-transfers",
          "actor": "operator@example.test",
          "reason": "Approved testnet settlement window",
          "expires_at": "2030-01-01T00:00:00Z"
        }
      ]
    }
  ]
}
```

Save to `~/.talos-agent/policies.json`. The engine hot-reloads on file change
after validating and dry-run simulating the candidate policy set. If the file
cannot be parsed, a rule is invalid, or the simulation fails, the active
last-known-good policy snapshot remains in effect. The failed reload is logged
and retried on the next hot-reload check; invalid policy data is not treated as
an empty override set.

### Time-bounded exceptions

An exception is scoped to the containing policy and an exact `rule_id`. It
must include a non-empty `actor`, a non-empty `reason`, and an explicit
timezone-aware `expires_at` ISO-8601 timestamp. While active, it suppresses
only that matching rule. At the expiry instant the exception is inactive and
the original rule is enforced again; it never grants unrelated permissions.
Expiry is exclusive, so an exception at exactly `expires_at` is already
expired. Invalid exception metadata is rejected when the policy file loads.

Each `rule_id` must be non-empty and unique across the complete loaded policy
set. Duplicate or empty identifiers are rejected before policies are installed;
rule IDs remain the stable link between decision traces and policy overrides.

### Supported operators

| Operator | Description |
|----------|-------------|
| `eq`, `neq` | Equality / inequality |
| `gt`, `gte`, `lt`, `lte` | Numeric comparisons |
| `in`, `not_in` | Set membership |
| `exists` | Field is present and non-null |
| `regex` | Field matches the pattern in `value` |
| `glob` | Field matches `*`, `?`, and character-class wildcards in `value` |

Glob patterns support `*` (zero or more characters other than `/`), `?`
(exactly one character other than `/`), `[abc]` and `[a-z]` (character
classes), and `[!abc]` (negated character classes). Character classes match
their explicit members, including `/`; `[[]` matches a literal `[`. Repeated
`*` characters have the same behavior as `*` and do not match `/`. Empty,
unclosed, or malformed character classes are rejected while policies are
loaded; the agent will not silently ignore the invalid policy or fall back to
built-in defaults.

### Field paths

- `action` — the tool name (e.g. `purchase_service`)
- `params.<key>` — a parameter passed to the tool
- `context.<key>` — runtime context (budget, thresholds, etc.)

## Built-in policies

| Policy | Priority | What it does |
|--------|----------|--------------|
| `budget-guard` | 100 | Blocks purchases when budget is exhausted |
| `approval-threshold` | 90 | Escalates transactions above 10 USDC |
| `publishing-guard` | 80 | Advisory checks for content publishing |
| `transfer-guard` | 75 | Escalates transfers above 100 units |
| `fulfillment-guard` | 70 | Advisory checks for job fulfillment |

## Overriding built-in policies

Place a policy with the **same name** in `policies.json`. It replaces the
default entirely.  For example, to disable the budget guard:

```json
{
  "policies": [
    {
      "name": "budget-guard",
      "enabled": false
    }
  ]
}
```

## Simulation / dry-run

```python
from talos_agent.policy import PolicySimulator, PolicyEngine

engine = PolicyEngine()
engine.enabled = True
engine.reload(loader.load())

sim = PolicySimulator(engine)
result = sim.simulate("transfer_xlm", {"amount": 500}, {"budget_remaining": 1000})
print(result.decision)  # "escalate"
```

## Approved Action Binding & Exact Simulated Policy Digest

To prevent parameter tampering or executing an action under a policy that changed after review, approved action executions are cryptographically bound to both:

1. **Canonical Action Identity (`action_digest`)**: SHA-256 hash of the canonical JSON payload (`action`, `params`, and `context`).
2. **Canonical Policy Identity (`policy_digest`)**: SHA-256 hash of the complete active policy ruleset and engine configuration at review time.

### Workflow

1. **Simulate & Create Approval Request**:
   ```python
   sim_result, approval = sim.create_approval(
       action="transfer_xlm",
       params={"amount": 500, "to": "GB123..."},
       approval_id="app-456",
   )
   ```
2. **Review & Approve**:
   ```python
   approval.approve(decided_by="operator_alice", reason="Approved budget transfer")
   store.save(approval)  # Persisted to DB with exact digests
   ```
3. **Execution Verification**:
   Before executing the approved action, verify that neither the action parameters nor the policy rules changed after review:
   ```python
   # Raises ActionDigestMismatchError or PolicyDigestMismatchError if tampered
   engine.verify_approved_execution(approval, spec)

   # Or evaluate via PolicyResult with detailed audit trace:
   result = engine.evaluate_approved(approval, spec)
   if result.decision == PolicyDecision.APPROVE:
       await execute_action()
   ```

If either the action arguments or the active policy rules were modified after review, execution is rejected immediately.

## Rollback / disabling

To disable the engine:
```bash
export POLICY_ENGINE_ENABLED=false
# or remove/comment the config key
```

When disabled, known actions retain their prior behavior and proceed without
policy evaluation. Unsupported action names remain denied. Inline checks in
individual tools continue to operate independently.


## Decision traces

Every evaluation returns a privacy-safe `PolicyDecisionTrace` on
`PolicyResult.trace`.  Use it to explain *why* an action was approved,
escalated, or denied:

```python
result = engine.evaluate(spec)
print(result.explain())          # multi-line human summary
print(result.trace.summary)      # one-line operator summary
print(result.trace.to_dict())    # structured audit payload
```

Traces include per-rule and per-condition steps.  Secret-shaped fields
(`api_key`, `seed`, `token`, `payment_proof`, etc.) are redacted as
`[redacted]` and never logged or returned in cleartext.  BLOCKER
short-circuits still emit the full trace up to the denying rule.

To export one simulated action's explanation as JSON:

```python
sim.export_decision(
  "transfer_xlm",
  "decision.json",
  params={"amount": 500, "beneficiary_note": "..."},
  private_arguments={"beneficiary_note"},
)
```

The export includes the decision, matched policy/rule IDs, bounded reasons,
condition trace steps, and bounded arguments. Built-in sensitive field names
are redacted automatically; pass `private_arguments` for tool arguments whose
privacy classification comes from the tool schema or caller. Nested arguments
can be classified with dotted paths; classified values are also redacted if a
policy condition references them. The export is a simulation and does not
enforce or execute the action. Existing `export_scenarios` batch exports and
`PolicyResult` interfaces are unchanged.

## Observability

The engine exposes counters via `engine.metrics`:
```python
{"evaluation_count": 42, "deny_count": 3, "escalate_count": 7}
```

Every evaluation result includes a SHA-256 `result_digest` for audit trails.

## Multi-agent mode

In multi-agent mode (`run_multi`) each agent gets its own policy engine and its
own tool registry, so one agent's policy never governs another's. See
[multi-agent-isolation.md](multi-agent-isolation.md).

## Known limitations

- Conditions compare a parameter value against a **static** threshold in the
  policy definition.  Dynamic comparisons (e.g. "amount > context.approval_threshold")
  are not yet supported at the condition level — use the inline tool checks for
  those cases, or set explicit values in the policy.
- Policy evaluation is synchronous and runs in the tool execution path —
  keep conditions simple and avoid regex on large payloads.
