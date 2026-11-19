import pino from "pino";
import {
  BenchmarkRun,
  BenchmarkResult,
  SbomMetricsSample,
  SbomAuditResult,
  SbomStateTransition,
  SbomFailureMode,
  EnvStateTransition,
} from "./types";

const isCI = !!process.env.CI;

export const logger = pino({
  level: process.env.BENCHMARK_LOG_LEVEL ?? (isCI ? "info" : "debug"),
  ...(process.env.NODE_ENV === "production" || isCI
    ? {}
    : { transport: { target: "pino-pretty", options: { colorize: true } } }),
});

const sensitivePatterns = [
  /api[Kk]ey/i,
  /secret/i,
  /password/i,
  /token/i,
  /auth/i,
  /signature/i,
  /stellar.*secret/i,
];

export function sanitizeForLogging(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (sensitivePatterns.some((p) => p.test(key))) {
      sanitized[key] = "[REDACTED]";
    } else if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      sanitized[key] = sanitizeForLogging(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

export function logBenchmarkRun(run: BenchmarkRun): void {
  const safe = sanitizeForLogging({
    id: run.id,
    suite: run.suite,
    summary: run.summary,
    ciRun: run.ciRun,
    commitSha: run.commitSha,
    branch: run.branch,
  });
  logger.info(safe, "Benchmark run completed");
}

export function logBenchmarkResult(result: BenchmarkResult): void {
  const safe = sanitizeForLogging({
    label: result.label,
    passed: result.passed,
    meanMs: Math.round(result.meanMs),
    p99: result.percentiles.p99,
    variance: Math.round(result.variance * 10000) / 10000,
    peakMemoryMb: Math.round(result.peakMemoryMb),
    violations: result.thresholdViolations.length,
  });
  if (result.passed) {
    logger.info(safe, "Benchmark passed");
  } else {
    logger.warn(safe, "Benchmark failed threshold check");
  }
}

export function logFailure(mode: string, error: unknown): void {
  logger.error(
    { mode, error: error instanceof Error ? error.message : String(error) },
    "Benchmark failure",
  );
}

export function logSbomState(transition: SbomStateTransition): void {
  const safe = sanitizeForLogging({
    component: transition.component,
    from: transition.from,
    to: transition.to,
    trigger: transition.trigger,
    at: new Date(transition.at).toISOString(),
    failureMode: transition.failureMode,
    detail: transition.detail ? transition.detail.slice(0, 200) : undefined,
  });
  if (transition.to === "failed" || transition.failureMode) {
    logger.warn(safe, `SBOM state: ${transition.from} -> ${transition.to}`);
  } else {
    logger.info(safe, `SBOM state: ${transition.from} -> ${transition.to}`);
  }
}

export function logSbomFailure(
  mode: SbomFailureMode,
  component: string,
  detail: unknown,
): void {
  logger.error(
    sanitizeForLogging({
      mode,
      component,
      detail:
        detail instanceof Error ? detail.message : String(detail).slice(0, 500),
    }),
    "SBOM subsystem failure",
  );
}

export function logSbomAudit(
  audit: SbomAuditResult,
  artifactPath?: string,
): void {
  const safe = sanitizeForLogging({
    component: audit.component,
    tag: audit.tag,
    durationMs: audit.durationMs,
    failureMode: audit.failureMode,
    artifactPath,
    sbomCount: audit.sboms.length,
    sbomValid: audit.sboms.filter((s) => s.schemaValid).length,
    sbomSigned: audit.sboms.filter((s) => s.signed && s.signatureValid).length,
    provenancePresent: audit.provenance.present,
    provenanceValid: audit.provenance.structureValid,
    provenanceSubjects: audit.provenance.subjectsCovered.length,
    slsaLevel: audit.provenance.slsaLevel,
    artifactsTotal: audit.artifacts.total,
    artifactsSigned: audit.artifacts.signed,
    artifactsVerified: audit.artifacts.verified,
    missingSignatures: audit.artifacts.missingSignature.length,
    failedVerifications: audit.artifacts.verificationFailed.length,
  });
  if (audit.failureMode) {
    logger.warn(safe, "SBOM audit completed with findings");
  } else {
    logger.info(safe, "SBOM audit passed");
  }
}

export function logSbomMetricsSummary(summary: {
  totalSamples: number;
  successRate: number;
  failures: number;
  failureModes: Record<string, number>;
  totalArtifactBytes: number;
  totalSignatureBytes: number;
  totalProvenanceBytes: number;
}): void {
  logger.info(
    sanitizeForLogging({
      totalSamples: summary.totalSamples,
      successRate: Math.round(summary.successRate * 10000) / 100,
      failures: summary.failures,
      failureModes: summary.failureModes,
      totalKb: {
        artifacts: Math.round(summary.totalArtifactBytes / 1024),
        signatures: Math.round(summary.totalSignatureBytes / 1024),
        provenance: Math.round(summary.totalProvenanceBytes / 1024),
      },
    }),
    "SBOM metrics summary",
  );
}

export function logSbomMetricSample(sample: SbomMetricsSample): void {
  const safe = sanitizeForLogging({
    component: sample.component,
    format: sample.format,
    componentCount: sample.componentCount,
    generationMs: Math.round(sample.generationDurationMs),
    signingMs: sample.signingDurationMs
      ? Math.round(sample.signingDurationMs)
      : undefined,
    verificationMs: sample.verificationDurationMs
      ? Math.round(sample.verificationDurationMs)
      : undefined,
    signingProvider: sample.signingProvider,
    slsaLevel: sample.slsaLevel,
    success: sample.success,
    failureMode: sample.failureMode,
    artifactKb: Math.round(sample.artifactSizeBytes / 1024),
    signatureKb: Math.round(sample.signatureSizeBytes / 1024),
    provenanceKb: Math.round(sample.provenanceSizeBytes / 1024),
  });
  if (sample.success) {
    logger.info(safe, "SBOM sample");
  } else {
    logger.warn(safe, "SBOM sample (failed)");
  }
}

export function logEnvStateTransition(transition: EnvStateTransition): void {
  const safe = sanitizeForLogging({
    prNumber: transition.prNumber,
    from: transition.from,
    to: transition.to,
    at: new Date(transition.at).toISOString(),
    failureMode: transition.failureMode,
    detail: transition.detail ? transition.detail.slice(0, 200) : undefined,
  });
  if (transition.to === "failed" || transition.failureMode) {
    logger.warn(safe, `Env state: ${transition.from} -> ${transition.to}`);
  } else {
    logger.info(safe, `Env state: ${transition.from} -> ${transition.to}`);
  }
}
