# Bounded Multi-Step A2A Plan Composition

## Overview

The A2A (Agent-to-Agent) composition system enables Talos agents to plan multi-step service compositions by chaining compatible services together. This feature extends the existing single-step planning system to support bounded, validated composition without cycles or combinatorial explosion.

## Key Features

- **Schema Compatibility Validation**: Validates output-to-input schema compatibility between service steps
- **Configurable Bounds**: Enforces limits on depth, candidates, calls, cost, and planning time
- **Cycle Detection**: Prevents infinite loops in composition graphs
- **Duplicate Rejection**: Prevents using the same service multiple times in a composition
- **Read-Only Planning**: Planning operations are side-effect free (no actual service calls)
- **Deterministic Output**: Same inputs always produce the same plan digest

## Configuration

### Database Configuration

Composition bounds can be configured via the Talos config in the database:

```json
{
  "compositionMaxDepth": 5,
  "compositionMaxCost": 100.0
}
```

### Default Bounds

| Parameter | Default Value | Description |
|-----------|---------------|-------------|
| `max_depth` | 5 | Maximum number of sequential service calls |
| `max_candidates` | 10 | Maximum candidates to consider per step |
| `max_calls` | 20 | Maximum total service calls in a composition |
| `max_cost_usdc` | 100.0 | Maximum total cost (USDC) for a composition |
| `max_planning_time_seconds` | 30.0 | Maximum planning time before timeout |
| `schema_strictness` | "compatible" | Schema validation mode ("strict" or "compatible") |

### Schema Strictness Modes

- **strict**: Requires exact type matches between output and input schemas
- **compatible**: Allows certain type conversions (e.g., integer → number, number → string)

## Usage

### Tool Function

The `compose_a2a_plan` tool is available to agents for planning multi-step compositions:

```python
from talos_agent.tools.a2a_composition import compose_a2a_plan

# Plan with default bounds
plan = await compose_a2a_plan()

# Plan with custom bounds
plan = await compose_a2a_plan(
    goal_description="Analyze market trends and generate report",
    max_depth=3,
    max_cost_usdc=50.0
)
```

### Plan Structure

The returned plan includes:

```python
{
    "steps": [
        {
            "step_number": 1,
            "service": {
                "talos_id": "talos-abc123",
                "talos_name": "AnalyticsBot",
                "service_name": "Data Analysis",
                "description": "...",
                "price_usdc": 5.0,
                "input_schema": {...},
                "output_schema": {...},
                ...
            },
            "input_mapping": {"query": "query"},
            "estimated_cost_usdc": 5.0
        },
        ...
    ],
    "assumptions": [
        "This is a COMPOSITION PLAN. No actual service calls are made.",
        "Schema strictness: compatible",
        "Max depth: 5",
        ...
    ],
    "confidence": 0.8,
    "total_estimated_cost_usdc": 15.0,
    "max_depth": 5,
    "max_candidates": 10,
    "max_calls": 20,
    "max_cost_usdc": 100.0,
    "planning_time_seconds": 0.5,
    "cycles_detected": [],
    "duplicates_rejected": [],
    "schema_incompatibilities": [],
    "plan_digest": "abc123...",
    "planned_at": "2024-01-01T00:00:00Z"
}
```

## Architecture

### Core Components

1. **ServiceSchema**: Represents input/output schemas for services
2. **ComposableService**: Service with schema information for composition
3. **CompositionStep**: Single step in a composition plan
4. **CompositionPlan**: Complete bounded multi-step composition plan
5. **SchemaValidator**: Validates output-to-input schema compatibility
6. **CycleDetector**: Detects cycles in composition graphs
7. **CompositionPlanner**: Plans bounded multi-step compositions

### Planning Algorithm

The planner uses a greedy algorithm:

1. Start with no output schema (first step accepts any service)
2. Find services compatible with current output schema
3. Filter by used services (prevent duplicates)
4. Sort by price (cheapest first)
5. Select best candidate within bounds
6. Update output schema and repeat until bounds reached

### Schema Compatibility

Schema compatibility is validated by:

1. Checking all required input fields are present in output
2. Validating type compatibility based on strictness mode
3. Collecting incompatibility reasons for debugging

### Cycle Detection

Cycle detection uses DFS (Depth-First Search):

1. Build adjacency list from composition steps
2. Track visited nodes and recursion stack
3. Detect back-edges indicating cycles
4. Return cycle descriptions for debugging

## Observability

### Plan Digest

Each plan includes a SHA-256 digest for identity and caching:

- Same inputs produce same digest
- Different inputs produce different digest
- Digest includes steps, assumptions, and bounds

### Assumptions

Plans include detailed assumptions about:

- Planning mode (read-only)
- Schema strictness
- Applied bounds
- Available services
- Generated steps
- Detected cycles
- Schema incompatibilities

### Confidence Score

Confidence score (0.0–1.0) is computed from:

- Depth ratio (closer to max_depth is better)
- Cost efficiency (lower cost is better)
- Schema completeness

## Limitations

### Current Limitations

1. **Schema Inference**: Schemas are currently inferred from service metadata. Future versions should support explicit schema registration.
2. **Greedy Algorithm**: The planner uses a greedy approach which may not find optimal compositions. Future versions could explore search algorithms.
3. **Linear Composition**: Only supports linear service chains. Future versions could support branching/parallel compositions.
4. **No Execution**: Planning is read-only. Actual execution requires separate orchestration.

### Known Issues

1. Schema inference may not accurately represent complex service interfaces
2. Confidence scoring is heuristic and may not reflect real-world performance
3. Cycle detection is limited to simple cycles in linear compositions

## Migration/Rollback

### Migration

No database migration required. The feature is:

- Purely additive (new module, new tool)
- Backward compatible (existing planning tools unchanged)
- Configuration via existing Talos config mechanism

### Rollback

To rollback:

1. Remove import from `tools/registry.py`:
   ```python
   # from talos_agent.tools import a2a_composition as _a2a_composition_mod
   ```
2. Remove dependency injection:
   ```python
   # _a2a_composition_mod._api = api
   # _a2a_composition_mod._db = db
   # _a2a_composition_mod._settings = settings
   ```
3. Delete `tools/a2a_composition.py`
4. Delete `tests/test_a2a_composition.py`

## Testing

### Unit Tests

Unit tests cover:

- Data structures (ServiceSchema, ComposableService, CompositionStep, CompositionPlan)
- SchemaValidator (strict and compatible modes)
- CycleDetector (various cycle scenarios)
- CompositionPlanner (bounds enforcement, confidence calculation, digest)

### Integration Tests

Integration tests cover:

- Tool function with mocked API/DB
- Custom bound overrides
- Empty service handling
- Malformed service handling
- DB configuration override
- Deterministic digest
- Planning time recording

### Running Tests

```bash
# Run composition tests
python -m pytest tests/test_a2a_composition.py -v

# Run all planning tests
python -m pytest tests/test_planning.py tests/test_a2a_composition.py -v
```

## Security Considerations

### Authorization

The planning tool is read-only and:

- Does not invoke wallet, reservation, or approval methods
- Does not mutate job state
- Does not make actual service calls

### Sensitive Data

- Planning data is not persisted
- Plan digests are SHA-256 hashes (no sensitive data)
- Service schemas may contain field names but not values

## Future Enhancements

1. **Explicit Schema Registration**: Allow services to register detailed schemas
2. **Advanced Search**: Implement A* or beam search for better compositions
3. **Branching Compositions**: Support parallel and conditional service chains
4. **Execution Orchestration**: Add execution layer to actually run compositions
5. **Learning**: Learn from past composition performance to improve planning
6. **Caching**: Cache plans by digest to avoid redundant planning
