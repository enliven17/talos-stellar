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
} from "./types";

export { routeKey } from "./types";

export {
  validateAgainstSchema,
  stripUnknownFields,
  makeInvalidJsonViolation,
} from "./validator";

export { shouldSample } from "./sampler";

export {
  withDriftDetection,
  registerSchema,
  deregisterSchema,
  registeredRoutes,
  setDriftConfig,
  resetDriftConfig,
} from "./middleware";

export {
  getDriftCounters,
  resetDriftCounters,
} from "./metrics";
