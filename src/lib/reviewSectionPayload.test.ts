import assert from "node:assert/strict";
import test from "node:test";
import {
	parseDisplayMessagePayload,
	parseReviewSectionPayload,
	parseSectionMapPayload,
	parseSectionProgressPayload,
} from "./reviewSectionPayload";

test("parseSectionMapPayload accepts section files and ignores agent ranges", () => {
	const map = parseSectionMapPayload({
		sections: [
			{
				section_id: "validation-flow",
				title: "Validation flow",
				intent: "Checks before saving.",
				files: ["src/lib/store.ts"],
				ranges: [
					{
						file_path: "src/lib/store.ts",
						start_line: 10,
						end_line: 20,
						kind: "changed-new",
					},
				],
			},
		],
	});

	assert.deepEqual(map, {
		schema_version: 1,
		sections: [
			{
				section_id: "validation-flow",
				title: "Validation flow",
				intent: "Checks before saving.",
				files: ["src/lib/store.ts"],
			},
		],
	});
});

test("parseReviewSectionPayload accepts feedback-only sections", () => {
	const section = parseReviewSectionPayload({
		section_id: "validation-flow",
		concerns: [
			{
				text: "Empty input can still be submitted.",
				severity: "medium",
				file_path: "src/lib/store.ts",
				line: 148,
			},
		],
		grill_questions: [
			{
				question_id: "empty-body-contract",
				title: "Empty body contract",
				question: "Should an empty body return 400?",
				pr_choice: "The PR allows it through.",
				recommended_answer: "Return 400 before persistence.",
				file_path: "src/lib/store.ts",
				line: 148,
			},
		],
		pause_prompt: "Want to leave a comment?",
	});

	assert.equal(section?.section_id, "validation-flow");
	assert.equal(section?.title, "");
	assert.deepEqual(section?.files, []);
	assert.deepEqual(section?.ranges, []);
	assert.deepEqual(section?.concerns, [
		{
			text: "Empty input can still be submitted.",
			severity: "medium",
			file_path: "src/lib/store.ts",
			line: 148,
		},
	]);
	assert.deepEqual(section?.grill_questions, [
		{
			schema_version: 1,
			question_id: "empty-body-contract",
			title: "Empty body contract",
			question: "Should an empty body return 400?",
			pr_choice: "The PR allows it through.",
			recommended_answer: "Return 400 before persistence.",
			file_path: "src/lib/store.ts",
			line: 148,
			files: [],
			ranges: [],
		},
	]);
	assert.equal(section?.pause_prompt, "Want to leave a comment?");
});

test("parseSectionProgressPayload accepts progressive range updates", () => {
	const update = parseSectionProgressPayload({
		section_id: "validation-flow",
		phase: "ranges",
		title: "Validation flow",
		intent: "Checks that happen before saving.",
		files: ["src/lib/store.ts"],
		ranges: [
			{
				file_path: "src/lib/store.ts",
				start_line: 120,
				end_line: 180,
				kind: "changed-new",
			},
		],
	});

	assert.deepEqual(update, {
		section_id: "validation-flow",
		phase: "ranges",
		title: "Validation flow",
		intent: "Checks that happen before saving.",
		files: ["src/lib/store.ts"],
		ranges: [
			{
				file_path: "src/lib/store.ts",
				start_line: 120,
				end_line: 180,
				kind: "changed-new",
			},
		],
	});
});

test("parseDisplayMessagePayload accepts visible markdown from ACP tool input", () => {
	assert.deepEqual(parseDisplayMessagePayload({ markdown: "Looks good." }), {
		markdown: "Looks good.",
	});
	assert.deepEqual(parseDisplayMessagePayload({ message: "Use this path." }), {
		markdown: "Use this path.",
	});
	assert.equal(parseDisplayMessagePayload({ markdown: "" }), null);
	assert.equal(parseDisplayMessagePayload({ markdown: "   " }), null);
});
