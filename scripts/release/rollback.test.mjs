// Unit coverage for rollback selector parsing and fail-closed behavior. These
// stay git-free by exercising the `--tag` path; the end-to-end release →
// rollback → re-release cycle lives in rollback-smoke.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveComponent,
  componentFromTag,
  resolveTarget,
  remoteCleanupCommands,
  RollbackInputError,
} from "./rollback.mjs";

test("resolveComponent accepts every released component", () => {
  for (const name of ["web", "sdk", "agent", "contracts"]) {
    assert.equal(resolveComponent(name).name, name);
  }
});

test("resolveComponent fails closed for an unknown component", () => {
  assert.throws(() => resolveComponent("nope"), RollbackInputError);
  assert.throws(() => resolveComponent("nope"), /unknown component "nope"/);
});

test("componentFromTag rejects a malformed tag", () => {
  for (const bad of ["sdk-1.2.3", "sdk-v1.2", "web-vlatest", "", null, undefined]) {
    assert.throws(() => componentFromTag(bad), /malformed tag/);
  }
});

test("componentFromTag maps a release tag back to its component", () => {
  assert.equal(componentFromTag("sdk-v1.2.3").name, "sdk");
  assert.equal(componentFromTag("contracts-v0.1.0-beta.2").name, "contracts");
});

test("componentFromTag rejects an unknown component prefix", () => {
  assert.throws(() => componentFromTag("other-v1.0.0"), /unknown component/);
});

test("resolveTarget fails closed when both selectors are given", () => {
  assert.throws(
    () => resolveTarget({ repoRoot: ".", componentName: "sdk", tag: "sdk-v1.0.0" }),
    /not both/,
  );
});

test("resolveTarget fails closed when no selector is given", () => {
  assert.throws(() => resolveTarget({ repoRoot: "." }), /--component=<name> or --tag=<tag>/);
});

test("remoteCleanupCommands is explicit and credential-free", () => {
  assert.deepEqual(remoteCleanupCommands("sdk-v1.2.3"), [
    "git push origin :refs/tags/sdk-v1.2.3",
    'gh release delete "sdk-v1.2.3" --yes',
  ]);
  for (const cmd of remoteCleanupCommands("sdk-v1.2.3")) {
    assert.doesNotMatch(cmd, /ghp_|GITHUB_TOKEN|GITHUB_PAT|-----BEGIN/);
  }
});
