import type { ChatMessagePart, ToolCallItem } from "./types/section";
import { cleanVisibleStructuredText } from "./store";

export type ThinkingBlockPart =
	| { type: "text"; text: string }
	| { type: "tool_call"; toolCall: ToolCallItem };

export type AssistantBlock =
	| { type: "response"; markdown: string }
	| { type: "thinking"; parts: ThinkingBlockPart[] };

export function stripMarkdownForSummary(markdown: string): string {
	return markdown
		.replace(/```[a-zA-Z0-9_-]*\r?\n?/g, " ")
		.replace(/```/g, " ")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/^\s{0,3}#{1,6}\s+/gm, "")
		.replace(/^\s{0,3}>\s?/gm, "")
		.replace(/^\s*[-*+]\s+/gm, "")
		.replace(/^\s*\d+\.\s+/gm, "")
		.replace(/<[^>]*>/g, "")
		.replace(/[*_~]+/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

export function assistantPartsToBlocks(
	parts: ChatMessagePart[],
): AssistantBlock[] {
	const blocks: AssistantBlock[] = [];
	let responseBuffer = "";
	let thinkingParts: ThinkingBlockPart[] = [];

	const flushThinking = () => {
		if (thinkingParts.length === 0) return;
		blocks.push({ type: "thinking", parts: thinkingParts });
		thinkingParts = [];
	};

	const flushResponse = () => {
		if (!responseBuffer) return;
		const cleaned = cleanVisibleStructuredText(responseBuffer).trim();
		responseBuffer = "";
		if (!cleaned) return;
		blocks.push({ type: "response", markdown: cleaned });
	};

	for (const part of parts) {
		if (part.type === "thinking") {
			flushResponse();
			const cleaned = cleanVisibleStructuredText(part.text);
			if (cleaned.trim()) {
				thinkingParts.push({ type: "text", text: cleaned });
			}
			continue;
		}
		if (part.type === "tool_call") {
			flushResponse();
			thinkingParts.push({ type: "tool_call", toolCall: part.toolCall });
			continue;
		}
		flushThinking();
		responseBuffer +=
			part.type === "assistant_response" ? part.markdown : part.text;
	}
	flushThinking();
	flushResponse();

	return blocks;
}
