import assert from "node:assert";
import { ChaosInjector, FaultType } from "../packages/sdk/dist/esm/chaos.js";

function testChaosInjector() {
  console.log("Running network-failure chaos integration tests...");

  // Initialize with a 100% failure rate for predictable testing
  const injector = new ChaosInjector({ enabled: true, random: () => 0 });

  // 1. Boundary: Probability validation
  try {
    injector.registerFault({ type: FaultType.NETWORK_DROP, probability: -0.1 });
    assert.fail("Should have rejected negative probability");
  } catch (e) {
    assert.equal(e instanceof RangeError, true);
  }

  // 2. Malformed: Should not throw unexpected errors when unregistered fault is requested
  assert.equal(injector.hasFault(FaultType.NETWORK_DELAY), false);
  
  // 3. Dependency-failure (simulated)
  injector.registerFault({ type: FaultType.DB_CONNECTION_FAIL, probability: 1.0 });
  injector.maybeInjectFault(FaultType.DB_CONNECTION_FAIL)
    .then(() => assert.fail("Expected injection to throw"))
    .catch((e) => {
        assert.equal(e.name, "ChaosInjectedError");
        assert.equal(e.faultType, FaultType.DB_CONNECTION_FAIL);
    });

  // 4. Missing inputs (not providing a type when invoking maybeInjectFault should just skip gracefully or we rely on TS type check, but let's test if passed explicitly undefined)
  injector.maybeInjectFault(undefined).catch(() => assert.fail("Should not throw on undefined"));

  console.log("Deeper boundary integration tests passed.");
}

testChaosInjector();
