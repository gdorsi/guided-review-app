import type {
	ClonedRepo,
	PublishedPrComment,
	PullRequestMetadata,
	SessionSource,
} from "./acp";
import type {
	ChatMessage,
	ReviewSection,
	SectionMapEntry,
} from "./types/section";
import type {
	CommentDraftState,
	SectionState,
	SessionInfo,
} from "./store";

export interface ReviewPersistenceTarget {
	repo_url: string;
	number: number;
	local_project_path?: string | null;
}

export interface ReviewSnapshot {
	current_section_id: string | null;
	sections: SectionState[];
	comment_drafts: CommentDraftState[];
	published_comments: PublishedPrComment[];
	published_comments_error: string | null;
	/**
	 * Legacy field — older records on disk include the chat transcript here.
	 * We no longer persist chats; this is read for compatibility only.
	 */
	chat?: ChatMessage[];
}

export interface SavedReviewRecord {
	id: string;
	repo_url: string;
	number: number;
	local_project_path?: string | null;
	base_ref: string;
	head_ref: string;
	head_sha: string;
	pr_title?: string | null;
	pr_url?: string | null;
	snapshot: ReviewSnapshot;
	created_at: number;
	updated_at: number;
	is_stale: boolean;
}

export interface SaveReviewStateRequest {
	target: ReviewPersistenceTarget;
	base_ref: string;
	head_ref: string;
	head_sha: string;
	pr_title?: string | null;
	pr_url?: string | null;
	snapshot: ReviewSnapshot;
}

export function reviewTargetFromSource(
	source: SessionSource | undefined,
): ReviewPersistenceTarget | null {
	if (!source || (source.kind !== "pr" && source.kind !== "local_pr")) {
		return null;
	}
	return {
		repo_url: source.repo_url,
		number: source.number,
		local_project_path: source.kind === "local_pr" ? source.path : null,
	};
}

function sectionMapFromSnapshot(snapshot: ReviewSnapshot): SectionMapEntry[] {
	return snapshot.sections
		.filter((section) => section.kind === "review_section")
		.map((section) => ({
			section_id: section.id,
			title: section.title,
			intent: section.intent,
			files: section.section?.files,
			ranges: section.section?.ranges,
		}));
}

function reviewSectionsFromSnapshot(snapshot: ReviewSnapshot): ReviewSection[] {
	return snapshot.sections
		.filter(
			(section): section is Extract<SectionState, { kind: "review_section" }> =>
				section.kind === "review_section" && !!section.section,
		)
		.map((section) => section.section!);
}

function compactChat(chat: ChatMessage[]): ChatMessage[] {
	return chat.slice(-12).map((message) => ({
		...message,
		text:
			message.text.length > 4000
				? `${message.text.slice(0, 4000)}\n[truncated]`
				: message.text,
	}));
}

function restoreContextPayload(args: {
	session: SessionInfo;
	savedReview: SavedReviewRecord;
}) {
	const { session, savedReview } = args;
	return {
		repository: {
			path: session.repo.path,
			display_slug: session.repo.display_slug,
			base_ref: session.repo.base_ref,
			head_ref: session.repo.head_ref,
			head_sha: session.repo.head_sha,
		},
		source: session.source,
		pull_request: session.pull_request ?? null,
		pull_request_error: session.pull_request_error ?? null,
		saved_review: {
			id: savedReview.id,
			repo_url: savedReview.repo_url,
			number: savedReview.number,
			local_project_path: savedReview.local_project_path ?? null,
			base_ref: savedReview.base_ref,
			head_ref: savedReview.head_ref,
			head_sha: savedReview.head_sha,
			pr_title: savedReview.pr_title ?? null,
			pr_url: savedReview.pr_url ?? null,
			is_stale: savedReview.is_stale,
			updated_at: savedReview.updated_at,
		},
		current_section_id: savedReview.snapshot.current_section_id,
		section_map: sectionMapFromSnapshot(savedReview.snapshot),
		review_sections: reviewSectionsFromSnapshot(savedReview.snapshot),
		published_comments: savedReview.snapshot.published_comments,
		published_comments_error: savedReview.snapshot.published_comments_error,
		comment_drafts: savedReview.snapshot.comment_drafts,
		recent_chat: compactChat(savedReview.snapshot.chat ?? []),
	};
}

export function buildAgentRestoreReviewPrompt(args: {
	session: SessionInfo;
	savedReview: SavedReviewRecord;
}): string {
	return [
		"The host app restored a saved PR review from local storage.",
		"Do not start over.",
		"Do not emit a new `acp-section-map` unless the user explicitly chooses Start Over.",
		"Use this restored state as your memory for future questions and comment drafts.",
		"If the saved review is marked stale, tell the user that the PR changed before relying on old feedback.",
		"Do not paste file contents or diffs.",
		"Do not reply with prose or structured blocks to this restore message.",
		"",
		"Restored review state:",
		"```json",
		JSON.stringify(restoreContextPayload(args), null, 2),
		"```",
	].join("\n");
}

function currentSectionFromSnapshot(snapshot: ReviewSnapshot): SectionState | null {
	if (!snapshot.current_section_id) return null;
	return (
		snapshot.sections.find(
			(section) => section.id === snapshot.current_section_id,
		) ?? null
	);
}

export function buildUserMessageWithReviewContext(args: {
	userText: string;
	session: SessionInfo;
	snapshot: ReviewSnapshot;
}): string {
	const currentSection = currentSectionFromSnapshot(args.snapshot);
	const payload = {
		repository: {
			path: args.session.repo.path,
			base_ref: args.session.repo.base_ref,
			head_ref: args.session.repo.head_ref,
			head_sha: args.session.repo.head_sha,
		},
		pull_request: args.session.pull_request ?? null,
		current_section_id: args.snapshot.current_section_id,
		current_section: currentSection,
		published_comments: args.snapshot.published_comments,
		published_comments_error: args.snapshot.published_comments_error,
		comment_drafts: args.snapshot.comment_drafts,
	};

	return [
		"Hidden review context for this user message. Use it to answer accurately. Do not mention that hidden context was attached unless it matters.",
		"```json",
		JSON.stringify(payload, null, 2),
		"```",
		"",
		"User message:",
		args.userText,
	].join("\n");
}

export function createReviewSnapshot(args: {
	current_section_id: string | null;
	sections: SectionState[];
	comment_drafts: CommentDraftState[];
	published_comments: PublishedPrComment[];
	published_comments_error: string | null;
}): ReviewSnapshot {
	return {
		current_section_id: args.current_section_id,
		sections: args.sections,
		comment_drafts: args.comment_drafts,
		published_comments: args.published_comments,
		published_comments_error: args.published_comments_error,
	};
}

export function saveReviewRequestFromSession(args: {
	session: SessionInfo;
	snapshot: ReviewSnapshot;
}): SaveReviewStateRequest | null {
	const target = reviewTargetFromSource(args.session.source);
	if (!target) return null;
	return {
		target,
		base_ref: args.session.repo.base_ref,
		head_ref: args.session.repo.head_ref,
		head_sha: args.session.repo.head_sha,
		pr_title: args.session.pull_request?.title ?? null,
		pr_url: args.session.pull_request?.url ?? null,
		snapshot: args.snapshot,
	};
}

export function historySourceFromSavedReview(args: {
	savedReview: Pick<SavedReviewRecord, "repo_url" | "number">;
	projectPath: string;
}): SessionSource {
	return {
		kind: "local_pr",
		path: args.projectPath,
		repo_url: args.savedReview.repo_url,
		number: args.savedReview.number,
	};
}

export function sessionInfoFromSavedReview(args: {
	session_id: string;
	repo: ClonedRepo;
	source: SessionSource;
	pull_request?: PullRequestMetadata;
	pull_request_error?: string;
	savedReview: SavedReviewRecord;
}): SessionInfo {
	return {
		session_id: args.session_id,
		repo: args.repo,
		source: args.source,
		pull_request: args.pull_request,
		pull_request_error: args.pull_request_error,
		published_comments: args.savedReview.snapshot.published_comments,
		published_comments_error:
			args.savedReview.snapshot.published_comments_error ?? undefined,
		saved_review_is_stale: args.savedReview.is_stale,
	};
}
