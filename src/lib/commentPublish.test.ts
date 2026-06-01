import assert from "node:assert/strict";
import test from "node:test";
import { sendMessageTelemetryAttrs } from "./commentPublish";

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

test("buildAgentPublishReviewPrompt pins the COMMENT event", async () => {
	const { buildAgentPublishReviewPrompt } = await import("./commentPublish");
	const prompt = buildAgentPublishReviewPrompt({
		target: { owner: "garden-co", repo: "jazz", number: 787 },
		head_sha: "57d6bce",
		event: "COMMENT",
		drafts: [
			{ id: "d1", draft: { kind: "inline", body: "x", file_path: "a.ts", line: 4, side: "RIGHT" } },
		],
	});
	assert.match(prompt, /garden-co\/jazz#787/);
	assert.match(prompt, /"review_event": "COMMENT"/);
	assert.match(prompt, /do not approve/i);
	assert.match(prompt, /d1/);
	assert.match(prompt, /acp-comment-result/);
});

test("buildAgentPublishReviewPrompt pins the APPROVE event", async () => {
	const { buildAgentPublishReviewPrompt } = await import("./commentPublish");
	const prompt = buildAgentPublishReviewPrompt({
		target: { owner: "garden-co", repo: "jazz", number: 787 },
		head_sha: "57d6bce",
		event: "APPROVE",
		drafts: [{ id: "d1", draft: { kind: "top_level", body: "x" } }],
	});
	assert.match(prompt, /"review_event": "APPROVE"/);
	assert.match(prompt, /approve the PR/i);
});

test("requestAgentPublishReview marks all comments publishing and sends one prompt", async () => {
	const { requestAgentPublishReview } = await import("./commentPublish");
	const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
	const messages: Array<{ text: string; options: unknown }> = [];

	await requestAgentPublishReview({
		session_id: "s1",
		target: { owner: "garden-co", repo: "jazz", number: 787 },
		head_sha: "57d6bce",
		event: "COMMENT",
		comments: [
			{ id: "d1", marked: true, status: "pending", draft: { kind: "top_level", body: "a" } },
			{ id: "d2", marked: true, status: "pending", draft: { kind: "top_level", body: "b" } },
		],
		updateCommentDraft: (id, patch) => updates.push({ id, patch }),
		sendMessage: async (_s, text, options) => {
			messages.push({ text, options });
		},
	});

	assert.deepEqual(updates, [
		{ id: "d1", patch: { status: "publishing", error: undefined } },
		{ id: "d2", patch: { status: "publishing", error: undefined } },
	]);
	assert.equal(messages.length, 1);
	assert.match(messages[0]?.text ?? "", /d1/);
	assert.match(messages[0]?.text ?? "", /d2/);
	assert.deepEqual(messages[0]?.options, {
		origin: "comment_publish",
		reason: "submit_review_comment",
		suppressPreview: true,
	});
});

test("requestAgentPublishReview reverts to pending when send fails", async () => {
	const { requestAgentPublishReview } = await import("./commentPublish");
	const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
	await assert.rejects(
		requestAgentPublishReview({
			session_id: "s1",
			target: { owner: "garden-co", repo: "jazz", number: 787 },
			head_sha: "57d6bce",
			event: "COMMENT",
			comments: [
				{ id: "d1", marked: true, status: "pending", draft: { kind: "top_level", body: "a" } },
			],
			updateCommentDraft: (id, patch) => updates.push({ id, patch }),
			sendMessage: async () => {
				throw new Error("agent is busy");
			},
		}),
		/agent is busy/,
	);
	assert.deepEqual(updates, [
		{ id: "d1", patch: { status: "publishing", error: undefined } },
		{ id: "d1", patch: { status: "pending", error: "agent is busy" } },
	]);
});
