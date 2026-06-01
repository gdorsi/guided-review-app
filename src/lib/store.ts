import { create } from "zustand";
import type {
	ChatItem,
	ChatMessage,
	ChatMessagePart,
	CommentDraft,
	CommentResult,
	ReviewSection,
	SectionMapEntry,
	SectionProgressUpdate,
	SectionStatus,
	ToolCallItem,
} from "./types/section";
import type {
	ClonedRepo,
	PublishedPrComment,
	PullRequestMetadata,
	SessionSource,
} from "./acp";
import type { LocalProject } from "./projectSource";
import { clearLastProjectPath, saveLastProjectPath } from "./projectSource";
import type { DiffFocusRange } from "./diffFocus";
import { recordClientTelemetry, truncateTelemetryText } from "./telemetry";
import type { ReviewSnapshot } from "./reviewPersistence";

export interface SessionInfo {
	session_id: string;
	repo: ClonedRepo;
	source: SessionSource;
	pull_request?: PullRequestMetadata;
	pull_request_error?: string;
	published_comments?: PublishedPrComment[];
	published_comments_error?: string;
	saved_review_is_stale?: boolean;
}

export const PR_DESCRIPTION_SECTION_ID = "pr-description";
export const REVIEW_SUMMARY_SECTION_ID = "review-summary";
export const OVERVIEW_CHAT_TAB_ID = "overview";

function hasSectionFeedback(section: ReviewSection): boolean {
	return (
		section.concerns.length > 0 ||
		section.grill_questions.length > 0 ||
		section.pause_prompt.trim().length > 0
	);
}

function emptyFeedbackSection(
	section_id: string,
	title: string,
	intent: string,
	session: SessionInfo | null,
): ReviewSection {
	return {
		schema_version: 1,
		section_id,
		title,
		intent,
		files: [],
		ranges: [],
		concerns: [],
		grill_questions: [],
		base_ref: session?.repo.base_ref ?? "",
		head_ref: session?.repo.head_ref ?? "",
		pause_prompt: "",
	};
}

function mergeMapEntrySection(
	entry: SectionMapEntry,
	existing: ReviewSectionState | undefined,
	session: SessionInfo | null,
): ReviewSection | undefined {
	const previous = existing?.section;
	const hasPreview =
		Array.isArray(entry.files) || Array.isArray(entry.ranges);
	if (!hasPreview && !previous) return undefined;
	const section = previous
		? { ...previous }
		: emptyFeedbackSection(entry.section_id, entry.title, entry.intent, session);
	return {
		...section,
		section_id: entry.section_id,
		title: entry.title,
		intent: entry.intent,
		files: entry.files ?? section.files,
		ranges: entry.ranges ?? section.ranges,
		base_ref: section.base_ref || session?.repo.base_ref || "",
		head_ref: section.head_ref || session?.repo.head_ref || "",
	};
}

function hasStructure(section: ReviewSection | undefined): boolean {
	return Boolean(
		section &&
			(section.files.length > 0 ||
				section.ranges.length > 0 ||
				section.base_ref ||
				section.head_ref),
	);
}

function mergeSectionProgress(
	update: SectionProgressUpdate,
	existing: ReviewSectionState | undefined,
	session: SessionInfo | null,
): ReviewSection {
	const previous = existing?.section;
	const previousHasStructure = hasStructure(previous);
	return {
		schema_version: 1,
		section_id: update.section_id,
		title: update.title ?? previous?.title ?? existing?.title ?? update.section_id,
		intent: update.intent ?? previous?.intent ?? existing?.intent ?? "",
		files: previousHasStructure
			? previous?.files ?? []
			: update.files ?? previous?.files ?? [],
		ranges: previousHasStructure
			? previous?.ranges ?? []
			: update.ranges ?? previous?.ranges ?? [],
		concerns: update.concerns ?? previous?.concerns ?? [],
		grill_questions:
			update.grill_questions ?? previous?.grill_questions ?? [],
		base_ref: update.base_ref ?? previous?.base_ref ?? session?.repo.base_ref ?? "",
		head_ref: update.head_ref ?? previous?.head_ref ?? session?.repo.head_ref ?? "",
		pause_prompt: previous?.pause_prompt ?? "",
	};
}

function mergeSectionFeedback(
	section: ReviewSection,
	existing: ReviewSectionState | undefined,
	session: SessionInfo | null,
): ReviewSection {
	const previous = existing?.section;
	const previousHasStructure = hasStructure(previous);
	return {
		schema_version: 1,
		section_id: section.section_id,
		title: previous?.title ?? existing?.title ?? section.title,
		intent: previous?.intent ?? existing?.intent ?? section.intent,
		files: previousHasStructure ? previous?.files ?? [] : section.files ?? [],
		ranges: previousHasStructure ? previous?.ranges ?? [] : section.ranges ?? [],
		concerns: section.concerns ?? [],
		grill_questions: section.grill_questions ?? [],
		base_ref: previousHasStructure
			? previous?.base_ref ?? ""
			: section.base_ref || session?.repo.base_ref || "",
		head_ref: previousHasStructure
			? previous?.head_ref ?? ""
			: section.head_ref || session?.repo.head_ref || "",
		pause_prompt: section.pause_prompt ?? "",
	};
}

interface BaseSectionState {
	id: string;
	title: string;
	intent: string;
}

export interface PrDescriptionSectionState extends BaseSectionState {
	kind: "pr_description";
	status: SectionStatus;
	body: string;
	url?: string;
	error?: string;
}

export interface ReviewSectionState extends BaseSectionState {
	kind: "review_section";
	status: SectionStatus;
	section?: ReviewSection;
	feedbackLoaded?: boolean;
}

export interface ReviewSummarySectionState extends BaseSectionState {
	kind: "review_summary";
	status: SectionStatus;
}

export type SectionState =
	| PrDescriptionSectionState
	| ReviewSectionState
	| ReviewSummarySectionState;

export interface ChatTab {
	id: string;
	title: string;
	createdAt: number;
}

export interface CommentDraftState {
	id: string;
	draft: CommentDraft;
	marked: boolean;
	status:
		| "pending"
		| "approved"
		| "publishing"
		| "published"
		| "rejected"
		| "error";
	url?: string;
	error?: string;
}

interface AssistantChunkMeta {
	sessionId?: string;
	messageId?: string;
	replaceStreaming?: boolean;
	kind?: "thinking" | "response";
}

interface RefreshSessionMetadataRequest {
	repo: ClonedRepo;
	pull_request?: PullRequestMetadata;
	pull_request_error?: string;
	published_comments: PublishedPrComment[];
	published_comments_error?: string;
}

export interface AppState {
	project: LocalProject | null;
	session: SessionInfo | null;
	sections: SectionState[];
	currentSectionId: string | null;
	processingSectionIds: string[];
	chatTabs: ChatTab[];
	activeChatTabId: string | null;
	chatByTab: Record<string, ChatMessage[]>;
	sessionByChatTab: Record<string, string>;
	chatTabForSession: Record<string, string>;
	commentDrafts: CommentDraftState[];
	publishedComments: PublishedPrComment[];
	publishedCommentsFetchedAt: number | null;
	publishedCommentsError: string | null;
	streaming: boolean;
	errors: string[];
	stderr: string[];
	structuredReviewBlockOpen: boolean;
	structuredReviewBlockPrefix: string;
	structuredReviewMarkdownFenceOpen: boolean;
	diffFocus: DiffFocusRange | null;
	diffFocusError: string | null;

	setProject: (p: LocalProject | null) => void;
	setSession: (s: SessionInfo | null) => void;
	refreshSessionMetadata: (req: RefreshSessionMetadataRequest) => void;
	restoreSavedReview: (session: SessionInfo, snapshot: ReviewSnapshot) => void;
	reset: () => void;
	setSectionMap: (entries: SectionMapEntry[]) => void;
	upsertSection: (section: ReviewSection) => void;
	upsertSectionProgress: (update: SectionProgressUpdate) => void;
	markSectionCompleted: (id: string) => void;
	setCurrentSection: (id: string | null, reason?: string) => void;
	startSectionProcessing: (id: string) => void;
	finishSectionProcessing: (id?: string | null) => void;
	setPrDescriptionBody: (body: string) => void;

	addUserMessage: (text: string, tabId?: string) => void;
	appendAssistantChunk: (text: string, meta?: AssistantChunkMeta) => void;
	finishAssistantMessage: (sessionId?: string) => void;
	addSectionMapItem: (entries: SectionMapEntry[], sessionId?: string) => void;
	addReviewSectionItem: (section: ReviewSection, sessionId?: string) => void;
	addToolCallItem: (toolCall: ToolCallItem, sessionId?: string) => void;
	updateToolCallItem: (id: string, status: string, sessionId?: string) => void;

	createChatTab: () => ChatTab;
	setActiveChatTab: (tabId: string) => void;
	closeChatTab: (tabId: string) => { closedSessionId: string | null };
	attachChatTabSession: (
		tabId: string,
		sessionId: string,
	) => { evictedSessionId: string | null };
	detachChatTabSession: (tabId: string) => void;

	addCommentDraft: (id: string, draft: CommentDraft) => void;
	updateCommentDraft: (id: string, patch: Partial<CommentDraftState>) => void;
	editCommentDraftBody: (id: string, body: string) => void;
	setCommentMarked: (id: string, marked: boolean) => void;
	toggleConcernDraft: (id: string, draft: CommentDraft) => void;
	dismissCommentDraft: (id: string) => void;
	applyCommentResult: (result: CommentResult) => void;

	pushError: (e: string) => void;
	dismissErrors: () => void;
	pushStderr: (line: string) => void;
	setStreaming: (s: boolean) => void;

	setDiffFocus: (range: DiffFocusRange | null) => void;
	clearDiffFocus: (id?: string) => void;
	setDiffFocusError: (error: string | null) => void;
}

function prDescriptionFromSession(
	session: SessionInfo | null,
): PrDescriptionSectionState | null {
	if (!session) return null;
	if (!session.pull_request && !session.pull_request_error) {
		return {
			id: PR_DESCRIPTION_SECTION_ID,
			kind: "pr_description",
			title: "Overview",
			intent: "Overview",
			status: "in_review",
			body: "Generating description from branch commits...",
		};
	}
	return {
		id: PR_DESCRIPTION_SECTION_ID,
		kind: "pr_description",
		title: "Overview",
		intent: session.pull_request?.title || "PR description unavailable",
		status: "in_review",
		body:
			session.pull_request?.body.trim() ||
			"No PR description was provided for this review.",
		url: session.pull_request?.url,
		error: session.pull_request_error,
	};
}

function inferFeedbackLoaded(section: ReviewSectionState | undefined): boolean {
	if (!section) return false;
	if (typeof section.feedbackLoaded === "boolean") {
		return section.feedbackLoaded;
	}
	return Boolean(section.section && section.status !== "pending");
}

function restoreSectionFeedbackLoaded(section: SectionState): SectionState {
	if (section.kind !== "review_section") return section;
	return {
		...section,
		feedbackLoaded: inferFeedbackLoaded(section),
	};
}

function withoutReviewSummarySections(sections: SectionState[]): SectionState[] {
	return sections.filter((s) => s.kind !== "review_summary");
}

function insertReviewSection(
	sections: SectionState[],
	updated: ReviewSectionState,
): SectionState[] {
	return [...withoutReviewSummarySections(sections), updated];
}

function restoredCurrentSectionId(
	requested: string | null,
	sections: SectionState[],
): string | null {
	const normalized =
		requested === "spec" || requested === REVIEW_SUMMARY_SECTION_ID
			? null
			: requested;
	if (normalized && sections.some((section) => section.id === normalized)) {
		return normalized;
	}
	return sections[0]?.id ?? null;
}

function normalizeRestoredDraft(draft: CommentDraftState): CommentDraftState {
	const marked =
		typeof draft.marked === "boolean" ? draft.marked : draft.status === "approved";
	const status =
		draft.status === "approved" || draft.status === "rejected"
			? "pending"
			: draft.status;
	return { ...draft, marked, status };
}

interface AppendStreamingTextResult {
	text: string;
	rawOverlapLength: number;
	appliedOverlapLength: number;
	replacesCurrent: boolean;
}

function sharedBoundaryLength(current: string, chunk: string): number {
	const maxOverlap = Math.min(current.length, chunk.length);
	for (let overlap = maxOverlap; overlap >= 1; overlap -= 1) {
		if (current.endsWith(chunk.slice(0, overlap))) {
			return overlap;
		}
	}
	return 0;
}

function appendStreamingText(
	current: string,
	chunk: string,
): AppendStreamingTextResult {
	if (!current || !chunk) {
		return {
			text: current + chunk,
			rawOverlapLength: 0,
			appliedOverlapLength: 0,
			replacesCurrent: false,
		};
	}

	const rawOverlapLength = sharedBoundaryLength(current, chunk);
	const replacesCurrent = chunk.startsWith(current);
	const appliedOverlapLength =
		replacesCurrent || rawOverlapLength >= 4 ? rawOverlapLength : 0;
	const text = replacesCurrent
		? chunk
		: current + chunk.slice(appliedOverlapLength);

	return {
		text,
		rawOverlapLength,
		appliedOverlapLength,
		replacesCurrent,
	};
}

const STRUCTURED_REVIEW_TAGS = [
	"acp-pr-description",
	"acp-section-map",
	"acp-section",
	"acp-comment-draft",
	"acp-comment-result",
];
const STRUCTURED_REVIEW_TAG_PATTERN = STRUCTURED_REVIEW_TAGS.join("|");
const STRUCTURED_REVIEW_BLOCK_RE = new RegExp(
	"```[ \\t]*(?:" +
		STRUCTURED_REVIEW_TAG_PATTERN +
		")[^\\n]*\\n[\\s\\S]*?\\n```[ \\t]*(?:\\r?\\n)?",
	"g",
);
const STRUCTURED_REVIEW_BLOCK_OPEN_RE = new RegExp(
	"^```[ \\t]*(?:" +
		STRUCTURED_REVIEW_TAG_PATTERN +
		")[^\\n]*\\r?\\n",
);

export function cleanVisibleStructuredText(text: string): string {
	return text
		.replace(STRUCTURED_REVIEW_BLOCK_RE, "")
		.replace(/[ \t]+\r?\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n");
}

function findStructuredFenceCloseEnd(text: string, start: number): number | null {
	if (text.startsWith("```", start)) {
		const lineEnd = text.indexOf("\n", start);
		return lineEnd === -1 ? text.length : lineEnd + 1;
	}
	const match = /\r?\n```[ \t]*(?:\r?\n)?/.exec(text.slice(start));
	return match ? start + match.index + match[0].length : null;
}

function isPossibleStructuredFenceOpenerPrefix(text: string): boolean {
	if (text === "`" || text === "``") return true;
	if (!text.startsWith("```") || text.includes("\n")) return false;
	const info = text.slice(3).replace(/^[ \t]*/, "");
	if (!info) return true;
	return STRUCTURED_REVIEW_TAGS.some(
		(tag) => tag.startsWith(info) || info.startsWith(tag),
	);
}

function splitTrailingStructuredFencePrefix(text: string): {
	text: string;
	prefix: string;
} {
	for (let index = 0; index < text.length; index += 1) {
		if (text[index] !== "`") continue;
		const candidate = text.slice(index);
		if (isPossibleStructuredFenceOpenerPrefix(candidate)) {
			return {
				text: text.slice(0, index),
				prefix: candidate,
			};
		}
	}
	return { text, prefix: "" };
}

function stripStructuredReviewBlocks(
	text: string,
	insideBlock: boolean,
	prefix: string,
	markdownFenceOpen: boolean,
): {
	text: string;
	insideBlock: boolean;
	prefix: string;
	markdownFenceOpen: boolean;
} {
	let cursor = 0;
	let visible = "";
	let hidden = insideBlock;
	let visibleMarkdownFenceOpen = markdownFenceOpen;
	const input = prefix + text;

	while (cursor < input.length) {
		if (hidden) {
			const closeEnd = findStructuredFenceCloseEnd(input, cursor);
			if (closeEnd === null) {
				return {
					text: cleanVisibleStructuredText(visible),
					insideBlock: true,
					prefix: "",
					markdownFenceOpen: visibleMarkdownFenceOpen,
				};
			}
			cursor = closeEnd;
			hidden = false;
			continue;
		}

		const fenceStart = input.indexOf("```", cursor);
		if (fenceStart === -1) {
			const trailing = splitTrailingStructuredFencePrefix(input.slice(cursor));
			visible += trailing.text;
			return {
				text: cleanVisibleStructuredText(visible),
				insideBlock: false,
				prefix: trailing.prefix,
				markdownFenceOpen: visibleMarkdownFenceOpen,
			};
		}

		visible += input.slice(cursor, fenceStart);
		const rest = input.slice(fenceStart);
		const startMatch = STRUCTURED_REVIEW_BLOCK_OPEN_RE.exec(rest);
		if (startMatch) {
			cursor = fenceStart + startMatch[0].length;
			hidden = true;
			continue;
		}
		if (visibleMarkdownFenceOpen && isPossibleStructuredFenceOpenerPrefix(rest)) {
			visible += "```";
			visibleMarkdownFenceOpen = false;
			cursor = fenceStart + 3;
			continue;
		}
		if (isPossibleStructuredFenceOpenerPrefix(rest)) {
			return {
				text: cleanVisibleStructuredText(visible),
				insideBlock: false,
				prefix: rest,
				markdownFenceOpen: visibleMarkdownFenceOpen,
			};
		}

		visible += "```";
		visibleMarkdownFenceOpen = !visibleMarkdownFenceOpen;
		cursor = fenceStart + 3;
	}

	return {
		text: cleanVisibleStructuredText(visible),
		insideBlock: hidden,
		prefix: "",
		markdownFenceOpen: visibleMarkdownFenceOpen,
	};
}

function finishStreamingMessages(chat: ChatMessage[]): ChatMessage[] {
	let changed = false;
	const next = chat.map((message) => {
		if (!message.streaming) return message;
		changed = true;
		return { ...message, streaming: false };
	});
	return changed ? next : chat;
}

function partsFromMessage(message: ChatMessage): ChatMessagePart[] {
	if (message.parts) return [...message.parts];
	return message.text ? [{ type: "markdown", text: message.text }] : [];
}

function textFromParts(parts: ChatMessagePart[]): string {
	return parts
		.map((part) => {
			if (part.type === "markdown" || part.type === "thinking") {
				return part.text;
			}
			if (part.type === "assistant_response") {
				return part.markdown;
			}
			return "";
		})
		.join("");
}

function visibleResponseTextFromParts(parts: ChatMessagePart[]): string {
	return parts
		.map((part) => {
			if (part.type === "assistant_response") return part.markdown;
			if (part.type === "markdown") return part.text;
			return "";
		})
		.join("");
}

function preserveThinkingParts(parts: ChatMessagePart[]): ChatMessagePart[] {
	return parts
		.map((part): ChatMessagePart | null => {
			if (part.type === "assistant_response") return null;
			if (part.type === "markdown") {
				return { type: "thinking", text: part.text };
			}
			return part;
		})
		.filter((part): part is ChatMessagePart => part !== null);
}

function appendResponsePart(
	parts: ChatMessagePart[],
	markdown: string,
): ChatMessagePart[] {
	const next: ChatMessagePart[] = parts.filter(
		(part) => part.type !== "assistant_response",
	);
	if (markdown) next.push({ type: "assistant_response", markdown });
	return next;
}

function appendResponseChunkToParts(
	parts: ChatMessagePart[],
	chunk: string,
): { parts: ChatMessagePart[]; text: string; merged: AppendStreamingTextResult } {
	const current = visibleResponseTextFromParts(parts);
	const merged = appendStreamingText(current, chunk);
	const text = cleanVisibleStructuredText(merged.text);
	return {
		parts: appendResponsePart(preserveThinkingParts(parts), text),
		text,
		merged,
	};
}

function updateToolCallPart(
	part: ChatMessagePart,
	id: string,
	status: string,
): ChatMessagePart {
	if (part.type !== "tool_call" || part.toolCall.tool_call_id !== id) {
		return part;
	}
	return {
		type: "tool_call",
		toolCall: {
			...part.toolCall,
			status,
		},
	};
}

function readableAssistantMessage(item: ChatItem): ChatMessage {
	return {
		id: crypto.randomUUID(),
		role: "assistant",
		text: "",
		item,
	};
}

function addProcessingSectionId(ids: string[], id: string): string[] {
	return ids.includes(id) ? ids : [...ids, id];
}

function removeProcessingSectionId(ids: string[], id: string): string[] {
	return ids.filter((current) => current !== id);
}

function overviewChatTab(): ChatTab {
	return {
		id: OVERVIEW_CHAT_TAB_ID,
		title: "Overview",
		createdAt: Date.now(),
	};
}

function nextChatTabTitle(tabs: ChatTab[]): string {
	return `Chat ${tabs.length + 1}`;
}

function emptyChatState(parentSessionId?: string) {
	const tab = overviewChatTab();
	const sessionByChatTab: Record<string, string> = {};
	const chatTabForSession: Record<string, string> = {};
	if (parentSessionId) {
		sessionByChatTab[tab.id] = parentSessionId;
		chatTabForSession[parentSessionId] = tab.id;
	}
	return {
		chatTabs: [tab],
		activeChatTabId: tab.id,
		chatByTab: { [tab.id]: [] },
		sessionByChatTab,
		chatTabForSession,
	};
}

function resolveTargetChatTabId(state: AppState, sessionId?: string): string {
	if (sessionId) {
		const known = state.chatTabForSession[sessionId];
		if (known) return known;
	}
	return state.activeChatTabId ?? state.chatTabs[0]?.id ?? OVERVIEW_CHAT_TAB_ID;
}

function resolveExplicitChatTabId(state: AppState, tabId?: string): string {
	if (tabId && state.chatTabs.some((tab) => tab.id === tabId)) return tabId;
	return resolveTargetChatTabId(state);
}

function updateChatForTab(
	state: AppState,
	tabId: string,
	updater: (messages: ChatMessage[]) => ChatMessage[],
): Pick<AppState, "chatByTab"> {
	const current = state.chatByTab[tabId] ?? [];
	const next = updater(current);
	if (next === current) {
		return { chatByTab: state.chatByTab };
	}
	return { chatByTab: { ...state.chatByTab, [tabId]: next } };
}

function attachSessionToTabState(
	state: AppState,
	tabId: string,
	sessionId: string,
): { patch: Partial<AppState>; evictedSessionId: string | null } {
	const previousSessionId = state.sessionByChatTab[tabId];
	const sessionByChatTab = { ...state.sessionByChatTab, [tabId]: sessionId };
	const chatTabForSession = { ...state.chatTabForSession, [sessionId]: tabId };

	if (previousSessionId && previousSessionId !== sessionId) {
		delete chatTabForSession[previousSessionId];
	}

	recordClientTelemetry("client.store.chat_tab_session.attached", {
		"chat.tab_id": tabId,
		"acp.session_id": sessionId,
	});

	return {
		evictedSessionId: null,
		patch: {
			sessionByChatTab,
			chatTabForSession,
			chatByTab:
				tabId in state.chatByTab
					? state.chatByTab
					: { ...state.chatByTab, [tabId]: [] },
		},
	};
}

function detachSessionFromTabState(
	state: AppState,
	tabId: string,
): Partial<AppState> {
	const sessionId = state.sessionByChatTab[tabId];
	if (!sessionId) return {};
	const sessionByChatTab = { ...state.sessionByChatTab };
	delete sessionByChatTab[tabId];
	const chatTabForSession = { ...state.chatTabForSession };
	delete chatTabForSession[sessionId];
	return {
		sessionByChatTab,
		chatTabForSession,
	};
}

export const useApp = create<AppState>((set) => ({
	project: null,
	session: null,
	sections: [],
	currentSectionId: null,
	processingSectionIds: [],
	chatTabs: [],
	activeChatTabId: null,
	chatByTab: {},
	sessionByChatTab: {},
	chatTabForSession: {},
	commentDrafts: [],
	publishedComments: [],
	publishedCommentsFetchedAt: null,
	publishedCommentsError: null,
	streaming: false,
	errors: [],
	stderr: [],
	structuredReviewBlockOpen: false,
	structuredReviewBlockPrefix: "",
	structuredReviewMarkdownFenceOpen: false,
	diffFocus: null,
	diffFocusError: null,

	setProject: (p) =>
		set((state) => {
			const samePath = state.project?.path === p?.path;
			if (p) saveLastProjectPath(p.path);
			else clearLastProjectPath();
			recordClientTelemetry("client.store.project.set", {
				"project.path": p?.path,
				"project.slug": p?.origin.slug,
				"project.previous_path": state.project?.path,
				"project.cleared_session": !samePath && !!state.session,
			});
			if (samePath) {
				return { project: p };
			}
			return {
				project: p,
				session: null,
				sections: [],
				currentSectionId: null,
				processingSectionIds: [],
				chatTabs: [],
				activeChatTabId: null,
				chatByTab: {},
				sessionByChatTab: {},
				chatTabForSession: {},
				commentDrafts: [],
				publishedComments: [],
				publishedCommentsFetchedAt: null,
				publishedCommentsError: null,
				streaming: false,
				structuredReviewBlockOpen: false,
				structuredReviewBlockPrefix: "",
				structuredReviewMarkdownFenceOpen: false,
				diffFocus: null,
				diffFocusError: null,
			};
		}),

	setSession: (s) => {
		recordClientTelemetry("client.store.session.set", {
			"acp.session_id": s?.session_id,
			"repo.display_slug": s?.repo.display_slug,
			"repo.base_ref": s?.repo.base_ref,
			"repo.head_ref": s?.repo.head_ref,
			"session.source.kind": s?.source.kind,
			"pull_request.has_metadata": !!s?.pull_request,
			"pull_request.has_error": !!s?.pull_request_error,
		});
		const prDescription = prDescriptionFromSession(s);
		set({
			session: s,
			sections: prDescription ? [prDescription] : [],
			currentSectionId: prDescription ? prDescription.id : null,
			...(s
				? emptyChatState(s.session_id)
				: {
					chatTabs: [],
					activeChatTabId: null,
					chatByTab: {},
					sessionByChatTab: {},
					chatTabForSession: {},
			}),
			commentDrafts: [],
			publishedComments: s?.published_comments ?? [],
			publishedCommentsFetchedAt: s ? Date.now() : null,
			publishedCommentsError: s?.published_comments_error ?? null,
			structuredReviewBlockOpen: false,
			structuredReviewBlockPrefix: "",
			structuredReviewMarkdownFenceOpen: false,
		});
	},
	refreshSessionMetadata: (req) =>
		set((state) => {
			if (!state.session) return {};
			recordClientTelemetry("client.store.session_metadata.refreshed", {
				"acp.session_id": state.session.session_id,
				"repo.previous_head_sha": state.session.repo.head_sha,
				"repo.next_head_sha": req.repo.head_sha,
				"pull_request.has_metadata": !!req.pull_request,
				"pull_request.has_error": !!req.pull_request_error,
			});
			return {
				session: {
					...state.session,
					repo: req.repo,
					pull_request: req.pull_request,
					pull_request_error: req.pull_request_error,
					published_comments: req.published_comments,
					published_comments_error: req.published_comments_error,
				},
				publishedComments: req.published_comments,
				publishedCommentsFetchedAt: Date.now(),
				publishedCommentsError: req.published_comments_error ?? null,
			};
		}),
	restoreSavedReview: (session, snapshot) => {
		recordClientTelemetry("client.store.saved_review.restored", {
			"acp.session_id": session.session_id,
			"repo.display_slug": session.repo.display_slug,
			"repo.base_ref": session.repo.base_ref,
			"repo.head_ref": session.repo.head_ref,
			"session.source.kind": session.source.kind,
			"section.current_id": snapshot.current_section_id,
			"section.count": snapshot.sections.length,
		});
		const restoredSections = withoutReviewSummarySections(
			snapshot.sections.map(restoreSectionFeedbackLoaded),
		);
		set({
			session,
			sections: restoredSections,
			currentSectionId: restoredCurrentSectionId(
				snapshot.current_section_id,
				restoredSections,
			),
			processingSectionIds: [],
			...emptyChatState(session.session_id),
			commentDrafts: snapshot.comment_drafts.map(normalizeRestoredDraft),
			publishedComments: snapshot.published_comments,
			publishedCommentsFetchedAt: Date.now(),
			publishedCommentsError: snapshot.published_comments_error,
			streaming: false,
			structuredReviewBlockOpen: false,
			structuredReviewBlockPrefix: "",
			structuredReviewMarkdownFenceOpen: false,
			diffFocus: null,
			diffFocusError: null,
		});
	},
	reset: () =>
		set((state) => {
			const chatCount = Object.values(state.chatByTab).reduce(
				(acc, messages) => acc + messages.length,
				0,
			);
			recordClientTelemetry("client.store.reset", {
				"acp.session_id": state.session?.session_id,
				"section.current_id": state.currentSectionId,
				"section.count": state.sections.length,
				"chat.count": chatCount,
			});
			return {
				session: null,
				sections: [],
				currentSectionId: null,
				processingSectionIds: [],
				chatTabs: [],
				activeChatTabId: null,
				chatByTab: {},
				sessionByChatTab: {},
				chatTabForSession: {},
				commentDrafts: [],
				publishedComments: [],
				publishedCommentsFetchedAt: null,
				publishedCommentsError: null,
				streaming: false,
				structuredReviewBlockOpen: false,
				structuredReviewBlockPrefix: "",
				structuredReviewMarkdownFenceOpen: false,
				diffFocus: null,
				diffFocusError: null,
			};
		}),

	setSectionMap: (entries) =>
		set((state) => {
			recordClientTelemetry("client.store.section_map.set", {
				"acp.session_id": state.session?.session_id,
				"section.count": entries.length,
				"section.first_id": entries[0]?.section_id,
				"section.previous_current_id": state.currentSectionId,
				"section.previous_count": state.sections.length,
			});
			const prDescription = state.sections.find(
				(section): section is PrDescriptionSectionState =>
					section.kind === "pr_description",
			);
			const existingReviewSections = new Map(
				state.sections
					.filter(
						(section): section is ReviewSectionState =>
							section.kind === "review_section",
					)
					.map((section) => [section.id, section]),
			);
			return {
				sections: [
					...(prDescription ? [prDescription] : []),
					...entries.map((e): ReviewSectionState => {
						const existing = existingReviewSections.get(e.section_id);
						const section = mergeMapEntrySection(e, existing, state.session);
						const feedbackLoaded = inferFeedbackLoaded(existing);
						return {
							id: e.section_id,
							kind: "review_section",
							title: e.title,
							intent: e.intent,
							status:
								existing?.status === "completed"
									? "completed"
									: feedbackLoaded || (section && hasSectionFeedback(section))
										? "in_review"
										: "pending",
							section,
							feedbackLoaded,
						};
					}),
				],
			};
		}),

	upsertSection: (section) =>
		set((state) => {
			const sections = [...state.sections];
			const idx = sections.findIndex((s) => s.id === section.section_id);
			const existing =
				idx >= 0 && sections[idx]?.kind === "review_section"
					? sections[idx]
					: undefined;
			const previousStatus = idx >= 0 ? sections[idx].status : undefined;
			const normalizedSection = mergeSectionFeedback(
				section,
				existing,
				state.session,
			);
			const updated: ReviewSectionState = {
				id: section.section_id,
				kind: "review_section",
				title: normalizedSection.title,
				intent: normalizedSection.intent,
				status: "in_review",
				section: normalizedSection,
				feedbackLoaded: true,
			};
			let nextSections = sections;
			if (idx >= 0) {
				nextSections = [...sections];
				nextSections[idx] = updated;
			} else {
				nextSections = insertReviewSection(sections, updated);
			}
			recordClientTelemetry("client.store.section.upserted", {
				"acp.session_id": state.session?.session_id,
				"section.id": section.section_id,
				"section.index": idx,
				"section.was_known": idx >= 0,
				"section.previous_status": previousStatus,
				"section.current_id": state.currentSectionId,
				"section.processing_ids": state.processingSectionIds.join(","),
				"section.file_count": normalizedSection.files.length,
				"section.concern_count": normalizedSection.concerns.length,
				"section.grill_question_count":
					normalizedSection.grill_questions.length,
			});
			return {
				sections: withoutReviewSummarySections(nextSections),
				processingSectionIds: removeProcessingSectionId(
					state.processingSectionIds,
					section.section_id,
				),
			};
		}),

	upsertSectionProgress: (update) =>
		set((state) => {
			const sections = [...state.sections];
			const idx = sections.findIndex((s) => s.id === update.section_id);
			const existing =
				idx >= 0 && sections[idx]?.kind === "review_section"
					? sections[idx]
					: undefined;
			const section = mergeSectionProgress(update, existing, state.session);
			const updated: ReviewSectionState = {
				id: update.section_id,
				kind: "review_section",
				title: section.title,
				intent: section.intent,
				status: "in_review",
				section,
				feedbackLoaded: inferFeedbackLoaded(existing),
			};
			let nextSections = sections;
			if (idx >= 0) {
				nextSections = [...sections];
				nextSections[idx] = updated;
			} else {
				nextSections = insertReviewSection(sections, updated);
			}
			recordClientTelemetry("client.store.section_progress.upserted", {
				"acp.session_id": state.session?.session_id,
				"section.id": update.section_id,
				"section.phase": update.phase,
				"section.index": idx,
				"section.was_known": idx >= 0,
				"section.current_id": state.currentSectionId,
				"section.file_count": section.files.length,
				"section.concern_count": section.concerns.length,
				"section.grill_question_count": section.grill_questions.length,
			});
			return {
				sections: withoutReviewSummarySections(nextSections),
				processingSectionIds: addProcessingSectionId(
					state.processingSectionIds,
					update.section_id,
				),
			};
		}),

	markSectionCompleted: (id) =>
		set((state) => {
			recordClientTelemetry("client.store.section.completed", {
				"acp.session_id": state.session?.session_id,
				"section.id": id,
				"section.current_id": state.currentSectionId,
			});
			return {
				sections: state.sections.map((s) =>
					s.id === id ? { ...s, status: "completed" } : s,
				),
			};
		}),

	setCurrentSection: (id, reason = "unknown") =>
		set((state) => {
			recordClientTelemetry("client.store.current_section.set", {
				"acp.session_id": state.session?.session_id,
				"section.previous_current_id": state.currentSectionId,
				"section.next_current_id": id,
				"section.set_reason": reason,
			});
			return {
				currentSectionId: id,
			};
		}),

	startSectionProcessing: (id) =>
		set((state) => {
			recordClientTelemetry("client.store.section_processing.started", {
				"acp.session_id": state.session?.session_id,
				"section.previous_processing_ids": state.processingSectionIds.join(","),
				"section.next_processing_id": id,
				"section.current_id": state.currentSectionId,
			});
			return {
				processingSectionIds: addProcessingSectionId(
					state.processingSectionIds,
					id,
				),
			};
		}),

	finishSectionProcessing: (id = null) =>
		set((state) => {
			if (id && !state.processingSectionIds.includes(id)) return {};
			recordClientTelemetry("client.store.section_processing.finished", {
				"acp.session_id": state.session?.session_id,
				"section.previous_processing_ids": state.processingSectionIds.join(","),
				"section.finished_id": id,
			});
			return {
				processingSectionIds: id
					? removeProcessingSectionId(state.processingSectionIds, id)
					: [],
			};
		}),

	setPrDescriptionBody: (body) =>
		set((state) => ({
			sections: state.sections.map((s) =>
				s.kind === "pr_description" ? { ...s, body } : s,
			),
		})),

	addUserMessage: (text, tabId) =>
		set((state) => {
			const targetTabId = resolveExplicitChatTabId(state, tabId);
			const chatState = updateChatForTab(state, targetTabId, (messages) => [
				...messages,
				{ id: crypto.randomUUID(), role: "user", text },
			]);
			return {
				...chatState,
				streaming: true,
			};
		}),

	appendAssistantChunk: (text, meta) =>
		set((state) => {
			const targetTabId = resolveTargetChatTabId(state, meta?.sessionId);
			const targetSectionId = state.currentSectionId ?? undefined;
			const sessionId = meta?.sessionId ?? state.session?.session_id;
			const stripped = stripStructuredReviewBlocks(
				text,
				state.structuredReviewBlockOpen,
				state.structuredReviewBlockPrefix,
				state.structuredReviewMarkdownFenceOpen,
			);
			const visibleText = stripped.text;
			const messages = state.chatByTab[targetTabId] ?? [];
			const chat = [...messages];
			const last = chat[chat.length - 1];
			const withChat = (nextChat: ChatMessage[]) => ({
				chatByTab: { ...state.chatByTab, [targetTabId]: nextChat },
				structuredReviewBlockOpen: stripped.insideBlock,
				structuredReviewBlockPrefix: stripped.prefix,
				structuredReviewMarkdownFenceOpen: stripped.markdownFenceOpen,
			});
			if (!last && !visibleText) {
				return {
					structuredReviewBlockOpen: stripped.insideBlock,
					structuredReviewBlockPrefix: stripped.prefix,
					structuredReviewMarkdownFenceOpen: stripped.markdownFenceOpen,
				};
			}
			if (last && last.role === "assistant" && last.streaming) {
				if (meta?.replaceStreaming) {
					const parts = appendResponsePart(
						preserveThinkingParts(partsFromMessage(last)),
						visibleText,
					);
					const responseText = visibleResponseTextFromParts(parts);
					recordClientTelemetry("client.chat.assistant_chunk.replaced", {
						"acp.session_id": sessionId,
						"acp.message_id": meta?.messageId,
						"section.id": targetSectionId,
						"chat.tab_id": targetTabId,
						"chat.chunk.length": text.length,
						"chat.previous.length": last.text.length,
					});
					chat[chat.length - 1] = {
						...last,
						text: responseText,
						parts: parts.length > 0 ? parts : undefined,
					};
					return withChat(chat);
				}
				const parts = partsFromMessage(last);
				if (meta?.kind === "response") {
					if (!visibleText) {
						return {
							structuredReviewBlockOpen: stripped.insideBlock,
							structuredReviewBlockPrefix: stripped.prefix,
							structuredReviewMarkdownFenceOpen: stripped.markdownFenceOpen,
						};
					}
					const response = appendResponseChunkToParts(parts, visibleText);
					recordClientTelemetry("client.chat.assistant_chunk.merged", {
						"acp.session_id": sessionId,
						"acp.message_id": meta?.messageId,
						"section.id": targetSectionId,
						"chat.tab_id": targetTabId,
						"chat.chunk.length": text.length,
						"chat.current.length": visibleResponseTextFromParts(parts).length,
						"chat.next.length": response.text.length,
						"chat.overlap.raw_length": response.merged.rawOverlapLength,
						"chat.overlap.applied_length": response.merged.appliedOverlapLength,
						"chat.overlap.replaces_current": response.merged.replacesCurrent,
						"chat.chunk.text": truncateTelemetryText(text),
						"chat.current.tail": truncateTelemetryText(
							visibleResponseTextFromParts(parts).slice(-512),
						),
					});
					chat[chat.length - 1] = {
						...last,
						text: response.text,
						parts: response.parts,
					};
					return withChat(chat);
				}
				const lastPart = parts[parts.length - 1];
				const merged = appendStreamingText(last.text, visibleText);
				const nextText = cleanVisibleStructuredText(merged.text);
				const nextSuffix = nextText.startsWith(last.text)
					? nextText.slice(last.text.length)
					: visibleText;
				if (lastPart?.type === "thinking" && nextSuffix) {
					parts[parts.length - 1] = {
						type: "thinking",
						text: cleanVisibleStructuredText(lastPart.text + nextSuffix),
					};
				} else if (nextSuffix) {
					parts.push({ type: "thinking", text: nextSuffix });
				}
				recordClientTelemetry("client.chat.assistant_chunk.merged", {
					"acp.session_id": sessionId,
					"acp.message_id": meta?.messageId,
					"section.id": targetSectionId,
					"chat.tab_id": targetTabId,
					"chat.chunk.length": text.length,
					"chat.current.length": last.text.length,
					"chat.next.length": nextText.length,
					"chat.overlap.raw_length": merged.rawOverlapLength,
					"chat.overlap.applied_length": merged.appliedOverlapLength,
					"chat.overlap.replaces_current": merged.replacesCurrent,
					"chat.chunk.text": truncateTelemetryText(text),
					"chat.current.tail": truncateTelemetryText(last.text.slice(-512)),
				});
				chat[chat.length - 1] = {
					...last,
					text: nextText,
					parts,
				};
			} else {
				if (!visibleText) {
					return {
						structuredReviewBlockOpen: stripped.insideBlock,
						structuredReviewBlockPrefix: stripped.prefix,
						structuredReviewMarkdownFenceOpen: stripped.markdownFenceOpen,
					};
				}
				recordClientTelemetry("client.chat.assistant_message.started", {
					"acp.session_id": sessionId,
					"acp.message_id": meta?.messageId,
					"section.id": targetSectionId,
					"chat.tab_id": targetTabId,
					"chat.chunk.length": text.length,
					"chat.chunk.text": truncateTelemetryText(text),
				});
				const parts: ChatMessagePart[] =
					meta?.replaceStreaming || meta?.kind === "response"
						? [{ type: "assistant_response", markdown: visibleText }]
						: [{ type: "thinking", text: visibleText }];
				chat.push({
					id: crypto.randomUUID(),
					role: "assistant",
					text: visibleText,
					parts,
					streaming: true,
				});
			}
			return withChat(chat);
		}),

	finishAssistantMessage: (sessionId) =>
		set((state) => {
			const targets = sessionId
				? [resolveTargetChatTabId(state, sessionId)]
				: Object.keys(state.chatByTab);
			let chatByTab = state.chatByTab;
			for (const targetTabId of targets) {
				const messages = chatByTab[targetTabId];
				if (!messages || messages.length === 0) continue;
				const last = messages[messages.length - 1];
				if (!last.streaming) continue;
				recordClientTelemetry("client.chat.assistant_message.finished", {
					"acp.session_id": state.session?.session_id,
					"section.id": state.currentSectionId,
					"chat.tab_id": targetTabId,
					"chat.message.length": last.text.length,
				});
				const next = [...messages];
				next[next.length - 1] = { ...last, streaming: false };
				chatByTab = { ...chatByTab, [targetTabId]: next };
			}
			return { chatByTab, streaming: false };
		}),

	addSectionMapItem: (entries, sessionId) =>
		set((state) => {
			const targetTabId = sessionId
				? resolveTargetChatTabId(state, sessionId)
				: OVERVIEW_CHAT_TAB_ID;
			return {
				...updateChatForTab(state, targetTabId, (messages) => [
					...finishStreamingMessages(messages),
					readableAssistantMessage({
						type: "section_map",
						sections: entries,
					}),
				]),
			};
		}),

	addReviewSectionItem: (section, sessionId) =>
		set((state) => {
			const targetTabId = sessionId
				? resolveTargetChatTabId(state, sessionId)
				: OVERVIEW_CHAT_TAB_ID;
			return {
				...updateChatForTab(state, targetTabId, (messages) => [
					...finishStreamingMessages(messages),
					readableAssistantMessage({
						type: "review_section",
						section,
					}),
				]),
			};
		}),

	addToolCallItem: (toolCall, sessionId) =>
		set((state) => {
			const targetTabId = sessionId
				? resolveTargetChatTabId(state, sessionId)
				: OVERVIEW_CHAT_TAB_ID;
			const messages = state.chatByTab[targetTabId] ?? [];
			const chat = [...messages];
			const last = chat[chat.length - 1];
			if (last?.role === "assistant" && last.streaming && !last.item) {
				const parts = partsFromMessage(last);
				parts.push({ type: "tool_call", toolCall });
				chat[chat.length - 1] = {
					...last,
					text: textFromParts(parts),
					parts,
				};
			} else {
				chat.push({
					id: crypto.randomUUID(),
					role: "assistant",
					text: "",
					parts: [{ type: "tool_call", toolCall }],
					streaming: true,
				});
			}
			return {
				...updateChatForTab(state, targetTabId, () => chat),
			};
		}),

	updateToolCallItem: (id, status, sessionId) =>
		set((state) => {
			let chatByTab = state.chatByTab;
			const targets = sessionId
				? [resolveTargetChatTabId(state, sessionId)]
				: Object.keys(state.chatByTab);
			for (const targetTabId of targets) {
				const messages = chatByTab[targetTabId];
				if (!messages) continue;
				let touched = false;
				const next = messages.map((message) => {
					if (!message.parts?.some((part) => part.type === "tool_call")) {
						return message;
					}
					const matches = message.parts.some(
						(part) =>
							part.type === "tool_call" && part.toolCall.tool_call_id === id,
					);
					if (!matches) return message;
					touched = true;
					const parts = message.parts.map((part) =>
						updateToolCallPart(part, id, status),
					);
					return {
						...message,
						parts,
					};
				});
				if (touched) {
					chatByTab = { ...chatByTab, [targetTabId]: next };
				}
			}
			return { chatByTab };
		}),

	createChatTab: () => {
		let created: ChatTab = {
			id: `chat:${crypto.randomUUID()}`,
			title: "Chat 2",
			createdAt: Date.now(),
		};
		set((state) => {
			const tabs = state.chatTabs.length ? state.chatTabs : [overviewChatTab()];
			created = {
				...created,
				title: nextChatTabTitle(tabs),
			};
			recordClientTelemetry("client.store.chat_tab.created", {
				"chat.tab_id": created.id,
				"chat.tab_count": tabs.length + 1,
			});
			return {
				chatTabs: [...tabs, created],
				activeChatTabId: created.id,
				chatByTab: {
					...state.chatByTab,
					...(tabs[0].id in state.chatByTab ? {} : { [tabs[0].id]: [] }),
					[created.id]: [],
				},
			};
		});
		return created;
	},
	setActiveChatTab: (tabId) =>
		set((state) => {
			if (!state.chatTabs.some((tab) => tab.id === tabId)) return {};
			recordClientTelemetry("client.store.chat_tab.selected", {
				"chat.tab_id": tabId,
			});
			return {
				activeChatTabId: tabId,
			};
		}),
	closeChatTab: (tabId) => {
		let closedSessionId: string | null = null;
		set((state) => {
			if (tabId === OVERVIEW_CHAT_TAB_ID) return {};
			const tabIndex = state.chatTabs.findIndex((tab) => tab.id === tabId);
			if (tabIndex < 0) return {};
			closedSessionId = state.sessionByChatTab[tabId] ?? null;
			const nextTabs = state.chatTabs.filter((tab) => tab.id !== tabId);
			const nextActiveId =
				state.activeChatTabId === tabId
					? (nextTabs[Math.max(0, tabIndex - 1)]?.id ?? OVERVIEW_CHAT_TAB_ID)
					: state.activeChatTabId;
			const chatByTab = { ...state.chatByTab };
			delete chatByTab[tabId];
			const sessionByChatTab = { ...state.sessionByChatTab };
			delete sessionByChatTab[tabId];
			const chatTabForSession = { ...state.chatTabForSession };
			if (closedSessionId) delete chatTabForSession[closedSessionId];
			recordClientTelemetry("client.store.chat_tab.closed", {
				"chat.tab_id": tabId,
				"acp.session_id": closedSessionId,
			});
			return {
				chatTabs: nextTabs,
				activeChatTabId: nextActiveId,
				chatByTab,
				sessionByChatTab,
				chatTabForSession,
			};
		});
		return { closedSessionId };
	},
	attachChatTabSession: (tabId, sessionId) => {
		let evictedSessionId: string | null = null;
		set((state) => {
			const next = attachSessionToTabState(state, tabId, sessionId);
			evictedSessionId = next.evictedSessionId;
			return next.patch;
		});
		return { evictedSessionId };
	},
	detachChatTabSession: (tabId) =>
		set((state) => detachSessionFromTabState(state, tabId)),

	addCommentDraft: (id, draft) =>
		set((state) => ({
			commentDrafts: [
				...state.commentDrafts,
				{ id, draft, marked: false, status: "pending" },
			],
		})),

	updateCommentDraft: (id, patch) =>
		set((state) => ({
			commentDrafts: state.commentDrafts.map((d) =>
				d.id === id ? { ...d, ...patch } : d,
			),
		})),
	editCommentDraftBody: (id, body) =>
		set((state) => ({
			commentDrafts: state.commentDrafts.map((d) =>
				d.id === id ? { ...d, draft: { ...d.draft, body } } : d,
			),
		})),
	setCommentMarked: (id, marked) =>
		set((state) => ({
			commentDrafts: state.commentDrafts.map((d) =>
				d.id === id ? { ...d, marked } : d,
			),
		})),
	toggleConcernDraft: (id, draft) =>
		set((state) => {
			if (state.commentDrafts.some((d) => d.id === id)) {
				return {
					commentDrafts: state.commentDrafts.filter((d) => d.id !== id),
				};
			}
			return {
				commentDrafts: [
					...state.commentDrafts,
					{ id, draft, marked: true, status: "pending" },
				],
			};
		}),
	dismissCommentDraft: (id) =>
		set((state) => ({
			commentDrafts: state.commentDrafts.filter((d) => d.id !== id),
		})),

	applyCommentResult: (result) =>
		set((state) => ({
			commentDrafts: state.commentDrafts.map((d) =>
				d.id === result.draft_id
					? {
							...d,
							status: result.status === "published" ? "published" : "error",
							url:
								result.status === "published"
									? result.url ?? d.url
									: undefined,
							error: result.error,
						}
					: d,
			),
		})),

	pushError: (e) =>
		set((state) => ({
			errors: [...state.errors.slice(-49), e],
			streaming: false,
		})),

	dismissErrors: () => set({ errors: [] }),

	pushStderr: (line) =>
		set((state) => ({ stderr: [...state.stderr.slice(-199), line] })),

	setStreaming: (s) => set({ streaming: s }),

	setDiffFocus: (range) =>
		set((state) => {
			recordClientTelemetry("client.store.diff_focus.set", {
				"acp.session_id": state.session?.session_id,
				"focus.file_path": range?.file_path,
				"focus.start_line": range?.start_line,
				"focus.end_line": range?.end_line,
				"focus.side": range?.side,
				"focus.source": range?.source,
				"focus.mode": range?.mode,
			});
			return { diffFocus: range, diffFocusError: null };
		}),
	clearDiffFocus: (id) =>
		set((state) => {
			if (id && state.diffFocus?.id !== id) return {};
			return { diffFocus: null };
		}),
	setDiffFocusError: (error) => set({ diffFocusError: error }),
}));
