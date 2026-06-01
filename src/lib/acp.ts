import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
	CommentDraft,
	CommentKind,
	CommentResult,
	CommentSide,
	LineRange,
	ReviewSection,
	SectionMap,
	SectionProgressUpdate,
} from "./types/section";
import {
	type TelemetryContext,
	recordClientTelemetry,
	recordClientTelemetryError,
	withClientTelemetrySpan,
	withTelemetryContext,
} from "./telemetry";
import { sendMessageTelemetryAttrs } from "./commentPublish";
import type {
	ReviewPersistenceTarget,
	SavedReviewRecord,
	SaveReviewStateRequest,
} from "./reviewPersistence";

export type AgentKind = "claude_code" | "codex";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export interface AgentInfo {
	kind: AgentKind;
	label: string;
	launch_command: string;
	supports_reasoning_effort: boolean;
	reasoning_effort_options: ReasoningEffort[];
}

export interface GhCliStatus {
	installed: boolean;
	version?: string;
	error?: string;
}

export type SessionSource =
	| { kind: "pr"; repo_url: string; number: number }
	| { kind: "branch"; repo_url: string; branch: string }
	| { kind: "sha"; repo_url: string; sha: string }
	| { kind: "local"; path: string }
	| { kind: "local_pr"; path: string; repo_url: string; number: number }
	| { kind: "local_branch"; path: string; branch: string };

export interface ClonedRepo {
	path: string;
	head_ref: string;
	head_sha: string;
	base_ref: string;
	display_slug: string;
}

export interface PullRequestMetadata {
	title: string;
	body: string;
	url: string;
	base_ref_name: string;
}

export type GithubCommentSide = "LEFT" | "RIGHT";

export interface PublishedPrComment {
	id: number;
	author_login: string;
	body: string;
	html_url: string;
	created_at: string;
	file_path?: string;
	line?: number;
	side?: GithubCommentSide;
	original_line?: number;
	original_side?: GithubCommentSide;
	is_outdated?: boolean;
}

export interface StartSessionResponse {
	session_id: string;
	repo: ClonedRepo;
	source: SessionSource;
	pull_request?: PullRequestMetadata;
	pull_request_error?: string;
	published_comments: PublishedPrComment[];
	published_comments_error?: string;
	saved_review?: SavedReviewRecord;
}

export interface UpdatePrFromUpstreamRequest {
	source: SessionSource;
	previous_repo: ClonedRepo;
}

export interface UpdatePrFromUpstreamResponse {
	repo: ClonedRepo;
	pull_request?: PullRequestMetadata;
	pull_request_error?: string;
	published_comments: PublishedPrComment[];
	published_comments_error?: string;
	changed_files: string[];
}

export interface SavedReviewSummary {
	id: string;
	repo_url: string;
	number: number;
	pr_title?: string | null;
	pr_url?: string | null;
	base_ref: string;
	head_ref: string;
	head_sha: string;
	created_at: number;
	updated_at: number;
}

interface StartSectionTaskRequest {
	parent_session_id: string;
	section_id: string;
	title: string;
	intent: string;
	files: string[];
	base_ref: string;
	head_ref: string;
	published_comment_context: string;
	additional_concerns_hint?: string;
}

interface StartChatRequest {
	parent_session_id: string;
}

interface StartChatResponse {
	session_id: string;
}

interface DiffPatch {
	file_path: string;
	patch: string;
}

export interface PrTarget {
	owner: string;
	repo: string;
	number: number;
}

export interface LocalRepoOrigin {
	repo_url: string;
	owner: string;
	repo: string;
	slug: string;
}

export type RecentProject =
	| {
			kind: "pr";
			repo_url: string;
			owner: string;
			repo: string;
			number: number;
			last_opened: number;
	  }
	| {
			kind: "branch";
			repo_url: string;
			owner: string;
			repo: string;
			branch: string;
			last_opened: number;
	  }
	| { kind: "local"; path: string; label: string; last_opened: number };

export interface SectionMapEvent {
	session_id: string;
	map: SectionMap;
	suppress_chat?: boolean;
	telemetry_context?: TelemetryContext;
}

export interface SectionEvent {
	session_id: string;
	section: ReviewSection;
	suppress_chat?: boolean;
	telemetry_context?: TelemetryContext;
}

export interface SectionProgressEvent {
	session_id: string;
	update: SectionProgressUpdate;
	telemetry_context?: TelemetryContext;
}

export interface TextChunkEvent {
	session_id: string;
	message_id: string;
	text: string;
	kind: "thinking" | "response";
	telemetry_context?: TelemetryContext;
}

export interface ToolCallEvent {
	session_id: string;
	tool_call_id: string;
	title: string;
	kind: string;
	status: string;
	raw_input: unknown;
	telemetry_context?: TelemetryContext;
}

export interface ToolCallUpdateEvent {
	session_id: string;
	tool_call_id: string;
	status: string;
	raw_output: unknown;
	telemetry_context?: TelemetryContext;
}

export interface TurnDoneEvent {
	session_id: string;
	stop_reason: string;
	telemetry_context?: TelemetryContext;
}

export interface ErrorEvent {
	session_id?: string;
	error: string;
	telemetry_context?: TelemetryContext;
}

export interface CommentDraftEvent {
	session_id: string;
	draft_id: string;
	draft: CommentDraft;
	telemetry_context?: TelemetryContext;
}

export interface CommentResultEvent {
	session_id: string;
	result: CommentResult;
	telemetry_context?: TelemetryContext;
}

export interface AgentStderrEvent {
	session_id: string;
	line: string;
	telemetry_context?: TelemetryContext;
}

export interface PrDescriptionEvent {
	session_id: string;
	body: string;
	telemetry_context?: TelemetryContext;
}

export interface SendMessageOptions {
	origin?: string;
	sectionId?: string;
	reason?: string;
	suppressPreview?: boolean;
}

function payloadSessionId(payload: unknown): string | undefined {
	if (payload && typeof payload === "object" && "session_id" in payload) {
		const sessionId = (payload as { session_id?: unknown }).session_id;
		return typeof sessionId === "string" ? sessionId : undefined;
	}
	return undefined;
}

function payloadTelemetryContext(payload: unknown): TelemetryContext | undefined {
	if (payload && typeof payload === "object" && "telemetry_context" in payload) {
		const telemetryContext = (payload as { telemetry_context?: unknown })
			.telemetry_context;
		if (telemetryContext && typeof telemetryContext === "object") {
			return Object.fromEntries(
				Object.entries(telemetryContext).filter(
					(entry): entry is [string, string] => typeof entry[1] === "string",
				),
			);
		}
	}
	return undefined;
}

function invokeWithTelemetry<T>(
	command: string,
	args: Record<string, unknown> = {},
	attrs: Record<string, string | number | boolean | undefined | null> = {},
) {
	return withClientTelemetrySpan(
		`client.tauri.invoke.${command}`,
		{ ...attrs, "tauri.command": command },
		(telemetryContext) =>
			invoke<T>(command, {
				...args,
				telemetryContext,
			}),
	);
}

export const acp = {
	listAgents: async () => {
		recordClientTelemetry("client.acp.invoke.started", {
			"tauri.command": "list_agents_cmd",
		});
		try {
			const agents = await invokeWithTelemetry<AgentInfo[]>("list_agents_cmd");
			recordClientTelemetry("client.acp.invoke.succeeded", {
				"tauri.command": "list_agents_cmd",
				"agent.count": agents.length,
			});
			return agents;
		} catch (e) {
			recordClientTelemetryError("client.acp.invoke.failed", e, {
				"tauri.command": "list_agents_cmd",
			});
			throw e;
		}
	},
	agentSkill: async () => {
		recordClientTelemetry("client.acp.invoke.started", {
			"tauri.command": "agent_skill_cmd",
		});
		try {
			const skill = await invokeWithTelemetry<string>("agent_skill_cmd");
			recordClientTelemetry("client.acp.invoke.succeeded", {
				"tauri.command": "agent_skill_cmd",
				"agent_skill.length": skill.length,
			});
			return skill;
		} catch (e) {
			recordClientTelemetryError("client.acp.invoke.failed", e, {
				"tauri.command": "agent_skill_cmd",
			});
			throw e;
		}
	},
	checkGhCli: async () => {
		recordClientTelemetry("client.acp.invoke.started", {
			"tauri.command": "check_gh_cli_cmd",
		});
		try {
			const status = await invokeWithTelemetry<GhCliStatus>("check_gh_cli_cmd");
			recordClientTelemetry("client.acp.invoke.succeeded", {
				"tauri.command": "check_gh_cli_cmd",
				"gh.installed": status.installed,
				"gh.has_error": !!status.error,
			});
			return status;
		} catch (e) {
			recordClientTelemetryError("client.acp.invoke.failed", e, {
				"tauri.command": "check_gh_cli_cmd",
			});
			throw e;
		}
	},
	startSession: async (req: {
		source: SessionSource;
		agent_kind: AgentKind;
		reasoning_effort?: ReasoningEffort;
	}) => {
		recordClientTelemetry("client.acp.start_session.requested", {
			"agent.kind": req.agent_kind,
			"agent.reasoning_effort": req.reasoning_effort,
			"session.source.kind": req.source.kind,
		});
		try {
			const response = await invokeWithTelemetry<StartSessionResponse>(
				"start_session_cmd",
				{ req },
				{
					"agent.kind": req.agent_kind,
					"agent.reasoning_effort": req.reasoning_effort,
					"session.source.kind": req.source.kind,
				},
			);
			recordClientTelemetry("client.acp.start_session.succeeded", {
				"agent.kind": req.agent_kind,
				"agent.reasoning_effort": req.reasoning_effort,
				"session.source.kind": req.source.kind,
				"acp.session_id": response.session_id,
				"repo.display_slug": response.repo.display_slug,
				"repo.base_ref": response.repo.base_ref,
				"repo.head_ref": response.repo.head_ref,
				"pull_request.has_metadata": !!response.pull_request,
				"pull_request.has_error": !!response.pull_request_error,
			});
			return response;
		} catch (e) {
			recordClientTelemetryError("client.acp.start_session.failed", e, {
				"agent.kind": req.agent_kind,
				"agent.reasoning_effort": req.reasoning_effort,
				"session.source.kind": req.source.kind,
			});
			throw e;
		}
	},
	updatePrFromUpstream: async (req: UpdatePrFromUpstreamRequest) => {
		recordClientTelemetry("client.acp.pr_update.requested", {
			"session.source.kind": req.source.kind,
			"repo.previous_head_sha": req.previous_repo.head_sha,
		});
		try {
			const response = await invokeWithTelemetry<UpdatePrFromUpstreamResponse>(
				"update_pr_from_upstream_cmd",
				{ req },
				{
					"session.source.kind": req.source.kind,
					"repo.previous_head_sha": req.previous_repo.head_sha,
				},
			);
			recordClientTelemetry("client.acp.pr_update.succeeded", {
				"session.source.kind": req.source.kind,
				"repo.next_head_sha": response.repo.head_sha,
				"pr_update.changed_file_count": response.changed_files.length,
			});
			return response;
		} catch (e) {
			recordClientTelemetryError("client.acp.pr_update.failed", e, {
				"session.source.kind": req.source.kind,
				"repo.previous_head_sha": req.previous_repo.head_sha,
			});
			throw e;
		}
	},
	parsePrUrl: (url: string) =>
		invokeWithTelemetry<[string, string, number] | null>("parse_pr_url_cmd", {
			url,
		}),
	listRecentProjects: () =>
		invokeWithTelemetry<RecentProject[]>("list_recent_projects_cmd"),
	inspectLocalRepoOrigin: (path: string) =>
		invokeWithTelemetry<LocalRepoOrigin>("inspect_local_repo_origin_cmd", {
			path,
		}),
	saveReviewState: (req: SaveReviewStateRequest) =>
		invokeWithTelemetry<SavedReviewRecord>("save_review_state_cmd", { req }),
	deleteSavedReview: (target: ReviewPersistenceTarget) =>
		invokeWithTelemetry<void>("delete_saved_review_cmd", { target }),
	listSavedReviewsForRepo: (repo_url: string) =>
		invokeWithTelemetry<SavedReviewSummary[]>(
			"list_saved_reviews_for_repo_cmd",
			{ repoUrl: repo_url },
			{ "repo.url": repo_url },
		),
	sendMessage: async (
		session_id: string,
		text: string,
		options: SendMessageOptions = {},
	) => {
		recordClientTelemetry(
			"client.acp.send_message.requested",
			sendMessageTelemetryAttrs({ session_id, text, options }),
		);
		try {
			await invokeWithTelemetry<void>(
				"send_message_cmd",
				{
					sessionId: session_id,
					text,
					origin: options.origin,
					reason: options.reason,
					sectionId: options.sectionId,
					suppressPreview: options.suppressPreview,
				},
				sendMessageTelemetryAttrs({ session_id, text, options }),
			);
			recordClientTelemetry("client.acp.send_message.succeeded", {
				"acp.session_id": session_id,
				"message.origin": options.origin,
				"message.reason": options.reason,
				"section.id": options.sectionId,
				"message.length": text.length,
			});
		} catch (e) {
			recordClientTelemetryError("client.acp.send_message.failed", e, {
				"acp.session_id": session_id,
				"message.origin": options.origin,
				"message.reason": options.reason,
				"section.id": options.sectionId,
				"message.length": text.length,
			});
			throw e;
		}
	},
	startChat: async (req: StartChatRequest) => {
		recordClientTelemetry("client.acp.chat.requested", {
			"acp.session_id": req.parent_session_id,
		});
		try {
			const response = await invokeWithTelemetry<StartChatResponse>(
				"start_chat_cmd",
				{ req },
				{
					"acp.session_id": req.parent_session_id,
				},
			);
			recordClientTelemetry("client.acp.chat.succeeded", {
				"acp.parent_session_id": req.parent_session_id,
				"acp.session_id": response.session_id,
			});
			return response;
		} catch (e) {
			recordClientTelemetryError("client.acp.chat.failed", e, {
				"acp.session_id": req.parent_session_id,
			});
			throw e;
		}
	},
	startSectionTask: async (req: StartSectionTaskRequest) => {
		recordClientTelemetry("client.acp.section_task.requested", {
			"acp.session_id": req.parent_session_id,
			"section.id": req.section_id,
			"section.file_count": req.files.length,
		});
		try {
			await invokeWithTelemetry<void>(
				"start_section_task_cmd",
				{ req },
				{
					"acp.session_id": req.parent_session_id,
					"section.id": req.section_id,
					"section.file_count": req.files.length,
				},
			);
			recordClientTelemetry("client.acp.section_task.succeeded", {
				"acp.session_id": req.parent_session_id,
				"section.id": req.section_id,
			});
		} catch (e) {
			recordClientTelemetryError("client.acp.section_task.failed", e, {
				"acp.session_id": req.parent_session_id,
				"section.id": req.section_id,
			});
			throw e;
		}
	},
	endSession: (session_id: string) =>
		invokeWithTelemetry<void>("end_session_cmd", { sessionId: session_id }),
	getFileAtRef: (args: {
		repo_path: string;
		file_path: string;
		refspec: string;
	}) => invokeWithTelemetry<string | null>("get_file_at_ref_cmd", { args }),
	getDiff: (args: {
		repo_path: string;
		base_ref: string;
		head_ref: string;
		file_path?: string | null;
	}) => invokeWithTelemetry<DiffPatch[]>("get_diff_cmd", { args }),
	getChangedRanges: (args: {
		repo_path: string;
		base_ref: string;
		head_ref: string;
		file_paths: string[];
	}) => invokeWithTelemetry<LineRange[]>("get_changed_ranges_cmd", { args }),
	writeReviewMd: (args: {
		repo_path: string;
		base_ref: string;
		head_ref: string;
		pr_title?: string | null;
		comments: {
			kind: CommentKind;
			title?: string;
			body: string;
			file_path?: string;
			line?: number;
			side?: CommentSide;
		}[];
	}) => invokeWithTelemetry<string>("write_review_md_cmd", { args }),
};

export type EventName =
	| "acp://section-map"
	| "acp://section"
	| "acp://section-progress"
	| "acp://text-chunk"
	| "acp://tool-call"
	| "acp://tool-call-update"
	| "acp://turn-done"
	| "acp://error"
	| "acp://comment-draft"
	| "acp://comment-result"
	| "acp://agent-stderr"
	| "acp://pr-description";

export function on<T>(name: EventName, handler: (payload: T) => void) {
	recordClientTelemetry("client.acp.listener.registering", {
		"acp.event_name": name,
	});
	return listen<T>(name, (e) => {
		withTelemetryContext(payloadTelemetryContext(e.payload), () => {
			recordClientTelemetry("client.acp.event.dispatched", {
				"acp.event_name": name,
				"acp.session_id": payloadSessionId(e.payload),
			});
			handler(e.payload);
		});
	});
}

export type Unlisten = UnlistenFn;
