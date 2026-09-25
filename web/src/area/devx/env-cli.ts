import { MockEnvironmentProvider, formatEnvironmentName } from "./environments";

async function main() {
  const command = process.argv[2];
  const prNumberStr = process.argv[3];
  const branch = process.argv[4] || "unknown-branch";

  if (!command || !prNumberStr) {
    console.error("Usage: tsx env-cli.ts <provision|teardown|cleanup> <prNumber> [branch]");
    process.exit(1);
  }

  const prNumber = parseInt(prNumberStr, 10);
  if (isNaN(prNumber)) {
    console.error("prNumber must be an integer");
    process.exit(1);
  }

  const provider = new MockEnvironmentProvider();

  try {
    if (command === "provision") {
      console.log(`Provisioning environment for PR #${prNumber} (branch: ${branch})...`);
      const meta = await provider.provision(prNumber, branch);
      console.log("Environment provisioned successfully:");
      console.log(JSON.stringify(meta, null, 2));
    } else if (command === "teardown") {
      console.log(`Tearing down environment for PR #${prNumber}...`);
      await provider.teardown(prNumber);
      console.log("Environment destroyed successfully.");
    } else if (command === "cleanup") {
      console.log(`Cleaning up environment for PR #${prNumber} after failure...`);
      await provider.cleanup(prNumber);
      console.log("Environment cleaned up successfully.");
    } else {
      console.error(`Unknown command: ${command}`);
      process.exit(1);
    }
  } catch (err) {
    const safeError = err instanceof Error ? err.message : "Unknown error occurred";
    console.error(`Failed to execute ${command}:`, safeError);
    process.exit(1);
  }
}

main().catch(err => {
  const safeError = err instanceof Error ? err.message : "Unknown error occurred";
  console.error("Fatal error:", safeError);
  process.exit(1);
});
