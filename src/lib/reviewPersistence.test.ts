import assert from "node:assert/strict";
import test from "node:test";
import {
	buildAgentRestoreReviewPrompt,
	buildUserMessageWithReviewContext,
	createReviewSnapshot,
	historySourceFromSavedReview,
	type SavedReviewRecord,
	type ReviewSnapshot,
} from "./reviewPersistence";
import type { SessionInfo } from "./store";

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
	pull_request: {
		title: "Improve checkout",
		body: "Checkout accepts coupons.",
		url: "https://github.com/garden-co/jazz/pull/787",
		base_ref_name: "main",
	},
	published_comments: [
		{
			id: 101,
			author_login: "mona",
			body: "Already covered.",
			html_url: "https://github.com/garden-co/jazz/pull/787#discussion_r101",
			created_at: "2026-05-05T10:00:00Z",
			file_path: "src/checkout.ts",
			line: 42,
			side: "RIGHT",
			is_outdated: false,
		},
	],
};

const snapshot: ReviewSnapshot = {
	current_section_id: "validation",
	sections: [
		{
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
				concerns: [
					{
						text: "Empty coupon still passes.",
						severity: "medium",
						file_path: "src/checkout.ts",
						line: 42,
					},
				],
				grill_questions: [],
				base_ref: "origin/main",
				head_ref: "guided-review-pr-787",
				pause_prompt: "Want to comment on this?",
			},
		},
	],
	chat: [],
	comment_drafts: [],
	published_comments: session.published_comments ?? [],
	published_comments_error: null,
};

const savedReview: SavedReviewRecord = {
	id: "pr::https://github.com/garden-co/jazz::787",
	repo_url: "https://github.com/garden-co/jazz",
	number: 787,
	local_project_path: "/Users/guidodorsi/dev/jazz",
	base_ref: "origin/main",
	head_ref: "guided-review-pr-787",
	head_sha: "abc123",
	pr_title: "Improve checkout",
	pr_url: "https://github.com/garden-co/jazz/pull/787",
	snapshot,
	created_at: 1,
	updated_at: 2,
	is_stale: false,
};

test("buildAgentRestoreReviewPrompt briefs the agent without asking for a new section map", () => {
	const prompt = buildAgentRestoreReviewPrompt({
		session,
		savedReview,
	});

	assert.match(prompt, /Do not start over/);
	assert.match(prompt, /Do not emit a new `acp-section-map`/);
	assert.match(prompt, /"current_section_id": "validation"/);
	assert.match(prompt, /Empty coupon still passes/);
	assert.match(prompt, /Already covered/);
});

test("historySourceFromSavedReview resumes a saved PR in the selected local repo", () => {
	assert.deepEqual(
		historySourceFromSavedReview({
			savedReview,
			projectPath: "/Users/guidodorsi/dev/jazz",
		}),
		{
			kind: "local_pr",
			path: "/Users/guidodorsi/dev/jazz",
			repo_url: "https://github.com/garden-co/jazz",
			number: 787,
		},
	);
});

test("buildUserMessageWithReviewContext adds hidden current section context", () => {
	const message = buildUserMessageWithReviewContext({
		userText: "Explain this like I'm 10.",
		session,
		snapshot,
	});

	assert.match(message, /Hidden review context/);
	assert.match(message, /"current_section_id": "validation"/);
	assert.match(message, /Empty coupon still passes/);
	assert.match(message, /Already covered/);
	assert.match(message, /User message:\nExplain this like I'm 10\./);
});

test("createReviewSnapshot stores inline grill questions with sections", () => {
	const snapshot = createReviewSnapshot({
		current_section_id: "api-changes",
		sections: [
			{
				id: "api-changes",
				kind: "review_section",
				title: "API changes",
				intent: "Review the API surface.",
				status: "in_review",
				feedbackLoaded: true,
				section: {
					schema_version: 1,
					section_id: "api-changes",
					title: "API changes",
					intent: "Review the API surface.",
					files: ["src-tauri/src/fenced.rs"],
					ranges: [],
					concerns: [],
					grill_questions: [
						{
							question_id: "error-boundary-policy",
							title: "Error boundary policy",
							question: "Should malformed JSON fail closed?",
							pr_choice: "The PR keeps the review going.",
							recommended_answer: "Fail closed when state is ambiguous.",
							file_path: "src-tauri/src/fenced.rs",
							line: 24,
						},
					],
					base_ref: "origin/main",
					head_ref: "feature",
					pause_prompt: "",
				},
			},
		],
		comment_drafts: [],
		published_comments: [],
		published_comments_error: null,
	});

	const section = snapshot.sections[0];
	assert.equal(section?.kind, "review_section");
	assert.equal(
		section?.kind === "review_section"
			? section.section?.grill_questions[0]?.question_id
			: "",
		"error-boundary-policy",
	);
});

test("buildAgentRestoreReviewPrompt includes inline grill question state without review mode", () => {
	const grillSnapshot: ReviewSnapshot = {
		current_section_id: "api-changes",
		sections: [
			{
				id: "api-changes",
				kind: "review_section",
				title: "API changes",
				intent: "Review the API surface.",
				status: "in_review",
				feedbackLoaded: true,
				section: {
					schema_version: 1,
					section_id: "api-changes",
					title: "API changes",
					intent: "Review the API surface.",
					files: ["src-tauri/src/fenced.rs"],
					ranges: [],
					concerns: [],
					grill_questions: [
						{
							question_id: "error-boundary-policy",
							title: "Error boundary policy",
							question: "Should malformed JSON fail closed?",
							pr_choice: "The PR keeps the review going.",
							recommended_answer: "Fail closed when state is ambiguous.",
							file_path: "src-tauri/src/fenced.rs",
							line: 24,
							answer_summary: "The user wants this to fail closed.",
							agrees_with_pr: false,
							comment_draft_ids: ["draft-123"],
						},
					],
					base_ref: "origin/main",
					head_ref: "feature",
					pause_prompt: "",
				},
			},
		],
		comment_drafts: [],
		published_comments: [],
		published_comments_error: null,
	};
	const prompt = buildAgentRestoreReviewPrompt({
		session,
		savedReview: {
			...savedReview,
			snapshot: grillSnapshot,
		},
	});

	assert.doesNotMatch(prompt, /review_mode/);
	assert.match(prompt, /error-boundary-policy/);
	assert.match(prompt, /The user wants this to fail closed/);
});
