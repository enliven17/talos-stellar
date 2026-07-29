export interface BenchmarkConfig {
  runs: number;
  warmupRuns: number;
  concurrency: number;
  timeoutMs: number;
  datasetSize: number;
  percentiles: number[];
  varianceThreshold: number;
  memoryThresholdMb: number;
  cpuThresholdPercent: number;
  artifactDir: string;
  trendWindow: number;
}

export interface MetricSample {
  label: string;
  durationMs: number;
  memoryMb: number;
  cpuPercent: number;
  timestamp: number;
  warm: boolean;
}

export interface Percentiles {
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
  [key: string]: number;
}

export interface BenchmarkResult {
  label: string;
  samples: MetricSample[];
  coldSamples: MetricSample[];
  warmSamples: MetricSample[];
  percentiles: Percentiles;
  coldPercentiles: Percentiles;
  warmPercentiles: Percentiles;
  meanMs: number;
  medianMs: number;
  stddevMs: number;
  minMs: number;
  maxMs: number;
  meanMemoryMb: number;
  peakMemoryMb: number;
  meanCpuPercent: number;
  peakCpuPercent: number;
  variance: number;
  passed: boolean;
  thresholdViolations: ThresholdViolation[];
  timestamp: number;
  durationMs: number;
}

export interface ThresholdViolation {
  metric: string;
  actual: number;
  threshold: number;
  severity: "warn" | "fail";
}

export interface BenchmarkRun {
  id: string;
  suite: string;
  config: BenchmarkConfig;
  results: BenchmarkResult[];
  summary: BenchmarkSummary;
  startedAt: number;
  completedAt: number;
  ciRun: boolean;
  commitSha: string | null;
  branch: string | null;
}

export interface BenchmarkSummary {
  total: number;
  passed: number;
  failed: number;
  totalDurationMs: number;
  meanDurationMs: number;
}

export interface BenchmarkDataset {
  name: string;
  description: string;
  size: number;
  generate: () => unknown[];
}

export interface TrendPoint {
  timestamp: number;
  label: string;
  p50: number;
  p90: number;
  p99: number;
  meanMs: number;
  meanMemoryMb: number;
  passed: boolean;
}

export interface TrendReport {
  suite: string;
  points: TrendPoint[];
  regression: boolean;
  regressions: string[];
  window: number;
}

export type BenchmarkStatus = "running" | "completed" | "failed" | "cancelled";

export interface BenchmarkEvent {
  type: "start" | "sample" | "result" | "error" | "complete";
  timestamp: number;
  label?: string;
  sample?: MetricSample;
  result?: BenchmarkResult;
  error?: string;
  run?: BenchmarkRun;
}

export type SbomFormat = "cyclonedx" | "spdx";
export type SbomSpecVersion = { cyclonedx: string; spdx: string };
export type ProvenanceSlsaLevel = "L1" | "L2" | "L3";
export type SigningProvider = "cosign-keyless" | "cosign-key" | "gpg" | "none";
export type ComponentName = "sdk" | "agent" | "contracts" | "web";

export interface SbomComponent {
  name: string;
  version: string;
  purl?: string;
  type: "library" | "application" | "framework" | "operating-system" | "device" | "file" | "container";
  licenses?: string[];
  supplier?: string;
  hashes?: {
    sha256?: string;
    sha512?: string;
  };
}

export interface SbomDocument {
  format: SbomFormat;
  specVersion: string;
  serialNumber?: string;
  generatedAt: string;
  toolName: string;
  toolVersion: string;
  subject: {
    name: string;
    version: string;
    component: ComponentName;
  };
  components: SbomComponent[];
  rawSizeBytes: number;
  sha256: string;
}

export interface ArtifactSignature {
  artifactName: string;
  artifactSha256: string;
  provider: SigningProvider;
  signatureSha256: string;
  certificateSha256?: string;
  oidcIssuer?: string;
  oidcIdentity?: string;
  signedAt: string;
  verified: boolean;
  verifiedAt?: string;
}

export interface IntotoSubject {
  name: string;
  digest: { sha256: string; sha512?: string };
}

export interface BuildProvenance {
  predicateType: string;
  slsaLevel: ProvenanceSlsaLevel;
  subjects: IntotoSubject[];
  buildType: string;
  invocationId: string;
  builderId: string;
  sourceRepo: string;
  sourceRef: string;
  sourceDigestSha1: string;
  startedAt: string;
  completedAt: string;
  workflowPath: string;
  actorId: string;
  rawSizeBytes: number;
}

export interface SbomAuditResult {
  component: ComponentName;
  tag: string;
  sboms: Array<{
    format: SbomFormat;
    present: boolean;
    schemaValid: boolean;
    signed: boolean;
    signatureValid: boolean;
    componentCount: number;
  }>;
  provenance: {
    present: boolean;
    slsaLevel: ProvenanceSlsaLevel | null;
    structureValid: boolean;
    subjectsCovered: string[];
  };
  artifacts: {
    total: number;
    signed: number;
    verified: number;
    missingSignature: string[];
    verificationFailed: string[];
  };
  generatedAt: string;
  durationMs: number;
  failureMode?: SbomFailureMode;
  failureDetail?: string;
}

export type SbomFailureMode =
  | "missing-sbom"
  | "invalid-sbom-schema"
  | "unsigned-sbom"
  | "invalid-signature"
  | "missing-provenance"
  | "invalid-provenance"
  | "missing-artifact-signature"
  | "artifact-verification-failed"
  | "digest-mismatch"
  | "certificate-expired"
  | "timeout"
  | "partial-failure";

export interface SbomMetricsSample {
  component: ComponentName;
  format: SbomFormat | "aggregate";
  timestamp: number;
  componentCount: number;
  generationDurationMs: number;
  signingDurationMs?: number;
  verificationDurationMs?: number;
  signingProvider: SigningProvider;
  slsaLevel: ProvenanceSlsaLevel;
  success: boolean;
  failureMode?: SbomFailureMode;
  artifactSizeBytes: number;
  signatureSizeBytes: number;
  provenanceSizeBytes: number;
}

export interface SbomThresholdRule {
  component?: ComponentName;
  format?: SbomFormat;
  maxComponentCount?: number;
  minSignatureValidityDays?: number;
  requireSigning: boolean;
  requireProvenance: boolean;
  minSlsaLevel: ProvenanceSlsaLevel;
}

export interface SbomConfig {
  enabled: boolean;
  retentionDays: number;
  formats: SbomFormat[];
  signingProvider: SigningProvider;
  slsaTarget: ProvenanceSlsaLevel;
  strictVerification: boolean;
  components: ComponentName[];
  artifactDir: string;
  digestManifestPath: string;
  oidcIssuerExpected: string;
  oidcIdentityRegex: string;
  thresholds: SbomThresholdRule[];
  metricsEnabled: boolean;
  logRedactSignatures: boolean;
  nightlyVerification: boolean;
}

export interface SbomStateTransition {
  from: "pending" | "generating" | "signing" | "uploading" | "verifying" | "complete" | "failed";
  to: "pending" | "generating" | "signing" | "uploading" | "verifying" | "complete" | "failed";
  at: number;
  component: ComponentName;
  trigger: string;
  detail?: string;
  failureMode?: SbomFailureMode;
}