import assert from "node:assert/strict";
import test from "node:test";
import {
	buildUpstreamChangeHint,
	findSectionsAffectedByChangedFiles,
	isPrBackedSession,
} from "./prUpdate";
import type { SessionInfo, SectionState } from "./store";

function reviewSection(id: string, files: string[]): SectionState {
	return {
		id,
		kind: "review_section",
		title: id,
		intent: id,
		status: "in_review",
		feedbackLoaded: true,
		section: {
			schema_version: 1,
			section_id: id,
			title: id,
			intent: id,
			files,
			ranges: [],
			concerns: [],
			grill_questions: [],
			base_ref: "origin/main",
			head_ref: "guided-review-pr-17",
			pause_prompt: "",
		},
	};
}

test("isPrBackedSession accepts PR-backed session sources", () => {
	const localPr = {
		session_id: "s1",
		repo: {
			path: "/tmp/review",
			head_ref: "guided-review-pr-17",
			head_sha: "abc",
			base_ref: "origin/main",
			display_slug: "review",
		},
		source: {
			kind: "local_pr",
			path: "/tmp/review",
			repo_url: "https://github.com/garden-co/review",
			number: 17,
		},
	} satisfies SessionInfo;

	assert.equal(isPrBackedSession(localPr), true);
	assert.equal(
		isPrBackedSession({
			...localPr,
			source: { kind: "local", path: "/tmp/review" },
		}),
		false,
	);
	assert.equal(isPrBackedSession(null), false);
});

test("findSectionsAffectedByChangedFiles uses file-list intersection", () => {
	const sections: SectionState[] = [
		{
			id: "pr-description",
			kind: "pr_description",
			title: "PR description",
			intent: "Overview",
			status: "in_review",
			body: "Summary",
		},
		reviewSection("api", ["src/api.ts", "src/shared.ts"]),
		reviewSection("tests", ["src/api.test.ts"]),
		reviewSection("docs", []),
	];

	const affected = findSectionsAffectedByChangedFiles(sections, [
		"src/shared.ts",
		"README.md",
	]);

	assert.deepEqual(
		affected.map((section) => section.id),
		["api"],
	);
});

test("buildUpstreamChangeHint lists changed files in sorted order", () => {
	const hint = buildUpstreamChangeHint(["src/b.ts", "src/a.ts"]);

	assert.match(hint, /PR changed upstream/);
	assert.match(hint, /- src\/a\.ts\n- src\/b\.ts/);
});
