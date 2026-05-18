import {
	useCallback,
	useDeferredValue,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { MultiFileDiff } from "@pierre/diffs/react";
import type { DiffLineAnnotation } from "@pierre/diffs";
import {
	ChevronDown,
	ChevronRight,
	LocateFixed,
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
	type DiffFocusSide,
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
import { stripMarkdownForSummary } from "@/lib/markdownContent";
import type { ReviewSection } from "@/lib/types/section";

interface FileBundle {
	file_path: string;
	oldText: string;
	newText: string;
}

const fileCache = new Map<string, string>();

type DiffAnnotationMetadata =
	| PublishedCommentAnnotationMetadata
	| SectionFeedbackAnnotationMetadata;

function reviewSectionHasFeedback(section: ReviewSection): boolean {
	return section.concerns.length > 0;
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

function scrollDiffLineIntoView(
	host: HTMLElement,
	line: number,
	side: DiffFocusSide,
	attempt = 0,
): void {
	const container = host.querySelector("diffs-container");
	const shadowRoot =
		container instanceof HTMLElement ? container.shadowRoot : null;
	if (!shadowRoot) {
		if (attempt < 30) {
			window.requestAnimationFrame(() =>
				scrollDiffLineIntoView(host, line, side, attempt + 1),
			);
		}
		return;
	}
	const preferredType =
		side === "RIGHT" ? "change-addition" : "change-deletion";
	const target =
		shadowRoot.querySelector(
			`[data-line="${line}"][data-line-type="${preferredType}"]`,
		) ?? shadowRoot.querySelector(`[data-line="${line}"]`);
	if (!(target instanceof HTMLElement)) {
		if (attempt < 30) {
			window.requestAnimationFrame(() =>
				scrollDiffLineIntoView(host, line, side, attempt + 1),
			);
		}
		return;
	}
	target.scrollIntoView({ behavior: "smooth", block: "center" });
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
}: {
	note: SectionFeedbackNote;
	showLocation?: boolean;
}) {
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

function SectionFeedbackAnnotation({
	notes,
}: {
	notes: SectionFeedbackNote[];
}) {
	return (
		<div className="space-y-1 border-l-2 border-primary bg-primary/10 px-2 py-1.5">
			{notes.map((note, index) => (
				<SectionFeedbackNoteView key={index} note={note} />
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

function DiffFileCard({
	bundle,
	collapsed,
	sectionFeedbackAnnotations,
	toggleFileCollapsed,
}: {
	bundle: FileBundle;
	collapsed: boolean;
	sectionFeedbackAnnotations: DiffLineAnnotation<SectionFeedbackAnnotationMetadata>[];
	toggleFileCollapsed: (filePath: string) => void;
}) {
	const activeFocus = useApp((s) => {
		const focus = s.diffFocus;
		if (!focus || focus.file_path !== bundle.file_path) return null;
		if (focus.source === "agent") return focus;
		if (focus.mode === "navigation") return focus;
		return null;
	});
	const publishedComments = useApp((s) => s.publishedComments);

	const oldFile = useMemo(
		() => ({ name: bundle.file_path, contents: bundle.oldText }),
		[bundle.file_path, bundle.oldText],
	);
	const newFile = useMemo(
		() => ({ name: bundle.file_path, contents: bundle.newText }),
		[bundle.file_path, bundle.newText],
	);

	const selectedLines = useMemo(
		() => (activeFocus ? focusRangeToPierreSelection(activeFocus) : null),
		[activeFocus],
	);

	const lineAnnotations = useMemo(
		(): DiffLineAnnotation<DiffAnnotationMetadata>[] => {
			const published = publishedComments
				.filter((comment) => comment.file_path === bundle.file_path)
				.map(publishedCommentToDiffAnnotation)
				.filter(
					(
						annotation,
					): annotation is DiffLineAnnotation<PublishedCommentAnnotationMetadata> =>
						annotation !== null,
				);
			const sectionFeedback = sectionFeedbackAnnotations.filter(
				(annotation) => annotation.metadata.file_path === bundle.file_path,
			);
			return [...published, ...sectionFeedback];
		},
		[publishedComments, sectionFeedbackAnnotations, bundle.file_path],
	);

	const hostRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (collapsed) return;
		if (!activeFocus || activeFocus.mode !== "navigation") return;
		const host = hostRef.current;
		if (!host) return;
		scrollDiffLineIntoView(host, activeFocus.start_line, activeFocus.side);
	}, [activeFocus, collapsed]);

	const renderAnnotation = useCallback(
		(annotation: DiffLineAnnotation<DiffAnnotationMetadata>) => {
			if (isSectionFeedbackAnnotation(annotation.metadata)) {
				return (
					<SectionFeedbackAnnotation notes={annotation.metadata.notes} />
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
		[],
	);

	const noteCount = lineAnnotations.length;
	const hasAgentNotes = sectionFeedbackAnnotations.some(
		(annotation) => annotation.metadata.file_path === bundle.file_path,
	);
	const ChevronIcon = collapsed ? ChevronRight : ChevronDown;

	const renderHeaderPrefix = useCallback(
		() => (
			<button
				type="button"
				onClick={() => toggleFileCollapsed(bundle.file_path)}
				aria-expanded={!collapsed}
				title={collapsed ? "Expand file" : "Collapse file"}
				className="-ml-1 inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted focus:outline-none focus-visible:ring-1 focus-visible:ring-primary"
			>
				<ChevronIcon className="size-3.5" />
			</button>
		),
		[ChevronIcon, bundle.file_path, collapsed, toggleFileCollapsed],
	);

	const renderHeaderMetadata = useCallback(() => {
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
	}, [hasAgentNotes, noteCount]);

	const options = useMemo(
		() => ({
			theme: "pierre-dark" as const,
			diffStyle: "unified" as const,
			enableLineSelection: false,
			collapsed,
		}),
		[collapsed],
	);

	return (
		<div
			ref={hostRef}
			data-file-path={bundle.file_path}
			data-expanded={collapsed ? "false" : "true"}
			className="relative overflow-hidden rounded-md border border-border bg-card"
		>
			<MultiFileDiff
				oldFile={oldFile}
				newFile={newFile}
				options={options}
				lineAnnotations={lineAnnotations}
				selectedLines={selectedLines}
				renderAnnotation={renderAnnotation}
				renderHeaderPrefix={renderHeaderPrefix}
				renderHeaderMetadata={renderHeaderMetadata}
			/>
		</div>
	);
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
	const publishedComments = useApp((s) => s.publishedComments);

	const deferredCurrentId = useDeferredValue(currentId);

	const current = useMemo(
		() => sections.find((s) => s.id === deferredCurrentId) ?? null,
		[sections, deferredCurrentId],
	);
	const section =
		current?.kind === "review_section" ? current.section ?? null : null;
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
	const sectionId = section?.section_id ?? null;
	const allFilePaths = useMemo(
		() => bundles.map((bundle) => bundle.file_path),
		[bundles],
	);
	useEffect(() => {
		setCollapsedFiles({});
	}, [sectionId]);

	useEffect(() => {
		scrollContainerRef.current?.scrollTo({ top: 0 });
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
		if (!diffFocus || loading || loadError) return;
		const visible = bundles.some((b) => b.file_path === diffFocus.file_path);
		if (!visible) {
			setDiffFocusError(
				`${diffFocus.file_path} is not visible in the current diff section.`,
			);
		}
	}, [bundles, diffFocus, loading, loadError, setDiffFocusError]);

	useEffect(() => {
		recordClientTelemetry("client.diff.current_section.evaluated", {
			"acp.session_id": session?.session_id,
			"section.current_id": deferredCurrentId,
			"section.has_entry": !!current,
			"section.has_payload": !!section,
			"section.file_count": section?.files.length,
		});
		if (!session || !section) {
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
					"section.id": section.section_id,
					"section.file_count": section.files.length,
				});
				const out: FileBundle[] = [];
				for (const file of section.files) {
					recordClientTelemetry("client.diff.file_load.started", {
						"acp.session_id": session.session_id,
						"section.id": section.section_id,
						"file.path": file,
						"repo.base_ref": section.base_ref,
						"repo.head_ref": section.head_ref,
					});
					const [oldText, newText] = await Promise.all([
						fetchFile(session.repo.path, file, section.base_ref),
						fetchFile(session.repo.path, file, section.head_ref),
					]);
					recordClientTelemetry("client.diff.file_load.finished", {
						"acp.session_id": session.session_id,
						"section.id": section.section_id,
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
						"section.id": section.section_id,
						"diff.bundle_count": out.length,
					});
					setBundles(out);
				}
			} catch (e) {
				if (!cancelled) {
					recordClientTelemetryError("client.diff.section_load.failed", e, {
						"acp.session_id": session.session_id,
						"section.id": section.section_id,
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
	}, [session, section, current, deferredCurrentId]);

	if (!session || !current) {
		return (
			<section
				ref={scrollContainerRef}
				className="flex min-h-0 flex-col items-center justify-center text-sm text-muted-foreground"
			>
				<p>Start a session to see the guided review.</p>
			</section>
		);
	}

	if (current.kind === "pr_description") {
		return (
			<section
				ref={scrollContainerRef}
				className="flex min-h-0 flex-col overflow-y-auto"
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

	if (current && !section) {
		return (
			<section
				ref={scrollContainerRef}
				className="flex min-h-0 flex-col items-center justify-center px-8 text-sm text-muted-foreground"
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
			className="flex min-h-0 flex-col overflow-y-auto"
		>
			<div className="flex flex-col gap-4 p-4">
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
					bundles.length === 0 &&
					sectionIsProcessing &&
					section!.files.length === 0 && (
						<div className="rounded-md border border-border bg-card/40 px-4 py-3 text-sm text-muted-foreground">
							Agent is finding files and ranges for this section…
						</div>
					)}
				{!loading &&
					!loadError &&
					bundles.length === 0 &&
					!(sectionIsProcessing && section!.files.length === 0) && (
					<div className="rounded-md border border-border bg-card/40 px-4 py-3 text-sm text-muted-foreground">
						No textual changes in the listed files.
					</div>
				)}
				{!loading && !loadError && bundles.length > 0 && (
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
				{bundles.map((b) => (
					<DiffFileCard
						key={b.file_path}
						bundle={b}
						collapsed={Boolean(collapsedFiles[b.file_path])}
						sectionFeedbackAnnotations={sectionFeedbackAnnotations}
						toggleFileCollapsed={toggleFileCollapsed}
					/>
				))}
			</div>

		</section>
	);
}
