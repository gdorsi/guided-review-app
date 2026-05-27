import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("App starts the next unloaded section after final section feedback arrives", async () => {
	const source = await readFile(new URL("./App.tsx", import.meta.url), "utf8");

	assert.match(source, /findNextSectionToAutoLoad/);
	assert.match(source, /startNextSectionAfter/);
	assert.match(source, /auto_load_next/);
});

test("App shows saved-review freshness only for the loaded review", async () => {
	const source = await readFile(new URL("./App.tsx", import.meta.url), "utf8");

	assert.match(source, /saved_review_is_stale/);
	assert.match(source, /Saved review is stale/);
	assert.match(source, /Saved review matches the current PR head/);
});

test("App renders guided display-message tool calls as processed assistant chat", async () => {
	const source = await readFile(new URL("./App.tsx", import.meta.url), "utf8");

	assert.match(source, /parseToolDisplayMessage/);
	assert.match(source, /parseDisplayMessagePayload/);
	assert.match(source, /replaceStreaming: true/);
	assert.match(source, /finishAssistantMessage\(p\.session_id\)/);
});

test("App listens for PR description events instead of SPEC events", async () => {
	const source = await readFile(new URL("./App.tsx", import.meta.url), "utf8");

	assert.match(source, /acp:\/\/pr-description/);
	assert.match(source, /setPrDescriptionBody/);
	assert.doesNotMatch(source, /acp:\/\/spec/);
	assert.doesNotMatch(source, /setSpecBody/);
});

test("App forwards response text chunks as response chat", async () => {
	const source = await readFile(new URL("./App.tsx", import.meta.url), "utf8");

	assert.match(source, /kind:\s*p\.kind/);
});
