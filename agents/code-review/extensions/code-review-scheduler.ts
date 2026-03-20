import { type CycleState, type DailyStats, type SafetyLimits, checkSafetyGates, isCodeFile } from "./code-review-utils.js";

// ============================================================================
// Backoff
// ============================================================================

/** Calculate the next scheduling interval with exponential backoff. */
export function calculateBackoffInterval(
	baseIntervalMs: number,
	consecutiveFailures: number,
): number {
	const multiplier = consecutiveFailures > 0 ? Math.pow(2, consecutiveFailures) : 1;
	return baseIntervalMs * multiplier;
}

// ============================================================================
// Loop Decision
// ============================================================================

export type LoopDecision =
	| { action: "run-cycle" }
	| { action: "wait-blocked"; reason: string; retryMs: number }
	| { action: "stop-inactive" };

/**
 * Decide what the loop should do at the start of each iteration.
 * Pure function — reads no external state.
 */
export function decideLoopAction(
	loopActive: boolean,
	consecutiveFailures: number,
	dailyStats: DailyStats,
	today: string,
	limits: SafetyLimits,
): LoopDecision {
	if (!loopActive) return { action: "stop-inactive" };

	const blocked = checkSafetyGates(consecutiveFailures, dailyStats, today, limits);
	if (blocked) {
		return { action: "wait-blocked", reason: blocked, retryMs: 3600_000 };
	}

	return { action: "run-cycle" };
}

// ============================================================================
// Post-Cycle Decision
// ============================================================================

export type PostCycleDecision =
	| { action: "schedule-next" }
	| { action: "stop-circuit-breaker"; failures: number };

/**
 * Decide what happens after a cycle completes (success or failure).
 * Covers both the normal post-cycle path and the catch-block path.
 */
export function decidePostCycle(
	currentFailures: number,
	maxConsecutiveFailures: number,
): PostCycleDecision {
	if (currentFailures >= maxConsecutiveFailures) {
		return { action: "stop-circuit-breaker", failures: currentFailures };
	}
	return { action: "schedule-next" };
}

// ============================================================================
// Daily Stats Increment
// ============================================================================

/**
 * Determine whether the daily cycle counter should be incremented.
 * Only counts cycles that actually ran without introducing new failures.
 */
export function shouldIncrementDailyStats(
	cycleRan: boolean,
	prevFailures: number,
	currentFailures: number,
): boolean {
	if (!cycleRan) return false;
	// Count if no new failures were added, or failures were reset to 0
	return currentFailures === prevFailures || currentFailures === 0;
}

// ============================================================================
// Crash Recovery Decision
// ============================================================================

export type CycleRecoveryDecision =
	| { action: "resume-verify"; file: string }
	| { action: "restart-review"; file: string }
	| { action: "skip-recovery"; reason: string }
	| { action: "fresh-start" };

/**
 * Decide how to handle a potentially incomplete cycle from a previous crash.
 * Uses isCodeFile to validate the recovery file still passes current filters.
 */
export function decideCycleRecovery(prevCycle: CycleState): CycleRecoveryDecision {
	if (prevCycle.status === "idle") {
		return { action: "fresh-start" };
	}

	const recoveryFile = prevCycle.file && isCodeFile(prevCycle.file) ? prevCycle.file : undefined;

	if (!recoveryFile) {
		return {
			action: "skip-recovery",
			reason: `${prevCycle.file ?? "unknown"} (file excluded by filter)`,
		};
	}

	if (prevCycle.status === "verifying") {
		return { action: "resume-verify", file: recoveryFile };
	}

	// status === "reviewing"
	return { action: "restart-review", file: recoveryFile };
}
