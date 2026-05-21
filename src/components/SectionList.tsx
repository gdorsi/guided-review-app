import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import { LoaderCircle } from "lucide-react";
import { stripMarkdownForSummary } from "@/lib/markdownContent";

export function SectionList() {
	const sections = useApp((s) => s.sections);
	const currentId = useApp((s) => s.currentSectionId);
	const processingIds = useApp((s) => s.processingSectionIds);
	const setCurrent = useApp((s) => s.setCurrentSection);

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
						return (
							<li key={s.id}>
								<button
									type="button"
									onClick={() => setCurrent(s.id, "section_list_click")}
									className={cn(
										"flex w-full items-start gap-2.5 border-b border-border/40 px-4 py-2.5 text-left transition-colors",
										"hover:bg-accent/50",
										s.id === currentId && "bg-accent",
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
										<div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
											{stripMarkdownForSummary(s.intent)}
										</div>
										{isProcessing && (
											<div className="mt-1.5 flex items-center gap-1.5 text-xs font-medium text-primary">
												<LoaderCircle className="size-3 animate-spin" />
												<span>Agent is processing this section…</span>
											</div>
										)}
									</div>
								</button>
							</li>
						);
					})}
				</ul>
			)}
		</aside>
	);
}
