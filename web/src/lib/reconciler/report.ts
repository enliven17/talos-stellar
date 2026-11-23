/**
 * Transition report generation for the reconciler.
 *
 * Allows replaying sequences of Horizon observations against a transaction record
 * to produce a deterministic transition report.
 */

import { computeTransition } from "./state-machine";
import type {
  TxRecord,
  ReconcilerConfig,
  ReconcilerObservation,
  ReconcilerTransitionReport,
} from "./types";

/**
 * Generates a transition report by replaying a sequence of observations
 * against the initial state of a transaction record.
 */
export function generateTransitionReport(
  initialState: TxRecord,
  observations: ReconcilerObservation[],
  config: ReconcilerConfig,
): ReconcilerTransitionReport {
  const steps: ReconcilerTransitionReport["steps"] = [];
  let currentState = { ...initialState };

  for (const observation of observations) {
    const update = computeTransition(
      currentState,
      observation.pollResult,
      observation.currentLedger,
      config,
      observation.now,
    );

    const resultingState = update
      ? { ...currentState, ...update }
      : { ...currentState };

    steps.push({
      observation,
      update,
      resultingState,
    });

    currentState = resultingState;
  }

  return {
    initialState,
    steps,
  };
}
