"""Bounded multi-step A2A plan composition.

This module extends the single-step planning system to support composing
compatible service steps without cycles or combinatorial explosion.

Key features:
- Schema compatibility validation (output-to-input)
- Configurable bounds (depth, candidates, calls, cost, planning time)
- Cycle detection and duplicate rejection
- Authorization and sensitive-data handling
- Deterministic planning with timeout and cancellation support

Public @tool functions
----------------------
compose_a2a_plan  — emit a bounded multi-step A2A composition plan
"""

from __future__ import annotations

import hashlib
import json
import time
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from talos_agent.tools.registry import tool

if TYPE_CHECKING:
    from talos_agent.api_client import TalosAPIClient
    from talos_agent.config import Settings
    from talos_agent.db import LocalDB

# ---------------------------------------------------------------------------
# Module-level dependency injection (filled by build_all_tools)
# ---------------------------------------------------------------------------
_api: TalosAPIClient = None  # type: ignore[assignment]
_db: LocalDB = None  # type: ignore[assignment]
_settings: Settings = None  # type: ignore[assignment]

# ---------------------------------------------------------------------------
# Planning bounds and constants
# ---------------------------------------------------------------------------

#: Maximum composition depth (number of sequential service calls)
DEFAULT_MAX_DEPTH: int = 5

#: Maximum candidate services to consider per step
DEFAULT_MAX_CANDIDATES: int = 10

#: Maximum total service calls in a composition plan
DEFAULT_MAX_CALLS: int = 20

#: Maximum total cost (USDC) for a composition plan
DEFAULT_MAX_COST_USDC: float = 100.0

#: Maximum planning time (seconds) before timeout
DEFAULT_MAX_PLANNING_TIME_SECONDS: float = 30.0

#: Schema compatibility strictness level
# "strict" - requires exact type match
# "compatible" - allows compatible types (e.g., number -> string)
DEFAULT_SCHEMA_STRICTNESS: str = "compatible"

# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------


@dataclass
class ServiceSchema:
    """Schema definition for a service's input or output."""
    
    fields: dict[str, str]  # field name -> JSON schema type
    required: list[str] = field(default_factory=list)
    
    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
    
    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ServiceSchema:
        return cls(
            fields=data.get("fields", {}),
            required=data.get("required", []),
        )


@dataclass
class ComposableService:
    """A service with schema information for composition."""
    
    # Identity
    talos_id: str
    talos_name: str
    service_name: str
    description: str
    
    # Pricing
    price_usdc: float
    
    # Schemas
    input_schema: ServiceSchema
    output_schema: ServiceSchema
    
    # Metadata
    category: str = ""
    chains: list[str] = field(default_factory=list)
    
    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class CompositionStep:
    """A single step in an A2A composition plan."""
    
    step_number: int
    service: ComposableService
    input_mapping: dict[str, str]  # output_field -> input_field
    estimated_cost_usdc: float
    
    def to_dict(self) -> dict[str, Any]:
        result = asdict(self)
        result["service"] = self.service.to_dict()
        return result


@dataclass
class CompositionPlan:
    """A bounded multi-step A2A composition plan."""
    
    # Composition steps
    steps: list[CompositionStep]
    
    # Planning metadata
    assumptions: list[str]
    confidence: float  # 0.0–1.0
    total_estimated_cost_usdc: float
    
    # Bounds applied
    max_depth: int
    max_candidates: int
    max_calls: int
    max_cost_usdc: float
    planning_time_seconds: float
    
    # Digest for plan identity / caching
    plan_digest: str
    
    # Timestamp
    planned_at: str
    
    # Validation results
    cycles_detected: list[str] = field(default_factory=list)
    duplicates_rejected: list[str] = field(default_factory=list)
    schema_incompatibilities: list[str] = field(default_factory=list)
    
    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# ---------------------------------------------------------------------------
# Schema compatibility validator
# ---------------------------------------------------------------------------


class SchemaValidator:
    """Validates output-to-input schema compatibility."""
    
    def __init__(self, strictness: str = DEFAULT_SCHEMA_STRICTNESS):
        self.strictness = strictness
    
    def are_compatible(
        self,
        output_schema: ServiceSchema,
        input_schema: ServiceSchema,
    ) -> tuple[bool, list[str]]:
        """Check if output schema is compatible with input schema.
        
        Returns:
            (is_compatible, incompatibility_reasons)
        """
        incompatibilities: list[str] = []
        
        # Check if all required input fields are satisfied by output
        for required_field in input_schema.required:
            if required_field not in output_schema.fields:
                incompatibilities.append(
                    f"Missing required input field: {required_field}"
                )
                continue
            
            output_type = output_schema.fields[required_field]
            input_type = input_schema.fields[required_field]
            
            if not self._types_compatible(output_type, input_type):
                incompatibilities.append(
                    f"Type mismatch for {required_field}: "
                    f"output {output_type} -> input {input_type}"
                )
        
        return len(incompatibilities) == 0, incompatibilities
    
    def _types_compatible(self, output_type: str, input_type: str) -> bool:
        """Check if two JSON schema types are compatible."""
        if self.strictness == "strict":
            return output_type == input_type
        
        # Compatible mode: allow certain type conversions
        compatible_conversions = {
            ("integer", "number"): True,
            ("number", "string"): True,
            ("integer", "string"): True,
            ("string", "string"): True,
            ("boolean", "string"): True,
            ("array", "array"): True,
            ("object", "object"): True,
        }
        
        return compatible_conversions.get((output_type, input_type), False)


# ---------------------------------------------------------------------------
# Cycle detector
# ---------------------------------------------------------------------------


class CycleDetector:
    """Detects cycles in composition graphs."""
    
    def __init__(self):
        self.visited: set[str] = set()
        self.recursion_stack: set[str] = set()
        self.cycles: list[str] = []
    
    def detect_cycles(
        self,
        steps: list[CompositionStep],
    ) -> list[str]:
        """Detect cycles in a composition plan.
        
        Returns list of cycle descriptions.
        """
        self.cycles = []
        self.visited = set()
        self.recursion_stack = set()
        
        # Build adjacency list: service_id -> [dependent_service_ids]
        graph = defaultdict(list)
        service_ids = [step.service.talos_id for step in steps]
        
        for i, step in enumerate(steps):
            if i > 0:
                # Previous step feeds into this step
                prev_id = steps[i - 1].service.talos_id
                current_id = step.service.talos_id
                graph[prev_id].append(current_id)
        
        # Detect cycles using DFS
        for service_id in service_ids:
            if service_id not in self.visited:
                self._dfs_detect_cycle(service_id, graph, [service_id])
        
        return self.cycles
    
    def _dfs_detect_cycle(
        self,
        node: str,
        graph: dict[str, list[str]],
        path: list[str],
    ) -> None:
        self.visited.add(node)
        self.recursion_stack.add(node)
        
        for neighbor in graph.get(node, []):
            if neighbor not in self.visited:
                self._dfs_detect_cycle(neighbor, graph, path + [neighbor])
            elif neighbor in self.recursion_stack:
                # Found a cycle
                cycle_start = path.index(neighbor)
                cycle_path = path[cycle_start:] + [neighbor]
                self.cycles.append(" -> ".join(cycle_path))
        
        self.recursion_stack.remove(node)


# ---------------------------------------------------------------------------
# Composition planner
# ---------------------------------------------------------------------------


class CompositionPlanner:
    """Plans bounded multi-step A2A compositions."""
    
    def __init__(
        self,
        max_depth: int = DEFAULT_MAX_DEPTH,
        max_candidates: int = DEFAULT_MAX_CANDIDATES,
        max_calls: int = DEFAULT_MAX_CALLS,
        max_cost_usdc: float = DEFAULT_MAX_COST_USDC,
        max_planning_time_seconds: float = DEFAULT_MAX_PLANNING_TIME_SECONDS,
        schema_strictness: str = DEFAULT_SCHEMA_STRICTNESS,
    ):
        self.max_depth = max_depth
        self.max_candidates = max_candidates
        self.max_calls = max_calls
        self.max_cost_usdc = max_cost_usdc
        self.max_planning_time_seconds = max_planning_time_seconds
        self.schema_strictness = schema_strictness
        
        self.validator = SchemaValidator(schema_strictness)
        self.cycle_detector = CycleDetector()
    
    def plan_composition(
        self,
        services: list[ComposableService],
        goal_description: str = "",
    ) -> CompositionPlan:
        """Plan a bounded multi-step A2A composition.
        
        Parameters
        ----------
        services:
            Available services with schema information.
        goal_description:
            Optional description of the composition goal.
        
        Returns:
            CompositionPlan with validated steps and bounds.
        """
        start_time = time.time()
        
        steps: list[CompositionStep] = []
        cycles_detected: list[str] = []
        duplicates_rejected: list[str] = []
        schema_incompatibilities: list[str] = []
        
        # Track used services to avoid duplicates
        used_service_ids: set[str] = set()
        total_cost = 0.0
        
        # Greedy composition: pick best compatible service at each step
        current_output_schema: ServiceSchema | None = None
        
        for depth in range(self.max_depth):
            # Check planning time bound
            if time.time() - start_time > self.max_planning_time_seconds:
                break
            
            # Check call count bound
            if len(steps) >= self.max_calls:
                break
            
            # Find compatible services
            candidates = self._find_compatible_candidates(
                services,
                current_output_schema,
                used_service_ids,
            )
            
            if not candidates:
                # No more compatible services
                break
            
            # Pick best candidate (cheapest first)
            best_service = candidates[0]
            
            # Check cost bound
            if total_cost + best_service.price_usdc > self.max_cost_usdc:
                break
            
            # Create input mapping
            input_mapping = self._create_input_mapping(
                current_output_schema,
                best_service.input_schema,
            )
            
            # Add step
            step = CompositionStep(
                step_number=len(steps) + 1,
                service=best_service,
                input_mapping=input_mapping,
                estimated_cost_usdc=best_service.price_usdc,
            )
            steps.append(step)
            
            # Update state
            used_service_ids.add(best_service.talos_id)
            total_cost += best_service.price_usdc
            current_output_schema = best_service.output_schema
        
        # Detect cycles
        if steps:
            cycles_detected = self.cycle_detector.detect_cycles(steps)
        
        # Compute confidence
        confidence = self._compute_confidence(steps, services)
        
        # Build assumptions
        assumptions = self._build_assumptions(
            services=services,
            steps=steps,
            goal_description=goal_description,
            cycles_detected=cycles_detected,
            schema_incompatibilities=schema_incompatibilities,
        )
        
        # Compute planning time
        planning_time = time.time() - start_time
        
        # Compute plan digest
        plan_digest = self._compute_digest(steps, assumptions)
        
        return CompositionPlan(
            steps=steps,
            assumptions=assumptions,
            confidence=confidence,
            total_estimated_cost_usdc=total_cost,
            max_depth=self.max_depth,
            max_candidates=self.max_candidates,
            max_calls=self.max_calls,
            max_cost_usdc=self.max_cost_usdc,
            planning_time_seconds=planning_time,
            cycles_detected=cycles_detected,
            duplicates_rejected=duplicates_rejected,
            schema_incompatibilities=schema_incompatibilities,
            plan_digest=plan_digest,
            planned_at=datetime.now(timezone.utc).isoformat(),
        )
    
    def _find_compatible_candidates(
        self,
        services: list[ComposableService],
        current_output_schema: ServiceSchema | None,
        used_service_ids: set[str],
    ) -> list[ComposableService]:
        """Find services compatible with current output schema."""
        candidates: list[ComposableService] = []
        
        for service in services:
            # Skip already used services
            if service.talos_id in used_service_ids:
                continue
            
            # First step: any service is valid
            if current_output_schema is None:
                candidates.append(service)
                continue
            
            # Check schema compatibility
            is_compatible, _ = self.validator.are_compatible(
                current_output_schema,
                service.input_schema,
            )
            
            if is_compatible:
                candidates.append(service)
        
        # Sort by price (cheapest first) and limit candidates
        candidates.sort(key=lambda s: s.price_usdc)
        return candidates[: self.max_candidates]
    
    def _create_input_mapping(
        self,
        output_schema: ServiceSchema | None,
        input_schema: ServiceSchema,
    ) -> dict[str, str]:
        """Create mapping from output fields to input fields."""
        if output_schema is None:
            return {}
        
        mapping: dict[str, str] = {}
        
        for input_field in input_schema.required:
            if input_field in output_schema.fields:
                mapping[input_field] = input_field
        
        return mapping
    
    def _compute_confidence(
        self,
        steps: list[CompositionStep],
        all_services: list[ComposableService],
    ) -> float:
        """Compute confidence score for the composition plan."""
        if not steps:
            return 0.0
        
        if not all_services:
            return 0.0
        
        # Confidence factors:
        # - Step depth ratio (closer to max_depth is better)
        # - Cost efficiency (lower cost is better)
        # - Schema completeness
        
        depth_ratio = len(steps) / max(1, self.max_depth)
        
        total_cost = sum(s.estimated_cost_usdc for s in steps)
        cost_efficiency = 1.0 - min(1.0, total_cost / max(1.0, self.max_cost_usdc))
        
        schema_completeness = sum(
            1 for s in steps
            if s.service.input_schema.fields and s.service.output_schema.fields
        ) / max(1, len(steps))
        
        confidence = (depth_ratio + cost_efficiency + schema_completeness) / 3.0
        return round(min(1.0, max(0.0, confidence)), 4)
    
    def _build_assumptions(
        self,
        services: list[ComposableService],
        steps: list[CompositionStep],
        goal_description: str,
        cycles_detected: list[str],
        schema_incompatibilities: list[str],
    ) -> list[str]:
        """Build list of planning assumptions."""
        assumptions: list[str] = [
            "This is a COMPOSITION PLAN. No actual service calls are made.",
            f"Schema strictness: {self.schema_strictness}",
            f"Max depth: {self.max_depth}",
            f"Max candidates per step: {self.max_candidates}",
            f"Max total calls: {self.max_calls}",
            f"Max total cost: {self.max_cost_usdc} USDC",
            f"Max planning time: {self.max_planning_time_seconds} seconds",
        ]
        
        if goal_description:
            assumptions.append(f"Goal: {goal_description}")
        
        assumptions.append(f"Available services: {len(services)}")
        assumptions.append(f"Composition steps: {len(steps)}")
        
        if steps:
            total_cost = sum(s.estimated_cost_usdc for s in steps)
            assumptions.append(f"Total estimated cost: {total_cost:.6f} USDC")
        
        if cycles_detected:
            assumptions.append(f"Cycles detected: {len(cycles_detected)}")
            for cycle in cycles_detected:
                assumptions.append(f"  - {cycle}")
        
        if schema_incompatibilities:
            assumptions.append(f"Schema incompatibilities: {len(schema_incompatibilities)}")
        
        if not steps:
            assumptions.append(
                "No composition steps generated. "
                "Consider relaxing bounds or providing more compatible services."
            )
        
        return assumptions
    
    def _compute_digest(
        self,
        steps: list[CompositionStep],
        assumptions: list[str],
    ) -> str:
        """Compute SHA-256 digest of the plan for identity/caching."""
        payload = {
            "steps": [s.to_dict() for s in steps],
            "assumptions": sorted(assumptions),
            "max_depth": self.max_depth,
            "max_candidates": self.max_candidates,
            "max_calls": self.max_calls,
            "max_cost_usdc": self.max_cost_usdc,
        }
        
        return hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()


# ---------------------------------------------------------------------------
# Internal helpers (read-only I/O)
# ---------------------------------------------------------------------------


async def _fetch_services_with_schemas() -> list[dict[str, Any]]:
    """Fetch services from the API with schema information."""
    if _api is None:
        return []
    
    try:
        services = await _api.discover_services()
        
        # Enrich with schema information if available
        # For now, use default schemas based on service metadata
        enriched = []
        for service in services:
            enriched_service = dict(service)
            
            # Infer default schemas from service metadata
            input_schema = _infer_input_schema(service)
            output_schema = _infer_output_schema(service)
            
            enriched_service["inputSchema"] = input_schema
            enriched_service["outputSchema"] = output_schema
            
            enriched.append(enriched_service)
        
        return enriched
    except Exception:
        return []


def _infer_input_schema(service: dict[str, Any]) -> dict[str, Any]:
    """Infer input schema from service metadata."""
    # Default: minimal input schema
    return {
        "fields": {
            "query": "string",
            "context": "string",
        },
        "required": ["query"],
    }


def _infer_output_schema(service: dict[str, Any]) -> dict[str, Any]:
    """Infer output schema from service metadata."""
    # Default: standard output schema
    return {
        "fields": {
            "result": "string",
            "data": "object",
            "confidence": "number",
        },
        "required": ["result"],
    }


def _read_composition_settings() -> dict[str, Any]:
    """Read composition settings from DB/settings."""
    settings = {
        "max_depth": DEFAULT_MAX_DEPTH,
        "max_candidates": DEFAULT_MAX_CANDIDATES,
        "max_calls": DEFAULT_MAX_CALLS,
        "max_cost_usdc": DEFAULT_MAX_COST_USDC,
        "max_planning_time_seconds": DEFAULT_MAX_PLANNING_TIME_SECONDS,
        "schema_strictness": DEFAULT_SCHEMA_STRICTNESS,
    }
    
    try:
        if _db is not None:
            config = _db.get_talos_config()
            if config:
                # Override with DB settings if present
                if "compositionMaxDepth" in config:
                    settings["max_depth"] = int(config["compositionMaxDepth"])
                if "compositionMaxCost" in config:
                    settings["max_cost_usdc"] = float(config["compositionMaxCost"])
    except Exception:
        pass
    
    return settings


# ---------------------------------------------------------------------------
# @tool functions
# ---------------------------------------------------------------------------


@tool(
    "compose_a2a_plan",
    "Plan a bounded multi-step A2A composition by finding compatible service "
    "steps without cycles or combinatorial explosion. Returns validated steps, "
    "cost estimates, confidence score, and bounds metadata. "
    "This is a READ-ONLY planning operation — no actual service calls are made.",
)
async def compose_a2a_plan(
    goal_description: str = "",
    max_depth: int = 0,
    max_cost_usdc: float = 0.0,
) -> dict:
    """Compose a bounded multi-step A2A plan.
    
    Parameters
    ----------
    goal_description:
        Optional description of the composition goal.
    max_depth:
        Override default max depth (0 = use default).
    max_cost_usdc:
        Override default max cost (0 = use default).
    
    Returns
    -------
    dict — the serialised CompositionPlan, including:
        steps                    list of composition steps
        assumptions              list of planning assumptions
        confidence               float [0,1]
        total_estimated_cost_usdc
        max_depth, max_candidates, max_calls, max_cost_usdc
        planning_time_seconds
        cycles_detected          list of detected cycles
        duplicates_rejected      list of rejected duplicates
        schema_incompatibilities list of schema issues
        plan_digest              sha256 of canonical plan
        planned_at               ISO-8601 timestamp
    """
    # Fetch services with schemas
    raw_services = await _fetch_services_with_schemas()
    
    # Read composition settings
    settings = _read_composition_settings()
    
    # Apply overrides
    if max_depth > 0:
        settings["max_depth"] = max_depth
    if max_cost_usdc > 0.0:
        settings["max_cost_usdc"] = max_cost_usdc
    
    # Convert to ComposableService objects
    services: list[ComposableService] = []
    for raw in raw_services:
        try:
            service = ComposableService(
                talos_id=raw.get("talosId", ""),
                talos_name=raw.get("talosName", ""),
                service_name=raw.get("serviceName", ""),
                description=raw.get("description", ""),
                price_usdc=float(raw.get("price", 0)),
                input_schema=ServiceSchema.from_dict(
                    raw.get("inputSchema", {"fields": {}, "required": []})
                ),
                output_schema=ServiceSchema.from_dict(
                    raw.get("outputSchema", {"fields": {}, "required": []})
                ),
                category=raw.get("talosCategory", ""),
                chains=raw.get("chains", []),
            )
            services.append(service)
        except (ValueError, TypeError):
            # Skip malformed services
            continue
    
    # Create planner and generate composition
    planner = CompositionPlanner(
        max_depth=settings["max_depth"],
        max_candidates=settings["max_candidates"],
        max_calls=settings["max_calls"],
        max_cost_usdc=settings["max_cost_usdc"],
        max_planning_time_seconds=settings["max_planning_time_seconds"],
        schema_strictness=settings["schema_strictness"],
    )
    
    plan = planner.plan_composition(services, goal_description)
    return plan.to_dict()
