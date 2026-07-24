# Performance Benchmarks

This document describes the benchmark framework for the Talos Stellar API, scheduler, SDK, and contract-adjacent workflows.

## Overview

The benchmark system lives in `web/src/area/devx/` and provides:

- **Typed interfaces** for benchmark config, metrics, and results
- **Dataset generators** for reproducible benchmark inputs
- **Warm/cold run separation** — warmup runs establish baseline before measured runs
- **Percentile metrics** — p50, p75, p90, p95, p99 latency tracking
- **Memory/CPU tracking** — per-sample resource monitoring via `process.memoryUsage()` and `process.cpuUsage()`
- **Variance controls** — coefficient of variation (CV) tracking with configurable thresholds
- **Threshold gates** — pass/fail decisions based on configurable rules
- **Artifact persistence** — JSON artifacts written to `.benchmarks/` directory
- **Trend reporting** — cross-run comparison detecting regressions
- **Privacy-safe logging** — pino structured logger with sensitive-field redaction

## Quick Start

```bash
# Run all benchmark tests
pnpm test:bench

# Run a specific benchmark suite
pnpm test:bench -- --suite api-routes

# Set environment overrides
BENCHMARK_RUNS=50 BENCHMARK_VARIANCE_THRESHOLD=0.2 pnpm test:bench
```

## Architecture

```
web/src/area/devx/
  index.ts          # Public API exports
  types.ts          # Core TypeScript interfaces
  config.ts         # Configuration loading (env vars + overrides)
  metrics.ts        # Statistical functions (percentiles, mean, stddev)
  tracker.ts        # ResourceTracker — memory/CPU sampling
  datasets.ts       # Reproducible dataset generators
  runner.ts         # Benchmark orchestrator (warm/cold runs)
  thresholds.ts     # Threshold rule engine (pass/fail gates)
  artifacts.ts      # JSON artifact read/write
  trend.ts          # Trend analysis and regression detection
  logger.ts         # Privacy-safe pino logger
  __tests__/        # Unit test suite
```

## Configuration

All configuration is defined in the `BenchmarkConfig` interface. Values are loaded from environment variables or explicit overrides:

| Variable | Default | Description |
|---|---|---|
| `BENCHMARK_RUNS` | 100 | Number of measured iterations per benchmark |
| `BENCHMARK_WARMUP_RUNS` | 10 | Warmup iterations before measurement |
| `BENCHMARK_CONCURRENCY` | 1 | Concurrency level |
| `BENCHMARK_TIMEOUT_MS` | 30000 | Per-benchmark timeout |
| `BENCHMARK_DATASET_SIZE` | 1000 | Dataset size for generators |
| `BENCHMARK_VARIANCE_THRESHOLD` | 0.15 | Max acceptable coefficient of variation (warn) |
| `BENCHMARK_MEMORY_THRESHOLD_MB` | 512 | Peak memory threshold (fail) |
| `BENCHMARK_CPU_THRESHOLD_PCT` | 80 | Peak CPU threshold (warn) |
| `BENCHMARK_ARTIFACT_DIR` | `.benchmarks` | Output directory for artifact files |
| `BENCHMARK_TREND_WINDOW` | 10 | Number of past runs for trend comparison |

## Writing Benchmarks

```typescript
import { runBenchmark, runSuite, loadConfig } from "@/area/devx";

const config = loadConfig({ runs: 20 });

// Simple synchronous benchmark
const result = await runBenchmark({
  label: "my-benchmark",
  fn: () => {
    // code to measure
  },
  config,
});

// Suite of benchmarks
const run = await runSuite("my-suite", [
  { label: "bench-a", fn: () => { ... }, config },
  { label: "bench-b", fn: async () => { ... }, config },
], config);

console.log(run.summary);
// { total: 2, passed: 2, failed: 0, totalDurationMs: ..., meanDurationMs: ... }
```

## Dataset Generators

The `datasets.ts` module provides deterministic, seed-reproducible generators:

- `generateTalosIds(size, seed)` — random 24-char alphanumeric IDs
- `generatePayloads(size, seed)` — structured JSON payloads
- `generateActivityEntries(size, seed)` — activity log entries
- `generateTransferPayloads(size, seed)` — Stellar transfer payloads

All generators use a seeded PRNG for deterministic output across runs:

```typescript
const ids = generateTalosIds(100, 42); // Always produces the same 100 IDs
```

## Thresholds

Benchmark thresholds control pass/fail gates. Built-in rules:

| Metric | Default | Severity | Comparator |
|---|---|---|---|
| `variance` | 0.15 | warn | gt |
| `peakMemoryMb` | 512 | fail | gt |
| `peakCpuPercent` | 80 | warn | gt |

Custom rules can be added via the `BENCHMARK_THRESHOLD_RULES` env var as JSON:

```json
[
  { "metric": "meanDurationMs", "threshold": 2000, "severity": "fail", "comparator": "gt" },
  { "metric": "p99", "threshold": 5000, "severity": "fail", "comparator": "gt" }
]
```

## Artifacts

Benchmark runs produce JSON artifacts in the configured artifact directory:

```bash
.benchmarks/
  benchmark-api-routes-a1b2c3d4.json
  benchmark-scheduler-e5f6g7h8.json
```

Each artifact contains the full run configuration, summary, per-result stats, percentiles, and threshold violations.

## Trend Reporting

The trend system compares recent benchmark runs against historical data:

```typescript
import { buildTrendReport, formatTrendReport } from "@/area/devx";

const report = buildTrendReport("api-routes", ".benchmarks", 10);
if (report.regression) {
  console.warn("Performance regression detected:");
  report.regressions.forEach(r => console.warn(`  - ${r}`));
}
```

Regressions are flagged when:
- p99 latency increases by >10% between consecutive runs
- Mean memory usage increases by >20%

## Database Schema

Benchmark results can be persisted to the database via two tables:

- `tls_benchmark_runs` — run metadata (suite, config, summary, CI info)
- `tls_benchmark_results` — per-label results (percentiles, memory, CPU, violations)

Migration: `drizzle/0013_add_benchmark_tables.sql`

## Privacy & Security

The benchmark logger (`logger.ts`) automatically redacts sensitive fields from log output:

- API keys (matches `apiKey`, `secret`, `password`, `token`, `auth`, `signature`)
- Stellar secret keys

No benchmark data is transmitted externally. Artifacts are local files only.

## CI Integration

Benchmarks can run in CI via:

```yaml
- name: Run benchmarks
  run: pnpm test:bench
  env:
    BENCHMARK_RUNS: 20
    BENCHMARK_VARIANCE_THRESHOLD: 0.2
    CI: true
```

When `CI=true`:
- Logger uses raw JSON output (no pretty-print)
- CI fields (`commitSha`, `branch`) are populated from `GITHUB_SHA` and `GITHUB_REF_NAME`

## Rollback

To disable the benchmark system:
1. Remove benchmark test files or exclude from test runner
2. Drop `tls_benchmark_runs` and `tls_benchmark_results` tables if they exist
3. Remove migration `drizzle/0013_add_benchmark_tables.sql`

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| High variance in results | System load variation | Increase `BENCHMARK_RUNS`, ensure isolated environment |
| Thresholds failing on CI | CI runners are slower | Adjust `BENCHMARK_MEMORY_THRESHOLD_MB` or `BENCHMARK_VARIANCE_THRESHOLD` |
| Artifact directory missing | Wrong working directory | Set `BENCHMARK_ARTIFACT_DIR` to absolute path |
| Trend report empty | No prior artifacts | Run benchmarks, then re-run trend analysis |