import type { CommentDraft, Concern } from "./types/section";

/** Stable, order-independent hash of a string (djb2-xor variant), base36. */
export function hashText(text: string): string {
	let hash = 5381;
	for (let i = 0; i < text.length; i += 1) {
		hash = (hash * 33 + text.charCodeAt(i)) >>> 0;
	}
	return hash.toString(36);
}

/** Deterministic draft id for a concern within a section. */
export function concernDraftId(sectionId: string, concern: Concern): string {
	const file = concern.file_path ?? "";
	const line = concern.line ?? "";
	return `concern:${sectionId}:${file}:${line}:${hashText(concern.text)}`;
}

/** Build a comment draft from a concern: inline when it has a file+line, else top-level. */
export function concernToDraft(concern: Concern): CommentDraft {
	const body = `[${concern.severity}] ${concern.text}`;
	if (concern.file_path && concern.line) {
		return {
			kind: "inline",
			body,
			file_path: concern.file_path,
			line: concern.line,
			side: "RIGHT",
		};
	}
	return { kind: "top_level", body };
}
