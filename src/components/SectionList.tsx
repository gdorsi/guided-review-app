import { useCallback } from "react";
import { useApp, type SectionState } from "@/lib/store";
import { cn } from "@/lib/utils";
import { LoaderCircle } from "lucide-react";
import { stripMarkdownForSummary } from "@/lib/markdownContent";
import { MarkdownViewer } from "./MarkdownViewer";
import { FeedbackList } from "./Concerns";
import { CommentDraftCard } from "./CommentDraftCard";
import { SubmitReviewButton } from "./SubmitReviewButton";
import { createDiffFocusRange } from "@/lib/diffFocus";
import { concernDraftId, concernToDraft } from "@/lib/concernReview";
import type { Concern } from "@/lib/types/section";
import type { GrillQuestion } from "@/lib/types/grill";
import { questionLocation } from "@/lib/sectionFeedback";

export function SectionList() {
	const sections = useApp((s) => s.sections);
	const currentId = useApp((s) => s.currentSectionId);
	const processingIds = useApp((s) => s.processingSectionIds);
	const setCurrent = useApp((s) => s.setCurrentSection);
	const setDiffFocus = useApp((s) => s.setDiffFocus);
	const drafts = useApp((s) => s.commentDrafts);
	const toggleConcernDraft = useApp((s) => s.toggleConcernDraft);
	const overviewConcernGroups = sectionConcernGroups(sections);
	const overviewQuestionGroups = sectionQuestionGroups(sections);

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

	const isConcernMarked = useCallback(
		(sectionId: string, concern: Concern) =>
			drafts.some((d) => d.id === concernDraftId(sectionId, concern)),
		[drafts],
	);

	const toggleConcern = useCallback(
		(sectionId: string, concern: Concern) =>
			toggleConcernDraft(
				concernDraftId(sectionId, concern),
				concernToDraft(concern),
			),
		[toggleConcernDraft],
	);

	const openQuestionLocation = useCallback(
		(sectionId: string, question: GrillQuestion) => {
			const location = questionLocation(question);
			if (!location.file_path || !location.line) return;
			setCurrent(sectionId, "question_link_clicked");
			const range = createDiffFocusRange({
				file_path: location.file_path,
				start_line: location.line,
				end_line: location.line,
				side: "RIGHT",
				source: "user",
				mode: "navigation",
			});
			if (range) setDiffFocus(range);
		},
		[setCurrent, setDiffFocus],
	);

	return (
		<aside className="flex h-full min-h-0 min-w-0 flex-col border-r border-border bg-card/30">
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
						const questions = sectionQuestions(s);
						const showOverviewConcernGroups =
							s.kind === "pr_description" && isSelected;
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
											{showOverviewConcernGroups &&
												(overviewConcernGroups.length > 0 ||
													overviewQuestionGroups.length > 0) && (
													<div className="space-y-3 border-t border-border/40 pt-3">
														{overviewConcernGroups.map((group) => (
															<FeedbackList
																key={group.id}
																title={`Concerns: ${group.title}`}
																concerns={group.concerns}
																onOpenLocation={(concern) =>
																	openConcernLocation(group.id, concern)
																}
																isMarked={(concern) =>
																	isConcernMarked(group.id, concern)
																}
																onToggleMarked={(concern) =>
																	toggleConcern(group.id, concern)
																}
															/>
														))}
														{overviewQuestionGroups.map((group) => (
															<QuestionList
																key={group.id}
																title={`Questions: ${group.title}`}
																questions={group.questions}
																onOpenLocation={(question) =>
																	openQuestionLocation(group.id, question)
																}
															/>
														))}
													</div>
												)}
											{!showOverviewConcernGroups && concerns.length > 0 && (
												<FeedbackList
													title="Concerns"
													concerns={concerns}
													onOpenLocation={(concern) =>
														openConcernLocation(s.id, concern)
													}
													isMarked={(concern) =>
														isConcernMarked(s.id, concern)
													}
													onToggleMarked={(concern) =>
														toggleConcern(s.id, concern)
													}
												/>
											)}
											{!showOverviewConcernGroups && questions.length > 0 && (
												<QuestionList
													title="Questions"
													questions={questions}
													onOpenLocation={(question) =>
														openQuestionLocation(s.id, question)
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
	const drafts = useApp((s) => s.commentDrafts);
	const markedCount = drafts.filter((d) => d.marked).length;

	return (
		<div className="flex max-h-[45%] flex-col border-t border-border bg-card/50">
			<div className="flex items-center justify-between border-b border-border px-4 py-2 text-sm font-semibold text-muted-foreground">
				<span>Comments</span>
				<span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">
					{markedCount}/{drafts.length} marked
				</span>
			</div>
			<div className="flex flex-col gap-2 overflow-y-auto px-3 py-2">
				{drafts.map((d) => (
					<CommentDraftCard key={d.id} state={d} />
				))}
			</div>
			<div className="border-t border-border px-3 py-2">
				<SubmitReviewButton compact />
			</div>
		</div>
	);
}

function QuestionItem({
	question,
	onOpenLocation,
}: {
	question: GrillQuestion;
	onOpenLocation: (question: GrillQuestion) => void;
}) {
	const location = questionLocation(question);
	const locationLabel = location.file_path
		? location.line
			? `${location.file_path}:${location.line}`
			: location.file_path
		: null;

	return (
		<li className="space-y-1 text-xs">
			<div>{question.question}</div>
			{locationLabel && (
				location.file_path && location.line ? (
					<button
						type="button"
						onClick={() => onOpenLocation(question)}
						className="block max-w-full truncate font-mono text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus:outline-hidden focus-visible:text-foreground focus-visible:underline"
						title="Open this line in the diff"
					>
						{locationLabel}
					</button>
				) : (
					<div className="font-mono text-[10px] text-muted-foreground">
						{locationLabel}
					</div>
				)
			)}
		</li>
	);
}

function QuestionList({
	title,
	questions,
	onOpenLocation,
}: {
	title: string;
	questions: GrillQuestion[];
	onOpenLocation: (question: GrillQuestion) => void;
}) {
	if (questions.length === 0) return null;
	return (
		<div className="space-y-1.5">
			<div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
				{title}
			</div>
			<ul className="space-y-1.5">
				{questions.map((question) => (
					<QuestionItem
						key={question.question_id}
						question={question}
						onOpenLocation={onOpenLocation}
					/>
				))}
			</ul>
		</div>
	);
}

function sectionConcerns(s: SectionState): Concern[] {
	if (s.kind !== "review_section") return [];
	return s.section?.concerns ?? [];
}

function sectionQuestions(s: SectionState): GrillQuestion[] {
	if (s.kind !== "review_section") return [];
	return s.section?.grill_questions ?? [];
}

interface SectionConcernGroup {
	id: string;
	title: string;
	concerns: Concern[];
}

interface SectionQuestionGroup {
	id: string;
	title: string;
	questions: GrillQuestion[];
}

function sectionConcernGroups(sections: SectionState[]): SectionConcernGroup[] {
	return sections.flatMap((section) => {
		if (section.kind !== "review_section") return [];
		const concerns = sectionConcerns(section);
		if (concerns.length === 0) return [];
		return [
			{
				id: section.id,
				title: section.title,
				concerns,
			},
		];
	});
}

function sectionQuestionGroups(sections: SectionState[]): SectionQuestionGroup[] {
	return sections.flatMap((section) => {
		if (section.kind !== "review_section") return [];
		const questions = sectionQuestions(section);
		if (questions.length === 0) return [];
		return [
			{
				id: section.id,
				title: section.title,
				questions,
			},
		];
	});
}
