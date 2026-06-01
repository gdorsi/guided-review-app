import {
	useCallback,
	useDeferredValue,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { CodeView, type CodeViewHandle } from "@pierre/diffs/react";
import {
	parseDiffFromFile,
	type CodeViewItem,
	type CodeViewLineSelection,
	type DiffLineAnnotation,
	type LineAnnotation,
} from "@pierre/diffs";
import {
	ChevronDown,
	ChevronRight,
	LocateFixed,
	Send,
	MessageSquare,
	Sparkles,
} from "lucide-react";
import { useApp } from "@/lib/store";
import { acp } from "@/lib/acp";
import { SeverityBadge } from "./SeverityBadge";
import {
	focusSideToPierreSide,
	formatDiffFocusHeader,
	type DiffFocusRange,
} from "@/lib/diffFocus";
import { computeFileDiffStats, isDeletionOnlyDiff } from "@/lib/diffStats";
import { recordClientTelemetry, recordClientTelemetryError } from "@/lib/telemetry";
import {
	publishedCommentToDiffAnnotation,
	type PublishedCommentAnnotationMetadata,
	formatPublishedCommentsForPrompt,
} from "@/lib/publishedComments";
import {
	sectionFeedbackToDiffAnnotations,
	sectionFeedbackTopNotes,
	type SectionFeedbackAnnotationMetadata,
	type SectionFeedbackNote,
} from "@/lib/sectionFeedback";
import { MarkdownViewer } from "./MarkdownViewer";
import { ReviewSummaryView } from "./ReviewSummaryView";
import { stripMarkdownForSummary } from "@/lib/markdownContent";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
	buildUserMessageWithReviewContext,
	createReviewSnapshot,
} from "@/lib/reviewPersistence";
import type { ReviewSection } from "@/lib/types/section";

interface FileBundle {
	file_path: string;
	oldText: string;
	newText: string;
}

interface DiffTarget {
	id: string;
	title: string;
	intent: string;
	files: string[];
	base_ref: string;
	head_ref: string;
}

const fileCache = new Map<string, string>();

type DiffAnnotationMetadata =
	| PublishedCommentAnnotationMetadata
	| SectionFeedbackAnnotationMetadata;

function reviewSectionHasFeedback(section: ReviewSection): boolean {
	return section.concerns.length > 0 || section.grill_questions.length > 0;
}

async function fetchFile(
	repoPath: string,
	filePath: string,
	refspec: string,
): Promise<string> {
	const key = `${repoPath}::${filePath}::${refspec}`;
	const cached = fileCache.get(key);
	if (cached !== undefined) return cached;
	const content = await acp.getFileAtRef({
		repo_path: repoPath,
		file_path: filePath,
		refspec,
	});
	const text = content ?? "";
	fileCache.set(key, text);
	return text;
}

function focusRangeToPierreSelection(range: DiffFocusRange) {
	const side = focusSideToPierreSide(range.side);
	return {
		start: range.start_line,
		end: range.end_line,
		side,
		endSide: side,
	};
}

function feedbackLocation(note: SectionFeedbackNote): string | null {
	if (note.file_path && note.line) return `${note.file_path}:${note.line}`;
	return note.file_path ?? null;
}

function isSectionFeedbackAnnotation(
	metadata: DiffAnnotationMetadata,
): metadata is SectionFeedbackAnnotationMetadata {
	return "notes" in metadata;
}

function SectionFeedbackNoteView({
	note,
	showLocation = false,
	onAnswer,
}: {
	note: SectionFeedbackNote;
	showLocation?: boolean;
	onAnswer?: (note: SectionFeedbackNote, answer: string) => Promise<void>;
}) {
	if (note.kind === "grill_question") {
		return (
			<GrillQuestionAnnotation
				note={note}
				showLocation={showLocation}
				onAnswer={onAnswer}
			/>
		);
	}
	const location = showLocation ? feedbackLocation(note) : null;
	return (
		<div className="rounded border border-border/70 bg-background/60 px-2 py-1.5 text-xs">
			<div className="mb-1 flex flex-wrap items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
				{note.severity && <SeverityBadge severity={note.severity} />}
				<span>{note.label}</span>
				{location && (
					<span className="font-mono normal-case tracking-normal">
						{location}
					</span>
				)}
			</div>
			<div className="whitespace-pre-wrap text-foreground">{note.text}</div>
		</div>
	);
}

function GrillQuestionAnnotation({
	note,
	showLocation = false,
	onAnswer,
}: {
	note: SectionFeedbackNote;
	showLocation?: boolean;
	onAnswer?: (note: SectionFeedbackNote, answer: string) => Promise<void>;
}) {
	const [answer, setAnswer] = useState("");
	const [sending, setSending] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const location = showLocation ? feedbackLocation(note) : null;
	const questionAnswerPanelClassName =
		"min-w-0 overflow-hidden rounded border border-border/60 bg-background/60 px-2 py-1.5";
	const questionAnswerMarkdownClassName =
		"min-w-0 [overflow-wrap:anywhere] [&_*]:min-w-0 [&_*]:[overflow-wrap:anywhere] [&_code]:whitespace-normal [&_pre]:whitespace-pre-wrap";

	const sendAnswer = useCallback(
		async (value: string) => {
			const body = value.trim();
			if (!body || !onAnswer || sending) return;
			setSending(true);
			try {
				await onAnswer(note, body);
				setAnswer("");
			} finally {
				setSending(false);
			}
		},
		[note, onAnswer, sending],
	);

	function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
		// Enter sends; Cmd/Ctrl+Enter inserts a newline.
		if (e.key === "Enter" && !e.shiftKey && !(e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			void sendAnswer(answer);
			return;
		}
		if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			const ta = e.currentTarget;
			const start = ta.selectionStart ?? answer.length;
			const end = ta.selectionEnd ?? start;
			const next = answer.slice(0, start) + "\n" + answer.slice(end);
			setAnswer(next);
			requestAnimationFrame(() => {
				if (textareaRef.current) {
					textareaRef.current.selectionStart = start + 1;
					textareaRef.current.selectionEnd = start + 1;
				}
			});
		}
	}

	return (
		<div className="rounded border border-primary/40 bg-primary/10 px-2 py-2 text-xs">
			<div className="mb-1 flex flex-wrap items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-primary">
				<span>{note.label}</span>
				{location && (
					<span className="font-mono normal-case tracking-normal">
						{location}
					</span>
				)}
			</div>
			{note.title && (
				<div className="mb-1 font-semibold text-foreground">{note.title}</div>
			)}
			<div className="mb-2 whitespace-pre-wrap text-foreground">{note.text}</div>
			<div className="mb-2 grid min-w-0 grid-cols-1 gap-2 lg:grid-cols-2">
				<div className={questionAnswerPanelClassName}>
					<div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
						PR choice
					</div>
					<MarkdownViewer
						markdown={note.pr_choice ?? ""}
						className={questionAnswerMarkdownClassName}
					/>
				</div>
				<div className={questionAnswerPanelClassName}>
					<div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
						Recommended answer
					</div>
					<MarkdownViewer
						markdown={note.recommended_answer ?? ""}
						className={questionAnswerMarkdownClassName}
					/>
				</div>
			</div>
			<div className="mb-2 flex flex-wrap gap-2">
				<Button
					type="button"
					size="sm"
					variant="outline"
					onClick={() => void sendAnswer(note.pr_choice ?? "")}
					disabled={sending || !onAnswer || !note.pr_choice}
					className="h-7"
				>
					Agree with PR
				</Button>
				<Button
					type="button"
					size="sm"
					variant="outline"
					onClick={() => void sendAnswer(note.recommended_answer ?? "")}
					disabled={sending || !onAnswer || !note.recommended_answer}
					className="h-7"
				>
					Use recommendation
				</Button>
			</div>
			<div className="space-y-1.5">
				<Textarea
					ref={textareaRef}
					value={answer}
					onChange={(e) => setAnswer(e.target.value)}
					onKeyDown={onKeyDown}
					placeholder="Write a free-form answer…  (Enter to send · ⌘+Enter for newline)"
					disabled={sending || !onAnswer}
					rows={3}
				/>
				<div className="flex justify-end">
					<Button
						type="button"
						size="sm"
						onClick={() => void sendAnswer(answer)}
						disabled={sending || !answer.trim() || !onAnswer}
						className="h-7"
					>
						<Send className="size-3.5" />
						Send
					</Button>
				</div>
			</div>
		</div>
	);
}

function SectionFeedbackAnnotation({
	notes,
	onAnswer,
}: {
	notes: SectionFeedbackNote[];
	onAnswer?: (note: SectionFeedbackNote, answer: string) => Promise<void>;
}) {
	return (
		<div className="space-y-1 border-l-2 border-primary bg-primary/10 px-2 py-1.5">
			{notes.map((note, index) => (
				<SectionFeedbackNoteView
					key={index}
					note={note}
					onAnswer={onAnswer}
				/>
			))}
		</div>
	);
}

function SectionNotesPanel({ notes }: { notes: SectionFeedbackNote[] }) {
	if (notes.length === 0) return null;
	return (
		<div className="rounded-md border border-border bg-card/60 px-3 py-2.5">
			<div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
				Section notes
			</div>
			<div className="space-y-2">
				{notes.map((note, index) => (
					<SectionFeedbackNoteView
						key={index}
						note={note}
						showLocation
					/>
				))}
			</div>
		</div>
	);
}

function hashStringPart(hash: number, value: string): number {
	let next = hash;
	for (let index = 0; index < value.length; index++) {
		next ^= value.charCodeAt(index);
		next = Math.imul(next, 16777619);
	}
	return next >>> 0;
}

function hashString(value: string): string {
	return hashStringPart(2166136261, value).toString(36);
}

function annotationVersionKey(
	annotation:
		| LineAnnotation<DiffAnnotationMetadata>
		| DiffLineAnnotation<DiffAnnotationMetadata>,
): string {
	const side = "side" in annotation ? annotation.side : "";
	const metadata = annotation.metadata;
	if (isSectionFeedbackAnnotation(metadata)) {
		return [
			"feedback",
			side,
			annotation.lineNumber,
			metadata.file_path,
			metadata.line,
			metadata.notes
				.map((note) =>
					[
						note.kind,
						note.label,
						note.severity ?? "",
						note.file_path ?? "",
						note.line ?? "",
						note.text,
					].join(":"),
				)
				.join("|"),
		].join("\0");
	}
	const { comment } = metadata;
	return [
		"comment",
		side,
		annotation.lineNumber,
		comment.id,
		comment.body,
		comment.file_path ?? "",
		comment.line ?? "",
		comment.side ?? "",
		comment.original_line ?? "",
		comment.original_side ?? "",
		comment.is_outdated ? "1" : "0",
	].join("\0");
}

function codeViewItemVersion(
	bundle: FileBundle,
	collapsed: boolean,
	annotations: DiffLineAnnotation<DiffAnnotationMetadata>[],
): number {
	let hash = 2166136261;
	hash = hashStringPart(hash, bundle.file_path);
	hash = hashStringPart(hash, bundle.oldText);
	hash = hashStringPart(hash, bundle.newText);
	hash = hashStringPart(hash, collapsed ? "collapsed" : "expanded");
	for (const annotation of annotations) {
		hash = hashStringPart(hash, annotationVersionKey(annotation));
	}
	return hash;
}

export function DiffPane() {
	const session = useApp((s) => s.session);
	const currentId = useApp((s) => s.currentSectionId);
	const sections = useApp((s) => s.sections);
	const processingSectionIds = useApp((s) => s.processingSectionIds);
	const diffFocus = useApp((s) => s.diffFocus);
	const diffFocusError = useApp((s) => s.diffFocusError);
	const clearDiffFocus = useApp((s) => s.clearDiffFocus);
	const setDiffFocusError = useApp((s) => s.setDiffFocusError);
	const startSectionProcessing = useApp((s) => s.startSectionProcessing);
	const finishSectionProcessing = useApp((s) => s.finishSectionProcessing);
	const pushError = useApp((s) => s.pushError);
	const addUserMessage = useApp((s) => s.addUserMessage);
	const commentDrafts = useApp((s) => s.commentDrafts);
	const publishedComments = useApp((s) => s.publishedComments);
	const publishedCommentsError = useApp((s) => s.publishedCommentsError);

	const deferredCurrentId = useDeferredValue(currentId);

	const current = useMemo(
		() => sections.find((s) => s.id === deferredCurrentId) ?? null,
		[sections, deferredCurrentId],
	);
	const section =
		current?.kind === "review_section" ? current.section ?? null : null;
	const diffTarget = useMemo<DiffTarget | null>(() => {
		if (current?.kind === "review_section" && current.section) {
			return {
				id: current.id,
				title: current.title,
				intent: current.intent,
				files: current.section.files,
				base_ref: current.section.base_ref,
				head_ref: current.section.head_ref,
			};
		}
		return null;
	}, [current]);
	const currentReviewId = current?.kind === "review_section" ? current.id : null;
	const sectionIsProcessing = currentReviewId
		? processingSectionIds.includes(currentReviewId)
		: false;
	const feedbackLoaded =
		current?.kind === "review_section" && current.feedbackLoaded === true;
	const canRequestFeedback = Boolean(
		session &&
			current?.kind === "review_section" &&
			!sectionIsProcessing &&
			!feedbackLoaded &&
			(!section || !reviewSectionHasFeedback(section)),
	);

	const [bundles, setBundles] = useState<FileBundle[]>([]);
	const [loading, setLoading] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [agentFocusLabel, setAgentFocusLabel] = useState<string | null>(null);
	const [collapsedFiles, setCollapsedFiles] = useState<Record<string, true>>({});
	const scrollContainerRef = useRef<HTMLElement>(null);
	const codeViewRef = useRef<CodeViewHandle<DiffAnnotationMetadata>>(null);
	const openFiles = useCallback((filePaths: string[]) => {
		setCollapsedFiles((current) => {
			let changed = false;
			const next = { ...current };
			for (const filePath of filePaths) {
				if (next[filePath]) {
					delete next[filePath];
					changed = true;
				}
			}
			return changed ? next : current;
		});
	}, []);
	const requestSectionFeedback = useCallback(async () => {
		if (!session || current?.kind !== "review_section") return;
		const sectionId = current.id;
		startSectionProcessing(sectionId);
		try {
			recordClientTelemetry("client.diff.feedback_request.started", {
				"acp.session_id": session.session_id,
				"section.id": sectionId,
			});
			const publishedCommentContext = formatPublishedCommentsForPrompt(
				publishedComments,
				session.published_comments_error,
			);
			await acp.startSectionTask({
				parent_session_id: session.session_id,
				section_id: sectionId,
				title: current.title,
				intent: current.intent,
				files: current.section?.files ?? [],
				base_ref: session.repo.base_ref,
				head_ref: session.repo.head_ref,
				published_comment_context: publishedCommentContext,
			});
			recordClientTelemetry("client.diff.feedback_request.sent", {
				"acp.session_id": session.session_id,
				"section.id": sectionId,
			});
		} catch (e) {
			finishSectionProcessing(sectionId);
			recordClientTelemetryError("client.diff.feedback_request.failed", e, {
				"acp.session_id": session.session_id,
				"section.id": sectionId,
			});
			pushError(`feedback load failed: ${e}`);
		}
	}, [
		session,
		current,
		startSectionProcessing,
		finishSectionProcessing,
		publishedComments,
		pushError,
	]);
	const sendGrillQuestionAnswer = useCallback(
		async (note: SectionFeedbackNote, answer: string) => {
			if (!session || current?.kind !== "review_section") return;
			const body = [
				`Answered inline review question "${note.title ?? note.question_id ?? "question"}".`,
				"",
				`Question ID: ${note.question_id ?? ""}`,
				`Section ID: ${current.id}`,
				`Question: ${note.text}`,
				`PR choice: ${note.pr_choice ?? ""}`,
				`Recommended answer: ${note.recommended_answer ?? ""}`,
				"",
				"Answer:",
				answer,
				"",
				"If this answer does not agree with the PR choice, store the disagreement as PR comment draft(s) to submit.",
			].join("\n");
			addUserMessage(body);
			const snapshot = createReviewSnapshot({
				current_section_id: current.id,
				sections,
				comment_drafts: commentDrafts,
				published_comments: publishedComments,
				published_comments_error: publishedCommentsError,
			});
			const message = buildUserMessageWithReviewContext({
				userText: body,
				session,
				snapshot,
			});
			try {
				recordClientTelemetry("client.diff.grill_answer.send_requested", {
					"acp.session_id": session.session_id,
					"section.id": current.id,
					"grill.question_id": note.question_id,
					"message.length": answer.length,
				});
				await acp.sendMessage(session.session_id, message, {
					origin: "diff_inline_grill_question",
					reason: "user_reply",
					sectionId: current.id,
					suppressPreview: true,
				});
			} catch (e) {
				recordClientTelemetryError("client.diff.grill_answer.send_failed", e, {
					"acp.session_id": session.session_id,
					"section.id": current.id,
					"grill.question_id": note.question_id,
				});
				pushError(`send_message failed: ${e}`);
			}
		},
		[
			session,
			current,
			addUserMessage,
			sections,
			commentDrafts,
			publishedComments,
			publishedCommentsError,
			pushError,
		],
	);
	const visibleFilePaths = useMemo(
		() => new Set(bundles.map((bundle) => bundle.file_path)),
		[bundles],
	);
	const sectionFeedbackAnnotations = useMemo(
		() =>
			section
				? sectionFeedbackToDiffAnnotations(section, visibleFilePaths)
				: [],
		[section, visibleFilePaths],
	);
	const sectionTopNotes = useMemo(
		() =>
			section ? sectionFeedbackTopNotes(section, visibleFilePaths) : [],
		[section, visibleFilePaths],
	);

	useEffect(() => {
		setAgentFocusLabel(null);
		setDiffFocusError(null);
		const currentFocus = useApp.getState().diffFocus;
		if (
			currentFocus?.source === "user" &&
			currentFocus.mode !== "navigation"
		) {
			clearDiffFocus(currentFocus.id);
		}
	}, [currentId, clearDiffFocus, setDiffFocusError]);

	useEffect(() => {
		if (diffFocus?.source !== "agent") return;
		const label = formatDiffFocusHeader(diffFocus);
		setAgentFocusLabel(label);
		const timeout = window.setTimeout(() => setAgentFocusLabel(null), 4500);
		return () => window.clearTimeout(timeout);
	}, [diffFocus]);

	useEffect(() => {
		if (!diffFocus) return;
		if (!visibleFilePaths.has(diffFocus.file_path)) return;
		openFiles([diffFocus.file_path]);
	}, [diffFocus, visibleFilePaths, openFiles]);

	const filesWithNotes = useMemo(() => {
		const set = new Set<string>();
		for (const comment of publishedComments) {
			const path = comment.file_path;
			if (!path || !visibleFilePaths.has(path)) continue;
			const line = comment.line ?? comment.original_line;
			const side = comment.side ?? comment.original_side;
			if (!line || !side) continue;
			set.add(path);
		}
		for (const annotation of sectionFeedbackAnnotations) {
			if (visibleFilePaths.has(annotation.metadata.file_path)) {
				set.add(annotation.metadata.file_path);
			}
		}
		return [...set];
	}, [publishedComments, sectionFeedbackAnnotations, visibleFilePaths]);

	const autoExpandedSectionsRef = useRef<Set<string>>(new Set());
	const sectionId = diffTarget?.id ?? null;
	const allFilePaths = useMemo(
		() => bundles.map((bundle) => bundle.file_path),
		[bundles],
	);
	useEffect(() => {
		setCollapsedFiles({});
	}, [sectionId]);

	useEffect(() => {
		scrollContainerRef.current?.scrollTo({ top: 0 });
		codeViewRef.current?.scrollTo({ type: "position", position: 0 });
	}, [currentId]);

	useEffect(() => {
		if (!sectionId) return;
		if (bundles.length === 0) return;
		if (autoExpandedSectionsRef.current.has(sectionId)) return;
		autoExpandedSectionsRef.current.add(sectionId);
		const deleteOnlyPaths: string[] = [];
		for (const bundle of bundles) {
			const stats = computeFileDiffStats(
				bundle.file_path,
				bundle.oldText,
				bundle.newText,
			);
			if (isDeletionOnlyDiff(stats)) {
				deleteOnlyPaths.push(bundle.file_path);
			}
		}
		if (deleteOnlyPaths.length > 0) {
			const notesSet = new Set(filesWithNotes);
			const focusedPath =
				diffFocus && visibleFilePaths.has(diffFocus.file_path)
					? diffFocus.file_path
					: null;
			setCollapsedFiles((current) => {
				let changed = false;
				const next = { ...current };
				for (const path of deleteOnlyPaths) {
					if (notesSet.has(path)) continue;
					if (focusedPath === path) continue;
					if (!next[path]) {
						next[path] = true;
						changed = true;
					}
				}
				return changed ? next : current;
			});
		}
		if (filesWithNotes.length > 0) {
			openFiles(filesWithNotes);
		}
	}, [sectionId, bundles, filesWithNotes, openFiles, diffFocus, visibleFilePaths]);

	const expandAll = useCallback(
		() => openFiles(allFilePaths),
		[openFiles, allFilePaths],
	);
	const collapseAll = useCallback(
		() => {
			const next: Record<string, true> = {};
			for (const filePath of allFilePaths) {
				next[filePath] = true;
			}
			setCollapsedFiles(next);
		},
		[allFilePaths],
	);
	const toggleFileCollapsed = useCallback((filePath: string) => {
		setCollapsedFiles((current) => {
			const next = { ...current };
			if (next[filePath]) delete next[filePath];
			else next[filePath] = true;
			return next;
		});
	}, []);

	const codeViewState = useMemo((): {
		items: CodeViewItem<DiffAnnotationMetadata>[];
		error: string | null;
	} => {
		try {
			const publishedByFile = new Map<
				string,
				DiffLineAnnotation<DiffAnnotationMetadata>[]
			>();
			for (const comment of publishedComments) {
				const annotation = publishedCommentToDiffAnnotation(comment);
				if (!annotation || !comment.file_path) continue;
				const annotations = publishedByFile.get(comment.file_path) ?? [];
				annotations.push(annotation);
				publishedByFile.set(comment.file_path, annotations);
			}

			const feedbackByFile = new Map<
				string,
				DiffLineAnnotation<DiffAnnotationMetadata>[]
			>();
			for (const annotation of sectionFeedbackAnnotations) {
				const annotations =
					feedbackByFile.get(annotation.metadata.file_path) ?? [];
				annotations.push(annotation);
				feedbackByFile.set(annotation.metadata.file_path, annotations);
			}

			const items = bundles.map((b): CodeViewItem<DiffAnnotationMetadata> => {
				const annotations = [
					...(publishedByFile.get(b.file_path) ?? []),
					...(feedbackByFile.get(b.file_path) ?? []),
				];
				const collapsed = Boolean(collapsedFiles[b.file_path]);
				const oldFile = {
					name: b.file_path,
					contents: b.oldText,
					cacheKey: `${b.file_path}:old:${hashString(b.oldText)}`,
				};
				const newFile = {
					name: b.file_path,
					contents: b.newText,
					cacheKey: `${b.file_path}:new:${hashString(b.newText)}`,
				};
				return {
					id: b.file_path,
					type: "diff",
					fileDiff: parseDiffFromFile(oldFile, newFile),
					annotations,
					collapsed,
					version: codeViewItemVersion(b, collapsed, annotations),
				};
			});
			return { items, error: null };
		} catch (error) {
			return { items: [], error: String(error) };
		}
	}, [bundles, collapsedFiles, publishedComments, sectionFeedbackAnnotations]);

	const selectedLines = useMemo<CodeViewLineSelection | null>(() => {
		if (!diffFocus) return null;
		if (!visibleFilePaths.has(diffFocus.file_path)) return null;
		return {
			id: diffFocus.file_path,
			range: focusRangeToPierreSelection(diffFocus),
		};
	}, [diffFocus, visibleFilePaths]);

	const codeViewOptions = useMemo(
		() => ({
			theme: "pierre-dark" as const,
			diffStyle: "unified" as const,
			enableLineSelection: false,
			layout: {
				paddingTop: 0,
				paddingBottom: 0,
				gap: 16,
			},
		}),
		[],
	);

	const renderAnnotation = useCallback(
		(
			annotation:
				| LineAnnotation<DiffAnnotationMetadata>
				| DiffLineAnnotation<DiffAnnotationMetadata>,
		) => {
			if (isSectionFeedbackAnnotation(annotation.metadata)) {
				return (
					<SectionFeedbackAnnotation
						notes={annotation.metadata.notes}
						onAnswer={sendGrillQuestionAnswer}
					/>
				);
			}
			const { comment } = annotation.metadata;
			return (
				<div className="border-l-2 border-[oklch(0.7_0.16_155)] bg-[oklch(0.2_0.05_155)]/35 px-2 py-1 text-xs">
					<div className="mb-0.5 flex items-center justify-between gap-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
						<span>{comment.author_login}</span>
						<a
							href={comment.html_url}
							target="_blank"
							rel="noreferrer"
							className="text-[oklch(0.75_0.15_155)] hover:underline"
						>
							GitHub
						</a>
					</div>
					<div className="whitespace-pre-wrap text-foreground">{comment.body}</div>
				</div>
			);
		},
		[sendGrillQuestionAnswer],
	);

	const renderHeaderPrefix = useCallback(
		(item: CodeViewItem<DiffAnnotationMetadata>) => {
			const collapsed = Boolean(item.collapsed);
			const ChevronIcon = collapsed ? ChevronRight : ChevronDown;
			return (
				<button
					type="button"
					onClick={() => toggleFileCollapsed(item.id)}
					aria-expanded={!collapsed}
					title={collapsed ? "Expand file" : "Collapse file"}
					className="-ml-1 inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted focus:outline-none focus-visible:ring-1 focus-visible:ring-primary"
				>
					<ChevronIcon className="size-3.5" />
				</button>
			);
		},
		[toggleFileCollapsed],
	);

	const renderHeaderMetadata = useCallback(
		(item: CodeViewItem<DiffAnnotationMetadata>) => {
			const annotations = item.annotations ?? [];
			const noteCount = annotations.length;
			const hasAgentNotes = annotations.some((annotation) =>
				isSectionFeedbackAnnotation(annotation.metadata),
			);
			if (noteCount === 0 && !hasAgentNotes) return null;
			return (
				<span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
					{noteCount > 0 && (
						<span className="inline-flex items-center gap-0.5 rounded border border-border/60 bg-background/60 px-1 py-0.5">
							<MessageSquare className="size-3" />
							<span className="tabular-nums">{noteCount}</span>
						</span>
					)}
					{hasAgentNotes && (
						<span
							title="Reviewed by the agent"
							className="inline-flex items-center text-primary"
						>
							<Sparkles className="size-3" />
						</span>
					)}
				</span>
			);
		},
		[],
	);

	useEffect(() => {
		if (allFilePaths.length === 0) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			const target = event.target as HTMLElement | null;
			if (
				target &&
				(target.tagName === "INPUT" ||
					target.tagName === "TEXTAREA" ||
					target.isContentEditable)
			) {
				return;
			}
			if (event.key === "c") {
				event.preventDefault();
				collapseAll();
			} else if (event.key === "e") {
				event.preventDefault();
				expandAll();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [allFilePaths, collapseAll, expandAll]);

	useEffect(() => {
		if (!diffFocus || loading || loadError || codeViewState.error) return;
		const visible = bundles.some((b) => b.file_path === diffFocus.file_path);
		if (!visible) {
			setDiffFocusError(
				`${diffFocus.file_path} is not visible in the current diff section.`,
			);
		}
	}, [
		bundles,
		diffFocus,
		loading,
		loadError,
		codeViewState.error,
		setDiffFocusError,
	]);

	useEffect(() => {
		if (!diffFocus || !visibleFilePaths.has(diffFocus.file_path)) return;
		if (collapsedFiles[diffFocus.file_path]) return;
		const frame = window.requestAnimationFrame(() => {
			codeViewRef.current?.scrollTo({
				type: "line",
				id: diffFocus.file_path,
				lineNumber: diffFocus.start_line,
				side: focusSideToPierreSide(diffFocus.side),
				align: "center",
				behavior: "smooth-auto",
			});
		});
		return () => window.cancelAnimationFrame(frame);
	}, [collapsedFiles, diffFocus, visibleFilePaths]);

	useEffect(() => {
		recordClientTelemetry("client.diff.current_section.evaluated", {
			"acp.session_id": session?.session_id,
			"section.current_id": deferredCurrentId,
			"section.has_entry": !!current,
			"section.has_payload": !!diffTarget,
			"section.file_count": diffTarget?.files.length,
		});
		if (!session || !diffTarget) {
			setBundles([]);
			return;
		}
		let cancelled = false;
		setLoading(true);
		setLoadError(null);
		(async () => {
			try {
				recordClientTelemetry("client.diff.section_load.started", {
					"acp.session_id": session.session_id,
					"section.id": diffTarget.id,
					"section.file_count": diffTarget.files.length,
				});
				const out: FileBundle[] = [];
				for (const file of diffTarget.files) {
					recordClientTelemetry("client.diff.file_load.started", {
						"acp.session_id": session.session_id,
						"section.id": diffTarget.id,
						"file.path": file,
						"repo.base_ref": diffTarget.base_ref,
						"repo.head_ref": diffTarget.head_ref,
					});
					const [oldText, newText] = await Promise.all([
						fetchFile(session.repo.path, file, diffTarget.base_ref),
						fetchFile(session.repo.path, file, diffTarget.head_ref),
					]);
					recordClientTelemetry("client.diff.file_load.finished", {
						"acp.session_id": session.session_id,
						"section.id": diffTarget.id,
						"file.path": file,
						"file.old_length": oldText.length,
						"file.new_length": newText.length,
						"file.changed": oldText !== newText,
					});
					if (oldText === newText) continue;
					out.push({ file_path: file, oldText, newText });
				}
				if (!cancelled) {
					recordClientTelemetry("client.diff.section_load.succeeded", {
						"acp.session_id": session.session_id,
						"section.id": diffTarget.id,
						"diff.bundle_count": out.length,
					});
					setBundles(out);
				}
			} catch (e) {
				if (!cancelled) {
					recordClientTelemetryError("client.diff.section_load.failed", e, {
						"acp.session_id": session.session_id,
						"section.id": diffTarget.id,
					});
					setLoadError(String(e));
				}
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [session, diffTarget, current, deferredCurrentId]);

	if (!session || !current) {
		return (
			<section
				ref={scrollContainerRef}
				className="flex h-full min-h-0 min-w-0 flex-col items-center justify-center text-sm text-muted-foreground"
			>
				<p>Start a session to see the guided review.</p>
			</section>
		);
	}

	if (current.kind === "pr_description") {
		return (
			<section
				ref={scrollContainerRef}
				className="flex h-full min-h-0 min-w-0 flex-col overflow-y-auto"
			>
				<header className="border-b border-border bg-card/40 px-6 py-4">
					<h2 className="text-base font-semibold">{current.title}</h2>
					<p className="mt-1 text-sm text-muted-foreground">
						{current.intent}
					</p>
					{current.url && (
						<a
							href={current.url}
							target="_blank"
							rel="noreferrer"
							className="mt-2 block truncate font-mono text-[11px] text-primary hover:underline"
						>
							{current.url}
						</a>
					)}
				</header>
				<div className="p-6">
					{current.error && (
						<div className="mb-4 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground">
							{current.error}
						</div>
					)}
					<div className="rounded-md border border-border bg-card/40 px-4 py-3">
						<MarkdownViewer markdown={current.body} />
					</div>
				</div>
			</section>
		);
	}

	if (current.kind === "review_summary") {
		return <ReviewSummaryView />;
	}

	if (current.kind === "review_section" && !section) {
		return (
			<section
				ref={scrollContainerRef}
				className="flex h-full min-h-0 min-w-0 flex-col items-center justify-center px-8 text-sm text-muted-foreground"
			>
				<p className="font-medium text-foreground">{current.title}</p>
				<p className="mt-1">{stripMarkdownForSummary(current.intent)}</p>
				<p className="mt-3 text-xs">
					Ask the agent to walk you through this section.
				</p>
				{canRequestFeedback && (
					<button
						type="button"
						onClick={requestSectionFeedback}
						className="mt-4 inline-flex items-center gap-1.5 rounded border border-border bg-card/70 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent"
					>
						<Sparkles className="size-3.5 text-primary" />
						<span>Load feedback</span>
					</button>
				)}
			</section>
		);
	}

	return (
		<section
			ref={scrollContainerRef}
			className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
		>
			<div className="flex shrink-0 flex-col gap-4 p-4 pb-3">
				{agentFocusLabel && (
					<div className="inline-flex w-fit items-center gap-1.5 rounded border border-primary/40 bg-primary/10 px-2 py-1 font-mono text-[11px] text-primary">
						<LocateFixed className="size-3" />
						{agentFocusLabel}
					</div>
				)}
				{loading && (
					<div className="text-sm text-muted-foreground">Loading diff…</div>
				)}
				{loadError && (
					<div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground">
						{loadError}
					</div>
				)}
				{!loading && !loadError && codeViewState.error && (
					<div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground">
						{codeViewState.error}
					</div>
				)}
				{diffFocusError && (
					<div className="rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-xs text-primary">
						{diffFocusError}
					</div>
				)}
				{!loading && !loadError && (
					<SectionNotesPanel notes={sectionTopNotes} />
				)}
				{!loading &&
					!loadError &&
					!codeViewState.error &&
					bundles.length === 0 &&
					sectionIsProcessing &&
					(diffTarget?.files.length ?? 0) === 0 && (
						<div className="rounded-md border border-border bg-card/40 px-4 py-3 text-sm text-muted-foreground">
							Agent is finding files and ranges for this section…
						</div>
					)}
				{!loading &&
					!loadError &&
					!codeViewState.error &&
					bundles.length === 0 &&
					!(sectionIsProcessing && (diffTarget?.files.length ?? 0) === 0) && (
						<div className="rounded-md border border-border bg-card/40 px-4 py-3 text-sm text-muted-foreground">
							No textual changes in the listed files.
						</div>
					)}
				{!loading &&
					!loadError &&
					!codeViewState.error &&
					codeViewState.items.length > 0 && (
						<div className="flex items-center gap-2 text-xs">
							<button
								type="button"
								onClick={expandAll}
								className="rounded border border-border bg-card/60 px-2 py-1 text-muted-foreground hover:bg-muted/60"
								title="Expand all files (e)"
							>
								Expand all
								<kbd className="ml-1.5 rounded border border-border/70 bg-background px-1 py-px font-mono text-[10px]">
									e
								</kbd>
							</button>
							<button
								type="button"
								onClick={collapseAll}
								className="rounded border border-border bg-card/60 px-2 py-1 text-muted-foreground hover:bg-muted/60"
								title="Collapse all files (c)"
							>
								Collapse all
								<kbd className="ml-1.5 rounded border border-border/70 bg-background px-1 py-px font-mono text-[10px]">
									c
								</kbd>
							</button>
						</div>
					)}
			</div>
			{!loading &&
				!loadError &&
				!codeViewState.error &&
				codeViewState.items.length > 0 && (
					<CodeView
						ref={codeViewRef}
						items={codeViewState.items}
						options={codeViewOptions}
						selectedLines={selectedLines}
						renderAnnotation={renderAnnotation}
						renderHeaderPrefix={renderHeaderPrefix}
						renderHeaderMetadata={renderHeaderMetadata}
						className="mx-4 mb-4 min-h-0 flex-1 overflow-x-hidden overflow-y-auto rounded-md border border-border bg-card"
					/>
				)}
		</section>
	);
}
