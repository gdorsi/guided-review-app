import type { PrTarget, SendMessageOptions, SessionSource } from "./acp";
import type { CommentDraftState } from "./store";
import { truncateTelemetryText } from "./telemetry";

type TelemetryValue = string | number | boolean;

export interface SendMessageTelemetryOptions {
	origin?: string;
	sectionId?: string;
	reason?: string;
	suppressPreview?: boolean;
}

type CommentDraftStatusPatch = {
	status: "approved" | "publishing" | "error";
	error?: string;
};

type SendMessage = (
	session_id: string,
	text: string,
	options?: SendMessageOptions,
) => Promise<void>;

export const AGENT_COMMENT_PUBLISHING_INSTRUCTIONS = [
	"Publish these comments using your own GitHub tools and authentication.",
	"Publish the drafts as one PR review if your tools support that. If they do not, publish the comments individually.",
	"Do not ask the host app to publish them. The host is only holding the approved drafts.",
	"Use the target PR and head SHA below. For inline comments, keep the provided file path, line, and side.",
	"After each draft is attempted, emit exactly one `acp-comment-result` fenced JSON block for that draft.",
	"Use `status: \"published\"` and include `url` when GitHub returns one. Use `status: \"failed\"` and include `error` if GitHub rejects it.",
];

function errorMessage(error: unknown, fallback: string): string {
	const message = error instanceof Error ? error.message : String(error);
	return message || fallback;
}

export function prTargetFromSessionSource(
	source: SessionSource | undefined,
): PrTarget | null {
	if (!source || (source.kind !== "pr" && source.kind !== "local_pr")) {
		return null;
	}
	const url = new URL(source.repo_url);
	const segs = url.pathname.split("/").filter(Boolean);
	if (segs.length < 2) return null;
	return {
		owner: segs[0],
		repo: segs[1].replace(/\.git$/, ""),
		number: source.number,
	};
}

export function buildAgentPublishCommentPrompt(args: {
	target: PrTarget;
	head_sha: string;
	drafts: Pick<CommentDraftState, "id" | "draft" | "status">[];
}): string {
	const payload = {
		target: {
			owner: args.target.owner,
			repo: args.target.repo,
			number: args.target.number,
			label: `${args.target.owner}/${args.target.repo}#${args.target.number}`,
		},
		head_sha: args.head_sha,
		drafts: args.drafts.map((state) => ({
			draft_id: state.id,
			...state.draft,
		})),
	};

	return [
		...AGENT_COMMENT_PUBLISHING_INSTRUCTIONS,
		"",
		"Approved comment drafts:",
		"```json",
		JSON.stringify(payload, null, 2),
		"```",
	].join("\n");
}

function approvedCommentDrafts(
	drafts: CommentDraftState[],
): CommentDraftState[] {
	return drafts.filter((draft) => draft.status === "approved");
}

export function approveCommentDraft(args: {
	draft_id: string;
	updateCommentDraft: (id: string, patch: CommentDraftStatusPatch) => void;
}): void {
	args.updateCommentDraft(args.draft_id, {
		status: "approved",
		error: undefined,
	});
}

export async function requestAgentPublishApprovedDrafts(args: {
	session_id: string;
	target: PrTarget;
	head_sha: string;
	comment_drafts: CommentDraftState[];
	updateCommentDraft: (id: string, patch: CommentDraftStatusPatch) => void;
	sendMessage: SendMessage;
}): Promise<void> {
	const drafts = approvedCommentDrafts(args.comment_drafts);
	if (drafts.length === 0) return;

	for (const draft of drafts) {
		args.updateCommentDraft(draft.id, {
			status: "publishing",
			error: undefined,
		});
	}

	try {
		await args.sendMessage(
			args.session_id,
			buildAgentPublishCommentPrompt({
				target: args.target,
				head_sha: args.head_sha,
				drafts,
			}),
			{
				origin: "comment_publish",
				reason: "publish_approved_drafts",
				suppressPreview: true,
			},
		);
	} catch (error) {
		const message = errorMessage(
			error,
			"Could not ask the agent to publish the comments.",
		);
		for (const draft of drafts) {
			args.updateCommentDraft(draft.id, {
				status: "approved",
				error: message,
			});
		}
		throw error;
	}
}

export type ReviewSubmitEvent = "COMMENT" | "APPROVE";

export const AGENT_REVIEW_PUBLISH_INSTRUCTIONS = [
	"Submit these comments as a single GitHub pull request review using your own GitHub tools and authentication.",
	"Create exactly ONE pull request review (not individual comments) using the review event specified below.",
	"Do not ask the host app to publish them. The host is only holding the marked comments.",
	"Use the target PR and head SHA below. For inline comments, keep the provided file path, line, and side.",
	"After the review is submitted, emit one `acp-comment-result` fenced JSON block per comment included in it.",
	"If the review cannot be created at all, emit one `acp-comment-result` block per comment with `status: \"failed\"`.",
	'Use `status: "published"` and include `url` when GitHub returns one. Use `status: "failed"` and include `error` if GitHub rejects it.',
];

export function buildAgentPublishReviewPrompt(args: {
	target: PrTarget;
	head_sha: string;
	event: ReviewSubmitEvent;
	drafts: Pick<CommentDraftState, "id" | "draft">[];
}): string {
	const payload = {
		target: {
			owner: args.target.owner,
			repo: args.target.repo,
			number: args.target.number,
			label: `${args.target.owner}/${args.target.repo}#${args.target.number}`,
		},
		review_event: args.event,
		head_sha: args.head_sha,
		drafts: args.drafts.map((state) => ({ draft_id: state.id, ...state.draft })),
	};

	const eventNote =
		args.event === "APPROVE"
			? "Review event APPROVE: approve the PR and include these comments."
			: "Review event COMMENT: comment only, do not approve the PR.";

	return [
		...AGENT_REVIEW_PUBLISH_INSTRUCTIONS,
		"",
		eventNote,
		"Marked comments:",
		"```json",
		JSON.stringify(payload, null, 2),
		"```",
	].join("\n");
}

export async function requestAgentPublishReview(args: {
	session_id: string;
	target: PrTarget;
	head_sha: string;
	event: ReviewSubmitEvent;
	comments: CommentDraftState[];
	updateCommentDraft: (
		id: string,
		patch: { status: "publishing" | "pending"; error?: string },
	) => void;
	sendMessage: SendMessage;
}): Promise<void> {
	const drafts = args.comments;
	if (drafts.length === 0) return;

	for (const draft of drafts) {
		args.updateCommentDraft(draft.id, { status: "publishing", error: undefined });
	}

	try {
		await args.sendMessage(
			args.session_id,
			buildAgentPublishReviewPrompt({
				target: args.target,
				head_sha: args.head_sha,
				event: args.event,
				drafts,
			}),
			{
				origin: "comment_publish",
				reason:
					args.event === "APPROVE"
						? "submit_review_approve"
						: "submit_review_comment",
				suppressPreview: true,
			},
		);
	} catch (error) {
		const message = errorMessage(
			error,
			"Could not ask the agent to submit the review.",
		);
		for (const draft of drafts) {
			args.updateCommentDraft(draft.id, { status: "pending", error: message });
		}
		throw error;
	}
}

export function sendMessageTelemetryAttrs(args: {
	session_id: string;
	text: string;
	options?: SendMessageTelemetryOptions;
}): Record<string, TelemetryValue | undefined> {
	const options = args.options ?? {};
	return {
		"acp.session_id": args.session_id,
		"message.origin": options.origin,
		"message.reason": options.reason,
		"section.id": options.sectionId,
		"message.length": args.text.length,
		"message.preview": options.suppressPreview
			? undefined
			: truncateTelemetryText(args.text.slice(0, 1024)),
		"message.preview_suppressed": options.suppressPreview ? true : undefined,
	};
}
