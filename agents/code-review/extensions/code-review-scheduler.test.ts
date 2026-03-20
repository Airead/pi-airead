import { describe, expect, it } from "vitest";
import type { CycleState, DailyStats, SafetyLimits } from "./code-review-utils.js";
import {
	calculateBackoffInterval,
	decideCycleRecovery,
	decideLoopAction,
	decidePostCycle,
	shouldIncrementDailyStats,
} from "./code-review-scheduler.js";

// ============================================================================
// calculateBackoffInterval
// ============================================================================

describe("calculateBackoffInterval", () => {
	const BASE = 3600_000; // 1 hour

	it("returns base interval when no failures", () => {
		expect(calculateBackoffInterval(BASE, 0)).toBe(BASE);
	});

	it("doubles interval after 1 failure", () => {
		expect(calculateBackoffInterval(BASE, 1)).toBe(BASE * 2);
	});

	it("quadruples interval after 2 failures", () => {
		expect(calculateBackoffInterval(BASE, 2)).toBe(BASE * 4);
	});

	it("applies 2^n multiplier for n failures", () => {
		expect(calculateBackoffInterval(BASE, 3)).toBe(BASE * 8);
		expect(calculateBackoffInterval(BASE, 5)).toBe(BASE * 32);
	});

	it("returns 0 when base interval is 0", () => {
		expect(calculateBackoffInterval(0, 3)).toBe(0);
	});

	it("works with fractional base interval", () => {
		expect(calculateBackoffInterval(360_000, 1)).toBe(720_000);
	});
});

// ============================================================================
// decideLoopAction
// ============================================================================

describe("decideLoopAction", () => {
	const limits: SafetyLimits = { maxConsecutiveFailures: 5, maxCyclesPerDay: 20 };
	const today = "2026-03-20";

	function stats(cycleCount: number): DailyStats {
		return { date: today, cycleCount };
	}

	it("returns run-cycle under normal conditions", () => {
		const result = decideLoopAction(true, 0, stats(0), today, limits);
		expect(result).toEqual({ action: "run-cycle" });
	});

	it("returns stop-inactive when loop is not active", () => {
		const result = decideLoopAction(false, 0, stats(0), today, limits);
		expect(result).toEqual({ action: "stop-inactive" });
	});

	it("returns wait-blocked when daily limit reached", () => {
		const result = decideLoopAction(true, 0, stats(20), today, limits);
		expect(result.action).toBe("wait-blocked");
		if (result.action === "wait-blocked") {
			expect(result.retryMs).toBe(3600_000);
			expect(result.reason).toContain("Daily cycle limit");
		}
	});

	it("returns wait-blocked when circuit breaker is active", () => {
		const result = decideLoopAction(true, 5, stats(0), today, limits);
		expect(result.action).toBe("wait-blocked");
		if (result.action === "wait-blocked") {
			expect(result.reason).toContain("Circuit breaker");
		}
	});

	it("returns run-cycle when stats are from a different day (rollover)", () => {
		const oldStats: DailyStats = { date: "2026-03-19", cycleCount: 99 };
		const result = decideLoopAction(true, 0, oldStats, today, limits);
		expect(result).toEqual({ action: "run-cycle" });
	});

	it("returns run-cycle when just below daily limit", () => {
		const result = decideLoopAction(true, 0, stats(19), today, limits);
		expect(result).toEqual({ action: "run-cycle" });
	});

	it("returns run-cycle when failures below threshold", () => {
		const result = decideLoopAction(true, 4, stats(0), today, limits);
		expect(result).toEqual({ action: "run-cycle" });
	});
});

// ============================================================================
// decidePostCycle
// ============================================================================

describe("decidePostCycle", () => {
	const MAX = 5;

	it("returns schedule-next when no failures", () => {
		expect(decidePostCycle(0, MAX)).toEqual({ action: "schedule-next" });
	});

	it("returns schedule-next when failures below threshold", () => {
		expect(decidePostCycle(4, MAX)).toEqual({ action: "schedule-next" });
	});

	it("returns stop-circuit-breaker when failures reach threshold", () => {
		expect(decidePostCycle(5, MAX)).toEqual({
			action: "stop-circuit-breaker",
			failures: 5,
		});
	});

	it("returns stop-circuit-breaker when failures exceed threshold", () => {
		expect(decidePostCycle(7, MAX)).toEqual({
			action: "stop-circuit-breaker",
			failures: 7,
		});
	});

	it("works with threshold of 1", () => {
		expect(decidePostCycle(1, 1)).toEqual({
			action: "stop-circuit-breaker",
			failures: 1,
		});
	});
});

// ============================================================================
// shouldIncrementDailyStats
// ============================================================================

describe("shouldIncrementDailyStats", () => {
	it("returns true when cycle ran and no new failures", () => {
		expect(shouldIncrementDailyStats(true, 2, 2)).toBe(true);
	});

	it("returns true when cycle ran and failures were reset to 0", () => {
		expect(shouldIncrementDailyStats(true, 3, 0)).toBe(true);
	});

	it("returns false when cycle did not run", () => {
		expect(shouldIncrementDailyStats(false, 0, 0)).toBe(false);
	});

	it("returns false when cycle ran but new failure was added", () => {
		expect(shouldIncrementDailyStats(true, 2, 3)).toBe(false);
	});

	it("returns true when cycle ran with 0 prev and 0 current", () => {
		expect(shouldIncrementDailyStats(true, 0, 0)).toBe(true);
	});
});

// ============================================================================
// decideCycleRecovery
// ============================================================================

describe("decideCycleRecovery", () => {
	it("returns fresh-start when status is idle", () => {
		const result = decideCycleRecovery({ status: "idle" });
		expect(result).toEqual({ action: "fresh-start" });
	});

	it("returns resume-verify for verifying status with valid code file", () => {
		const cycle: CycleState = { status: "verifying", file: "src/main.ts", repo: "o/r" };
		const result = decideCycleRecovery(cycle);
		expect(result).toEqual({ action: "resume-verify", file: "src/main.ts" });
	});

	it("returns restart-review for reviewing status with valid code file", () => {
		const cycle: CycleState = { status: "reviewing", file: "src/main.ts", repo: "o/r" };
		const result = decideCycleRecovery(cycle);
		expect(result).toEqual({ action: "restart-review", file: "src/main.ts" });
	});

	it("returns skip-recovery when file is a test file (excluded by isCodeFile)", () => {
		const cycle: CycleState = { status: "reviewing", file: "src/main.test.ts", repo: "o/r" };
		const result = decideCycleRecovery(cycle);
		expect(result.action).toBe("skip-recovery");
		if (result.action === "skip-recovery") {
			expect(result.reason).toContain("src/main.test.ts");
		}
	});

	it("returns skip-recovery when file is in node_modules", () => {
		const cycle: CycleState = { status: "verifying", file: "node_modules/pkg/index.js", repo: "o/r" };
		const result = decideCycleRecovery(cycle);
		expect(result.action).toBe("skip-recovery");
	});

	it("returns skip-recovery when file is undefined", () => {
		const cycle: CycleState = { status: "reviewing", repo: "o/r" };
		const result = decideCycleRecovery(cycle);
		expect(result.action).toBe("skip-recovery");
		if (result.action === "skip-recovery") {
			expect(result.reason).toContain("unknown");
		}
	});

	it("returns skip-recovery when file is a non-code extension", () => {
		const cycle: CycleState = { status: "reviewing", file: "README.md", repo: "o/r" };
		const result = decideCycleRecovery(cycle);
		expect(result.action).toBe("skip-recovery");
	});

	it("handles .go files as valid code files", () => {
		const cycle: CycleState = { status: "verifying", file: "pkg/server.go", repo: "o/r" };
		const result = decideCycleRecovery(cycle);
		expect(result).toEqual({ action: "resume-verify", file: "pkg/server.go" });
	});

	it("handles .py files in __tests__ as excluded", () => {
		const cycle: CycleState = { status: "reviewing", file: "__tests__/test_main.py", repo: "o/r" };
		const result = decideCycleRecovery(cycle);
		expect(result.action).toBe("skip-recovery");
	});
});
