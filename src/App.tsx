import { useCallback, useEffect, useState } from "react";
import {
	useApp,
	type ReviewSectionState,
	type SessionInfo,
} from "@/lib/store";
import {
	on,
	acp,
	type SectionMapEvent,
	type SectionEvent,
	type SectionProgressEvent,
	type TextChunkEvent,
	type TurnDoneEvent,
	type ErrorEvent,
	type CommentDraftEvent,
	type CommentResultEvent,
	type AgentStderrEvent,
	type ToolCallEvent,
	type ToolCallUpdateEvent,
	type PrDescriptionEvent,
	type Unlisten,
	type GhCliStatus,
} from "@/lib/acp";
import type {
	ReviewSection,
	SectionMap,
	SectionMapEntry,
	SectionProgressUpdate,
} from "@/lib/types/section";
import {
	parseDisplayMessagePayload,
	parseReviewSectionPayload,
	parseSectionMapPayload,
	parseSectionProgressPayload,
} from "@/lib/reviewSectionPayload";
import { ProjectPicker } from "@/components/ProjectPicker";
import { ReviewLauncher } from "@/components/ReviewLauncher";
import { SectionList } from "@/components/SectionList";
import { DiffPane } from "@/components/DiffView";
import { ChatPanel } from "@/components/ChatPanel";
import {
	Group as PanelGroup,
	Panel,
	Separator as PanelResizeHandle,
	useDefaultLayout,
} from "react-resizable-panels";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import {
	recordClientTelemetry,
	recordClientTelemetryError,
	truncateTelemetryText,
} from "@/lib/telemetry";
import { formatPublishedCommentsForPrompt } from "@/lib/publishedComments";
import {
	createReviewSnapshot,
	saveReviewRequestFromSession,
} from "@/lib/reviewPersistence";
import { findNextSectionToAutoLoad } from "@/lib/sectionQueue";
import {
	buildUpstreamChangeHint,
	changedFilesForSection,
	findSectionsAffectedByChangedFiles,
	isPrBackedSession,
} from "@/lib/prUpdate";
import { ghCliNeedsInstallPopup, ghCliPopupMessage } from "@/lib/ghCli";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

function parseToolSectionMap(raw: unknown): SectionMap | null {
	return parseSectionMapPayload(raw);
}

function parseToolReviewSection(raw: unknown): ReviewSection | null {
	return parseReviewSectionPayload(raw);
}

function parseToolSectionProgress(raw: unknown): SectionProgressUpdate | null {
	return parseSectionProgressPayload(raw);
}

function parseToolDisplayMessage(raw: unknown): { markdown: string } | null {
	return parseDisplayMessagePayload(raw);
}

async function enrichSectionMapWithLocalRanges(
	session: SessionInfo,
	sections: SectionMapEntry[],
): Promise<SectionMapEntry[]> {
	return Promise.all(
		sections.map(async (section) => {
			const files = section.files ?? [];
			if (files.length === 0) return section;
			try {
				recordClientTelemetry("client.acp.section_map.ranges.started", {
					"acp.session_id": session.session_id,
					"section.id": section.section_id,
					"section.file_count": files.length,
				});
				const ranges = await acp.getChangedRanges({
					repo_path: session.repo.path,
					base_ref: session.repo.base_ref,
					head_ref: session.repo.head_ref,
					file_paths: files,
				});
				recordClientTelemetry("client.acp.section_map.ranges.succeeded", {
					"acp.session_id": session.session_id,
					"section.id": section.section_id,
					"section.local_changed_range_count": ranges.length,
				});
				return { ...section, ranges };
			} catch (e) {
				recordClientTelemetryError("client.acp.section_map.ranges.failed", e, {
					"acp.session_id": session.session_id,
					"section.id": section.section_id,
				});
				return section;
			}
		}),
	);
}

interface SectionTaskTarget {
	sectionId: string;
	title: string;
	intent: string;
	files: string[];
}

function targetFromMapEntry(entry: SectionMapEntry): SectionTaskTarget {
	return {
		sectionId: entry.section_id,
		title: entry.title,
		intent: entry.intent,
		files: entry.files ?? [],
	};
}

function targetFromReviewSection(section: ReviewSectionState): SectionTaskTarget {
	return {
		sectionId: section.id,
		title: section.title,
		intent: section.intent,
		files: section.section?.files ?? [],
	};
}

export default function App() {
	const session = useApp((s) => s.session);
	const sections = useApp((s) => s.sections);
	const currentSectionId = useApp((s) => s.currentSectionId);
	const commentDrafts = useApp((s) => s.commentDrafts);
	const publishedComments = useApp((s) => s.publishedComments);
	const publishedCommentsError = useApp((s) => s.publishedCommentsError);
	const errors = useApp((s) => s.errors);
	const dismissErrors = useApp((s) => s.dismissErrors);
	const setSectionMap = useApp((s) => s.setSectionMap);
	const upsertSection = useApp((s) => s.upsertSection);
	const upsertSectionProgress = useApp((s) => s.upsertSectionProgress);
	const setCurrentSection = useApp((s) => s.setCurrentSection);
	const startSectionProcessing = useApp((s) => s.startSectionProcessing);
	const finishSectionProcessing = useApp((s) => s.finishSectionProcessing);
	const appendAssistantChunk = useApp((s) => s.appendAssistantChunk);
	const finishAssistantMessage = useApp((s) => s.finishAssistantMessage);
	const addSectionMapItem = useApp((s) => s.addSectionMapItem);
	const addReviewSectionItem = useApp((s) => s.addReviewSectionItem);
	const addToolCallItem = useApp((s) => s.addToolCallItem);
	const updateToolCallItem = useApp((s) => s.updateToolCallItem);
	const setPrDescriptionBody = useApp((s) => s.setPrDescriptionBody);
	const refreshSessionMetadata = useApp((s) => s.refreshSessionMetadata);
	const pushError = useApp((s) => s.pushError);
	const addCommentDraft = useApp((s) => s.addCommentDraft);
	const applyCommentResult = useApp((s) => s.applyCommentResult);
	const pushStderr = useApp((s) => s.pushStderr);
	const [ghCliStatus, setGhCliStatus] = useState<GhCliStatus | null>(null);
	const [ghCliDismissed, setGhCliDismissed] = useState(false);
	const [updatingPr, setUpdatingPr] = useState(false);
	const [prUpdateStatus, setPrUpdateStatus] = useState<string | null>(null);
	const { defaultLayout, onLayoutChanged } = useDefaultLayout({
		id: "guided-review.main-layout",
		panelIds: ["sections", "diff", "chat"],
		storage: typeof window === "undefined" ? undefined : window.localStorage,
	});

	const startSectionTask = useCallback(
		async (
			sess: SessionInfo,
			target: SectionTaskTarget,
			reason: "auto_open_first" | "auto_load_next" | "upstream_update",
			additionalConcernsHint?: string,
		): Promise<boolean> => {
			startSectionProcessing(target.sectionId);
			recordClientTelemetry("client.acp.section_task.auto_load_sending", {
				"acp.session_id": sess.session_id,
				"section.id": target.sectionId,
				"section.title": target.title,
				"section.auto_load_reason": reason,
			});
			try {
				const state = useApp.getState();
				const publishedCommentContext = formatPublishedCommentsForPrompt(
					state.session?.session_id === sess.session_id
						? state.publishedComments
						: (sess.published_comments ?? []),
					state.session?.session_id === sess.session_id
						? (state.publishedCommentsError ?? undefined)
						: sess.published_comments_error,
				);
				await acp.startSectionTask({
					parent_session_id: sess.session_id,
					section_id: target.sectionId,
					title: target.title,
					intent: target.intent,
					files: target.files,
					base_ref: sess.repo.base_ref,
					head_ref: sess.repo.head_ref,
					published_comment_context: publishedCommentContext,
					additional_concerns_hint: additionalConcernsHint,
				});
				recordClientTelemetry("client.acp.section_task.auto_load_sent", {
					"acp.session_id": sess.session_id,
					"section.id": target.sectionId,
					"section.auto_load_reason": reason,
				});
				return true;
			} catch (e) {
				finishSectionProcessing(target.sectionId);
				recordClientTelemetryError("client.acp.section_task.auto_load_failed", e, {
					"acp.session_id": sess.session_id,
					"section.id": target.sectionId,
					"section.auto_load_reason": reason,
				});
				pushError(`section auto-load failed: ${e}`);
				return false;
			}
		},
		[finishSectionProcessing, pushError, startSectionProcessing],
	);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const status = await acp.checkGhCli();
				if (!cancelled) setGhCliStatus(status);
			} catch (e) {
				if (!cancelled) pushError(`gh check failed: ${e}`);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [pushError]);

	useEffect(() => {
		if (!session) return;
		const snapshot = createReviewSnapshot({
			current_section_id: currentSectionId,
			sections,
			comment_drafts: commentDrafts,
			published_comments: publishedComments,
			published_comments_error: publishedCommentsError,
		});
		const req = saveReviewRequestFromSession({ session, snapshot });
		if (!req) return;
		const handle = window.setTimeout(() => {
			void acp.saveReviewState(req).catch((e) => {
				recordClientTelemetryError("client.review_persistence.save.failed", e, {
					"acp.session_id": session.session_id,
					"session.source.kind": session.source.kind,
				});
			});
		}, 500);
		return () => window.clearTimeout(handle);
	}, [
		session,
		sections,
		currentSectionId,
		commentDrafts,
		publishedComments,
		publishedCommentsError,
	]);

	useEffect(() => {
		recordClientTelemetry("client.app.event_listeners.effect_started", {
			"react.strict_mode_probe": true,
		});
		let cancelled = false;
		const registered: Unlisten[] = [];

		const startNextSectionAfter = (completedSectionId: string, sessionId: string) => {
			if (cancelled) return;
			const state = useApp.getState();
			const sess = state.session;
			if (!sess || sess.session_id !== sessionId) return;
			const next = findNextSectionToAutoLoad(
				state.sections,
				completedSectionId,
				state.processingSectionIds,
			);
			recordClientTelemetry("client.acp.section_task.auto_load_next_evaluated", {
				"acp.session_id": sessionId,
				"section.completed_id": completedSectionId,
				"section.next_id": next?.id,
				"auto_load.will_send": !!next,
			});
			if (!next) return;
			void startSectionTask(sess, targetFromReviewSection(next), "auto_load_next");
		};

		const handlePrDescription = (p: PrDescriptionEvent) => {
			recordClientTelemetry("client.acp.pr_description.received", {
				"acp.session_id": p.session_id,
				"body.length": p.body.length,
			});
			setPrDescriptionBody(p.body);
		};

		const handleSectionMap = async (p: SectionMapEvent) => {
			recordClientTelemetry("client.acp.section_map.received", {
				"acp.session_id": p.session_id,
				"section.count": p.map.sections.length,
			});
			setSectionMap(p.map.sections);
			if (!p.suppress_chat) addSectionMapItem(p.map.sections);
			const sess = useApp.getState().session;
			const sectionsWithRanges = sess
				? await enrichSectionMapWithLocalRanges(sess, p.map.sections)
				: p.map.sections;
			if (cancelled) return;
			if (sectionsWithRanges !== p.map.sections) {
				setSectionMap(sectionsWithRanges);
			}
			const first = sectionsWithRanges[0];
			recordClientTelemetry("client.acp.section_map.auto_open_evaluated", {
				"acp.session_id": p.session_id,
				"session.current_id": sess?.session_id,
				"section.first_id": first?.section_id,
				"section.count": sectionsWithRanges.length,
				"auto_open.will_send": !!first && !!sess,
			});
			if (first && sess) {
				recordClientTelemetry("client.acp.section_map.auto_open_sending", {
					"acp.session_id": sess.session_id,
					"section.id": first.section_id,
					"section.title": first.title,
				});
				const sent = await startSectionTask(
					sess,
					targetFromMapEntry(first),
					"auto_open_first",
				);
				if (!sent) return;
				recordClientTelemetry("client.acp.section_map.auto_open_sent", {
					"acp.session_id": sess.session_id,
					"section.id": first.section_id,
				});
			}
		};

		const handleReviewSection = (p: SectionEvent) => {
			recordClientTelemetry("client.acp.section.received", {
				"acp.session_id": p.session_id,
				"section.id": p.section.section_id,
				"section.file_count": p.section.files.length,
				"section.concern_count": p.section.concerns.length,
				"section.suppress_chat": p.suppress_chat ?? false,
			});
			upsertSection(p.section);
			const merged = useApp
				.getState()
				.sections.find((s) => s.id === p.section.section_id);
			if (merged?.kind === "review_section" && merged.section) {
				addReviewSectionItem(merged.section);
			}
			startNextSectionAfter(p.section.section_id, p.session_id);
		};

		const handleSectionProgress = (p: SectionProgressEvent) => {
			recordClientTelemetry("client.acp.section_progress.received", {
				"acp.session_id": p.session_id,
				"section.id": p.update.section_id,
				"section.phase": p.update.phase,
				"section.file_count": p.update.files?.length,
				"section.concern_count": p.update.concerns?.length,
			});
			upsertSectionProgress(p.update);
		};

		const handleToolCall = async (p: ToolCallEvent) => {
			const displayMessage = parseToolDisplayMessage(p.raw_input);
			if (displayMessage) {
				recordClientTelemetry("client.acp.display_message.received", {
					"acp.session_id": p.session_id,
					"acp.tool_call_id": p.tool_call_id,
					"message.length": displayMessage.markdown.length,
					"message.text": truncateTelemetryText(displayMessage.markdown),
				});
				appendAssistantChunk(displayMessage.markdown, {
					messageId: p.tool_call_id,
					replaceStreaming: true,
					sessionId: p.session_id,
				});
				finishAssistantMessage(p.session_id);
				return;
			}
			const sectionProgress = parseToolSectionProgress(p.raw_input);
			if (sectionProgress) {
				handleSectionProgress({
					session_id: p.session_id,
					update: sectionProgress,
				});
				return;
			}
			const sectionMap = parseToolSectionMap(p.raw_input);
			if (sectionMap) {
				await handleSectionMap({ session_id: p.session_id, map: sectionMap });
				return;
			}
			const section = parseToolReviewSection(p.raw_input);
			if (section) {
				handleReviewSection({ session_id: p.session_id, section });
				return;
			}
			addToolCallItem(
				{
					tool_call_id: p.tool_call_id,
					title: p.title,
					kind: p.kind,
					status: p.status,
				},
				p.session_id,
			);
		};

		(async () => {
			const pending = await Promise.all([
				on<SectionMapEvent>("acp://section-map", handleSectionMap),
				on<SectionEvent>("acp://section", handleReviewSection),
				on<SectionProgressEvent>(
					"acp://section-progress",
					handleSectionProgress,
				),
				on<ToolCallEvent>("acp://tool-call", handleToolCall),
				on<ToolCallUpdateEvent>("acp://tool-call-update", (p) => {
					updateToolCallItem(p.tool_call_id, p.status, p.session_id);
				}),
				on<TextChunkEvent>("acp://text-chunk", (p) => {
					recordClientTelemetry("client.acp.text_chunk.received", {
						"acp.session_id": p.session_id,
						"acp.message_id": p.message_id,
						"chat.chunk.length": p.text.length,
						"chat.chunk.text": truncateTelemetryText(p.text),
						"chat.chunk.text_truncated":
							p.text.length > truncateTelemetryText(p.text).length,
					});
					appendAssistantChunk(p.text, {
						messageId: p.message_id,
						sessionId: p.session_id,
						kind: p.kind,
					});
				}),
				on<TurnDoneEvent>("acp://turn-done", (p) => {
					recordClientTelemetry("client.acp.turn_done.received", {
						"acp.session_id": p.session_id,
						"acp.stop_reason": p.stop_reason,
					});
					finishAssistantMessage(p.session_id);
				}),
				on<PrDescriptionEvent>("acp://pr-description", handlePrDescription),
				on<ErrorEvent>("acp://error", (p) => {
					recordClientTelemetryError("client.acp.error.received", p.error, {
						"acp.session_id": p.session_id,
					});
					finishSectionProcessing();
					pushError(p.error);
				}),
				on<CommentDraftEvent>("acp://comment-draft", (p) => {
					recordClientTelemetry("client.acp.comment_draft.received", {
						"acp.session_id": p.session_id,
						"comment.draft_id": p.draft_id,
						"comment.kind": p.draft.kind,
						"comment.file_path": p.draft.file_path,
						"comment.line": p.draft.line,
					});
					addCommentDraft(p.draft_id, p.draft);
				}),
				on<CommentResultEvent>("acp://comment-result", (p) => {
					recordClientTelemetry("client.acp.comment_result.received", {
						"acp.session_id": p.session_id,
						"comment.draft_id": p.result.draft_id,
						"comment.result.status": p.result.status,
						"comment.result.has_url": !!p.result.url,
						"comment.result.has_error": !!p.result.error,
					});
					applyCommentResult(p.result);
				}),
				on<AgentStderrEvent>("acp://agent-stderr", (p) => {
					recordClientTelemetry("client.acp.agent_stderr.received", {
						"acp.session_id": p.session_id,
						"agent.stderr.line": truncateTelemetryText(p.line),
					});
					pushStderr(p.line);
				}),
			]);

			if (cancelled) {
				// Effect was torn down (StrictMode double-mount, hot reload, etc.)
				// while we were still resolving listener registrations. Drop them
				// before they can fire.
				recordClientTelemetry("client.app.event_listeners.registration_cancelled", {
					"listener.count": pending.length,
				});
				for (const u of pending) u();
				return;
			}
			registered.push(...pending);
			recordClientTelemetry("client.app.event_listeners.registered", {
				"listener.count": registered.length,
			});
		})();

		return () => {
			cancelled = true;
			recordClientTelemetry("client.app.event_listeners.cleanup", {
				"listener.count": registered.length,
			});
			for (const u of registered) u();
		};
	}, [
			setSectionMap,
			upsertSection,
			upsertSectionProgress,
			setCurrentSection,
			startSectionTask,
			startSectionProcessing,
			finishSectionProcessing,
		appendAssistantChunk,
		finishAssistantMessage,
		addSectionMapItem,
		addReviewSectionItem,
		addToolCallItem,
		updateToolCallItem,
		setPrDescriptionBody,
			pushError,
			addCommentDraft,
			applyCommentResult,
			pushStderr,
		]);

	async function updatePrFromUpstream() {
		if (!session || !isPrBackedSession(session) || updatingPr) return;
		setUpdatingPr(true);
		setPrUpdateStatus(null);
		recordClientTelemetry("client.pr_update.started", {
			"acp.session_id": session.session_id,
			"repo.previous_head_sha": session.repo.head_sha,
		});
		try {
			const response = await acp.updatePrFromUpstream({
				source: session.source,
				previous_repo: session.repo,
			});
			refreshSessionMetadata({
				repo: response.repo,
				pull_request: response.pull_request,
				pull_request_error: response.pull_request_error,
				published_comments: response.published_comments,
				published_comments_error: response.published_comments_error,
			});
			const state = useApp.getState();
			const affectedSections = findSectionsAffectedByChangedFiles(
				state.sections,
				response.changed_files,
			);
			if (response.changed_files.length === 0) {
				setPrUpdateStatus("PR is already up to date.");
				return;
			}
			if (affectedSections.length === 0) {
				setPrUpdateStatus(
					"PR updated; no existing sections own the changed files.",
				);
				return;
			}
			setPrUpdateStatus(
				`Reprocessing ${affectedSections.length} section${affectedSections.length === 1 ? "" : "s"}.`,
			);
			const refreshedSession = useApp.getState().session;
			if (!refreshedSession) return;
			for (const section of affectedSections) {
				const changedFiles = changedFilesForSection(
					section,
					response.changed_files,
				);
				await startSectionTask(
					refreshedSession,
					targetFromReviewSection(section),
					"upstream_update",
					buildUpstreamChangeHint(changedFiles),
				);
			}
			recordClientTelemetry("client.pr_update.reprocess_queued", {
				"acp.session_id": refreshedSession.session_id,
				"section.count": affectedSections.length,
				"pr_update.changed_file_count": response.changed_files.length,
			});
		} catch (e) {
			recordClientTelemetryError("client.pr_update.failed", e, {
				"acp.session_id": session.session_id,
			});
			pushError(`PR update failed: ${e}`);
		} finally {
			setUpdatingPr(false);
		}
	}

	return (
		<div className="grid h-screen grid-rows-[44px_1fr] bg-background text-foreground">
			<Dialog
				open={ghCliNeedsInstallPopup(ghCliStatus) && !ghCliDismissed}
				onOpenChange={(open) => {
					if (!open) setGhCliDismissed(true);
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle className="flex items-center gap-2">
							<AlertTriangle className="size-4 text-destructive" />
							GitHub CLI is missing
						</DialogTitle>
						<DialogDescription className="whitespace-pre-line">
							{ghCliStatus ? ghCliPopupMessage(ghCliStatus) : ""}
						</DialogDescription>
					</DialogHeader>
					<div className="rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs">
						brew install gh
					</div>
					<div className="flex justify-end">
						<Button size="sm" onClick={() => setGhCliDismissed(true)}>
							Dismiss
						</Button>
					</div>
				</DialogContent>
			</Dialog>
			<header className="flex items-center gap-3 border-b border-border bg-background px-3">
				<ProjectPicker />
				<ReviewLauncher
					beforeHistory={
						isPrBackedSession(session) && prUpdateStatus ? (
							<span
								className="max-w-[240px] truncate text-[11px] text-muted-foreground"
								title={prUpdateStatus}
							>
								{prUpdateStatus}
							</span>
						) : null
					}
				/>
				{isPrBackedSession(session) && (
					<div className="flex min-w-0 items-center gap-2">
						<Button
							type="button"
							size="sm"
							variant="outline"
							className="h-7 px-2"
							disabled={updatingPr}
							onClick={() => void updatePrFromUpstream()}
							title="Update PR from upstream"
						>
							{updatingPr ? (
								<Loader2 className="size-3.5 animate-spin" />
							) : (
								<RefreshCw className="size-3.5" />
							)}
							{updatingPr ? "Updating" : "Update"}
						</Button>
					</div>
				)}
			</header>
			<main className="min-h-0 overflow-hidden">
				<PanelGroup
					id="guided-review.main-layout"
					orientation="horizontal"
					defaultLayout={defaultLayout}
					onLayoutChanged={onLayoutChanged}
					className="flex h-full"
				>
					<Panel
						id="sections"
						defaultSize={24}
						minSize={12}
						className="flex min-h-0 min-w-0 flex-col"
					>
						<SectionList />
					</Panel>
					<PanelResizeHandle className="resize-handle resize-handle--vertical" />
					<Panel
						id="diff"
						defaultSize={44}
						minSize={20}
						className="flex min-h-0 min-w-0 flex-col"
					>
						<DiffPane />
					</Panel>
					<PanelResizeHandle className="resize-handle resize-handle--vertical" />
					<Panel
						id="chat"
						defaultSize={32}
						minSize={16}
						className="flex min-h-0 min-w-0 flex-col"
					>
						<ChatPanel />
					</Panel>
				</PanelGroup>
			</main>
			{errors.length > 0 && (
				<div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-xs text-destructive shadow-lg">
					<span>{errors[errors.length - 1]}</span>
					<Button
						size="sm"
						variant="ghost"
						className="h-6 px-2 text-xs text-destructive hover:text-destructive"
						onClick={dismissErrors}
					>
						dismiss
					</Button>
				</div>
			)}
		</div>
	);
}
