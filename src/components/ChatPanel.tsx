import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "@/lib/store";
import { acp } from "@/lib/acp";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { CommentDraftCard } from "./CommentDraftCard";
import { SeverityBadge } from "./SeverityBadge";
import { cn } from "@/lib/utils";
import {
	Check,
	Copy,
	FileText,
	ListChecks,
	LoaderCircle,
	Map,
	Maximize2,
	Wrench,
} from "lucide-react";
import { recordClientTelemetry, recordClientTelemetryError } from "@/lib/telemetry";
import {
	prTargetFromSessionSource,
	requestAgentPublishApprovedDrafts,
} from "@/lib/commentPublish";
import { createDiffFocusRange } from "@/lib/diffFocus";
import {
	buildUserMessageWithReviewContext,
	createReviewSnapshot,
} from "@/lib/reviewPersistence";
import {
	type AssistantBlock,
	assistantPartsToBlocks,
	stripMarkdownForSummary,
} from "@/lib/markdownContent";
import { isChatScrolledToBottom } from "@/lib/chatScroll";
import { MarkdownViewer } from "./MarkdownViewer";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import type {
	ChatItem,
	ChatMessage,
	ChatMessagePart,
	Concern,
	ReviewSection,
	ToolCallItem,
} from "@/lib/types/section";

function formatConcernForCopy(concern: Concern): string {
	const text = concern.text.trim();
	if (!concern.file_path) return text;
	const location = concern.line
		? `${concern.file_path}:${concern.line}`
		: concern.file_path;
	return text ? `${text}\n${location}` : location;
}

function ConcernItem({
	concern,
	onOpenLocation,
}: {
	concern: Concern;
	onOpenLocation: (concern: Concern) => void;
}) {
	const [copied, setCopied] = useState(false);
	const copyTimeoutRef = useRef<number | null>(null);

	useEffect(() => {
		return () => {
			if (copyTimeoutRef.current !== null) {
				window.clearTimeout(copyTimeoutRef.current);
			}
		};
	}, []);

	const copy = useCallback(async () => {
		const payload = formatConcernForCopy(concern);
		try {
			await navigator.clipboard.writeText(payload);
			setCopied(true);
			if (copyTimeoutRef.current !== null) {
				window.clearTimeout(copyTimeoutRef.current);
			}
			copyTimeoutRef.current = window.setTimeout(() => setCopied(false), 1500);
		} catch {
			// Browser/WebView refused clipboard write; fall through silently.
		}
	}, [concern]);

	const hasLocation = Boolean(concern.file_path);
	const locationLabel = concern.file_path
		? concern.line
			? `${concern.file_path}:${concern.line}`
			: concern.file_path
		: null;

	return (
		<li className="group flex items-start gap-2 text-xs">
			<SeverityBadge severity={concern.severity} />
			<div className="min-w-0 flex-1">
				<div>{concern.text}</div>
				{locationLabel && (
					hasLocation && concern.line ? (
						<button
							type="button"
							onClick={() => onOpenLocation(concern)}
							className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus:outline-hidden focus-visible:text-foreground focus-visible:underline"
							title="Open this line in the diff"
						>
							{locationLabel}
						</button>
					) : (
						<div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
							{locationLabel}
						</div>
					)
				)}
			</div>
			<button
				type="button"
				onClick={copy}
				className={cn(
					"inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-opacity hover:bg-muted/60 hover:text-foreground focus:outline-hidden focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-primary",
					copied
						? "opacity-100"
						: "opacity-0 group-hover:opacity-100",
				)}
				aria-label={copied ? "Copied" : "Copy concern"}
				title={copied ? "Copied" : "Copy concern"}
			>
				{copied ? (
					<Check className="size-3 text-primary" />
				) : (
					<Copy className="size-3" />
				)}
			</button>
		</li>
	);
}

function FeedbackList({
	title,
	concerns,
	onOpenLocation,
}: {
	title: string;
	concerns: Concern[];
	onOpenLocation: (concern: Concern) => void;
}) {
	if (concerns.length === 0) return null;
	return (
		<div className="space-y-1.5">
			<div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
				{title}
			</div>
			<ul className="space-y-1.5">
				{concerns.map((concern, index) => (
					<ConcernItem
						key={index}
						concern={concern}
						onOpenLocation={onOpenLocation}
					/>
				))}
			</ul>
		</div>
	);
}

function ReviewSectionCard({ section }: { section: ReviewSection }) {
	const hasFeedback = section.concerns.length > 0;
	const sectionId = section.section_id;
	const setCurrentSection = useApp((s) => s.setCurrentSection);
	const setDiffFocus = useApp((s) => s.setDiffFocus);

	const openConcernLocation = useCallback(
		(concern: Concern) => {
			if (!concern.file_path || !concern.line) return;
			setCurrentSection(sectionId, "concern_link_clicked");
			const range = createDiffFocusRange({
				file_path: concern.file_path,
				start_line: concern.line,
				end_line: concern.line,
				side: "RIGHT",
				source: "user",
				mode: "navigation",
			});
			if (range) setDiffFocus(range);
		},
		[sectionId, setCurrentSection, setDiffFocus],
	);

	return (
		<div className="rounded-md border border-border bg-card px-3 py-2 text-sm">
			<div className="mb-2 flex items-center gap-2 font-semibold">
				<ListChecks className="size-4 text-muted-foreground" />
				<span>{section.title}</span>
			</div>
			<div className="mb-2 text-xs text-muted-foreground">
				{stripMarkdownForSummary(section.intent)}
			</div>
			{section.files.length > 0 && (
				<div className="mb-3 space-y-1.5">
					<div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
						<FileText className="size-3" />
						<span>Files</span>
					</div>
					<div className="flex flex-wrap gap-1.5">
						{section.files.map((file) => (
							<span
								key={file}
								className="max-w-full truncate rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px]"
							>
								{file}
							</span>
						))}
					</div>
				</div>
			)}
			{hasFeedback ? (
				<div className="space-y-3">
					<FeedbackList
						title="Concerns"
						concerns={section.concerns}
						onOpenLocation={openConcernLocation}
					/>
				</div>
			) : (
				<div className="text-xs text-muted-foreground">
					No concerns found for this section.
				</div>
			)}
		</div>
	);
}

function ChatItemView({ item }: { item: ChatItem }) {
	if (item.type === "section_map") {
		return (
			<div className="rounded-md border border-border bg-card px-3 py-2 text-sm">
				<div className="mb-2 flex items-center gap-2 font-semibold">
					<Map className="size-4 text-muted-foreground" />
					<span>Section map</span>
					<span className="ml-auto text-xs font-normal text-muted-foreground">
						{item.sections.length} section
						{item.sections.length === 1 ? "" : "s"}
					</span>
				</div>
				<ul className="space-y-2">
					{item.sections.map((section) => (
						<li key={section.section_id} className="min-w-0">
							<div className="font-medium leading-tight">{section.title}</div>
							<div className="mt-0.5 text-xs text-muted-foreground">
								{stripMarkdownForSummary(section.intent)}
							</div>
						</li>
					))}
				</ul>
			</div>
		);
	}

	if (item.type === "review_section") {
		return <ReviewSectionCard section={item.section} />;
	}

	return null;
}

function partsFromMessage(message: ChatMessage): ChatMessagePart[] {
	if (message.parts) return message.parts;
	return message.text ? [{ type: "markdown", text: message.text }] : [];
}

function ToolCallCard({ toolCall }: { toolCall: ToolCallItem }) {
	return (
		<div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-1.5 text-xs text-muted-foreground">
			<Wrench className="size-3.5 shrink-0" />
			<span className="min-w-0 flex-1 truncate font-medium text-foreground">
				{toolCall.title}
			</span>
			<span className="rounded bg-background/70 px-1.5 py-0.5 font-mono text-[10px]">
				{toolCall.status}
			</span>
		</div>
	);
}

function AssistantBlocks({
	blocks,
	className,
}: {
	blocks: AssistantBlock[];
	className?: string;
}) {
	return (
		<div className={cn("space-y-2", className)}>
			{blocks.map((block, index) =>
				block.type === "markdown" ? (
					<MarkdownViewer key={index} markdown={block.markdown} />
				) : (
					<ToolCallCard
						key={`${block.toolCall.tool_call_id}-${index}`}
						toolCall={block.toolCall}
					/>
				),
			)}
		</div>
	);
}

function AssistantResponseView({
	message,
	blocks,
	onOpenFullPage,
}: {
	message: ChatMessage;
	blocks: AssistantBlock[];
	onOpenFullPage: (blocks: AssistantBlock[]) => void;
}) {
	const canOpenFullPage = blocks.length > 0;

	return (
		<div className="relative rounded-md border border-border bg-card px-3 py-2 text-foreground">
			{canOpenFullPage && (
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="absolute right-1.5 top-1.5 h-7 w-7 text-muted-foreground hover:text-foreground"
					onClick={() => onOpenFullPage(blocks)}
					title="Open response"
					aria-label="Open response"
				>
					<Maximize2 className="size-3.5" />
				</Button>
			)}
			<AssistantBlocks
				blocks={blocks}
				className={canOpenFullPage ? "pr-7" : undefined}
			/>
			{message.streaming && (
				<span className="ml-0.5 animate-pulse text-sm">▋</span>
			)}
		</div>
	);
}

export function ChatPanel() {
	const session = useApp((s) => s.session);
	const chat = useApp((s) => s.chat);
	const drafts = useApp((s) => s.commentDrafts);
	const streaming = useApp((s) => s.streaming);
	const sections = useApp((s) => s.sections);
	const currentSectionId = useApp((s) => s.currentSectionId);
	const processingSectionIds = useApp((s) => s.processingSectionIds);
	const publishedComments = useApp((s) => s.publishedComments);
	const publishedCommentsError = useApp((s) => s.publishedCommentsError);
	const addUserMessage = useApp((s) => s.addUserMessage);
	const pushError = useApp((s) => s.pushError);
	const updateCommentDraft = useApp((s) => s.updateCommentDraft);

	const [input, setInput] = useState("");
	const [publishingComments, setPublishingComments] = useState(false);
	const [fullPageBlocks, setFullPageBlocks] = useState<AssistantBlock[] | null>(
		null,
	);
	const scrollerRef = useRef<HTMLDivElement>(null);
	const bottomAnchorRef = useRef<HTMLDivElement>(null);
	const stickToBottomRef = useRef(true);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const processingSection = processingSectionIds[0]
		? sections.find((s) => s.id === processingSectionIds[0])
		: null;

	useEffect(() => {
		queueMicrotask(() => {
			if (!stickToBottomRef.current) return;
			bottomAnchorRef.current?.scrollIntoView({
				block: "end",
				inline: "nearest",
			});
		});
	}, [chat, drafts, streaming]);

	function handleChatScroll(e: React.UIEvent<HTMLDivElement>) {
		stickToBottomRef.current = isChatScrolledToBottom(e.currentTarget);
	}

	async function send() {
		if (!session) return;
		const text = input.trim();
		if (!text) return;
		const body = text;
		const snapshot = createReviewSnapshot({
			current_section_id: currentSectionId,
			sections,
			chat,
			comment_drafts: drafts,
			published_comments: publishedComments,
			published_comments_error: publishedCommentsError,
		});
		const messageToAgent = buildUserMessageWithReviewContext({
			userText: body,
			session,
			snapshot,
		});
		recordClientTelemetry("client.chat.send.requested", {
			"acp.session_id": session.session_id,
			"message.length": body.length,
		});
		setInput("");
		addUserMessage(body);
		try {
			await acp.sendMessage(session.session_id, messageToAgent, {
				origin: "chat_panel_user_send",
				reason: "user_reply",
				suppressPreview: true,
			});
			recordClientTelemetry("client.chat.send.succeeded", {
				"acp.session_id": session.session_id,
				"message.length": body.length,
			});
		} catch (e) {
			recordClientTelemetryError("client.chat.send.failed", e, {
				"acp.session_id": session.session_id,
				"message.length": body.length,
			});
			pushError(`send_message failed: ${e}`);
		}
	}

	async function submitApprovedDrafts() {
		if (!session || publishingComments) return;
		const target = prTargetFromSessionSource(session.source);
		if (!target) {
			pushError("PR target unknown.");
			return;
		}
		setPublishingComments(true);
		try {
			await requestAgentPublishApprovedDrafts({
				session_id: session.session_id,
				target,
				head_sha: session.repo.head_sha,
				comment_drafts: drafts,
				updateCommentDraft,
				sendMessage: acp.sendMessage,
			});
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			pushError(message || "Could not ask the agent to publish the comments.");
		} finally {
			setPublishingComments(false);
		}
	}

	function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
		// Enter sends; Cmd/Ctrl+Enter inserts a newline.
		if (e.key === "Enter" && !e.shiftKey && !(e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			send();
			return;
		}
		if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			const ta = e.currentTarget;
			const start = ta.selectionStart ?? input.length;
			const end = ta.selectionEnd ?? start;
			const next = input.slice(0, start) + "\n" + input.slice(end);
			setInput(next);
			requestAnimationFrame(() => {
				if (textareaRef.current) {
					textareaRef.current.selectionStart = start + 1;
					textareaRef.current.selectionEnd = start + 1;
				}
			});
		}
	}

	return (
		<aside className="flex h-full min-h-0 min-w-0 flex-col border-l border-border bg-card/30">
			<Dialog
				open={!!fullPageBlocks}
				onOpenChange={(open) => {
					if (!open) setFullPageBlocks(null);
				}}
			>
				<DialogContent className="grid h-[calc(100vh-2rem)] max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-none grid-rows-[auto_1fr] gap-0 p-0">
					<DialogHeader className="border-b border-border px-6 py-4">
						<DialogTitle>Assistant response</DialogTitle>
						<DialogDescription className="sr-only">
							Full page view of the selected assistant response.
						</DialogDescription>
					</DialogHeader>
					<div className="min-h-0 overflow-y-auto px-6 py-5">
						{fullPageBlocks && (
							<AssistantBlocks
								blocks={fullPageBlocks}
								className="mx-auto max-w-4xl text-base"
							/>
						)}
					</div>
				</DialogContent>
			</Dialog>
			<div className="border-b border-border px-4 py-3 text-sm font-semibold text-muted-foreground">
				Chat
			</div>
			<div
				ref={scrollerRef}
				onScroll={handleChatScroll}
				className="flex-1 space-y-3 overflow-y-auto px-4 py-4"
			>
				{chat.map((m) => {
					if (m.item) {
						return (
							<div key={m.id} className="chat-scroll-item space-y-1">
								<div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
									{m.role}
								</div>
								<ChatItemView item={m.item} />
							</div>
						);
					}
					if (m.role === "user") {
						if (!m.text.trim()) return null;
						return (
							<div key={m.id} className="chat-scroll-item space-y-1">
								<div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
									{m.role}
								</div>
								<div
									className={cn(
										"whitespace-pre-wrap break-words rounded-md px-3 py-2 text-sm leading-relaxed",
										"bg-primary/15 text-foreground",
									)}
								>
									{m.text}
									{m.streaming && (
										<span className="ml-0.5 animate-pulse">▋</span>
									)}
								</div>
							</div>
						);
					}
					const blocks = assistantPartsToBlocks(partsFromMessage(m));
					if (blocks.length === 0 && !m.streaming) return null;
					return (
						<div key={m.id} className="chat-scroll-item space-y-1">
							<div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
								{m.role}
							</div>
							<AssistantResponseView
								message={m}
								blocks={blocks}
								onOpenFullPage={setFullPageBlocks}
							/>
						</div>
					);
				})}
				{streaming &&
					(chat.length === 0 || chat[chat.length - 1].role === "user") && (
						<div className="chat-scroll-item flex items-center gap-1.5 self-start rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
							<span className="block h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:0ms]" />
							<span className="block h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:150ms]" />
							<span className="block h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:300ms]" />
							<span className="ml-1">agent thinking…</span>
						</div>
					)}
				{drafts.length > 0 && (
					<div className="chat-scroll-item flex flex-col gap-2 pt-2">
						{drafts.map((d) => (
							<CommentDraftCard key={d.id} state={d} />
						))}
						{drafts.some((d) => d.status === "approved") && (
							<Button
								size="sm"
								onClick={submitApprovedDrafts}
								disabled={publishingComments}
							>
								{publishingComments ? (
									<LoaderCircle className="size-3.5 animate-spin" />
								) : null}
								Submit approved comments
							</Button>
						)}
					</div>
				)}
				<div
					ref={bottomAnchorRef}
					className="chat-scroll-anchor !mt-0"
					aria-hidden="true"
				/>
			</div>
			<div className="space-y-2 border-t border-border bg-background/40 p-3">
				{processingSectionIds.length > 0 && (
					<div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-xs font-medium text-primary">
						<LoaderCircle className="size-3.5 animate-spin" />
						<span>
							{processingSectionIds.length === 1
								? `Agent is processing ${processingSection ? `“${processingSection.title}”` : "this section"}…`
								: `Agent is processing ${processingSectionIds.length} sections…`}
						</span>
					</div>
				)}
				<Textarea
					ref={textareaRef}
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={onKeyDown}
					placeholder={
						session
							? "Reply to the agent…  (Enter to send · ⌘+Enter for newline)"
							: "Start a session first"
					}
					disabled={!session}
					rows={3}
				/>
				<div className="flex items-center justify-end gap-2">
					<Button
						size="sm"
						onClick={send}
						disabled={!session || !input.trim()}
					>
						Send
					</Button>
				</div>
			</div>
		</aside>
	);
}
