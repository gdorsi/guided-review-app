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
export const MAX_SECTION_CHAT_SESSIONS = 3;

function hasSectionFeedback(section: ReviewSection): boolean {
	return (
		section.concerns.length > 0 ||
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
	status: SectionStatus;
}

export interface PrDescriptionSectionState extends BaseSectionState {
	kind: "pr_description";
	body: string;
	url?: string;
	error?: string;
}

export interface ReviewSectionState extends BaseSectionState {
	kind: "review_section";
	section?: ReviewSection;
	feedbackLoaded?: boolean;
}

export type SectionState = PrDescriptionSectionState | ReviewSectionState;

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

interface AppState {
	project: LocalProject | null;
	session: SessionInfo | null;
	sections: SectionState[];
	currentSectionId: string | null;
	processingSectionIds: string[];
	chatBySection: Record<string, ChatMessage[]>;
	sessionBySection: Record<string, string>;
	sectionForSession: Record<string, string>;
	sectionChatLru: string[];
	commentDrafts: CommentDraftState[];
	publishedComments: PublishedPrComment[];
	publishedCommentsFetchedAt: number | null;
	publishedCommentsError: string | null;
	streaming: boolean;
	errors: string[];
	stderr: string[];
	structuredReviewBlockOpen: boolean;
	diffFocus: DiffFocusRange | null;
	diffFocusError: string | null;

	setProject: (p: LocalProject | null) => void;
	setSession: (s: SessionInfo | null) => void;
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

	addUserMessage: (text: string, sectionId?: string) => void;
	appendAssistantChunk: (text: string, meta?: AssistantChunkMeta) => void;
	finishAssistantMessage: (sessionId?: string) => void;
	addSectionMapItem: (entries: SectionMapEntry[], sessionId?: string) => void;
	addReviewSectionItem: (section: ReviewSection, sessionId?: string) => void;
	addToolCallItem: (toolCall: ToolCallItem, sessionId?: string) => void;
	updateToolCallItem: (id: string, status: string, sessionId?: string) => void;

	attachSectionChatSession: (
		sectionId: string,
		sessionId: string,
	) => { evictedSessionId: string | null };
	detachSectionChatSession: (sectionId: string) => void;
	touchSectionChatSession: (sectionId: string) => void;

	addCommentDraft: (id: string, draft: CommentDraft) => void;
	updateCommentDraft: (id: string, patch: Partial<CommentDraftState>) => void;
	editCommentDraftBody: (id: string, body: string) => void;
	setCommentMarked: (id: string, marked: boolean) => void;
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
			title: "PR description",
			intent: "Overview",
			status: "in_review",
			body: "Generating description from branch commits...",
		};
	}
	return {
		id: PR_DESCRIPTION_SECTION_ID,
		kind: "pr_description",
		title: "PR description",
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

const STRUCTURED_REVIEW_BLOCK_RE =
	/```[ \t]*(?:acp-pr-description|acp-section-map|acp-section|acp-comment-draft|acp-comment-result)[^\n]*\n[\s\S]*?\n```[ \t]*(?:\r?\n)?/g;
const STRUCTURED_REVIEW_BLOCK_START_RE =
	/```[ \t]*(?:acp-pr-description|acp-section-map|acp-section|acp-comment-draft|acp-comment-result)[^\n]*\r?\n/g;

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

function stripStructuredReviewBlocks(
	text: string,
	insideBlock: boolean,
): { text: string; insideBlock: boolean } {
	let cursor = 0;
	let visible = "";
	let hidden = insideBlock;

	while (cursor < text.length) {
		if (hidden) {
			const closeEnd = findStructuredFenceCloseEnd(text, cursor);
			if (closeEnd === null) {
				return {
					text: cleanVisibleStructuredText(visible),
					insideBlock: true,
				};
			}
			cursor = closeEnd;
			hidden = false;
			continue;
		}

		STRUCTURED_REVIEW_BLOCK_START_RE.lastIndex = cursor;
		const startMatch = STRUCTURED_REVIEW_BLOCK_START_RE.exec(text);
		if (!startMatch) {
			visible += text.slice(cursor);
			break;
		}

		visible += text.slice(cursor, startMatch.index);
		cursor = startMatch.index + startMatch[0].length;
		const closeEnd = findStructuredFenceCloseEnd(text, cursor);
		if (closeEnd === null) {
			return {
				text: cleanVisibleStructuredText(visible),
				insideBlock: true,
			};
		}
		cursor = closeEnd;
	}

	return { text: cleanVisibleStructuredText(visible), insideBlock: false };
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

function resolveTargetSectionId(state: AppState, sessionId?: string): string {
	if (sessionId) {
		const known = state.sectionForSession[sessionId];
		if (known) return known;
	}
	if (state.currentSectionId) return state.currentSectionId;
	return PR_DESCRIPTION_SECTION_ID;
}

function updateChatForSection(
	chatBySection: Record<string, ChatMessage[]>,
	sectionId: string,
	updater: (messages: ChatMessage[]) => ChatMessage[],
): Record<string, ChatMessage[]> {
	const current = chatBySection[sectionId] ?? [];
	const next = updater(current);
	if (next === current) return chatBySection;
	return { ...chatBySection, [sectionId]: next };
}

function touchLru(lru: string[], sectionId: string): string[] {
	const filtered = lru.filter((id) => id !== sectionId);
	filtered.push(sectionId);
	return filtered;
}

export const useApp = create<AppState>((set) => ({
	project: null,
	session: null,
	sections: [],
	currentSectionId: null,
	processingSectionIds: [],
	chatBySection: {},
	sessionBySection: {},
	sectionForSession: {},
	sectionChatLru: [],
	commentDrafts: [],
	publishedComments: [],
	publishedCommentsFetchedAt: null,
	publishedCommentsError: null,
	streaming: false,
	errors: [],
	stderr: [],
	structuredReviewBlockOpen: false,
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
					chatBySection: {},
					sessionBySection: {},
					sectionForSession: {},
					sectionChatLru: [],
					commentDrafts: [],
					publishedComments: [],
					publishedCommentsFetchedAt: null,
					publishedCommentsError: null,
					streaming: false,
					structuredReviewBlockOpen: false,
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
			const sessionBySection: Record<string, string> = s
				? { [PR_DESCRIPTION_SECTION_ID]: s.session_id }
				: {};
			const sectionForSession: Record<string, string> = s
				? { [s.session_id]: PR_DESCRIPTION_SECTION_ID }
				: {};
			set({
				session: s,
				sections: prDescription ? [prDescription] : [],
				currentSectionId: prDescription ? prDescription.id : null,
				chatBySection: prDescription ? { [PR_DESCRIPTION_SECTION_ID]: [] } : {},
				sessionBySection,
				sectionForSession,
				sectionChatLru: [],
				commentDrafts: [],
				publishedComments: s?.published_comments ?? [],
				publishedCommentsFetchedAt: s ? Date.now() : null,
				publishedCommentsError: s?.published_comments_error ?? null,
			});
		},
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
			const restoredSections = snapshot.sections.map(restoreSectionFeedbackLoaded);
			set({
				session,
				sections: restoredSections,
				currentSectionId:
					snapshot.current_section_id === "spec"
						? PR_DESCRIPTION_SECTION_ID
						: snapshot.current_section_id,
				processingSectionIds: [],
				chatBySection: { [PR_DESCRIPTION_SECTION_ID]: [] },
				sessionBySection: { [PR_DESCRIPTION_SECTION_ID]: session.session_id },
				sectionForSession: { [session.session_id]: PR_DESCRIPTION_SECTION_ID },
				sectionChatLru: [],
				commentDrafts: snapshot.comment_drafts,
				publishedComments: snapshot.published_comments,
				publishedCommentsFetchedAt: Date.now(),
				publishedCommentsError: snapshot.published_comments_error,
				streaming: false,
				structuredReviewBlockOpen: false,
				diffFocus: null,
				diffFocusError: null,
			});
		},
		reset: () =>
			set((state) => {
				const chatCount = Object.values(state.chatBySection).reduce(
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
					chatBySection: {},
					sessionBySection: {},
					sectionForSession: {},
					sectionChatLru: [],
					commentDrafts: [],
					publishedComments: [],
					publishedCommentsFetchedAt: null,
					publishedCommentsError: null,
					streaming: false,
					structuredReviewBlockOpen: false,
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
				if (idx >= 0) sections[idx] = updated;
				else sections.push(updated);
				recordClientTelemetry("client.store.section.upserted", {
					"acp.session_id": state.session?.session_id,
					"section.id": section.section_id,
					"section.index": idx,
					"section.was_known": idx >= 0,
					"section.previous_status": previousStatus,
					"section.current_id": state.currentSectionId,
					"section.processing_ids": state.processingSectionIds.join(","),
					"section.file_count": normalizedSection.files.length,
				});
				return {
					sections,
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
				if (idx >= 0) sections[idx] = updated;
				else sections.push(updated);
				recordClientTelemetry("client.store.section_progress.upserted", {
					"acp.session_id": state.session?.session_id,
					"section.id": update.section_id,
					"section.phase": update.phase,
					"section.index": idx,
					"section.was_known": idx >= 0,
					"section.current_id": state.currentSectionId,
					"section.file_count": section.files.length,
					"section.concern_count": section.concerns.length,
				});
				return {
					sections,
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
				return { currentSectionId: id };
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

	addUserMessage: (text, sectionId) =>
		set((state) => {
			const targetId = sectionId ?? resolveTargetSectionId(state);
			return {
				chatBySection: updateChatForSection(
					state.chatBySection,
					targetId,
					(messages) => [
						...messages,
						{ id: crypto.randomUUID(), role: "user", text },
					],
				),
				streaming: true,
			};
		}),

	appendAssistantChunk: (text, meta) =>
		set((state) => {
			const targetId = resolveTargetSectionId(state, meta?.sessionId);
			const sessionId = meta?.sessionId ?? state.session?.session_id;
			const stripped = stripStructuredReviewBlocks(
				text,
				state.structuredReviewBlockOpen,
			);
			const visibleText = stripped.text;
			const messages = state.chatBySection[targetId] ?? [];
			const chat = [...messages];
			const last = chat[chat.length - 1];
			if (!last && !visibleText) {
				return {
					structuredReviewBlockOpen: stripped.insideBlock,
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
						"section.id": targetId,
						"chat.chunk.length": text.length,
						"chat.previous.length": last.text.length,
					});
					chat[chat.length - 1] = {
						...last,
						text: responseText,
						parts: parts.length > 0 ? parts : undefined,
					};
					return {
						chatBySection: { ...state.chatBySection, [targetId]: chat },
						structuredReviewBlockOpen: stripped.insideBlock,
					};
				}
				const parts = partsFromMessage(last);
				if (meta?.kind === "response") {
					if (!visibleText) {
						return {
							structuredReviewBlockOpen: stripped.insideBlock,
						};
					}
					const response = appendResponseChunkToParts(parts, visibleText);
					recordClientTelemetry("client.chat.assistant_chunk.merged", {
						"acp.session_id": sessionId,
						"acp.message_id": meta?.messageId,
						"section.id": targetId,
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
					return {
						chatBySection: { ...state.chatBySection, [targetId]: chat },
						structuredReviewBlockOpen: stripped.insideBlock,
					};
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
					"section.id": targetId,
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
					};
				}
				recordClientTelemetry("client.chat.assistant_message.started", {
					"acp.session_id": sessionId,
					"acp.message_id": meta?.messageId,
					"section.id": targetId,
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
			return {
				chatBySection: { ...state.chatBySection, [targetId]: chat },
				structuredReviewBlockOpen: stripped.insideBlock,
			};
		}),

	finishAssistantMessage: (sessionId) =>
		set((state) => {
			const targets = sessionId
				? [resolveTargetSectionId(state, sessionId)]
				: Object.keys(state.chatBySection);
			let chatBySection = state.chatBySection;
			for (const targetId of targets) {
				const messages = chatBySection[targetId];
				if (!messages || messages.length === 0) continue;
				const last = messages[messages.length - 1];
				if (!last.streaming) continue;
				recordClientTelemetry("client.chat.assistant_message.finished", {
					"acp.session_id": state.session?.session_id,
					"section.id": targetId,
					"chat.message.length": last.text.length,
				});
				const next = [...messages];
				next[next.length - 1] = { ...last, streaming: false };
				chatBySection = { ...chatBySection, [targetId]: next };
			}
			return { chatBySection, streaming: false };
		}),

	addSectionMapItem: (entries, sessionId) =>
		set((state) => {
			const targetId = sessionId
				? resolveTargetSectionId(state, sessionId)
				: PR_DESCRIPTION_SECTION_ID;
			return {
				chatBySection: updateChatForSection(
					state.chatBySection,
					targetId,
					(messages) => [
						...finishStreamingMessages(messages),
						readableAssistantMessage({
							type: "section_map",
							sections: entries,
						}),
					],
				),
			};
		}),

	addReviewSectionItem: (section, sessionId) =>
		set((state) => {
			const targetId = sessionId
				? resolveTargetSectionId(state, sessionId)
				: PR_DESCRIPTION_SECTION_ID;
			return {
				chatBySection: updateChatForSection(
					state.chatBySection,
					targetId,
					(messages) => [
						...finishStreamingMessages(messages),
						readableAssistantMessage({
							type: "review_section",
							section,
						}),
					],
				),
			};
		}),

	addToolCallItem: (toolCall, sessionId) =>
		set((state) => {
			const targetId = sessionId
				? resolveTargetSectionId(state, sessionId)
				: PR_DESCRIPTION_SECTION_ID;
			const messages = state.chatBySection[targetId] ?? [];
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
				chatBySection: { ...state.chatBySection, [targetId]: chat },
			};
		}),

	updateToolCallItem: (id, status, sessionId) =>
		set((state) => {
			let chatBySection = state.chatBySection;
			const targets = sessionId
				? [resolveTargetSectionId(state, sessionId)]
				: Object.keys(state.chatBySection);
			for (const targetId of targets) {
				const messages = chatBySection[targetId];
				if (!messages) continue;
				let touched = false;
				const next = messages.map((message) => {
					if (!message.parts?.some((part) => part.type === "tool_call")) {
						return message;
					}
					const matches = message.parts.some(
						(part) => part.type === "tool_call" && part.toolCall.tool_call_id === id,
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
					chatBySection = { ...chatBySection, [targetId]: next };
				}
			}
			return { chatBySection };
		}),

	attachSectionChatSession: (sectionId, sessionId) => {
		let evictedSessionId: string | null = null;
		set((state) => {
			const previousSessionId = state.sessionBySection[sectionId];
			const sectionForSession = { ...state.sectionForSession };
			if (previousSessionId && previousSessionId !== sessionId) {
				delete sectionForSession[previousSessionId];
			}
			sectionForSession[sessionId] = sectionId;
			const sessionBySection = {
				...state.sessionBySection,
				[sectionId]: sessionId,
			};
			let lru =
				sectionId === PR_DESCRIPTION_SECTION_ID
					? state.sectionChatLru
					: touchLru(state.sectionChatLru, sectionId);
			if (
				sectionId !== PR_DESCRIPTION_SECTION_ID &&
				lru.length > MAX_SECTION_CHAT_SESSIONS
			) {
				const victimSectionId = lru[0];
				lru = lru.slice(1);
				const victimSessionId = sessionBySection[victimSectionId];
				if (victimSessionId) {
					evictedSessionId = victimSessionId;
					delete sessionBySection[victimSectionId];
					delete sectionForSession[victimSessionId];
				}
			}
			recordClientTelemetry("client.store.section_chat.attached", {
				"section.id": sectionId,
				"acp.session_id": sessionId,
				"section.lru": lru.join(","),
				"section.evicted_session_id": evictedSessionId,
			});
			return {
				sessionBySection,
				sectionForSession,
				sectionChatLru: lru,
				chatBySection:
					sectionId in state.chatBySection
						? state.chatBySection
						: { ...state.chatBySection, [sectionId]: [] },
			};
		});
		return { evictedSessionId };
	},
	detachSectionChatSession: (sectionId) =>
		set((state) => {
			const sessionId = state.sessionBySection[sectionId];
			if (!sessionId) return {};
			const sessionBySection = { ...state.sessionBySection };
			delete sessionBySection[sectionId];
			const sectionForSession = { ...state.sectionForSession };
			delete sectionForSession[sessionId];
			return {
				sessionBySection,
				sectionForSession,
				sectionChatLru: state.sectionChatLru.filter((id) => id !== sectionId),
			};
		}),
	touchSectionChatSession: (sectionId) =>
		set((state) => {
			if (sectionId === PR_DESCRIPTION_SECTION_ID) return {};
			if (!state.sessionBySection[sectionId]) return {};
			return {
				sectionChatLru: touchLru(state.sectionChatLru, sectionId),
			};
		}),

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
							url: result.url ?? d.url,
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
