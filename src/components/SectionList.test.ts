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
