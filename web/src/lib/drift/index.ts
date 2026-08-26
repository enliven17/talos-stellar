/**
 * Public API for the drift detection module.
 *
 * Import from "@/lib/drift" in route files.
 */
export type {
  DriftMode,
  DriftConfig,
  UnknownFieldPolicy,
  DriftViolation,
  DriftViolationKind,
  DriftValidationResult,
  JsonSchemaObject,
  SchemaRegistry,
} from "./types.js";

export { routeKey } from "./types.js";

export {
  validateAgainstSchema,
  stripUnknownFields,
  makeInvalidJsonViolation,
} from "./validator.js";

export { shouldSample } from "./sampler.js";

export {
  withDriftDetection,
  registerSchema,
  deregisterSchema,
  registeredRoutes,
  setDriftConfig,
  resetDriftConfig,
} from "./middleware.js";

export {
  getDriftCounters,
  resetDriftCounters,
} from "./metrics.js";
