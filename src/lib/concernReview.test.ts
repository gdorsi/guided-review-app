import assert from "node:assert/strict";
import test from "node:test";
import { concernDraftId, concernToDraft, hashText } from "./concernReview";
import type { Concern } from "./types/section";

test("hashText is deterministic and differs by content", () => {
	assert.equal(hashText("hello"), hashText("hello"));
	assert.notEqual(hashText("hello"), hashText("world"));
});

test("concernDraftId is stable and varies by section/file/line/text", () => {
	const c: Concern = { text: "Null check", severity: "medium", file_path: "a.ts", line: 4 };
	const id = concernDraftId("sec1", c);
	assert.equal(id, concernDraftId("sec1", c));
	assert.ok(id.startsWith("concern:"));
	assert.notEqual(id, concernDraftId("sec2", c));
	assert.notEqual(id, concernDraftId("sec1", { ...c, line: 5 }));
	assert.notEqual(id, concernDraftId("sec1", { ...c, file_path: "b.ts" }));
	assert.notEqual(id, concernDraftId("sec1", { ...c, text: "Other" }));
});

test("concernToDraft builds an inline draft when file+line present", () => {
	const draft = concernToDraft({ text: "Null check", severity: "medium", file_path: "a.ts", line: 4 });
	assert.equal(draft.kind, "inline");
	assert.equal(draft.file_path, "a.ts");
	assert.equal(draft.line, 4);
	assert.equal(draft.side, "RIGHT");
	assert.match(draft.body, /\[medium\]/);
	assert.match(draft.body, /Null check/);
});

test("concernToDraft builds a top_level draft without file/line", () => {
	const draft = concernToDraft({ text: "Split the PR", severity: "low" });
	assert.equal(draft.kind, "top_level");
	assert.equal(draft.file_path, undefined);
	assert.equal(draft.line, undefined);
	assert.equal(draft.side, undefined);
	assert.match(draft.body, /\[low\] Split the PR/);
});
