import type { PublishedPrComment } from "./acp";
import type { Concern, ReviewSection } from "./types/section";
import { formatPublishedCommentsForPrompt } from "./publishedComments";
import type { ReviewSectionState, SessionInfo } from "./store";
import { AGENT_COMMENT_PUBLISHING_INSTRUCTIONS } from "./commentPublish";

function commentBelongsToSection(
	comment: PublishedPrComment,
	files: Set<string>,
): boolean {
	if (!comment.file_path) return false;
	return files.has(comment.file_path);
}

function formatConcernsForPrompt(concerns: Concern[]): string {
	if (concerns.length === 0) {
		return "No concerns have been raised for this section yet.";
	}
	const lines = ["Concerns already raised for this section:"];
	for (const concern of concerns) {
		const location =
			concern.file_path && concern.line
				? ` (${concern.file_path}:${concern.line})`
				: concern.file_path
					? ` (${concern.file_path})`
					: "";
		lines.push(`- [${concern.severity}]${location} ${concern.text}`);
	}
	return lines.join("\n");
}

function formatFileList(files: string[]): string {
	if (files.length === 0) {
		return "- No files were listed for this section.";
	}
	return files.map((file) => `- ${file}`).join("\n");
}

function formatDiffCommand(baseRef: string, headRef: string, files: string[]): string {
	const fileArgs = files.length === 0 ? "" : ` -- ${files.join(" ")}`;
	return `git diff ${baseRef}..${headRef}${fileArgs}`;
}

function formatReadCodeInstructions(args: {
	baseRef: string;
	headRef: string;
	files: string[];
}): string {
	return [
		"Read code with your built-in tools before answering.",
		`Start with the section diff, for example: \`${formatDiffCommand(args.baseRef, args.headRef, args.files)}\`.`,
		"Open the relevant files and surrounding code when needed; check callers, callees, and sibling branches before claiming an issue.",
		"Never paste file contents, code excerpts, or diff hunks into your reply.",
		"Reference code by `file_path:line` instead of pasting diffs.",
	].join("\n");
}

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

export function buildSectionChatKickoffPrefix(args: {
	session: SessionInfo;
	section: ReviewSectionState;
	publishedComments: PublishedPrComment[];
	publishedCommentsError: string | null;
}): string {
	const { session, section, publishedComments, publishedCommentsError } = args;
	const reviewSection: ReviewSection | undefined = section.section;
	const files = reviewSection?.files ?? [];
	const concerns = reviewSection?.concerns ?? [];
	const fileSet = new Set(files);
	const scopedComments = publishedComments.filter((comment) =>
		commentBelongsToSection(comment, fileSet),
	);
	const commentBlock = formatPublishedCommentsForPrompt(
		scopedComments,
		scopedComments.length === 0 ? undefined : (publishedCommentsError ?? undefined),
	);

	return [
		`You are an interactive code reviewer helping the user discuss one section of a guided code review.`,
		``,
		`Repository: \`${session.repo.path}\``,
		`Base ref: ${session.repo.base_ref}`,
		`Head ref: ${session.repo.head_ref}`,
		``,
		`Section: ${section.id} — ${section.title}`,
		`Intent: ${section.intent}`,
		`Files in this section:`,
		formatFileList(files),
		``,
		formatConcernsForPrompt(concerns),
		``,
		commentBlock,
		``,
		formatReadCodeInstructions({
			baseRef: session.repo.base_ref,
			headRef: session.repo.head_ref,
			files,
		}),
		``,
		formatCommentProtocolInstructions(),
		``,
		formatVisibleReplyInstructions(),
		``,
		`Stay focused on this section.`,
		`Do not emit \`acp-pr-description\`, \`acp-section-map\`, or \`acp-section\` blocks — the host owns those.`,
	].join("\n");
}
