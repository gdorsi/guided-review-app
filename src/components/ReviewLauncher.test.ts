import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const reviewLauncherPath = new URL("./ReviewLauncher.tsx", import.meta.url);

test("ReviewLauncher exposes PR history instead of the saved-review modal", async () => {
	const src = await readFile(reviewLauncherPath, "utf8");

	assert.match(src, /listSavedReviewsForRepo/);
	assert.match(src, /historySourceFromSavedReview/);
	assert.match(src, /startFreshReview\(res,\s*true\)/);
	assert.doesNotMatch(src, /HistoryStatusBadge/);
	assert.doesNotMatch(src, /review\.is_stale/);
	assert.doesNotMatch(src, /Saved review found/);
	assert.doesNotMatch(src, /pendingSavedStart/);
});

test("ReviewLauncher exposes Codex effort controls and sends selected effort", async () => {
	const src = await readFile(reviewLauncherPath, "utf8");

	assert.match(src, /supports_reasoning_effort/);
	assert.match(src, /reasoning_effort_options/);
	assert.match(src, /loadSelectedAgentReasoningEffort/);
	assert.match(src, /saveSelectedAgentReasoningEffort/);
	assert.match(src, /reasoning_effort: selectedReasoningEffort \?\? undefined/);
	assert.match(src, /<option value="">Default<\/option>/);
});

test("ReviewLauncher asks for a PR description before the section map when needed", async () => {
	const src = await readFile(reviewLauncherPath, "utf8");

	assert.match(src, /```acp-pr-description/);
	assert.match(src, /This review has no GitHub PR description/);
	assert.match(src, /Before emitting the section map/);
	assert.match(src, /acp-section-map/);
	assert.doesNotMatch(src, /```acp-spec/);
	assert.doesNotMatch(src, /SPEC/);
});
