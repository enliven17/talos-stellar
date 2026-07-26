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
      ]
    }
  ]
}
```

Save to `~/.talos-agent/policies.json`.  The engine hot-reloads on file change.

### Supported operators

| Operator | Description |
|----------|-------------|
| `eq`, `neq` | Equality / inequality |
| `gt`, `gte`, `lt`, `lte` | Numeric comparisons |
| `in`, `not_in` | Set membership |
| `exists` | Field is present and non-null |
| `regex` | Field matches the pattern in `value` |

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
engine.load(loader.load())

sim = PolicySimulator(engine)
result = sim.simulate("transfer_xlm", {"amount": 500}, {"budget_remaining": 1000})
print(result.decision)  # "escalate"
```

## Rollback / disabling

To disable the engine:
```bash
export POLICY_ENGINE_ENABLED=false
# or remove/comment the config key
```

The engine is backwards-compatible: when disabled, all actions proceed as
before.  Inline checks in individual tools continue to operate independently.

## Observability

The engine exposes counters via `engine.metrics`:
```python
{"evaluation_count": 42, "deny_count": 3, "escalate_count": 7}
```

Every evaluation result includes a SHA-256 `result_digest` for audit trails.

## Known limitations

- Conditions compare a parameter value against a **static** threshold in the
  policy definition.  Dynamic comparisons (e.g. "amount > context.approval_threshold")
  are not yet supported at the condition level — use the inline tool checks for
  those cases, or set explicit values in the policy.
- Multi-agent mode (`run_multi`) creates a separate engine per agent but the
  tool registry's `_middleware` is set once at build time.
- Policy evaluation is synchronous and runs in the tool execution path —
  keep conditions simple and avoid regex on large payloads.
