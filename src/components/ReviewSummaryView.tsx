import { useApp } from "@/lib/store";
import { CodePeek } from "./CodePeek";
import { SubmitReviewButton } from "./SubmitReviewButton";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";

export function ReviewSummaryView() {
	const drafts = useApp((s) => s.commentDrafts);
	const setCommentMarked = useApp((s) => s.setCommentMarked);
	const marked = drafts.filter((d) => d.marked);

	return (
		<section className="flex h-full min-h-0 min-w-0 flex-col overflow-y-auto">
			<header className="border-b border-border bg-card/40 px-6 py-4">
				<h2 className="text-base font-semibold">Review Summary</h2>
				<p className="mt-1 text-sm text-muted-foreground">
					{marked.length === 0
						? "No comments marked yet."
						: `${marked.length} comment${marked.length === 1 ? "" : "s"} marked for this review.`}
				</p>
			</header>
			<div className="flex flex-1 flex-col gap-4 p-6">
				{marked.length === 0 ? (
					<div className="rounded-md border border-border bg-card/40 px-4 py-6 text-center text-sm text-muted-foreground">
						Mark comments from the Comments list to include them in the review.
					</div>
				) : (
					marked.map((d) => (
						<div
							key={d.id}
							className="overflow-hidden rounded-lg border border-border bg-card"
						>
							<div className="flex items-center gap-2 border-b border-border bg-card/60 px-3 py-2">
								<span className="text-[10px] uppercase tracking-wider text-primary shrink-0">
									{d.draft.kind === "inline" ? "Inline" : "Top-level"}
								</span>
								<span className="min-w-0 flex-1 truncate text-sm font-medium">
									{d.draft.title?.trim() || d.draft.body.slice(0, 60)}
								</span>
								{d.draft.file_path && (
									<span className="font-mono text-[11px] text-muted-foreground shrink-0">
										{d.draft.file_path}:{d.draft.line}
									</span>
								)}
								{d.status === "published" ? (
									d.url ? (
										<a
											href={d.url}
											target="_blank"
											rel="noreferrer"
											className="text-[11px] text-[oklch(0.75_0.15_155)] shrink-0"
										>
											published ✓
										</a>
									) : (
										<span className="text-[11px] text-[oklch(0.75_0.15_155)] shrink-0">
											published ✓
										</span>
									)
								) : (
									<Button
										size="icon"
										variant="ghost"
										className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
										aria-label="Unmark comment"
										onClick={() => setCommentMarked(d.id, false)}
									>
										<X className="size-3.5" />
									</Button>
								)}
							</div>
							{d.draft.kind === "inline" && <CodePeek comment={d.draft} />}
							<div className="whitespace-pre-wrap px-3 py-2 text-sm">
								{d.draft.body}
							</div>
							{d.status === "publishing" && (
								<div className="px-3 pb-2 text-xs text-muted-foreground">
									Publishing…
								</div>
							)}
							{d.status === "error" && d.error && (
								<div className="px-3 pb-2 text-xs text-destructive">{d.error}</div>
							)}
						</div>
					))
				)}
			</div>
			<div className="border-t border-border bg-card/40 px-6 py-4">
				<SubmitReviewButton />
			</div>
		</section>
	);
}
