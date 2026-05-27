import type { AgentKind, ReasoningEffort } from "./acp";

export const SELECTED_AGENT_KIND_KEY = "gr.selectedAgentKind";
export const SELECTED_AGENT_REASONING_EFFORT_KEY_PREFIX =
	"gr.selectedAgentReasoningEffort.";

const VALID_AGENT_KINDS = ["claude_code", "codex"] as const satisfies readonly AgentKind[];
const VALID_REASONING_EFFORTS = [
	"low",
	"medium",
	"high",
	"xhigh",
] as const satisfies readonly ReasoningEffort[];

function isAgentKind(value: string): value is AgentKind {
	return VALID_AGENT_KINDS.includes(value as AgentKind);
}

function isReasoningEffort(value: string): value is ReasoningEffort {
	return VALID_REASONING_EFFORTS.includes(value as ReasoningEffort);
}

export function loadSelectedAgentKind(
	storage: Storage = localStorage,
): AgentKind | null {
	try {
		const value = storage.getItem(SELECTED_AGENT_KIND_KEY)?.trim() ?? "";
		return isAgentKind(value) ? value : null;
	} catch {
		return null;
	}
}

export function saveSelectedAgentKind(
	kind: AgentKind,
	storage: Storage = localStorage,
): void {
	try {
		storage.setItem(SELECTED_AGENT_KIND_KEY, kind);
	} catch {}
}

function reasoningEffortKey(kind: AgentKind): string {
	return `${SELECTED_AGENT_REASONING_EFFORT_KEY_PREFIX}${kind}`;
}

export function loadSelectedAgentReasoningEffort(
	kind: AgentKind,
	storage: Storage = localStorage,
): ReasoningEffort | null {
	try {
		const value = storage.getItem(reasoningEffortKey(kind))?.trim() ?? "";
		return isReasoningEffort(value) ? value : null;
	} catch {
		return null;
	}
}

export function saveSelectedAgentReasoningEffort(
	kind: AgentKind,
	effort: ReasoningEffort | null,
	storage: Storage = localStorage,
): void {
	try {
		if (effort) {
			storage.setItem(reasoningEffortKey(kind), effort);
		} else {
			storage.removeItem(reasoningEffortKey(kind));
		}
	} catch {}
}
