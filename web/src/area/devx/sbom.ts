import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import {
  SbomFormat,
  SbomDocument,
  SbomComponent,
  SbomAuditResult,
  SbomFailureMode,
  SbomMetricsSample,
  SbomStateTransition,
  SbomConfig,
  BuildProvenance,
  ArtifactSignature,
  IntotoSubject,
  ProvenanceSlsaLevel,
  ComponentName,
  SigningProvider,
  SbomThresholdRule,
} from "./types";
import { logger, sanitizeForLogging } from "./logger";

export function sha256Buffer(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function sha256File(filepath: string): string {
  return sha256Buffer(fs.readFileSync(filepath));
}

export function computeSbomDigests(dir: string) {
  const entries: Array<{ name: string; sha256: string; sizeBytes: number }> = [];
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  for (const f of files) {
    const fp = path.join(dir, f);
    if (fs.statSync(fp).isFile()) {
      entries.push({ name: f, sha256: sha256File(fp), sizeBytes: fs.statSync(fp).size });
    }
  }
  return entries;
}

export function validateCycloneDxJson(raw: string): {
  valid: boolean;
  components: SbomComponent[];
  specVersion?: string;
  error?: SbomFailureMode;
  errorDetail?: string;
  component: SbomDocument["subject"];
} {
  try {
    const j = JSON.parse(raw);
    if (j.bomFormat !== "CycloneDX") {
      return { valid: false, components: [], error: "invalid-sbom-schema", errorDetail: "bad bomFormat", component: { name: "", version: "", component: "sdk" } };
    }
    const meta = j.metadata || {};
    const subjectComp = meta.component || {};
    const rawComponents = (j.components || []) as Array<Record<string, unknown>>;
    const components: SbomComponent[] = rawComponents.map((c) => ({
      name: String(c.name || ""),
      version: String(c.version || ""),
      purl: c.purl ? String(c.purl) : undefined,
      type: (c.type as SbomComponent["type"]) || "library",
      licenses: Array.isArray(c.licenses)
        ? c.licenses.map((l: { id?: string; name?: string }) => String(l.id || l.name || ""))
        : undefined,
      supplier: c.supplier ? String((c.supplier as Record<string, unknown>).name || c.supplier) : undefined,
    }));
    return {
      valid: true,
      components,
      specVersion: String(j.specVersion || "1.6"),
      component: {
        name: String(subjectComp.name || meta.project || "talos"),
        version: String(subjectComp.version || "0.0.0"),
        component: "sdk",
      },
    };
  } catch (e) {
    return {
      valid: false,
      components: [],
      error: "invalid-sbom-schema",
      errorDetail: e instanceof Error ? e.message : String(e),
      component: { name: "", version: "", component: "sdk" },
    };
  }
}

export function validateSpdxText(raw: string): {
  valid: boolean;
  components: SbomComponent[];
  spdxVersion?: string;
  error?: SbomFailureMode;
  errorDetail?: string;
  component: SbomDocument["subject"];
} {
  const lines = raw.split("\n");
  const requiredFieldStarts = [
    "SPDXVersion:",
    "DataLicense:",
    "SPDXID: SPDXRef-DOCUMENT",
    "DocumentName:",
    "DocumentNamespace:",
    "Created:",
    "Creator:",
  ];
  for (const r of requiredFieldStarts) {
    if (!lines.some((l) => l.startsWith(r))) {
      return {
        valid: false,
        components: [],
        error: "invalid-sbom-schema",
        errorDetail: `missing SPDX field starting with: ${r}`,
        component: { name: "", version: "", component: "sdk" },
      };
    }
  }
  const pkgStarts = lines.filter((l) => l.startsWith("PackageName:")).map((l) => l.slice("PackageName:".length).trim());
  const components: SbomComponent[] = pkgStarts.map((name) => ({ name, version: "", type: "library" }));
  const verMatches: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("PackageName:")) {
      const nm = lines[i].slice("PackageName:".length).trim();
      for (let j = i; j < Math.min(i + 10, lines.length); j++) {
        if (lines[j].startsWith("PackageVersion:")) {
          verMatches[nm] = lines[j].slice("PackageVersion:".length).trim();
          break;
        }
      }
    }
  }
  for (const c of components) if (verMatches[c.name]) c.version = verMatches[c.name];
  const subjectName = pkgStarts[0] || "talos";
  const subjectVersion = verMatches[subjectName] || "0.0.0";
  return {
    valid: true,
    components,
    spdxVersion: lines.find((l) => l.startsWith("SPDXVersion:"))?.split(":")[1]?.trim() || "SPDX-2.3",
    component: { name: subjectName, version: subjectVersion, component: "sdk" },
  };
}

export function loadSbomDocument(filepath: string): SbomDocument | null {
  try {
    const rawBuf = fs.readFileSync(filepath);
    const raw = rawBuf.toString("utf8");
    const name = path.basename(filepath);
    const format: SbomFormat = /\.cdx\.json$/.test(name) ? "cyclonedx" : "spdx";
    const checked =
      format === "cyclonedx"
        ? validateCycloneDxJson(raw)
        : validateSpdxText(raw);
    if (!checked.valid) {
      logger.warn({ path: filepath, mode: checked.error, detail: checked.errorDetail }, "Sbom validation failed on load");
      return null;
    }
    return {
      format,
      specVersion: checked.specVersion || checked.spdxVersion || "unknown",
      generatedAt: new Date().toISOString(),
      toolName: "talos-devx-sbom-validator",
      toolVersion: "1.0.0",
      subject: checked.component,
      components: checked.components,
      rawSizeBytes: rawBuf.length,
      sha256: sha256Buffer(rawBuf),
    };
  } catch (e) {
    logger.error({ path: filepath, error: e instanceof Error ? e.message : String(e) }, "Failed to load SBOM");
    return null;
  }
}

export function writeSbomAuditArtifact(result: SbomAuditResult, dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const safeTag = result.tag.replace(/[^A-Za-z0-9._-]/g, "_");
  const filename = `sbom-audit-${result.component}-${safeTag}-${Date.now()}.json`;
  const fp = path.join(dir, filename);
  const toSerialize = { ...result };
  if (toSerialize.artifacts) {
    toSerialize.artifacts = {
      ...toSerialize.artifacts,
      missingSignature: toSerialize.artifacts.missingSignature.map((n) => n.replace(/[^A-Za-z0-9._-]/g, "_")),
      verificationFailed: toSerialize.artifacts.verificationFailed.map((n) => n.replace(/[^A-Za-z0-9._-]/g, "_")),
    };
  }
  fs.writeFileSync(fp, JSON.stringify(toSerialize, null, 2));
  logSbomAuditResult(result, fp);
  return fp;
}

export function logSbomAuditResult(result: SbomAuditResult, artifactPath?: string): void {
  const safe = sanitizeForLogging({
    component: result.component,
    tag: result.tag,
    durationMs: result.durationMs,
    failureMode: result.failureMode,
    artifactPath,
    sbomCount: result.sboms.length,
    sbomValid: result.sboms.filter((s) => s.schemaValid).length,
    sbomSigned: result.sboms.filter((s) => s.signed && s.signatureValid).length,
    provenance: {
      present: result.provenance.present,
      structureValid: result.provenance.structureValid,
      level: result.provenance.slsaLevel,
      subjects: result.provenance.subjectsCovered.length,
    },
    artifacts: {
      total: result.artifacts.total,
      signed: result.artifacts.signed,
      verified: result.artifacts.verified,
    },
  });
  if (result.failureMode) {
    logger.warn(safe, "Sbom audit completed with findings");
  } else {
    logger.info(safe, "Sbom audit completed clean");
  }
}

export function logSbomStateTransition(t: SbomStateTransition): void {
  const safe = sanitizeForLogging({
    component: t.component,
    from: t.from,
    to: t.to,
    trigger: t.trigger,
    at: new Date(t.at).toISOString(),
    failureMode: t.failureMode,
    detail: t.detail?.slice(0, 256),
  });
  logger.info(safe, `Sbom state transition ${t.from} → ${t.to}`);
}

export function recordSbomMetric(sample: SbomMetricsSample, dir?: string): SbomMetricsSample {
  logger.info(
    sanitizeForLogging({
      component: sample.component,
      format: sample.format,
      componentCount: sample.componentCount,
      generationDurationMs: sample.generationDurationMs,
      signingDurationMs: sample.signingDurationMs,
      verificationDurationMs: sample.verificationDurationMs,
      signingProvider: sample.signingProvider,
      slsaLevel: sample.slsaLevel,
      success: sample.success,
      failureMode: sample.failureMode,
      artifactSizeBytes: sample.artifactSizeBytes,
      signatureSizeBytes: sample.signatureSizeBytes,
      provenanceSizeBytes: sample.provenanceSizeBytes,
    }),
    "Sbom metrics sample recorded",
  );
  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
    const filename = `sbom-metrics-${sample.component}-${sample.format}-${sample.timestamp}.json`;
    fs.writeFileSync(path.join(dir, filename), JSON.stringify(sample, null, 2));
  }
  return sample;
}

export function summarizeSbomMetrics(samples: SbomMetricsSample[]) {
  const successes = samples.filter((s) => s.success).length;
  const failures = samples.length - successes;
  const failureModes: Record<string, number> = {};
  for (const s of samples) {
    if (s.failureMode) failureModes[s.failureMode] = (failureModes[s.failureMode] || 0) + 1;
  }
  const componentCounts = samples.map((s) => s.componentCount);
  const mean = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  const percentile = (arr: number[], p: number) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)];
  };
  return {
    totalSamples: samples.length,
    successes,
    failures,
    successRate: samples.length ? successes / samples.length : 0,
    failureModes,
    componentCount: {
      mean: mean(componentCounts),
      p50: percentile(componentCounts, 50),
      p95: percentile(componentCounts, 95),
      p99: percentile(componentCounts, 99),
    },
    generationDurationMs: {
      mean: mean(samples.map((s) => s.generationDurationMs)),
      p95: percentile(samples.map((s) => s.generationDurationMs), 95),
    },
    signingDurationMs: {
      mean: mean(samples.map((s) => s.signingDurationMs || 0)),
      p95: percentile(samples.map((s) => s.signingDurationMs || 0), 95),
    },
    totalArtifactBytes: samples.reduce((sum, s) => sum + s.artifactSizeBytes, 0),
    totalSignatureBytes: samples.reduce((sum, s) => sum + s.signatureSizeBytes, 0),
    totalProvenanceBytes: samples.reduce((sum, s) => sum + s.provenanceSizeBytes, 0),
  };
}

export function validateSbomThresholds(
  samples: SbomMetricsSample[],
  thresholds: SbomThresholdRule[],
): Array<{ component?: ComponentName; threshold: SbomThresholdRule; violated: string; sample?: SbomMetricsSample }> {
  const violations: Array<{ component?: ComponentName; threshold: SbomThresholdRule; violated: string; sample?: SbomMetricsSample }> = [];
  for (const rule of thresholds) {
    const relevant = samples.filter(
      (s) => (!rule.component || s.component === rule.component) && (!rule.format || s.format === rule.format || s.format === "aggregate"),
    );
    for (const s of relevant) {
      if (rule.requireSigning && s.signingProvider === "none") {
        violations.push({ component: rule.component, threshold: rule, violated: "signing required but provider=none", sample: s });
      }
      if (rule.requireProvenance && s.provenanceSizeBytes === 0) {
        violations.push({ component: rule.component, threshold: rule, violated: "provenance required but size=0", sample: s });
      }
      const order: ProvenanceSlsaLevel[] = ["L1", "L2", "L3"];
      if (order.indexOf(s.slsaLevel) < order.indexOf(rule.minSlsaLevel)) {
        violations.push({ component: rule.component, threshold: rule, violated: `SLSA ${s.slsaLevel} below min ${rule.minSlsaLevel}`, sample: s });
      }
      if (rule.maxComponentCount && s.componentCount > rule.maxComponentCount) {
        violations.push({ component: rule.component, threshold: rule, violated: `component count ${s.componentCount} > ${rule.maxComponentCount}`, sample: s });
      }
    }
  }
  return violations;
}

export function validateIntotoStatement(raw: string): {
  valid: boolean;
  statement: BuildProvenance | null;
  subjects: IntotoSubject[];
  error?: SbomFailureMode;
  errorDetail?: string;
} {
  try {
    const stmt = JSON.parse(raw);
    if (stmt["_type"] !== "https://in-toto.io/Statement/v1") {
      return { valid: false, statement: null, subjects: [], error: "invalid-provenance", errorDetail: "bad _type" };
    }
    if (!Array.isArray(stmt.subject) || stmt.subject.length === 0) {
      return { valid: false, statement: null, subjects: [], error: "invalid-provenance", errorDetail: "bad subject list" };
    }
    const subjects: IntotoSubject[] = stmt.subject.map((s: Record<string, unknown>) => ({
      name: String(s.name || ""),
      digest: { sha256: String((s.digest as Record<string, string> | undefined)?.sha256 || ""), sha512: (s.digest as Record<string, string> | undefined)?.sha512 },
    }));
    for (const s of subjects) {
      if (!/^[0-9a-f]{64}$/.test(s.digest.sha256)) {
        return { valid: false, statement: null, subjects: [], error: "invalid-provenance", errorDetail: `bad sha256 for ${s.name}` };
      }
    }
    const pred = stmt.predicate || {};
    const bd = pred.buildDefinition || {};
    const rd = pred.runDetails || {};
    const extp = bd.externalParameters || {};
    const src = extp.source || {};
    const md = rd.metadata || {};
    const provenance: BuildProvenance = {
      predicateType: stmt.predicateType,
      slsaLevel: "L3",
      subjects,
      buildType: bd.buildType || "",
      invocationId: md.invocationId || "",
      builderId: rd.builder?.id || "",
      sourceRepo: src.uri ? String(src.uri).replace(/^git\+/, "").replace(/@.*$/, "") : "",
      sourceRef: String(src.uri || "").split("@")[1] || "",
      sourceDigestSha1: src.digest?.sha1 || "",
      startedAt: md.startedOn || "",
      completedAt: md.completedOn || "",
      workflowPath: extp.workflow?.path || "",
      actorId: bd.internalParameters?.github?.actor_id || "",
      rawSizeBytes: Buffer.byteLength(raw, "utf8"),
    };
    return { valid: true, statement: provenance, subjects };
  } catch (e) {
    return { valid: false, statement: null, subjects: [], error: "invalid-provenance", errorDetail: e instanceof Error ? e.message : String(e) };
  }
}

export function auditArtifactsAgainstProvenance(
  artifactDir: string,
  provenanceSubjects: IntotoSubject[],
): { missing: string[]; mismatched: Array<{ name: string; expected: string; actual: string }>; covered: string[] } {
  const digests = new Map(computeSbomDigests(artifactDir).map((e) => [e.name, e]));
  const covered: string[] = [];
  const missing: string[] = [];
  const mismatched: Array<{ name: string; expected: string; actual: string }> = [];
  for (const s of provenanceSubjects) {
    const a = digests.get(s.name);
    if (!a) {
      missing.push(s.name);
      continue;
    }
    covered.push(s.name);
    if (a.sha256 !== s.digest.sha256) {
      mismatched.push({ name: s.name, expected: s.digest.sha256, actual: a.sha256 });
    }
  }
  return { missing, mismatched, covered };
}

export function validateSignatureIdentity(
  sig: Pick<ArtifactSignature, "oidcIssuer" | "oidcIdentity">,
  expected: { oidcIssuer: string; identityRegex: string },
): { valid: boolean; reason?: string } {
  if (!sig.oidcIssuer) return { valid: false, reason: "no oidcIssuer in signature metadata" };
  if (sig.oidcIssuer !== expected.oidcIssuer) {
    return { valid: false, reason: `issuer mismatch: ${sig.oidcIssuer} != ${expected.oidcIssuer}` };
  }
  if (!sig.oidcIdentity) return { valid: false, reason: "no oidcIdentity on signature" };
  try {
    const re = new RegExp(expected.identityRegex);
    if (!re.test(sig.oidcIdentity)) {
      return { valid: false, reason: `identity ${sig.oidcIdentity} does not match ${expected.identityRegex}` };
    }
  } catch (e) {
    return { valid: false, reason: `identity regex invalid: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { valid: true };
}
