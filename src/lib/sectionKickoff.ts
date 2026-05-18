import type { PublishedPrComment } from "./acp";
import type { Concern, ReviewSection } from "./types/section";
import { formatPublishedCommentsForPrompt } from "./publishedComments";
import type { ReviewSectionState, SessionInfo } from "./store";

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
		`Stay focused on this section. Read files in the repo if you need more context.`,
		`Do not emit \`acp-section-map\`, \`acp-section\`, or \`acp-pr-description\` blocks — the host owns those.`,
		`Reference code by \`file_path:line\` instead of pasting diffs.`,
		`Reply in plain Markdown.`,
	].join("\n");
}
