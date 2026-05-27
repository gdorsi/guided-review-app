import assert from "node:assert/strict";
import test from "node:test";
import { findNextSectionToAutoLoad } from "./sectionQueue";
import type { SectionState } from "./store";

function prDescription(): SectionState {
	return {
		id: "pr-description",
		kind: "pr_description",
		title: "PR description",
		intent: "Overview",
		status: "in_review",
		body: "Summary",
	};
}

function reviewSection(
	id: string,
	overrides: Partial<Extract<SectionState, { kind: "review_section" }>> = {},
): SectionState {
	return {
		id,
		kind: "review_section",
		title: id,
		intent: id,
		status: "pending",
		...overrides,
	};
}

test("findNextSectionToAutoLoad returns the next pending review section", () => {
	const sections: SectionState[] = [
		prDescription(),
		reviewSection("overview", { feedbackLoaded: true }),
		reviewSection("tests"),
	];

	const next = findNextSectionToAutoLoad(sections, "overview", []);

	assert.equal(next?.id, "tests");
});

test("findNextSectionToAutoLoad skips sections with final feedback loaded", () => {
	const sections: SectionState[] = [
		prDescription(),
		reviewSection("overview", { feedbackLoaded: true }),
		reviewSection("tests", { feedbackLoaded: true }),
		reviewSection("cleanup"),
	];

	const next = findNextSectionToAutoLoad(sections, "overview", []);

	assert.equal(next?.id, "cleanup");
});

test("findNextSectionToAutoLoad stops when the next unloaded section is already processing", () => {
	const sections: SectionState[] = [
		reviewSection("overview", { feedbackLoaded: true }),
		reviewSection("tests"),
		reviewSection("cleanup"),
	];

	const next = findNextSectionToAutoLoad(sections, "overview", ["tests"]);

	assert.equal(next, null);
});

test("findNextSectionToAutoLoad stops at the end instead of wrapping", () => {
	const sections: SectionState[] = [
		reviewSection("overview"),
		reviewSection("tests", { feedbackLoaded: true }),
	];

	const next = findNextSectionToAutoLoad(sections, "tests", []);

	assert.equal(next, null);
});

test("findNextSectionToAutoLoad never returns the PR description section", () => {
	const sections: SectionState[] = [
		reviewSection("overview", { feedbackLoaded: true }),
		prDescription(),
		reviewSection("tests"),
	];

	const next = findNextSectionToAutoLoad(sections, "overview", []);

	assert.equal(next?.id, "tests");
});
