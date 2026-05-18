import { useEffect, useState } from "react";
import { useApp, type CommentDraftState } from "@/lib/store";
import { approveCommentDraft } from "@/lib/commentPublish";
import { stripMarkdownForSummary } from "@/lib/markdownContent";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { ChevronDown, ChevronRight, Pencil, X } from "lucide-react";

export function CommentDraftCard({ state }: { state: CommentDraftState }) {
	const updateCommentDraft = useApp((s) => s.updateCommentDraft);
	const editCommentDraftBody = useApp((s) => s.editCommentDraftBody);
	const dismissCommentDraft = useApp((s) => s.dismissCommentDraft);
	const [expanded, setExpanded] = useState(state.status === "error");
	const [editing, setEditing] = useState(false);
	const [editBody, setEditBody] = useState(state.draft.body);
	const canEdit = state.status === "pending" || state.status === "approved";
	const editedBodyIsEmpty = editBody.trim().length === 0;
	const headerTitle =
		state.draft.title?.trim() || deriveFallbackTitle(state.draft.body);

	useEffect(() => {
		if (state.status === "error") setExpanded(true);
	}, [state.status]);

	function approve() {
		approveCommentDraft({
			draft_id: state.id,
			updateCommentDraft,
		});
	}

	function startEditing() {
		setEditBody(state.draft.body);
		setEditing(true);
		setExpanded(true);
	}

	function cancelEditing() {
		setEditBody(state.draft.body);
		setEditing(false);
	}

	function saveEdit() {
		if (editedBodyIsEmpty) return;
		editCommentDraftBody(state.id, editBody);
		setEditing(false);
	}

	return (
		<Card className="bg-primary/5 border-primary/30 px-2 py-1.5">
			<button
				type="button"
				onClick={() => setExpanded((v) => !v)}
				aria-expanded={expanded}
				className="flex w-full items-center gap-2 text-left"
			>
				{expanded ? (
					<ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
				) : (
					<ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
				)}
				<span className="text-[10px] uppercase tracking-wider text-primary shrink-0">
					{state.draft.kind === "inline" ? "Inline" : "Top-level"}
				</span>
				<span className="min-w-0 flex-1 truncate text-sm font-medium">
					{headerTitle}
				</span>
				<span className="text-[10px] uppercase tracking-wider text-muted-foreground shrink-0">
					{state.status}
				</span>
			</button>
			{expanded && (
				<div className="mt-2 space-y-1.5">
					<div className="flex items-center justify-end gap-1.5">
						{canEdit && !editing && (
							<Button
								type="button"
								size="icon"
								variant="ghost"
								className="size-6 text-muted-foreground hover:text-foreground"
								onClick={startEditing}
								aria-label="Edit comment draft"
								title="Edit comment draft"
							>
								<Pencil className="size-3.5" />
							</Button>
						)}
						{!editing &&
							state.status !== "approved" &&
							state.status !== "publishing" && (
								<Button
									type="button"
									size="icon"
									variant="ghost"
									className="size-6 text-muted-foreground hover:text-foreground"
									onClick={() => dismissCommentDraft(state.id)}
									aria-label="Dismiss comment draft"
								>
									<X className="size-3.5" />
								</Button>
							)}
					</div>
					{state.draft.kind === "inline" && (
						<div className="font-mono text-[11px] text-muted-foreground">
							{state.draft.file_path}:{state.draft.line}
							{state.draft.side ? ` (${state.draft.side})` : ""}
						</div>
					)}
					{editing && canEdit ? (
						<div className="space-y-2">
							<Textarea
								value={editBody}
								onChange={(event) => setEditBody(event.target.value)}
								aria-label="Comment body"
								className="min-h-24"
							/>
							<div className="flex gap-2">
								<Button
									size="sm"
									onClick={saveEdit}
									disabled={editedBodyIsEmpty}
								>
									Save
								</Button>
								<Button
									size="sm"
									variant="outline"
									onClick={cancelEditing}
								>
									Cancel
								</Button>
							</div>
						</div>
					) : (
						<div className="whitespace-pre-wrap text-sm">
							{state.draft.body}
						</div>
					)}
					{state.url && (
						<a
							className="inline-block text-xs text-[oklch(0.7_0.16_155)]"
							href={state.url}
							target="_blank"
							rel="noreferrer"
						>
							View on GitHub
						</a>
					)}
					{state.error && (
						<div className="text-xs text-destructive">{state.error}</div>
					)}
					{state.status === "pending" && !editing && (
						<div className="flex gap-2 pt-1">
							<Button
								size="sm"
								onClick={approve}
							>
								Approve
							</Button>
							<Button
								size="sm"
								variant="outline"
								onClick={() => dismissCommentDraft(state.id)}
							>
								Discard
							</Button>
						</div>
					)}
					{state.status === "approved" && !editing && (
						<div className="text-xs text-muted-foreground">
							Approved locally. It will be published when you submit the batch.
						</div>
					)}
				</div>
			)}
		</Card>
	);
}

function deriveFallbackTitle(body: string): string {
	const plain = stripMarkdownForSummary(body);
	if (!plain) return "(empty comment)";
	const words = plain.split(/\s+/).filter(Boolean);
	if (words.length === 0) return "(empty comment)";
	const head = words.slice(0, 5).join(" ");
	return words.length > 5 ? `${head}…` : head;
}
