import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("SectionList shows grouped section concerns under the expanded Overview row", async () => {
	const source = await readFile(
		new URL("./SectionList.tsx", import.meta.url),
		"utf8",
	);

	assert.match(source, /sectionConcernGroups\(sections\)/);
	assert.match(source, /s\.kind === "pr_description" && isSelected/);
	assert.match(source, /group\.title/);
	assert.match(source, /title=\{`Concerns: \$\{group\.title\}`\}/);
});

test("SectionList shows grill questions as question-only section feedback", async () => {
	const source = await readFile(
		new URL("./SectionList.tsx", import.meta.url),
		"utf8",
	);

	assert.doesNotMatch(source, /reviewMode/);
	assert.match(source, /Sections/);
	assert.match(source, /sectionQuestions\(s\)/);
	assert.match(source, /QuestionList/);
	assert.match(source, /title=\{`Questions: \$\{group\.title\}`\}/);
	assert.match(source, /question\.question/);
	assert.doesNotMatch(source, /pr_choice/);
	assert.doesNotMatch(source, /recommended_answer/);
	assert.doesNotMatch(source, /Agree with PR/);
	assert.doesNotMatch(source, /Use recommendation/);
});

test("SectionList renders the compact submit action in the comments footer", async () => {
	const source = await readFile(
		new URL("./SectionList.tsx", import.meta.url),
		"utf8",
	);

	assert.match(source, /import \{ SubmitReviewButton \} from "\.\/SubmitReviewButton";/);
	assert.match(source, /function CommentDraftsFooter/);
	assert.match(source, /<SubmitReviewButton compact \/>/);
});
