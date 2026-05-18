import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useApp } from "@/lib/store";
import {
	acp,
	type AgentInfo,
	type AgentKind,
	type SessionSource,
	type StartSessionResponse,
} from "@/lib/acp";
import {
	loadSelectedAgentKind,
	saveSelectedAgentKind,
} from "@/lib/agentPreference";
import { localReviewSourceFromInput } from "@/lib/projectSource";
import {
	recordClientTelemetry,
	recordClientTelemetryError,
} from "@/lib/telemetry";
import { formatPublishedCommentsForPrompt } from "@/lib/publishedComments";
import {
	reviewTargetFromSource,
	sessionInfoFromSavedReview,
} from "@/lib/reviewPersistence";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

const DEFAULT_AGENT_KIND: AgentKind = "claude_code";

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
	const [starting, setStarting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pendingSavedStart, setPendingSavedStart] =
		useState<StartSessionResponse | null>(null);

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
	const canStart =
		!starting && !pendingSavedStart && !!project && "source" in sourceResult;

	async function sendFreshKickoff(res: StartSessionResponse) {
		const skill = await acp.agentSkill();
		const publishedCommentContext = formatPublishedCommentsForPrompt(
			res.published_comments,
			res.published_comments_error,
		);
		const isBranchReview =
			!res.pull_request &&
			(res.source.kind === "branch" ||
				res.source.kind === "local_branch" ||
				res.source.kind === "local" ||
				res.source.kind === "sha");
		const branchDescriptionInstruction = isBranchReview
			? `\n\nThis review has no GitHub PR description. Before emitting the section map, emit one \`\`\`acp-pr-description\`\`\` fenced block whose body is a concise Markdown summary of the branch (read the commit log between base and head, then summarize the intent and the scope of changes in 1–3 short paragraphs). Do not include code excerpts.`
			: "";
		const kickoff = `${skill}\n\n---\n\nThe repository for this review is at \`${res.repo.path}\` (base \`${res.repo.base_ref}\`, head \`${res.repo.head_ref}\`).\n\n${publishedCommentContext}${branchDescriptionInstruction}\n\nInvestigate the diff with your built-in tools, then reply with one \`\`\`acp-section-map\`\`\` fenced block describing the planned sections. After that, stop and wait for me.`;
		addUserMessage("(starting guided review)");
		await acp.sendMessage(res.session_id, kickoff, {
			origin: "review_launcher_kickoff",
			reason: "request_section_map",
			suppressPreview: true,
		});
		recordClientTelemetry("client.launcher.start.kickoff_sent", {
			"acp.session_id": res.session_id,
			"kickoff.branch_description_requested": isBranchReview,
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
		// With per-section chat sessions, each section spawns a fresh agent on the
		// user's first message and prepends its own context. The PR description
		// session sits idle until the user types — no agent kickoff needed.
		recordClientTelemetry("client.launcher.saved_review.restored", {
			"acp.session_id": res.session_id,
			"review.is_stale": savedReview.is_stale,
			"review.saved_head_sha": savedReview.head_sha,
			"repo.head_sha": res.repo.head_sha,
		});
	}

	async function start(source: SessionSource) {
		setError(null);
		setStarting(true);
		recordClientTelemetry("client.launcher.start.requested", {
			"agent.kind": agentKind,
			"session.source.kind": source.kind,
		});
		try {
			const res = await acp.startSession({ source, agent_kind: agentKind });
			recordClientTelemetry("client.launcher.start.session_received", {
				"agent.kind": agentKind,
				"session.source.kind": source.kind,
				"acp.session_id": res.session_id,
				"repo.display_slug": res.repo.display_slug,
			});
			if (res.saved_review) {
				setPendingSavedStart(res);
				return;
			}
			await startFreshReview(res, false);
		} catch (e) {
			recordClientTelemetryError("client.launcher.start.failed", e, {
				"agent.kind": agentKind,
				"session.source.kind": source.kind,
			});
			const message = String(e);
			setError(message);
			pushError(message);
		} finally {
			setStarting(false);
		}
	}

	async function chooseResumeSaved() {
		if (!pendingSavedStart) return;
		setStarting(true);
		try {
			const res = pendingSavedStart;
			setPendingSavedStart(null);
			await resumeSavedReview(res);
		} catch (e) {
			const message = String(e);
			setError(message);
			pushError(message);
		} finally {
			setStarting(false);
		}
	}

	async function chooseStartOver() {
		if (!pendingSavedStart) return;
		setStarting(true);
		try {
			const res = pendingSavedStart;
			setPendingSavedStart(null);
			await startFreshReview(res, true);
		} catch (e) {
			const message = String(e);
			setError(message);
			pushError(message);
		} finally {
			setStarting(false);
		}
	}

	async function onSubmit(e: FormEvent) {
		e.preventDefault();
		const result = localReviewSourceFromInput({ input, project });
		if ("error" in result) {
			setError(result.error);
			return;
		}
		await start(result.source);
	}

	if (!project) return null;

	return (
		<div className="flex min-w-0 flex-1 items-center gap-2">
			<Dialog open={!!pendingSavedStart}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Saved review found</DialogTitle>
						<DialogDescription>
							{pendingSavedStart?.saved_review?.is_stale
								? "This PR has saved review state, but the PR head changed. Resume the saved review or start over with the latest code."
								: "This PR has saved review state. Resume it or start over with a fresh analysis."}
						</DialogDescription>
					</DialogHeader>
					<div className="flex justify-end gap-2">
						<Button
							type="button"
							variant="outline"
							onClick={chooseStartOver}
							disabled={starting}
						>
							Start over
						</Button>
						<Button
							type="button"
							onClick={chooseResumeSaved}
							disabled={starting}
						>
							Resume saved review
						</Button>
					</div>
				</DialogContent>
			</Dialog>
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
