import type {
	Concern,
	LineRange,
	RangeKind,
	ReviewSection,
	SectionProgressPhase,
	SectionProgressUpdate,
	SectionMap,
	SectionMapEntry,
	Severity,
} from "./types/section";

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: null;
}

function asString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
	return typeof value === "number" ? value : null;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

const severities: Severity[] = ["high", "medium", "low"];
const rangeKinds: RangeKind[] = [
	"context",
	"changed-old",
	"changed-new",
	"added",
	"removed",
];
const sectionProgressPhases: SectionProgressPhase[] = [
	"started",
	"ranges",
	"feedback",
];

function parseSeverity(value: unknown): Severity | null {
	return severities.includes(value as Severity) ? (value as Severity) : null;
}

function parseRangeKind(value: unknown): RangeKind | null {
	return rangeKinds.includes(value as RangeKind) ? (value as RangeKind) : null;
}

function parseSectionProgressPhase(value: unknown): SectionProgressPhase | null {
	return sectionProgressPhases.includes(value as SectionProgressPhase)
		? (value as SectionProgressPhase)
		: null;
}

function parseSectionMapEntry(value: unknown): SectionMapEntry | null {
	const record = asRecord(value);
	if (!record) return null;
	const section_id = asString(record.section_id);
	const title = asString(record.title);
	const intent = asString(record.intent);
	if (!section_id || !title || !intent) return null;
	const entry: SectionMapEntry = { section_id, title, intent };
	if (Array.isArray(record.files)) entry.files = asStringArray(record.files);
	return entry;
}

function parseLineRange(value: unknown): LineRange | null {
	const record = asRecord(value);
	if (!record) return null;
	const file_path = asString(record.file_path);
	const start_line = asNumber(record.start_line);
	const end_line = asNumber(record.end_line);
	const kind = parseRangeKind(record.kind);
	if (!file_path || start_line === null || end_line === null || !kind) {
		return null;
	}
	return { file_path, start_line, end_line, kind };
}

function parseConcern(value: unknown): Concern | null {
	const record = asRecord(value);
	if (!record) return null;
	const text = asString(record.text);
	const severity = parseSeverity(record.severity);
	if (!text || !severity) return null;
	return {
		text,
		severity,
		file_path: asString(record.file_path) ?? undefined,
		line: asNumber(record.line) ?? undefined,
	};
}

function parseArray<T>(
	value: unknown,
	parse: (entry: unknown) => T | null,
): T[] {
	return Array.isArray(value)
		? value.map(parse).filter((entry): entry is T => entry !== null)
		: [];
}

function parseOptionalArray<T>(
	value: unknown,
	parse: (entry: unknown) => T | null,
): T[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return parseArray(value, parse);
}

export function parseSectionMapPayload(raw: unknown): SectionMap | null {
	const record = asRecord(raw);
	if (!record || !Array.isArray(record.sections)) return null;
	const sections = parseArray(record.sections, parseSectionMapEntry);
	if (sections.length !== record.sections.length) return null;
	return {
		schema_version: 1,
		sections,
	};
}

export function parseReviewSectionPayload(
	raw: unknown,
): ReviewSection | null {
	const record = asRecord(raw);
	if (!record) return null;
	const section_id = asString(record.section_id);
	if (!section_id) return null;
	const title = asString(record.title) ?? "";
	const intent = asString(record.intent) ?? "";
	return {
		schema_version: 1,
		section_id,
		title,
		intent,
		files: asStringArray(record.files),
		ranges: parseArray(record.ranges, parseLineRange),
		concerns: parseArray(record.concerns, parseConcern),
		base_ref: asString(record.base_ref) ?? "",
		head_ref: asString(record.head_ref) ?? "",
		pause_prompt: asString(record.pause_prompt) ?? "",
	};
}

export function parseSectionProgressPayload(
	raw: unknown,
): SectionProgressUpdate | null {
	const record = asRecord(raw);
	if (!record) return null;
	const section_id = asString(record.section_id);
	const phase = parseSectionProgressPhase(record.phase);
	if (!section_id || !phase) return null;
	const update: SectionProgressUpdate = {
		section_id,
		phase,
	};
	const title = asString(record.title);
	const intent = asString(record.intent);
	const ranges = parseOptionalArray(record.ranges, parseLineRange);
	const concerns = parseOptionalArray(record.concerns, parseConcern);
	const base_ref = asString(record.base_ref);
	const head_ref = asString(record.head_ref);
	if (title) update.title = title;
	if (intent) update.intent = intent;
	if (Array.isArray(record.files)) update.files = asStringArray(record.files);
	if (ranges) update.ranges = ranges;
	if (concerns) update.concerns = concerns;
	if (base_ref) update.base_ref = base_ref;
	if (head_ref) update.head_ref = head_ref;
	return update;
}

export function parseDisplayMessagePayload(
	raw: unknown,
): { markdown: string } | null {
	const record = asRecord(raw);
	if (!record) return null;
	const markdown = asString(record.markdown) ?? asString(record.message);
	if (!markdown || markdown.trim().length === 0) return null;
	return { markdown };
}
