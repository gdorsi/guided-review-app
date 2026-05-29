import type { PublishedPrComment } from "./acp";
import { AGENT_COMMENT_PUBLISHING_INSTRUCTIONS } from "./commentPublish";
import { formatPublishedCommentsForPrompt } from "./publishedComments";
import type { ReviewSnapshot } from "./reviewPersistence";
import type { SessionInfo } from "./store";

function formatCommentProtocolInstructions(): string {
	return [
		"When the user asks to leave a PR comment, emit one `acp-comment-draft` fenced JSON block. The host will preview it and save approved drafts locally.",
		"Use this shape for an inline comment:",
		"```acp-comment-draft",
		"{",
		'  "kind": "inline",',
		'  "title": "Null check missing",',
		'  "body": "Concrete code question or concern.",',
		'  "file_path": "src/example.ts",',
		'  "line": 24,',
		'  "side": "RIGHT"',
		"}",
		"```",
		"For a top-level PR comment, use `\"kind\": \"top_level\"` and omit `file_path`, `line`, and `side`. Keep `title` at most 5 words.",
		"When the host asks you to publish approved drafts:",
		...AGENT_COMMENT_PUBLISHING_INSTRUCTIONS,
		"Result format:",
		"```acp-comment-result",
		"{",
		'  "draft_id": "draft-123",',
		'  "status": "published",',
		'  "url": "https://github.com/owner/repo/pull/123#discussion_r1"',
		"}",
		"```",
	].join("\n");
}

function formatVisibleReplyInstructions(): string {
	return [
		"Show any user-visible reply by calling the `guided_review_show_message` tool with Markdown in the `markdown` field.",
		"Do not write user-visible Markdown directly in the assistant message stream.",
		"Keep private analysis, tool exploration, and planning out of visible text.",
		"Use the display tool only when there is an actual message for the user.",
	].join("\n");
}

export function buildReviewChatKickoffPrefix(args: {
	session: SessionInfo;
	snapshot: ReviewSnapshot;
	publishedComments: PublishedPrComment[];
	publishedCommentsError: string | null;
}): string {
	const { session, snapshot, publishedComments, publishedCommentsError } = args;
	return [
		"You are an interactive code reviewer helping the user discuss a guided PR review.",
		"This chat tab is a review-level conversation. It is not owned by any section.",
		"The host attaches fresh hidden review context to every user message, including the currently selected section when one is selected.",
		"",
		`Repository: \`${session.repo.path}\``,
		`Base ref: ${session.repo.base_ref}`,
		`Head ref: ${session.repo.head_ref}`,
		`Head SHA: ${session.repo.head_sha}`,
		"",
		"Current review snapshot:",
		"```json",
		JSON.stringify(snapshot, null, 2),
		"```",
		"",
		formatPublishedCommentsForPrompt(
			publishedComments,
			publishedCommentsError ?? undefined,
		),
		"",
		"Read code with your built-in tools before answering.",
		"Never paste file contents, code excerpts, or diff hunks into your reply.",
		"Reference code by `file_path:line` instead of pasting diffs.",
		"",
		formatCommentProtocolInstructions(),
		"",
		formatVisibleReplyInstructions(),
		"",
		"Do not emit `acp-pr-description`, `acp-section-map`, or `acp-section` blocks. The host owns review structure.",
	].join("\n");
}
