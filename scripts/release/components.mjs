// The four release surfaces named in issue #264: web, agent, SDK, contracts.
// `contracts` bundles the three Soroban crates — they are built, deployed
// and versioned together (see contracts-ci.yml), so a single component with
// multiple lockstep manifests keeps their versions from drifting apart.
export const COMPONENTS = [
  {
    name: "web",
    paths: ["web/"],
    manifests: [{ file: "web/package.json", kind: "json" }],
    changelog: "web/CHANGELOG.md",
  },
  {
    name: "sdk",
    paths: ["packages/sdk/"],
    manifests: [{ file: "packages/sdk/package.json", kind: "json" }],
    changelog: "packages/sdk/CHANGELOG.md",
  },
  {
    name: "agent",
    paths: ["packages/prime-agent/"],
    manifests: [{ file: "packages/prime-agent/pyproject.toml", kind: "toml" }],
    changelog: "packages/prime-agent/CHANGELOG.md",
  },
  {
    name: "contracts",
    paths: ["contracts/"],
    manifests: [
      { file: "contracts/talos_registry/Cargo.toml", kind: "toml" },
      { file: "contracts/talos_name_service/Cargo.toml", kind: "toml" },
      { file: "contracts/talos_governance/Cargo.toml", kind: "toml" },
    ],
    changelog: "contracts/CHANGELOG.md",
  },
];
