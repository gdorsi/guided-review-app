import { useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, LoaderCircle } from "lucide-react";
import { useApp } from "@/lib/store";
import { acp } from "@/lib/acp";
import {
	prTargetFromSessionSource,
	requestAgentPublishReview,
	type ReviewSubmitEvent,
} from "@/lib/commentPublish";
import { cn } from "@/lib/utils";

type Mode = "comment" | "approve" | "review_md";

interface SubmitReviewButtonProps {
	compact?: boolean;
}

const MODES: { id: Mode; label: string; description: string; github: boolean }[] = [
	{
		id: "comment",
		label: "Submit comments to GitHub",
		description: "Posts the marked comments as a PR review. No approval.",
		github: true,
	},
	{
		id: "approve",
		label: "Approve and submit",
		description: "Approves the PR and posts the marked comments.",
		github: true,
	},
	{
		id: "review_md",
		label: "Write comments to REVIEW.md",
		description: "Generates a local file in the repo for an AI to read and fix.",
		github: false,
	},
];

export function SubmitReviewButton({ compact = false }: SubmitReviewButtonProps) {
	const session = useApp((s) => s.session);
	const drafts = useApp((s) => s.commentDrafts);
	const updateCommentDraft = useApp((s) => s.updateCommentDraft);
	const pushError = useApp((s) => s.pushError);

	const marked = drafts.filter((d) => d.marked);
	const target = prTargetFromSessionSource(session?.source);
	const githubAvailable = !!target;
	const [mode, setMode] = useState<Mode>("comment");
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState<string | null>(null);

	const effectiveMode: Mode = githubAvailable ? mode : "review_md";
	const selectedMode = MODES.find((m) => m.id === effectiveMode) ?? MODES[0];
	const submitLabel = selectedMode.label;
	const disabled = busy || marked.length === 0 || !session;

	async function run() {
		if (!session || disabled) return;
		setBusy(true);
		setDone(null);
		try {
			if (effectiveMode === "review_md") {
				const path = await acp.writeReviewMd({
					repo_path: session.repo.path,
					base_ref: session.repo.base_ref,
					head_ref: session.repo.head_ref,
					pr_title: session.pull_request?.title ?? null,
					comments: marked.map((d) => ({
						kind: d.draft.kind,
						title: d.draft.title,
						body: d.draft.body,
						file_path: d.draft.file_path,
						line: d.draft.line,
						side: d.draft.side,
					})),
				});
				setDone(`Wrote ${path}`);
			} else {
				if (!target) {
					pushError("No PR to submit to.");
					return;
				}
				const event: ReviewSubmitEvent =
					effectiveMode === "approve" ? "APPROVE" : "COMMENT";
				await requestAgentPublishReview({
					session_id: session.session_id,
					target,
					head_sha: session.repo.head_sha,
					event,
					comments: marked,
					updateCommentDraft,
					sendMessage: acp.sendMessage,
				});
				setDone(
					event === "APPROVE"
						? "Approval + comments sent to the agent."
						: "Comments sent to the agent.",
				);
			}
		} catch (e) {
			pushError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className={cn("space-y-2", compact && "space-y-1.5")}>
			<div
				className={cn(
					compact ? "flex w-full" : "inline-flex",
					"overflow-hidden rounded-md border border-[oklch(0.5_0.15_155)]",
				)}
			>
				<button
					type="button"
					onClick={run}
					disabled={disabled}
					className={cn(
						"inline-flex min-w-0 items-center gap-1.5 bg-[oklch(0.6_0.15_155)] font-semibold text-white transition-colors hover:bg-[oklch(0.55_0.15_155)] disabled:opacity-50",
						compact ? "flex-1" : "",
						compact ? "px-2.5 py-1.5 text-xs" : "px-4 py-2 text-sm",
					)}
				>
					{busy && (
						<LoaderCircle
							className={cn(
								"shrink-0 animate-spin",
								compact ? "size-3" : "size-3.5",
							)}
						/>
					)}
					<span className="truncate">{submitLabel}</span>
				</button>
				<DropdownMenu.Root>
					<DropdownMenu.Trigger asChild>
						<button
							type="button"
							disabled={busy}
							aria-label="Choose submit mode"
							className={cn(
								"flex shrink-0 items-center border-l border-[oklch(0.5_0.15_155)] bg-[oklch(0.6_0.15_155)] text-white transition-colors hover:bg-[oklch(0.55_0.15_155)] disabled:opacity-50",
								compact ? "px-1.5" : "px-2",
							)}
						>
							<ChevronDown className={compact ? "size-3.5" : "size-4"} />
						</button>
					</DropdownMenu.Trigger>
					<DropdownMenu.Portal>
						<DropdownMenu.Content
							align="start"
							sideOffset={6}
							className={cn(
								"z-50 rounded-lg border border-border bg-card p-1 shadow-xl",
								compact
									? "w-[320px] max-w-[calc(100vw-2rem)]"
									: "w-[360px]",
							)}
						>
							{MODES.map((m) => {
								const itemDisabled = m.github && !githubAvailable;
								const active = effectiveMode === m.id;
								return (
									<DropdownMenu.Item
										key={m.id}
										disabled={itemDisabled}
										onSelect={(event) => {
											event.preventDefault();
											if (!itemDisabled) setMode(m.id);
										}}
										className={cn(
											"flex cursor-pointer gap-2 rounded-md px-3 py-2 text-sm outline-none data-[highlighted]:bg-accent",
											itemDisabled && "cursor-not-allowed opacity-40",
										)}
									>
										<span className="mt-0.5 w-4 shrink-0">
											{active && <Check className="size-4 text-primary" />}
										</span>
										<span className="min-w-0">
											<span className="block font-medium">{m.label}</span>
											<span className="block text-xs text-muted-foreground">
												{m.description}
												{itemDisabled ? " (no PR for this session)" : ""}
											</span>
										</span>
									</DropdownMenu.Item>
								);
							})}
						</DropdownMenu.Content>
					</DropdownMenu.Portal>
				</DropdownMenu.Root>
			</div>
			{marked.length === 0 && (
				<p
					className={cn(
						"text-muted-foreground",
						compact ? "text-[11px]" : "text-xs",
					)}
				>
					Mark at least one comment to submit.
				</p>
			)}
			{done && (
				<p
					className={cn(
						"text-[oklch(0.75_0.15_155)]",
						compact ? "text-[11px]" : "text-xs",
					)}
				>
					{done}
				</p>
			)}
		</div>
	);
}
