import assert from "node:assert/strict";
import test from "node:test";
import {
	sectionFeedbackToDiffAnnotations,
	sectionFeedbackTopNotes,
} from "./sectionFeedback";
import type { ReviewSection } from "./types/section";

function section(overrides: Partial<ReviewSection> = {}): ReviewSection {
	return {
		schema_version: 1,
		section_id: "diff-feedback",
		title: "Diff feedback",
		intent: "Review inline feedback.",
		files: ["src/main.ts"],
		ranges: [],
		concerns: [],
		grill_questions: [],
		base_ref: "base",
		head_ref: "head",
		pause_prompt: "",
		...overrides,
	};
}

test("section concerns with file and line become diff annotations", () => {
	const annotations = sectionFeedbackToDiffAnnotations(
		section({
			concerns: [
				{
					text: "This can publish an empty approved batch.",
					severity: "medium",
					file_path: "src/main.ts",
					line: 12,
				},
			],
		}),
		["src/main.ts"],
	);

	assert.equal(annotations.length, 1);
	assert.equal(annotations[0]?.lineNumber, 12);
	assert.equal(annotations[0]?.side, "additions");
	assert.deepEqual(annotations[0]?.metadata.notes, [
		{
			kind: "concern",
			label: "Concern",
			text: "This can publish an empty approved batch.",
			severity: "medium",
			file_path: "src/main.ts",
			line: 12,
		},
	]);
});

test("feedback without a line is shown in top notes", () => {
	const notes = sectionFeedbackTopNotes(
		section({
			concerns: [
				{
					text: "This section needs a broader error path check.",
					severity: "low",
				},
			],
		}),
		["src/main.ts"],
	);

	assert.deepEqual(notes, [
		{
			kind: "concern",
			label: "Concern",
			text: "This section needs a broader error path check.",
			severity: "low",
		},
	]);
});

test("multiple concerns on the same line are grouped", () => {
	const annotations = sectionFeedbackToDiffAnnotations(
		section({
			concerns: [
				{
					text: "This can fail silently.",
					severity: "medium",
					file_path: "src/main.ts",
					line: 12,
				},
				{
					text: "No test covers this failure.",
					severity: "low",
					file_path: "src/main.ts",
					line: 12,
				},
			],
		}),
		["src/main.ts"],
	);

	assert.equal(annotations.length, 1);
	assert.equal(annotations[0]?.metadata.notes.length, 2);
	assert.deepEqual(
		annotations[0]?.metadata.notes.map((note) => note.text),
		["This can fail silently.", "No test covers this failure."],
	);
});

test("grill questions in section feedback become inline diff annotations", () => {
	const annotations = sectionFeedbackToDiffAnnotations(
		section({
			grill_questions: [
				{
					question_id: "error-policy",
					title: "Error policy",
					question: "Should malformed agent output fail closed?",
					pr_choice: "The PR keeps the review going.",
					recommended_answer: "Fail closed when review state is ambiguous.",
					file_path: "src/main.ts",
					line: 12,
					agrees_with_pr: false,
				},
			],
		}),
		["src/main.ts"],
	);

	assert.equal(annotations.length, 1);
	assert.equal(annotations[0]?.lineNumber, 12);
	assert.deepEqual(annotations[0]?.metadata.notes, [
		{
			kind: "grill_question",
			label: "Question",
			question_id: "error-policy",
			title: "Error policy",
			text: "Should malformed agent output fail closed?",
			pr_choice: "The PR keeps the review going.",
			recommended_answer: "Fail closed when review state is ambiguous.",
			agrees_with_pr: false,
			file_path: "src/main.ts",
			line: 12,
		},
	]);
});

test("feedback for files outside the visible diff is shown in top notes", () => {
	const notes = sectionFeedbackTopNotes(
		section({
			concerns: [
				{
					text: "This concern points to a hidden file.",
					severity: "medium",
					file_path: "src/hidden.ts",
					line: 8,
				},
			],
		}),
		["src/main.ts"],
	);

	assert.deepEqual(notes, [
		{
			kind: "concern",
			label: "Concern",
			text: "This concern points to a hidden file.",
			severity: "medium",
			file_path: "src/hidden.ts",
			line: 8,
		},
	]);
});
