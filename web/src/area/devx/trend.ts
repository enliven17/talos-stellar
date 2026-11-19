import { TrendPoint, TrendReport, BenchmarkRun } from "./types";
import { listArtifacts, loadArtifact } from "./artifacts";

export function buildTrendReport(suite: string, artifactDir: string, window: number): TrendReport {
  const files = listArtifacts(artifactDir).slice(0, window);
  const points: TrendPoint[] = [];

  for (const file of files) {
    const run = loadArtifact(file);
    if (!run || run.suite !== suite) continue;
    for (const result of run.results) {
      points.push({
        timestamp: result.timestamp,
        label: result.label,
        p50: result.percentiles.p50,
        p90: result.percentiles.p90,
        p99: result.percentiles.p99,
        meanMs: result.meanMs,
        meanMemoryMb: result.meanMemoryMb,
        passed: result.passed,
      });
    }
  }

  points.sort((a, b) => a.timestamp - b.timestamp);

  const regressions: string[] = [];
  let regression = false;

  if (points.length >= 2) {
    const byLabel = new Map<string, TrendPoint[]>();
    for (const p of points) {
      const arr = byLabel.get(p.label) ?? [];
      arr.push(p);
      byLabel.set(p.label, arr);
    }

    for (const [, pts] of byLabel) {
      if (pts.length < 2) continue;
      const latest = pts[pts.length - 1];
      const prev = pts[pts.length - 2];
      const degradation = ((latest.p99 - prev.p99) / Math.max(1, prev.p99)) * 100;
      if (degradation > 10) {
        regressions.push(`${latest.label}: p99 increased ${degradation.toFixed(1)}% (${prev.p99.toFixed(1)}ms → ${latest.p99.toFixed(1)}ms)`);
        regression = true;
      }
      const memDegradation = ((latest.meanMemoryMb - prev.meanMemoryMb) / Math.max(1, prev.meanMemoryMb)) * 100;
      if (memDegradation > 20) {
        regressions.push(`${latest.label}: memory increased ${memDegradation.toFixed(1)}% (${prev.meanMemoryMb.toFixed(1)}MB → ${latest.meanMemoryMb.toFixed(1)}MB)`);
        regression = true;
      }
    }
  }

  return { suite, points, regression, regressions, window };
}

export function formatTrendReport(report: TrendReport): string {
  const lines: string[] = [
    `Trend Report: ${report.suite}`,
    `Window: ${report.points.length} data points across ${report.window} runs`,
    `Status: ${report.regression ? "REGRESSION DETECTED" : "OK"}`,
    "",
  ];

  if (report.regressions.length > 0) {
    lines.push("Regressions:");
    for (const r of report.regressions) {
      lines.push(`  - ${r}`);
    }
    lines.push("");
  }

  const byLabel = new Map<string, TrendPoint[]>();
  for (const p of report.points) {
    const arr = byLabel.get(p.label) ?? [];
    arr.push(p);
    byLabel.set(p.label, arr);
  }

  for (const [label, pts] of byLabel) {
    const latest = pts[pts.length - 1];
    lines.push(`${label}:`);
    lines.push(`  Latest: p50=${latest.p50.toFixed(1)}ms, p90=${latest.p90.toFixed(1)}ms, p99=${latest.p99.toFixed(1)}ms, mem=${latest.meanMemoryMb.toFixed(1)}MB`);
    if (pts.length > 1) {
      const prev = pts[pts.length - 2];
      lines.push(`  Previous: p99=${prev.p99.toFixed(1)}ms, mem=${prev.meanMemoryMb.toFixed(1)}MB`);
      lines.push(`  Trend: ${pts.length} measurements`);
    }
    lines.push("");
  }

  return lines.join("\n");
}