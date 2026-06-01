import assert from "node:assert/strict";
import test from "node:test";
import { buildSectionChatKickoffPrefix } from "./sectionKickoff";
import type { SessionInfo, ReviewSectionState } from "./store";

const session: SessionInfo = {
	session_id: "session-123",
	repo: {
		path: "/Users/guidodorsi/dev/jazz",
		base_ref: "origin/main",
		head_ref: "guided-review-pr-787",
		head_sha: "abc123",
		display_slug: "jazz",
	},
	source: {
		kind: "local_pr",
		path: "/Users/guidodorsi/dev/jazz",
		repo_url: "https://github.com/garden-co/jazz",
		number: 787,
	},
};

const section: ReviewSectionState = {
	id: "validation",
	kind: "review_section",
	title: "Validation",
	intent: "Checks bad input before checkout.",
	status: "in_review",
	section: {
		schema_version: 1,
		section_id: "validation",
		title: "Validation",
		intent: "Checks bad input before checkout.",
		files: ["src/checkout.ts"],
		ranges: [
			{
				file_path: "src/checkout.ts",
				start_line: 38,
				end_line: 48,
				kind: "changed-new",
			},
		],
		concerns: [],
		base_ref: "origin/main",
		head_ref: "guided-review-pr-787",
		pause_prompt: "Want to comment on this?",
	},
};

test("buildSectionChatKickoffPrefix includes read-code and comment protocol instructions", () => {
	const prompt = buildSectionChatKickoffPrefix({
		session,
		section,
		publishedComments: [],
		publishedCommentsError: null,
	});

	assert.match(
		prompt,
		/Read code with your built-in tools.*git diff origin\/main\.\.guided-review-pr-787 -- src\/checkout\.ts/s,
	);
	assert.match(prompt, /Never paste file contents, code excerpts, or diff hunks/);
	assert.match(prompt, /Reference code by `file_path:line`/);
	assert.match(prompt, /When the user asks to leave a PR comment/);
	assert.match(prompt, /```acp-comment-draft/);
	assert.match(prompt, /"kind": "inline"/);
	assert.match(prompt, /When the host asks you to submit the review/);
	assert.match(prompt, /```acp-comment-result/);
});

test("buildSectionChatKickoffPrefix tells the agent to show visible replies through the display tool", () => {
	const prompt = buildSectionChatKickoffPrefix({
		session,
		section,
		publishedComments: [],
		publishedCommentsError: null,
	});

	assert.match(prompt, /guided_review_show_message/);
	assert.match(prompt, /Do not write user-visible Markdown directly/);
	assert.doesNotMatch(prompt, /Reply in plain Markdown/);
});

test("buildSectionChatKickoffPrefix does not include forked main chat context", () => {
	const prompt = buildSectionChatKickoffPrefix({
		session,
		section,
		publishedComments: [],
		publishedCommentsError: null,
	});

	assert.doesNotMatch(prompt, /forked from the main guided review chat/);
	assert.doesNotMatch(prompt, /Review state at fork time:/);
	assert.doesNotMatch(prompt, /Main chat context at fork time:/);
});
