import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("DiffView does not render pending diff reference labels inline", async () => {
	const source = await readFile(
		new URL("./DiffView.tsx", import.meta.url),
		"utf8",
	);

	assert.equal(source.includes("Tagged "), false);
});

test("DiffView does not render section pause prompts", async () => {
	const source = await readFile(
		new URL("./DiffView.tsx", import.meta.url),
		"utf8",
	);

	assert.equal(source.includes("pause_prompt"), false);
	assert.equal(
		source.includes("Questions on this section, or should I move to the next one?"),
		false,
	);
});

test("DiffView does not render section feedback in a bottom panel", async () => {
	const source = await readFile(
		new URL("./DiffView.tsx", import.meta.url),
		"utf8",
	);

	assert.equal(source.includes("section!.concerns.map"), false);
	assert.equal(source.includes("border-t border-border px-6 py-4"), false);
	assert.equal(source.includes("sectionFeedbackToDiffAnnotations"), true);
});

test("DiffView keeps per-file collapsed state locally and passes it to Pierre", async () => {
	const source = await readFile(
		new URL("./DiffView.tsx", import.meta.url),
		"utf8",
	);

	assert.match(source, /collapsedFiles/);
	assert.match(source, /toggleFileCollapsed/);
	assert.match(source, /collapsedFiles\[b\.file_path\]/);
	assert.match(source, /collapsed,/);
	assert.doesNotMatch(source, /expandedFiles/);
	assert.doesNotMatch(source, /toggleFileExpanded/);
	assert.equal(source.includes("<Activity"), false);
	assert.match(source, /Collapse all/);
	assert.match(source, /Expand all/);
});

test("DiffView starts each section with delete-only files closed and other loaded files open", async () => {
	const source = await readFile(
		new URL("./DiffView.tsx", import.meta.url),
		"utf8",
	);

	assert.match(source, /setCollapsedFiles\(\{\}\)/);
	assert.match(source, /isDeletionOnlyDiff/);
	assert.match(source, /computeFileDiffStats\(/);
	assert.doesNotMatch(source, /defaultExpandedSectionsRef/);
	assert.doesNotMatch(source, /expandFiles\(allFilePaths\)/);
});

test("DiffView auto-expands the file the agent focuses on", async () => {
	const source = await readFile(
		new URL("./DiffView.tsx", import.meta.url),
		"utf8",
	);

	assert.match(source, /openFiles\(\[diffFocus\.file_path\]\)/);
});

test("DiffView auto-expands files with notes once per section", async () => {
	const source = await readFile(
		new URL("./DiffView.tsx", import.meta.url),
		"utf8",
	);

	assert.match(source, /filesWithNotes/);
	assert.match(source, /autoExpandedSectionsRef/);
	assert.match(source, /openFiles\(filesWithNotes\)/);
});

test("DiffView shows a progressive loading message before section files arrive", async () => {
	const source = await readFile(
		new URL("./DiffView.tsx", import.meta.url),
		"utf8",
	);

	assert.match(source, /sectionIsProcessing/);
	assert.match(source, /Agent is finding files and ranges/);
});

test("DiffView disables Pierre line selection", async () => {
	const source = await readFile(
		new URL("./DiffView.tsx", import.meta.url),
		"utf8",
	);

	assert.match(source, /enableLineSelection: false/);
	assert.doesNotMatch(source, /enableLineSelection: true/);
	assert.doesNotMatch(source, /onLineSelected/);
});

test("DiffView uses Pierre CodeView instead of per-file MultiFileDiff", async () => {
	const source = await readFile(
		new URL("./DiffView.tsx", import.meta.url),
		"utf8",
	);

	assert.match(source, /import \{ CodeView/);
	assert.match(source, /<CodeView/);
	assert.doesNotMatch(source, /MultiFileDiff/);
});

test("DiffView makes Pierre CodeView the vertical scroll container", async () => {
	const source = await readFile(
		new URL("./DiffView.tsx", import.meta.url),
		"utf8",
	);

	assert.match(
		source,
		/<CodeView[\s\S]*className="[^"]*overflow-x-hidden[^"]*overflow-y-auto[^"]*"/,
	);
});

test("DiffView offers a feedback request for preview-only sections", async () => {
	const source = await readFile(
		new URL("./DiffView.tsx", import.meta.url),
		"utf8",
	);

	assert.match(source, /requestSectionFeedback/);
	assert.match(source, /Load feedback/);
	assert.match(source, /formatPublishedCommentsForPrompt/);
	assert.match(source, /startSectionTask/);
	assert.match(source, /feedbackLoaded/);
});

test("DiffView does not render a synthetic Review Summary section", async () => {
	const source = await readFile(
		new URL("./DiffView.tsx", import.meta.url),
		"utf8",
	);

	assert.doesNotMatch(source, /ReviewSummaryView/);
	assert.doesNotMatch(source, /review_summary/);
});

test("DiffView renders grill questions as answerable inline annotations", async () => {
	const source = await readFile(
		new URL("./DiffView.tsx", import.meta.url),
		"utf8",
	);

	assert.match(source, /GrillQuestionAnnotation/);
	assert.match(source, /Agree with PR/);
	assert.match(source, /Use recommendation/);
	assert.match(source, /free-form answer/);
	assert.match(source, /questionAnswerPanelClassName/);
	assert.match(source, /min-w-0/);
	assert.match(source, /overflow-wrap:anywhere/);
	assert.match(source, /white-space:break-spaces/);
	assert.match(source, /sendGrillQuestionAnswer/);
	assert.match(source, /onAnswer=\{sendGrillQuestionAnswer\}/);
	assert.match(source, /note\.pr_choice \?\? ""/);
	assert.match(source, /note\.recommended_answer \?\? ""/);
	assert.match(source, /setGrillQuestionChoice/);
	assert.match(source, /selectedAnswer/);
	assert.match(source, /LoaderCircle/);
	assert.match(source, /Sending/);
	assert.match(source, /readOnly=\{sending\}/);
	assert.doesNotMatch(source, /setAnswer\(""\)/);
	assert.doesNotMatch(source, /sendAnswer\(note\.pr_choice \?\? ""\)/);
	assert.doesNotMatch(source, /sendAnswer\(note\.recommended_answer \?\? ""\)/);
	assert.doesNotMatch(source, /current\?\.kind === "grill_question"/);
});
