import { useCallback, useState } from "react";
import { useApp, type SectionState } from "@/lib/store";
import { cn } from "@/lib/utils";
import { LoaderCircle } from "lucide-react";
import { stripMarkdownForSummary } from "@/lib/markdownContent";
import { MarkdownViewer } from "./MarkdownViewer";
import { FeedbackList } from "./Concerns";
import { CommentDraftCard } from "./CommentDraftCard";
import { Button } from "@/components/ui/button";
import { createDiffFocusRange } from "@/lib/diffFocus";
import { acp } from "@/lib/acp";
import {
	prTargetFromSessionSource,
	requestAgentPublishApprovedDrafts,
} from "@/lib/commentPublish";
import type { Concern } from "@/lib/types/section";

export function SectionList() {
	const sections = useApp((s) => s.sections);
	const currentId = useApp((s) => s.currentSectionId);
	const processingIds = useApp((s) => s.processingSectionIds);
	const setCurrent = useApp((s) => s.setCurrentSection);
	const setDiffFocus = useApp((s) => s.setDiffFocus);
	const drafts = useApp((s) => s.commentDrafts);

	const openConcernLocation = useCallback(
		(sectionId: string, concern: Concern) => {
			if (!concern.file_path || !concern.line) return;
			setCurrent(sectionId, "concern_link_clicked");
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
		[setCurrent, setDiffFocus],
	);

	return (
		<aside className="flex min-h-0 min-w-0 flex-col border-r border-border bg-card/30">
			<div className="border-b border-border px-4 py-3 text-sm font-semibold text-muted-foreground">
				Sections
			</div>
			{sections.length === 0 ? (
				<div className="px-4 py-3 text-xs text-muted-foreground">
					Waiting for the agent's section map…
				</div>
			) : (
				<ul className="flex-1 overflow-y-auto">
					{sections.map((s) => {
						const isProcessing = processingIds.includes(s.id);
						const isSelected = s.id === currentId;
						const concerns = sectionConcerns(s);
						return (
							<li
								key={s.id}
								className={cn(
									"border-b border-border/40 transition-colors duration-200",
									isSelected && "bg-accent",
								)}
							>
								<button
									type="button"
									onClick={() => setCurrent(s.id, "section_list_click")}
									className={cn(
										"flex w-full items-start gap-2.5 px-4 py-2.5 text-left transition-colors",
										!isSelected && "hover:bg-accent/50",
									)}
								>
									<span
										className={cn(
											"mt-1.5 h-2 w-2 shrink-0 rounded-full",
											s.status === "pending" && "bg-muted-foreground/40",
											s.status === "in_review" &&
												"bg-[oklch(0.74_0.16_70)]",
											s.status === "completed" &&
												"bg-[oklch(0.7_0.16_155)]",
											isProcessing && "bg-primary",
										)}
									/>
									<div className="min-w-0 flex-1">
										<div className="text-sm font-medium leading-tight">
											{s.title}
										</div>
										<div
											className={cn(
												"grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
												isSelected
													? "grid-rows-[0fr]"
													: "grid-rows-[1fr]",
											)}
										>
											<div className="overflow-hidden">
												<div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
													{stripMarkdownForSummary(s.intent)}
												</div>
											</div>
										</div>
										{isProcessing && (
											<div className="mt-1.5 flex items-center gap-1.5 text-xs font-medium text-primary">
												<LoaderCircle className="size-3 animate-spin" />
												<span>Agent is processing this section…</span>
											</div>
										)}
									</div>
								</button>
								<div
									className={cn(
										"grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
										isSelected ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
									)}
								>
									<div className="overflow-hidden">
										<div className="space-y-3 px-4 pb-3 pl-[1.875rem]">
											{s.intent && (
												<MarkdownViewer
													markdown={s.intent}
													className="text-xs text-muted-foreground"
												/>
											)}
											{concerns.length > 0 && (
												<FeedbackList
													title="Concerns"
													concerns={concerns}
													onOpenLocation={(concern) =>
														openConcernLocation(s.id, concern)
													}
												/>
											)}
										</div>
									</div>
								</div>
							</li>
						);
					})}
				</ul>
			)}
			{drafts.length > 0 && <CommentDraftsFooter />}
		</aside>
	);
}

function CommentDraftsFooter() {
	const session = useApp((s) => s.session);
	const drafts = useApp((s) => s.commentDrafts);
	const pushError = useApp((s) => s.pushError);
	const updateCommentDraft = useApp((s) => s.updateCommentDraft);
	const [publishing, setPublishing] = useState(false);
	const hasApproved = drafts.some((d) => d.status === "approved");

	async function submit() {
		if (!session || publishing) return;
		const target = prTargetFromSessionSource(session.source);
		if (!target) {
			pushError("PR target unknown.");
			return;
		}
		setPublishing(true);
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
			setPublishing(false);
		}
	}

	return (
		<div className="flex max-h-[45%] flex-col border-t border-border bg-card/50">
			<div className="flex items-center justify-between border-b border-border px-4 py-2 text-sm font-semibold text-muted-foreground">
				<span>Comments to submit</span>
				<span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">
					{drafts.length}
				</span>
			</div>
			<div className="flex flex-col gap-2 overflow-y-auto px-3 py-2">
				{drafts.map((d) => (
					<CommentDraftCard key={d.id} state={d} />
				))}
			</div>
			{hasApproved && (
				<div className="border-t border-border px-3 py-2">
					<Button
						size="sm"
						onClick={submit}
						disabled={publishing}
						className="w-full"
					>
						{publishing ? (
							<LoaderCircle className="size-3.5 animate-spin" />
						) : null}
						Submit approved comments
					</Button>
				</div>
			)}
		</div>
	);
}

function sectionConcerns(s: SectionState): Concern[] {
	if (s.kind !== "review_section") return [];
	return s.section?.concerns ?? [];
}
