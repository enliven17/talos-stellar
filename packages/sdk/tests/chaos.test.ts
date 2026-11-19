import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ChaosInjector,
  ChaosInjectedError,
  FaultType,
  globalChaosInjector,
} from "../src/chaos.js";

describe("ChaosInjector - Unit Tests (Deterministic)", () => {
  beforeEach(() => {
    globalChaosInjector.clearFaults();
    globalChaosInjector.setEnabled(true);
    globalChaosInjector.resetStats();
  });

  describe("Construction & Options", () => {
    it("should construct with default options", () => {
      const injector = new ChaosInjector();
      expect(injector.isEnabled()).toBe(true);
      expect(injector.injectionCount).toBe(0);
      expect(injector.getRegisteredFaults()).toEqual([]);
    });

    it("should construct with custom options", () => {
      const customRandom = () => 0.5;
      const injector = new ChaosInjector({
        enabled: false,
        random: customRandom,
      });
      expect(injector.isEnabled()).toBe(false);
    });

    it("should respect setEnabled toggles", () => {
      const injector = new ChaosInjector();
      expect(injector.isEnabled()).toBe(true);
      injector.setEnabled(false);
      expect(injector.isEnabled()).toBe(false);
      injector.setEnabled(true);
      expect(injector.isEnabled()).toBe(true);
    });
  });

  describe("Fault Registration", () => {
    it("should register a fault and report it via hasFault/getFault", () => {
      const injector = new ChaosInjector();
      const config = {
        type: FaultType.NETWORK_DROP,
        probability: 0.5,
      };
      injector.registerFault(config);
      expect(injector.hasFault(FaultType.NETWORK_DROP)).toBe(true);
      expect(injector.getFault(FaultType.NETWORK_DROP)).toEqual(config);
      expect(injector.getRegisteredFaults()).toEqual([FaultType.NETWORK_DROP]);
    });

    it("should unregister a specific fault", () => {
      const injector = new ChaosInjector();
      injector.registerFault({
        type: FaultType.NETWORK_DROP,
        probability: 1.0,
      });
      injector.registerFault({
        type: FaultType.NETWORK_DELAY,
        probability: 1.0,
        durationMs: 100,
      });
      expect(injector.getRegisteredFaults().length).toBe(2);

      injector.unregisterFault(FaultType.NETWORK_DROP);
      expect(injector.hasFault(FaultType.NETWORK_DROP)).toBe(false);
      expect(injector.hasFault(FaultType.NETWORK_DELAY)).toBe(true);
      expect(injector.getRegisteredFaults()).toEqual([FaultType.NETWORK_DELAY]);
    });

    it("should clear all faults", () => {
      const injector = new ChaosInjector();
      injector.registerFault({
        type: FaultType.NETWORK_DROP,
        probability: 1.0,
      });
      injector.registerFault({
        type: FaultType.DB_CONNECTION_FAIL,
        probability: 1.0,
      });
      expect(injector.getRegisteredFaults().length).toBe(2);

      injector.clearFaults();
      expect(injector.getRegisteredFaults()).toEqual([]);
      expect(injector.hasFault(FaultType.NETWORK_DROP)).toBe(false);
    });

    it("should throw RangeError for probability < 0", () => {
      const injector = new ChaosInjector();
      expect(() =>
        injector.registerFault({
          type: FaultType.NETWORK_DROP,
          probability: -0.1,
        }),
      ).toThrow(RangeError);
    });

    it("should throw RangeError for probability > 1", () => {
      const injector = new ChaosInjector();
      expect(() =>
        injector.registerFault({
          type: FaultType.NETWORK_DROP,
          probability: 1.1,
        }),
      ).toThrow(RangeError);
    });

    it("should accept probability boundaries 0 and 1", () => {
      const injector = new ChaosInjector();
      expect(() =>
        injector.registerFault({
          type: FaultType.NETWORK_DROP,
          probability: 0,
        }),
      ).not.toThrow();
      expect(() =>
        injector.registerFault({
          type: FaultType.API_TIMEOUT,
          probability: 1,
        }),
      ).not.toThrow();
    });
  });

  describe("Deterministic Probability (Seeded Random)", () => {
    it("should NEVER inject when probability = 0 (deterministic random returns 0)", async () => {
      const alwaysZero = () => 0;
      const injector = new ChaosInjector({ random: alwaysZero });
      injector.registerFault({
        type: FaultType.NETWORK_DROP,
        probability: 0,
      });

      for (let i = 0; i < 100; i++) {
        await injector.maybeInjectFault(FaultType.NETWORK_DROP);
      }
      expect(injector.injectionCount).toBe(0);
    });

    it("should NEVER inject when random >= probability (0.5 threshold, random returns 0.5)", async () => {
      const half = () => 0.5;
      const injector = new ChaosInjector({ random: half });
      injector.registerFault({
        type: FaultType.NETWORK_DROP,
        probability: 0.5,
      });

      for (let i = 0; i < 100; i++) {
        await injector.maybeInjectFault(FaultType.NETWORK_DROP);
      }
      expect(injector.injectionCount).toBe(0);
    });

    it("should ALWAYS inject when probability = 1.0 (any random < 1.0)", async () => {
      const alwaysHalf = () => 0.5;
      const injector = new ChaosInjector({ random: alwaysHalf });
      injector.registerFault({
        type: FaultType.NETWORK_DROP,
        probability: 1.0,
      });

      await expect(injector.maybeInjectFault(FaultType.NETWORK_DROP)).rejects.toThrow(
        ChaosInjectedError,
      );
      expect(injector.injectionCount).toBe(1);
    });

    it("should ALWAYS inject when random = 0 (below any non-zero probability)", async () => {
      const alwaysZero = () => 0;
      const injector = new ChaosInjector({ random: alwaysZero });
      injector.registerFault({
        type: FaultType.NETWORK_DROP,
        probability: 0.0001,
      });

      await expect(injector.maybeInjectFault(FaultType.NETWORK_DROP)).rejects.toThrow(
        ChaosInjectedError,
      );
      expect(injector.injectionCount).toBe(1);
    });

    it("should fire exactly on probability boundary with a sequence of deterministic values", async () => {
      const sequence = [0.1, 0.3, 0.5, 0.7, 0.9];
      let idx = 0;
      const seqRandom = () => sequence[idx++ % sequence.length];
      const injector = new ChaosInjector({ random: seqRandom });
      injector.registerFault({
        type: FaultType.NETWORK_DROP,
        probability: 0.4,
      });

      let thrownCount = 0;
      for (let i = 0; i < 5; i++) {
        try {
          await injector.maybeInjectFault(FaultType.NETWORK_DROP);
        } catch (e) {
          if (e instanceof ChaosInjectedError) thrownCount++;
        }
      }
      expect(thrownCount).toBe(2);
      expect(injector.injectionCount).toBe(2);
    });
  });

  describe("Enabled Flag", () => {
    it("should NOT inject faults when disabled, even with probability 1.0", async () => {
      const alwaysZero = () => 0;
      const injector = new ChaosInjector({
        enabled: false,
        random: alwaysZero,
      });
      injector.registerFault({
        type: FaultType.NETWORK_DROP,
        probability: 1.0,
      });

      await injector.maybeInjectFault(FaultType.NETWORK_DROP);
      expect(injector.injectionCount).toBe(0);
    });

    it("should resume injecting after re-enabling", async () => {
      const alwaysZero = () => 0;
      const injector = new ChaosInjector({ random: alwaysZero });
      injector.registerFault({
        type: FaultType.NETWORK_DROP,
        probability: 1.0,
      });

      injector.setEnabled(false);
      await injector.maybeInjectFault(FaultType.NETWORK_DROP);
      expect(injector.injectionCount).toBe(0);

      injector.setEnabled(true);
      await expect(injector.maybeInjectFault(FaultType.NETWORK_DROP)).rejects.toThrow(
        ChaosInjectedError,
      );
      expect(injector.injectionCount).toBe(1);
    });
  });

  describe("FaultType Behaviors", () => {
    const alwaysInject = () => 0;

    describe("NETWORK_DROP", () => {
      it("should throw ChaosInjectedError with correct faultType", async () => {
        const injector = new ChaosInjector({ random: alwaysInject });
        injector.registerFault({
          type: FaultType.NETWORK_DROP,
          probability: 1.0,
          message: "simulated drop",
        });

        try {
          await injector.maybeInjectFault(FaultType.NETWORK_DROP);
          expect.fail("should have thrown");
        } catch (e) {
          expect(e).toBeInstanceOf(ChaosInjectedError);
          const err = e as ChaosInjectedError;
          expect(err.faultType).toBe(FaultType.NETWORK_DROP);
          expect(err.message).toContain("simulated drop");
        }
      });
    });

    describe("DB_CONNECTION_FAIL", () => {
      it("should throw ChaosInjectedError", async () => {
        const injector = new ChaosInjector({ random: alwaysInject });
        injector.registerFault({
          type: FaultType.DB_CONNECTION_FAIL,
          probability: 1.0,
        });

        await expect(
          injector.maybeInjectFault(FaultType.DB_CONNECTION_FAIL),
        ).rejects.toThrow(ChaosInjectedError);
      });
    });

    describe("API_TIMEOUT", () => {
      it("should delay first, then throw", async () => {
        vi.useFakeTimers();
        const injector = new ChaosInjector({ random: alwaysInject });
        injector.registerFault({
          type: FaultType.API_TIMEOUT,
          probability: 1.0,
          durationMs: 5000,
        });

        const promise = injector.maybeInjectFault(FaultType.API_TIMEOUT);
        await vi.advanceTimersByTimeAsync(4999);
        const notYetResolved = await Promise.race([
          promise.then(() => "resolved" as const),
          Promise.resolve("pending" as const),
        ]);
        expect(notYetResolved).toBe("pending");

        await vi.advanceTimersByTimeAsync(1);
        await expect(promise).rejects.toThrow(ChaosInjectedError);
        vi.useRealTimers();
      });
    });

    describe("NETWORK_DELAY", () => {
      it("should delay for the specified duration but NOT throw", async () => {
        vi.useFakeTimers();
        const injector = new ChaosInjector({ random: alwaysInject });
        injector.registerFault({
          type: FaultType.NETWORK_DELAY,
          probability: 1.0,
          durationMs: 2000,
        });

        const startTime = Date.now();
        vi.useFakeTimers();
        const promise = injector.maybeInjectFault(FaultType.NETWORK_DELAY);
        await vi.advanceTimersByTimeAsync(2000);
        const result = await promise;
        vi.useRealTimers();
        expect(result).toBeUndefined();
        expect(injector.injectionCount).toBe(1);
      });
    });

    describe("SIGNATURE_VERIFICATION_SLOW", () => {
      it("should delay but NOT throw", async () => {
        vi.useFakeTimers();
        const injector = new ChaosInjector({ random: alwaysInject });
        injector.registerFault({
          type: FaultType.SIGNATURE_VERIFICATION_SLOW,
          probability: 1.0,
          durationMs: 300,
        });

        const promise = injector.maybeInjectFault(FaultType.SIGNATURE_VERIFICATION_SLOW);
        await vi.advanceTimersByTimeAsync(300);
        await expect(promise).resolves.toBeUndefined();
        expect(injector.injectionCount).toBe(1);
        vi.useRealTimers();
      });
    });

    describe("REPLAY_STORE_ERROR", () => {
      it("should throw ChaosInjectedError", async () => {
        const injector = new ChaosInjector({ random: alwaysInject });
        injector.registerFault({
          type: FaultType.REPLAY_STORE_ERROR,
          probability: 1.0,
          message: "redis connection lost",
        });

        try {
          await injector.maybeInjectFault(FaultType.REPLAY_STORE_ERROR);
          expect.fail("should have thrown");
        } catch (e) {
          expect(e).toBeInstanceOf(ChaosInjectedError);
          expect((e as ChaosInjectedError).message).toContain("redis connection lost");
        }
      });
    });
  });

  describe("Unregistered FaultType", () => {
    it("should do nothing when no fault is registered for the requested type", async () => {
      const alwaysZero = () => 0;
      const injector = new ChaosInjector({ random: alwaysZero });
      injector.registerFault({
        type: FaultType.NETWORK_DROP,
        probability: 1.0,
      });

      await injector.maybeInjectFault(FaultType.DB_CONNECTION_FAIL);
      expect(injector.injectionCount).toBe(0);
    });
  });

  describe("Stats & History", () => {
    it("should track injectionCount correctly", async () => {
      const alwaysZero = () => 0;
      const injector = new ChaosInjector({ random: alwaysZero });
      injector.registerFault({
        type: FaultType.NETWORK_DROP,
        probability: 1.0,
      });

      for (let i = 0; i < 5; i++) {
        try {
          await injector.maybeInjectFault(FaultType.NETWORK_DROP);
        } catch {
          /* ignore */
        }
      }
      expect(injector.injectionCount).toBe(5);
    });

    it("should record injectionHistory entries", async () => {
      const alwaysZero = () => 0;
      const injector = new ChaosInjector({ random: alwaysZero });
      injector.registerFault({
        type: FaultType.NETWORK_DROP,
        probability: 1.0,
        message: "hist-test",
      });

      try {
        await injector.maybeInjectFault(FaultType.NETWORK_DROP);
      } catch {
        /* ignore */
      }

      const history = injector.injectionHistory;
      expect(history.length).toBe(1);
      expect(history[0].type).toBe(FaultType.NETWORK_DROP);
      expect(history[0].config.message).toBe("hist-test");
      expect(history[0].timestamp).toBeInstanceOf(Date);
    });

    it("should resetStats to zero count and empty history", async () => {
      const alwaysZero = () => 0;
      const injector = new ChaosInjector({ random: alwaysZero });
      injector.registerFault({
        type: FaultType.NETWORK_DROP,
        probability: 1.0,
      });

      try {
        await injector.maybeInjectFault(FaultType.NETWORK_DROP);
      } catch {
        /* ignore */
      }
      expect(injector.injectionCount).toBe(1);
      expect(injector.injectionHistory.length).toBe(1);

      injector.resetStats();
      expect(injector.injectionCount).toBe(0);
      expect(injector.injectionHistory.length).toBe(0);
    });
  });

  describe("Logger Integration", () => {
    it("should call logger.warn on fault injection", async () => {
      const alwaysZero = () => 0;
      const warnSpy = vi.fn();
      const infoSpy = vi.fn();
      const injector = new ChaosInjector({
        random: alwaysZero,
        logger: {
          info: infoSpy,
          warn: warnSpy,
          error: vi.fn(),
        },
      });
      injector.registerFault({
        type: FaultType.NETWORK_DROP,
        probability: 1.0,
      });

      try {
        await injector.maybeInjectFault(FaultType.NETWORK_DROP);
      } catch {
        /* ignore */
      }

      expect(infoSpy).toHaveBeenCalledWith(
        "chaos:fault_registered",
        expect.any(Object),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        "chaos:fault_injected",
        expect.objectContaining({ type: FaultType.NETWORK_DROP }),
      );
    });
  });
});
