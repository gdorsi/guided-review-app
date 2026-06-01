import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const submitReviewButtonPath = new URL("./SubmitReviewButton.tsx", import.meta.url);

test("SubmitReviewButton shows the selected submit mode on the primary action", async () => {
	const src = await readFile(submitReviewButtonPath, "utf8");

	assert.match(src, /const selectedMode = MODES\.find\(\(m\) => m\.id === effectiveMode\) \?\? MODES\[0\];/);
	assert.match(src, /const submitLabel = selectedMode\.label;/);
	assert.match(src, /\{submitLabel\}/);
	assert.doesNotMatch(src, />\s*Submit review\s*</);
});

test("SubmitReviewButton has a compact sidebar variant", async () => {
	const src = await readFile(submitReviewButtonPath, "utf8");

	assert.match(src, /compact \? "flex w-full" : "inline-flex"/);
	assert.match(src, /compact \? "px-2\.5 py-1\.5 text-xs" : "px-4 py-2 text-sm"/);
	assert.match(src, /<span className="truncate">\{submitLabel\}<\/span>/);
});
