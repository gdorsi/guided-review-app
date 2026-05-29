export interface PeekLine {
	number: number;
	text: string;
	isTarget: boolean;
}

/**
 * Returns the 1-based target line plus one neighbor on each side, clamped to
 * the file's bounds. Empty when the content is empty or the line is < 1.
 */
export function selectPeekLines(content: string, line: number): PeekLine[] {
	if (!content || line < 1) return [];
	const lines = content.split("\n");
	const total = lines.length;
	const target = Math.min(line, total);
	const start = target <= 1 ? 1 : target - 1;
	const end = Math.min(target + 1, total);
	const out: PeekLine[] = [];
	for (let n = start; n <= end; n += 1) {
		out.push({ number: n, text: lines[n - 1], isTarget: n === target });
	}
	return out;
}
