import { useCallback, useEffect, useRef, useState } from "react";
import {
	OVERVIEW_CHAT_TAB_ID,
	useApp,
	type ChatTab,
} from "@/lib/store";
import { acp } from "@/lib/acp";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { FeedbackList } from "./Concerns";
import { cn } from "@/lib/utils";
import {
	ChevronDown,
	ChevronRight,
	CircleEllipsis,
	FileText,
	ListChecks,
	LoaderCircle,
	Map,
	Maximize2,
	MessageSquareText,
	Plus,
	Wrench,
	X,
} from "lucide-react";
import { recordClientTelemetry, recordClientTelemetryError } from "@/lib/telemetry";
import { createDiffFocusRange } from "@/lib/diffFocus";
import {
	buildUserMessageWithReviewContext,
	createReviewSnapshot,
} from "@/lib/reviewPersistence";
import { buildReviewChatKickoffPrefix } from "@/lib/reviewChatKickoff";
import {
	type AssistantBlock,
	type ThinkingBlockPart,
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

function ThinkingThread({
	parts,
	active,
}: {
	parts: ThinkingBlockPart[];
	active: boolean;
}) {
	const [open, setOpen] = useState(active);
	const toolCallCount = parts.filter((part) => part.type === "tool_call").length;

	useEffect(() => {
		setOpen(active);
	}, [active]);

	return (
		<div className="rounded-md border border-border bg-muted/20 text-muted-foreground">
			<button
				type="button"
				className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs"
				onClick={() => setOpen((value) => !value)}
				aria-expanded={open}
			>
				{open ? (
					<ChevronDown className="size-3.5 shrink-0" />
				) : (
					<ChevronRight className="size-3.5 shrink-0" />
				)}
				<CircleEllipsis className="size-3.5 shrink-0" />
				<span className="min-w-0 flex-1 truncate font-medium">
					{active ? "Thinking" : "Thinking collapsed"}
				</span>
				{toolCallCount > 0 && (
					<span className="rounded bg-background/70 px-1.5 py-0.5 font-mono text-[10px]">
						{toolCallCount} tool{toolCallCount === 1 ? "" : "s"}
					</span>
				)}
			</button>
			{open && (
				<div className="space-y-1.5 border-t border-border px-2.5 py-2">
					{parts.map((part, index) =>
						part.type === "text" ? (
							<div
								key={index}
								className="whitespace-pre-wrap break-words text-xs leading-relaxed"
							>
								{part.text}
							</div>
						) : (
							<ToolCallCard
								key={`${part.toolCall.tool_call_id}-${index}`}
								toolCall={part.toolCall}
							/>
						),
					)}
				</div>
			)}
		</div>
	);
}

function AssistantResponseCard({ markdown }: { markdown: string }) {
	return (
		<div className="rounded-md border border-border bg-card px-3 py-2 text-foreground">
			<div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
				<MessageSquareText className="size-3.5" />
				<span>Response</span>
			</div>
			<MarkdownViewer markdown={markdown} />
		</div>
	);
}

function AssistantBlocks({
	blocks,
	activeThinking = false,
	className,
}: {
	blocks: AssistantBlock[];
	activeThinking?: boolean;
	className?: string;
}) {
	return (
		<div className={cn("space-y-2", className)}>
			{blocks.map((block, index) =>
				block.type === "response" ? (
					<AssistantResponseCard key={index} markdown={block.markdown} />
				) : (
					<ThinkingThread
						key={index}
						parts={block.parts}
						active={activeThinking}
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
	const responseBlocks = blocks.filter((block) => block.type === "response");
	const canOpenFullPage = responseBlocks.length > 0;
	const hasResponse = responseBlocks.length > 0;
	const activeThinking = Boolean(message.streaming && !hasResponse);

	return (
		<div className="relative">
			{canOpenFullPage && (
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="absolute right-1.5 top-1.5 h-7 w-7 text-muted-foreground hover:text-foreground"
					onClick={() => onOpenFullPage(responseBlocks)}
					title="Open response"
					aria-label="Open response"
				>
					<Maximize2 className="size-3.5" />
				</Button>
			)}
			<AssistantBlocks
				blocks={blocks}
				activeThinking={activeThinking}
				className={canOpenFullPage ? "pr-7" : undefined}
			/>
			{message.streaming && (
				<span className="ml-0.5 animate-pulse text-sm">▋</span>
			)}
		</div>
	);
}

function ChatTabs({
	tabs,
	activeTabId,
	canCreate,
	onSelect,
	onCreate,
	onClose,
}: {
	tabs: ChatTab[];
	activeTabId: string | undefined;
	canCreate: boolean;
	onSelect: (tabId: string) => void;
	onCreate: () => void;
	onClose: (tabId: string) => void;
}) {
	if (tabs.length === 0) return null;
	return (
		<div className="flex min-h-10 items-center gap-1 overflow-x-auto border-b border-border bg-background/40 px-2 py-1.5">
			{tabs.map((tab) => {
				const active = tab.id === activeTabId;
				return (
					<div
						key={tab.id}
						className={cn(
							"flex h-7 max-w-36 shrink-0 items-center overflow-hidden rounded-md border text-xs transition-colors",
							active
								? "border-primary/35 bg-primary/10 text-foreground"
								: "border-transparent text-muted-foreground hover:bg-accent",
						)}
					>
						<button
							type="button"
							onClick={() => onSelect(tab.id)}
							className="min-w-0 flex-1 truncate px-2 text-left"
							title={tab.title}
						>
							{tab.title}
						</button>
						{canCreate && tab.id !== OVERVIEW_CHAT_TAB_ID && (
							<button
								type="button"
								onClick={(e) => {
									e.stopPropagation();
									onClose(tab.id);
								}}
								className="grid h-7 w-6 shrink-0 place-items-center text-muted-foreground hover:text-foreground"
								title={`Close ${tab.title}`}
								aria-label={`Close ${tab.title}`}
							>
								<X className="size-3" />
							</button>
						)}
					</div>
				);
			})}
			{canCreate && (
				<Button
					type="button"
					size="icon"
					variant="ghost"
					className="h-7 w-7 shrink-0"
					onClick={onCreate}
					title="New chat tab"
					aria-label="New chat tab"
				>
					<Plus className="size-3.5" />
				</Button>
			)}
		</div>
	);
}

export function ChatPanel() {
	const session = useApp((s) => s.session);
	const chatTabs = useApp((s) => s.chatTabs);
	const activeChatTabId = useApp((s) => s.activeChatTabId);
	const chatByTab = useApp((s) => s.chatByTab);
	const sessionByChatTab = useApp((s) => s.sessionByChatTab);
	const drafts = useApp((s) => s.commentDrafts);
	const streaming = useApp((s) => s.streaming);
	const sections = useApp((s) => s.sections);
	const currentSectionId = useApp((s) => s.currentSectionId);
	const processingSectionIds = useApp((s) => s.processingSectionIds);
	const publishedComments = useApp((s) => s.publishedComments);
	const publishedCommentsError = useApp((s) => s.publishedCommentsError);
	const addUserMessage = useApp((s) => s.addUserMessage);
	const createChatTab = useApp((s) => s.createChatTab);
	const setActiveChatTab = useApp((s) => s.setActiveChatTab);
	const closeChatTab = useApp((s) => s.closeChatTab);
	const attachChatTabSession = useApp((s) => s.attachChatTabSession);
	const detachChatTabSession = useApp((s) => s.detachChatTabSession);
	const pushError = useApp((s) => s.pushError);

	const tabs = chatTabs;
	const activeTabId = activeChatTabId ?? tabs[0]?.id;
	const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
	const chat = activeTab ? (chatByTab[activeTab.id] ?? []) : [];
	const canCreateTabs = !!session;

	const [input, setInput] = useState("");
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
		if (!activeTab) return;
		const text = input.trim();
		if (!text) return;
		const body = text;
		const targetTabId = activeTab.id;

		setInput("");
		addUserMessage(body, targetTabId);

		try {
			const snapshot = createReviewSnapshot({
				current_section_id: currentSectionId,
				sections,
				comment_drafts: drafts,
				published_comments: publishedComments,
				published_comments_error: publishedCommentsError,
			});
			const userMessageWithContext = buildUserMessageWithReviewContext({
				userText: body,
				session,
				snapshot,
			});

			if (targetTabId === OVERVIEW_CHAT_TAB_ID) {
				recordClientTelemetry("client.chat.send.requested", {
					"acp.session_id": session.session_id,
					"section.id": currentSectionId,
					"chat.tab_id": targetTabId,
					"message.length": body.length,
				});
				await acp.sendMessage(session.session_id, userMessageWithContext, {
					origin: "chat_panel_user_send",
					reason: "user_reply",
					sectionId: currentSectionId ?? undefined,
					suppressPreview: true,
				});
				recordClientTelemetry("client.chat.send.succeeded", {
					"acp.session_id": session.session_id,
					"section.id": currentSectionId,
					"chat.tab_id": targetTabId,
					"message.length": body.length,
				});
				return;
			}

			let sessionId = sessionByChatTab[targetTabId];
			let messageToAgent = userMessageWithContext;
			let spawnedThisTurn = false;

			if (!sessionId) {
				recordClientTelemetry("client.chat.session.spawning", {
					"acp.parent_session_id": session.session_id,
					"section.id": currentSectionId,
					"chat.tab_id": targetTabId,
				});
				const spawned = await acp.startChat({
					parent_session_id: session.session_id,
				});
				sessionId = spawned.session_id;
				spawnedThisTurn = true;
				attachChatTabSession(targetTabId, sessionId);
				const kickoffPrefix = buildReviewChatKickoffPrefix({
					session,
					snapshot,
					publishedComments,
					publishedCommentsError,
				});
				messageToAgent = `${kickoffPrefix}\n\n---\n\n${userMessageWithContext}`;
				recordClientTelemetry("client.chat.session.spawned", {
					"acp.parent_session_id": session.session_id,
					"acp.session_id": sessionId,
					"section.id": currentSectionId,
					"chat.tab_id": targetTabId,
				});
			}

			recordClientTelemetry("client.chat.send.requested", {
				"acp.session_id": sessionId,
				"section.id": currentSectionId,
				"chat.tab_id": targetTabId,
				"message.length": body.length,
			});

			try {
				await acp.sendMessage(sessionId, messageToAgent, {
					origin: "chat_panel_user_send",
					reason: "user_reply",
					sectionId: currentSectionId ?? undefined,
					suppressPreview: true,
				});
				recordClientTelemetry("client.chat.send.succeeded", {
					"acp.session_id": sessionId,
					"section.id": currentSectionId,
					"chat.tab_id": targetTabId,
					"message.length": body.length,
				});
			} catch (e) {
				if (spawnedThisTurn) detachChatTabSession(targetTabId);
				throw e;
			}
		} catch (e) {
			recordClientTelemetryError("client.chat.send.failed", e, {
				"acp.session_id": session.session_id,
				"section.id": currentSectionId,
				"chat.tab_id": targetTabId,
				"message.length": body.length,
			});
			pushError(`send_message failed: ${e}`);
		}
	}

	function createTab() {
		if (!canCreateTabs) return;
		createChatTab();
		requestAnimationFrame(() => textareaRef.current?.focus());
	}

	function closeTab(tabId: string) {
		const { closedSessionId } = closeChatTab(tabId);
		if (closedSessionId) {
			void acp.endSession(closedSessionId).catch((e) => {
				recordClientTelemetryError("client.chat.tab.close_session_failed", e, {
					"acp.session_id": closedSessionId,
					"chat.tab_id": tabId,
				});
			});
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
			<div className="flex items-center justify-between border-b border-border px-4 py-3 text-sm font-semibold text-muted-foreground">
				<span>Chat</span>
			</div>
			<ChatTabs
				tabs={tabs}
				activeTabId={activeTab?.id}
				canCreate={canCreateTabs}
				onSelect={(tabId) => setActiveChatTab(tabId)}
				onCreate={createTab}
				onClose={closeTab}
			/>
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
							<div
								key={m.id}
								className="chat-scroll-item space-y-1"
							>
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
							? "Ask about this review…  (Enter to send · ⌘+Enter for newline)"
							: "Start a session first"
					}
					disabled={!session || !activeTab}
					rows={3}
				/>
				<div className="flex items-center justify-end gap-2">
					<Button
						size="sm"
						onClick={send}
						disabled={!session || !activeTab || !input.trim()}
					>
						Send
					</Button>
				</div>
			</div>
		</aside>
	);
}
