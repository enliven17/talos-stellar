import { MockEnvironmentProvider, formatEnvironmentName } from "./environments";

async function main() {
  const command = process.argv[2];
  const prNumberStr = process.argv[3];
  const branch = process.argv[4] || "unknown-branch";

  if (!command || !prNumberStr) {
    console.error("Usage: tsx env-cli.ts <provision|teardown> <prNumber> [branch]");
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
    } else {
      console.error(`Unknown command: ${command}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`Failed to execute ${command}:`, err);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
