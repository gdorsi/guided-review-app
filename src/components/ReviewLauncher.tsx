import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Clock3, History, Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useApp } from "@/lib/store";
import {
	acp,
	type AgentInfo,
	type AgentKind,
	type ReasoningEffort,
	type SavedReviewSummary,
	type SessionSource,
	type StartSessionResponse,
} from "@/lib/acp";
import {
	loadSelectedAgentKind,
	loadSelectedAgentReasoningEffort,
	saveSelectedAgentKind,
	saveSelectedAgentReasoningEffort,
} from "@/lib/agentPreference";
import { localReviewSourceFromInput } from "@/lib/projectSource";
import {
	recordClientTelemetry,
	recordClientTelemetryError,
} from "@/lib/telemetry";
import { formatPublishedCommentsForPrompt } from "@/lib/publishedComments";
import {
	historySourceFromSavedReview,
	reviewTargetFromSource,
	sessionInfoFromSavedReview,
} from "@/lib/reviewPersistence";

const DEFAULT_AGENT_KIND: AgentKind = "claude_code";

function historyLabel(review: SavedReviewSummary): string {
	const title = review.pr_title?.trim();
	return title ? `#${review.number} ${title}` : `PR #${review.number}`;
}

function formatHistoryTime(timestamp: number): string {
	if (!Number.isFinite(timestamp) || timestamp <= 0) return "unknown";
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	}).format(new Date(timestamp * 1000));
}

export function ReviewLauncher() {
	const project = useApp((s) => s.project);
	const session = useApp((s) => s.session);
	const setSession = useApp((s) => s.setSession);
	const restoreSavedReview = useApp((s) => s.restoreSavedReview);
	const reset = useApp((s) => s.reset);
	const addUserMessage = useApp((s) => s.addUserMessage);
	const pushError = useApp((s) => s.pushError);

	const [input, setInput] = useState("");
	const [agents, setAgents] = useState<AgentInfo[]>([]);
	const [agentKind, setAgentKind] = useState<AgentKind>(
		() => loadSelectedAgentKind() ?? DEFAULT_AGENT_KIND,
	);
	const [selectedReasoningEffort, setSelectedReasoningEffort] =
		useState<ReasoningEffort | null>(() =>
			loadSelectedAgentReasoningEffort(
				loadSelectedAgentKind() ?? DEFAULT_AGENT_KIND,
			),
		);
	const [starting, setStarting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [historyOpen, setHistoryOpen] = useState(false);
	const [history, setHistory] = useState<SavedReviewSummary[]>([]);
	const [historyLoading, setHistoryLoading] = useState(false);
	const [historyError, setHistoryError] = useState<string | null>(null);

	useEffect(() => {
		(async () => {
			try {
				const list = await acp.listAgents();
				setAgents(list);
				setAgentKind((current) => {
					const selectedAgentExists = list.some(
						(agent) => agent.kind === current,
					);
					if (selectedAgentExists) return current;
					saveSelectedAgentKind(DEFAULT_AGENT_KIND);
					return DEFAULT_AGENT_KIND;
				});
			} catch (e) {
				recordClientTelemetryError("client.launcher.agents_load.failed", e);
			}
		})();
	}, []);

	const loadHistory = useCallback(async () => {
		if (!project) {
			setHistory([]);
			setHistoryError(null);
			return;
		}
		setHistoryLoading(true);
		setHistoryError(null);
		recordClientTelemetry("client.launcher.history.load_requested", {
			"repo.url": project.origin.repo_url,
		});
		try {
			const reviews = await acp.listSavedReviewsForRepo(project.origin.repo_url);
			setHistory(reviews);
			recordClientTelemetry("client.launcher.history.load_succeeded", {
				"repo.url": project.origin.repo_url,
				"history.count": reviews.length,
			});
		} catch (e) {
			const message = String(e);
			setHistoryError(message);
			recordClientTelemetryError("client.launcher.history.load_failed", e, {
				"repo.url": project.origin.repo_url,
			});
		} finally {
			setHistoryLoading(false);
		}
	}, [project]);

	useEffect(() => {
		void loadHistory();
	}, [loadHistory]);

	const sourceResult = useMemo(
		() => localReviewSourceFromInput({ input, project }),
		[input, project],
	);

	const validationError =
		!project
			? null
			: "error" in sourceResult && input.trim()
				? sourceResult.error
				: null;
	const canStart = !starting && !!project && "source" in sourceResult;
	const selectedAgent = agents.find((agent) => agent.kind === agentKind);
	const showReasoningEffort = selectedAgent?.supports_reasoning_effort ?? false;

	async function sendFreshKickoff(res: StartSessionResponse) {
		const skill = await acp.agentSkill();
		const publishedCommentContext = formatPublishedCommentsForPrompt(
			res.published_comments,
			res.published_comments_error,
		);
		const prDescriptionInstruction =
			res.pull_request || res.pull_request_error
				? ""
				: "\n\nThis review has no GitHub PR description. Before emitting the section map, emit one ```acp-pr-description``` fenced block whose body is a concise Markdown summary of the branch (read the commit log between base and head, then summarize the intent and the scope of changes in 1-3 short paragraphs). Do not include code excerpts.";
		const kickoff = `${skill}\n\n---\n\nThe repository for this review is at \`${res.repo.path}\` (base \`${res.repo.base_ref}\`, head \`${res.repo.head_ref}\`).\n\n${publishedCommentContext}${prDescriptionInstruction}\n\nInvestigate the diff with your built-in tools, then reply with one \`\`\`acp-section-map\`\`\` fenced block describing the planned sections. After that, stop and wait for me.`;
		addUserMessage("(starting guided review)");
		await acp.sendMessage(res.session_id, kickoff, {
			origin: "review_launcher_kickoff",
			reason: "request_section_map",
			suppressPreview: true,
		});
		recordClientTelemetry("client.launcher.start.kickoff_sent", {
			"acp.session_id": res.session_id,
			"kickoff.pr_description_requested":
				!res.pull_request && !res.pull_request_error,
		});
	}

	async function startFreshReview(res: StartSessionResponse, clearSaved: boolean) {
		if (clearSaved) {
			const target = reviewTargetFromSource(res.source);
			if (target) await acp.deleteSavedReview(target);
		}
		reset();
		setSession(res);
		setInput("");
		await sendFreshKickoff(res);
		void loadHistory();
	}

	async function resumeSavedReview(res: StartSessionResponse) {
		const savedReview = res.saved_review;
		if (!savedReview) {
			await startFreshReview(res, false);
			return;
		}
		const restoredSession = sessionInfoFromSavedReview({
			session_id: res.session_id,
			repo: res.repo,
			source: res.source,
			pull_request: res.pull_request,
			pull_request_error: res.pull_request_error,
			savedReview,
		});
		reset();
		restoreSavedReview(restoredSession, savedReview.snapshot);
		setInput("");
		recordClientTelemetry("client.launcher.saved_review.restored", {
			"acp.session_id": res.session_id,
			"saved_review.stale": savedReview.is_stale,
			"review.saved_head_sha": savedReview.head_sha,
			"repo.head_sha": res.repo.head_sha,
		});
	}

	async function start(source: SessionSource, mode: "fresh" | "resume") {
		setError(null);
		setStarting(true);
		recordClientTelemetry("client.launcher.start.requested", {
			"agent.kind": agentKind,
			"agent.reasoning_effort": selectedReasoningEffort,
			"session.source.kind": source.kind,
			"review.start_mode": mode,
		});
		try {
			const res = await acp.startSession({
				source,
				agent_kind: agentKind,
				reasoning_effort: selectedReasoningEffort ?? undefined,
			});
			recordClientTelemetry("client.launcher.start.session_received", {
				"agent.kind": agentKind,
				"agent.reasoning_effort": selectedReasoningEffort,
				"session.source.kind": source.kind,
				"review.start_mode": mode,
				"acp.session_id": res.session_id,
				"repo.display_slug": res.repo.display_slug,
			});
			if (mode === "resume") {
				await resumeSavedReview(res);
				return;
			}
			await startFreshReview(res, true);
		} catch (e) {
			recordClientTelemetryError("client.launcher.start.failed", e, {
				"agent.kind": agentKind,
				"agent.reasoning_effort": selectedReasoningEffort,
				"session.source.kind": source.kind,
				"review.start_mode": mode,
			});
			const message = String(e);
			setError(message);
			pushError(message);
		} finally {
			setStarting(false);
		}
	}

	async function resumeHistoryReview(review: SavedReviewSummary) {
		if (!project) return;
		setHistoryOpen(false);
		const source = historySourceFromSavedReview({
			savedReview: review,
			projectPath: project.path,
		});
		await start(source, "resume");
	}

	async function onSubmit(e: FormEvent) {
		e.preventDefault();
		const result = localReviewSourceFromInput({ input, project });
		if ("error" in result) {
			setError(result.error);
			return;
		}
		await start(result.source, "fresh");
	}

	if (!project) return null;

	return (
		<div className="flex min-w-0 flex-1 items-center gap-2">
			<DropdownMenu.Root
				open={historyOpen}
				onOpenChange={(open) => {
					setHistoryOpen(open);
					if (open) void loadHistory();
				}}
			>
				<DropdownMenu.Trigger asChild>
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="h-7 px-2"
						disabled={starting}
						title="PR history"
					>
						{historyLoading ? (
							<Loader2 className="size-3.5 animate-spin" />
						) : (
							<History className="size-3.5" />
						)}
						History
					</Button>
				</DropdownMenu.Trigger>
				<DropdownMenu.Portal>
					<DropdownMenu.Content
						align="start"
						sideOffset={6}
						className="z-50 w-[420px] rounded-md border border-border bg-popover p-1 shadow-2xl"
					>
						<div className="flex items-center justify-between border-b border-border px-2 py-1.5">
							<div className="text-xs font-medium">PR history</div>
							<div className="text-[11px] text-muted-foreground">
								{historyLoading ? "loading..." : `${history.length} saved`}
							</div>
						</div>
						{historyError && (
							<div className="m-2 rounded-md bg-destructive/15 px-2 py-1.5 text-xs text-destructive">
								{historyError}
							</div>
						)}
						{!historyError && historyLoading && history.length === 0 && (
							<div className="px-2 py-3 text-xs text-muted-foreground">
								Loading saved reviews...
							</div>
						)}
						{!historyError && !historyLoading && history.length === 0 && (
							<div className="px-2 py-3 text-xs text-muted-foreground">
								No saved PR reviews for this repo.
							</div>
						)}
						{history.map((review) => (
							<DropdownMenu.Item
								key={review.id}
								className="flex cursor-default items-start gap-2 rounded-sm px-2 py-2 text-xs outline-hidden hover:bg-accent focus:bg-accent"
								disabled={starting}
								onSelect={(event) => {
									event.preventDefault();
									void resumeHistoryReview(review);
								}}
							>
								<Clock3 className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
								<div className="min-w-0 flex-1">
									<div className="flex min-w-0 items-center gap-2">
										<div className="truncate font-medium">
											{historyLabel(review)}
										</div>
									</div>
									<div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
										<span className="shrink-0">
											Updated {formatHistoryTime(review.updated_at)}
										</span>
										<span className="truncate font-mono">
											{review.head_ref} {"->"} {review.base_ref}
										</span>
									</div>
								</div>
							</DropdownMenu.Item>
						))}
					</DropdownMenu.Content>
				</DropdownMenu.Portal>
			</DropdownMenu.Root>
			<form onSubmit={onSubmit} className="flex min-w-0 flex-1 items-center gap-2">
				<Input
					value={input}
					onChange={(e) => {
						setInput(e.target.value);
						setError(null);
					}}
					placeholder={
						session
							? "Switch to PR #, URL, branch, or SHA..."
							: "PR #, PR URL, branch, or SHA..."
					}
					disabled={starting}
					className="h-7 max-w-md flex-1 text-xs"
				/>
				{agents.length > 1 && (
					<select
						value={agentKind}
						onChange={(e) => {
							const next = e.target.value as AgentKind;
							setAgentKind(next);
							saveSelectedAgentKind(next);
							setSelectedReasoningEffort(
								loadSelectedAgentReasoningEffort(next),
							);
						}}
						className="h-7 rounded-md border border-border bg-input px-1.5 text-xs text-foreground"
						disabled={starting}
						title="Agent"
					>
						{agents.map((agent) => (
							<option key={agent.kind} value={agent.kind}>
								{agent.label}
							</option>
						))}
					</select>
				)}
				{showReasoningEffort && (
					<select
						value={selectedReasoningEffort ?? ""}
						onChange={(e) => {
							const next = e.target.value
								? (e.target.value as ReasoningEffort)
								: null;
							setSelectedReasoningEffort(next);
							saveSelectedAgentReasoningEffort(agentKind, next);
						}}
						className="h-7 rounded-md border border-border bg-input px-1.5 text-xs text-foreground"
						disabled={starting}
						title="Effort"
					>
						<option value="">Default</option>
						{selectedAgent?.reasoning_effort_options.map((effort) => (
							<option key={effort} value={effort}>
								{effort}
							</option>
						))}
					</select>
				)}
				<Button
					type="submit"
					size="sm"
					disabled={!canStart}
					className="h-7"
				>
					{starting ? (
						<Loader2 className="size-3.5 animate-spin" />
					) : (
						<Play className="size-3.5" />
					)}
					{session ? "Switch" : "Start"}
				</Button>
			</form>
			{(error || validationError) && (
				<span className="truncate text-xs text-destructive" title={error ?? validationError ?? undefined}>
					{error ?? validationError}
				</span>
			)}
		</div>
	);
}
