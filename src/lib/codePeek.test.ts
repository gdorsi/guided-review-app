import assert from "node:assert/strict";
import test from "node:test";
import { selectPeekLines } from "./codePeek";

test("selectPeekLines centers on the target line", () => {
	const lines = selectPeekLines("one\ntwo\nthree\nfour", 2);
	assert.deepEqual(
		lines.map((l) => [l.number, l.text, l.isTarget]),
		[
			[1, "one", false],
			[2, "two", true],
			[3, "three", false],
		],
	);
});

test("selectPeekLines clamps at file start", () => {
	const lines = selectPeekLines("one\ntwo\nthree", 1);
	assert.equal(lines.length, 2);
	assert.equal(lines[0]?.isTarget, true);
});

test("selectPeekLines clamps at file end", () => {
	const lines = selectPeekLines("one\ntwo\nthree", 3);
	assert.equal(lines.length, 2);
	assert.equal(lines[1]?.isTarget, true);
	assert.equal(lines[1]?.text, "three");
});

test("selectPeekLines returns nothing for invalid input", () => {
	assert.deepEqual(selectPeekLines("", 1), []);
	assert.deepEqual(selectPeekLines("a\nb", 0), []);
});
