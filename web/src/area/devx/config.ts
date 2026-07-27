import { BenchmarkConfig, SbomConfig, SbomFormat, ComponentName, ProvenanceSlsaLevel, SigningProvider } from "./types";

const DEFAULTS: BenchmarkConfig = {
  runs: 100,
  warmupRuns: 10,
  concurrency: 1,
  timeoutMs: 30_000,
  datasetSize: 1000,
  percentiles: [50, 75, 90, 95, 99],
  varianceThreshold: 0.15,
  memoryThresholdMb: 512,
  cpuThresholdPercent: 80,
  artifactDir: process.env.BENCHMARK_ARTIFACT_DIR ?? ".benchmarks",
  trendWindow: 10,
};

export function loadConfig(overrides?: Partial<BenchmarkConfig>): BenchmarkConfig {
  const env: Partial<BenchmarkConfig> = {};

  if (process.env.BENCHMARK_RUNS) env.runs = Number(process.env.BENCHMARK_RUNS);
  if (process.env.BENCHMARK_WARMUP_RUNS) env.warmupRuns = Number(process.env.BENCHMARK_WARMUP_RUNS);
  if (process.env.BENCHMARK_CONCURRENCY) env.concurrency = Number(process.env.BENCHMARK_CONCURRENCY);
  if (process.env.BENCHMARK_TIMEOUT_MS) env.timeoutMs = Number(process.env.BENCHMARK_TIMEOUT_MS);
  if (process.env.BENCHMARK_DATASET_SIZE) env.datasetSize = Number(process.env.BENCHMARK_DATASET_SIZE);
  if (process.env.BENCHMARK_VARIANCE_THRESHOLD) env.varianceThreshold = Number(process.env.BENCHMARK_VARIANCE_THRESHOLD);
  if (process.env.BENCHMARK_MEMORY_THRESHOLD_MB) env.memoryThresholdMb = Number(process.env.BENCHMARK_MEMORY_THRESHOLD_MB);
  if (process.env.BENCHMARK_CPU_THRESHOLD_PCT) env.cpuThresholdPercent = Number(process.env.BENCHMARK_CPU_THRESHOLD_PCT);
  if (process.env.BENCHMARK_ARTIFACT_DIR) env.artifactDir = process.env.BENCHMARK_ARTIFACT_DIR;
  if (process.env.BENCHMARK_TREND_WINDOW) env.trendWindow = Number(process.env.BENCHMARK_TREND_WINDOW);

  return { ...DEFAULTS, ...env, ...overrides };
}

const SBOM_DEFAULTS: SbomConfig = {
  enabled: true,
  retentionDays: 90,
  formats: ["cyclonedx", "spdx"],
  signingProvider: "cosign-keyless",
  slsaTarget: "L3",
  strictVerification: true,
  components: ["sdk", "agent", "contracts", "web"],
  artifactDir: process.env.SBOM_ARTIFACT_DIR ?? ".sbom-artifacts",
  digestManifestPath: process.env.SBOM_DIGEST_MANIFEST ?? ".sbom-artifacts/digest-manifest.txt",
  oidcIssuerExpected: "https://token.actions.githubusercontent.com",
  oidcIdentityRegex: process.env.SBOM_OIDC_IDENTITY_REGEX ??
    "^https://github.com/.+/(talos-stellar|.+)/.github/workflows/(release-publish|sbom-provenance)\\.yml@.*",
  thresholds: [
    {
      requireSigning: true,
      requireProvenance: true,
      minSlsaLevel: "L3",
    },
  ],
  metricsEnabled: true,
  logRedactSignatures: true,
  nightlyVerification: true,
};

export function loadSbomConfig(overrides?: Partial<SbomConfig>): SbomConfig {
  const env: Partial<SbomConfig> = {};

  if (process.env.SBOM_ENABLED !== undefined) env.enabled = process.env.SBOM_ENABLED !== "0" && process.env.SBOM_ENABLED !== "false";
  if (process.env.SBOM_RETENTION_DAYS) env.retentionDays = Number(process.env.SBOM_RETENTION_DAYS);
  if (process.env.SBOM_FORMATS) {
    const vals = process.env.SBOM_FORMATS.split(",");
    const parsed = vals.map((v) => v.trim() as SbomFormat).filter((v) => v === "cyclonedx" || v === "spdx");
    if (parsed.length) env.formats = parsed;
  }
  if (process.env.SBOM_SIGNING_PROVIDER) {
    const p = process.env.SBOM_SIGNING_PROVIDER as SigningProvider;
    if ((["cosign-keyless", "cosign-key", "gpg", "none"] as SigningProvider[]).includes(p)) {
      env.signingProvider = p;
    }
  }
  if (process.env.SBOM_SLSA_TARGET) {
    const l = process.env.SBOM_SLSA_TARGET as ProvenanceSlsaLevel;
    if ((["L1", "L2", "L3"] as ProvenanceSlsaLevel[]).includes(l)) env.slsaTarget = l;
  }
  if (process.env.SBOM_STRICT_VERIFY !== undefined) {
    env.strictVerification = process.env.SBOM_STRICT_VERIFY !== "0" && process.env.SBOM_STRICT_VERIFY !== "false";
  }
  if (process.env.SBOM_COMPONENTS) {
    const vals = process.env.SBOM_COMPONENTS.split(",");
    const parsed = vals
      .map((v) => v.trim() as ComponentName)
      .filter((v) => (["sdk", "agent", "contracts", "web"] as ComponentName[]).includes(v));
    if (parsed.length) env.components = parsed;
  }
  if (process.env.SBOM_ARTIFACT_DIR) env.artifactDir = process.env.SBOM_ARTIFACT_DIR;
  if (process.env.SBOM_DIGEST_MANIFEST) env.digestManifestPath = process.env.SBOM_DIGEST_MANIFEST;
  if (process.env.SBOM_OIDC_ISSUER) env.oidcIssuerExpected = process.env.SBOM_OIDC_ISSUER;
  if (process.env.SBOM_OIDC_IDENTITY_REGEX) env.oidcIdentityRegex = process.env.SBOM_OIDC_IDENTITY_REGEX;
  if (process.env.SBOM_METRICS !== undefined) {
    env.metricsEnabled = process.env.SBOM_METRICS !== "0" && process.env.SBOM_METRICS !== "false";
  }
  if (process.env.SBOM_REDACT_LOGS !== undefined) {
    env.logRedactSignatures = process.env.SBOM_REDACT_LOGS !== "0" && process.env.SBOM_REDACT_LOGS !== "false";
  }
  if (process.env.SBOM_NIGHTLY !== undefined) {
    env.nightlyVerification = process.env.SBOM_NIGHTLY !== "0" && process.env.SBOM_NIGHTLY !== "false";
  }

  return { ...SBOM_DEFAULTS, ...env, ...overrides };
}