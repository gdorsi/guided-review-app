import assert from "node:assert/strict";
import test from "node:test";
import {
	buildAgentPublishCommentPrompt,
	sendMessageTelemetryAttrs,
	requestAgentPublishApprovedDrafts,
} from "./commentPublish";

test("sendMessageTelemetryAttrs suppresses private message preview", () => {
	const attrs = sendMessageTelemetryAttrs({
		session_id: "session-1",
		text: "private pending comment body",
		options: {
			origin: "review_launcher_kickoff",
			reason: "request_section_map",
			suppressPreview: true,
		},
	});

	assert.equal(attrs["message.length"], 28);
	assert.equal(attrs["message.preview"], undefined);
	assert.equal(Object.values(attrs).includes("private pending comment body"), false);
});

test("buildAgentPublishCommentPrompt includes all approved drafts", () => {
	const prompt = buildAgentPublishCommentPrompt({
		target: { owner: "garden-co", repo: "jazz", number: 787 },
		head_sha: "57d6bce6ed8e3750f829ff9e9a48b76615df11d6",
		drafts: [
			{
				id: "draft-inline",
				status: "approved",
				draft: {
					kind: "inline",
					body: "Please short-circuit this lookup.",
					file_path: "src/main.ts",
					line: 12,
					side: "RIGHT",
				},
			},
			{
				id: "draft-top",
				status: "approved",
				draft: {
					kind: "top_level",
					body: "This is a summary note.",
				},
			},
		],
	});

	assert.match(prompt, /garden-co\/jazz#787/);
	assert.match(prompt, /57d6bce6ed8e3750f829ff9e9a48b76615df11d6/);
	assert.match(prompt, /draft-inline/);
	assert.match(prompt, /src\/main\.ts/);
	assert.match(prompt, /"line": 12/);
	assert.match(prompt, /draft-top/);
	assert.match(prompt, /acp-comment-result/);
	assert.match(prompt, /Publish these comments using your own GitHub tools/);
});

test("requestAgentPublishApprovedDrafts sends one private agent publish prompt", async () => {
	const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
	const messages: Array<{
		session_id: string;
		text: string;
		options: unknown;
	}> = [];

	await requestAgentPublishApprovedDrafts({
		session_id: "session-1",
		target: { owner: "garden-co", repo: "jazz", number: 787 },
		head_sha: "57d6bce6ed8e3750f829ff9e9a48b76615df11d6",
		comment_drafts: [
			{
				id: "draft-1",
				marked: false,
				status: "approved",
				draft: { kind: "top_level", body: "Summary." },
			},
			{
				id: "draft-2",
				marked: false,
				status: "pending",
				draft: { kind: "top_level", body: "Not added yet." },
			},
		],
		updateCommentDraft: (id, patch) => updates.push({ id, patch }),
		sendMessage: async (session_id, text, options) => {
			messages.push({ session_id, text, options });
		},
	});

	assert.deepEqual(updates, [
		{ id: "draft-1", patch: { status: "publishing", error: undefined } },
	]);
	assert.equal(messages.length, 1);
	assert.equal(messages[0]?.session_id, "session-1");
	assert.match(messages[0]?.text ?? "", /draft-1/);
	assert.doesNotMatch(messages[0]?.text ?? "", /draft-2/);
	assert.deepEqual(messages[0]?.options, {
		origin: "comment_publish",
		reason: "publish_approved_drafts",
		suppressPreview: true,
	});
});

test("requestAgentPublishApprovedDrafts restores approved drafts when send fails", async () => {
	const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];

	await assert.rejects(
		requestAgentPublishApprovedDrafts({
			session_id: "session-1",
			target: { owner: "garden-co", repo: "jazz", number: 787 },
			head_sha: "57d6bce6ed8e3750f829ff9e9a48b76615df11d6",
			comment_drafts: [
				{
					id: "draft-1",
					marked: false,
					status: "approved",
					draft: { kind: "top_level", body: "Summary." },
				},
			],
			updateCommentDraft: (id, patch) => updates.push({ id, patch }),
			sendMessage: async () => {
				throw new Error("agent is busy");
			},
		}),
		/agent is busy/,
	);

	assert.deepEqual(updates, [
		{ id: "draft-1", patch: { status: "publishing", error: undefined } },
		{
			id: "draft-1",
			patch: {
				status: "approved",
				error: "agent is busy",
			},
		},
	]);
});
