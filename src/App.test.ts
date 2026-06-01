import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("App starts the next unloaded section after final section feedback arrives", async () => {
	const source = await readFile(new URL("./App.tsx", import.meta.url), "utf8");

	assert.match(source, /findNextSectionToAutoLoad/);
	assert.match(source, /startNextSectionAfter/);
	assert.match(source, /auto_load_next/);
});

test("App leaves saved-review freshness in the launcher controls", async () => {
	const source = await readFile(new URL("./App.tsx", import.meta.url), "utf8");

	assert.doesNotMatch(source, /SavedReviewFreshnessBadge/);
	assert.doesNotMatch(source, /Saved review is stale/);
	assert.doesNotMatch(source, /Saved review matches the current PR head/);
});

test("App header does not render the raw session ref label", async () => {
	const source = await readFile(new URL("./App.tsx", import.meta.url), "utf8");

	assert.doesNotMatch(source, /←/);
});

test("App exposes PR upstream update and reprocesses affected sections", async () => {
	const source = await readFile(new URL("./App.tsx", import.meta.url), "utf8");

	assert.match(source, /updatePrFromUpstream/);
	assert.match(source, /findSectionsAffectedByChangedFiles/);
	assert.match(source, /buildUpstreamChangeHint/);
	assert.match(source, /additional_concerns_hint/);
	assert.match(source, /Update/);
});

test("App passes PR update status into the launcher history area", async () => {
	const source = await readFile(new URL("./App.tsx", import.meta.url), "utf8");

	assert.match(source, /<ReviewLauncher\s+beforeHistory=/);
	assert.match(source, /isPrBackedSession\(session\) && prUpdateStatus/);
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

test("App does not route grill questions as a separate review mode", async () => {
	const source = await readFile(new URL("./App.tsx", import.meta.url), "utf8");

	assert.doesNotMatch(source, /acp:\/\/grill-question/);
	assert.doesNotMatch(source, /handleGrillQuestion/);
	assert.doesNotMatch(source, /parseToolGrillQuestion/);
	assert.doesNotMatch(source, /upsertGrillQuestion/);
	assert.doesNotMatch(source, /upsertGrillAnswer/);
	assert.doesNotMatch(source, /markGrillComplete/);
});
