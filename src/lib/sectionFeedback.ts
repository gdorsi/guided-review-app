import type { DiffLineAnnotation } from "@pierre/diffs";
import type { Concern, ReviewSection, Severity } from "./types/section";
import type { GrillQuestion } from "./types/grill";

export type SectionFeedbackKind = "concern" | "grill_question";

export interface SectionFeedbackNote {
	kind: SectionFeedbackKind;
	label: "Concern" | "Question";
	text: string;
	severity?: Severity;
	file_path?: string;
	line?: number;
	question_id?: string;
	title?: string;
	pr_choice?: string;
	recommended_answer?: string;
	agrees_with_pr?: boolean;
}

export interface SectionFeedbackAnnotationMetadata {
	kind: "section_feedback";
	file_path: string;
	line: number;
	notes: SectionFeedbackNote[];
}

function visibleFileSet(visibleFiles: Iterable<string>): Set<string> {
	return visibleFiles instanceof Set ? visibleFiles : new Set(visibleFiles);
}

function concernNote(concern: Concern): SectionFeedbackNote | null {
	const text = concern.text.trim();
	if (!text) return null;
	const note: SectionFeedbackNote = {
		kind: "concern",
		label: "Concern",
		text,
		severity: concern.severity,
	};
	if (concern.file_path) note.file_path = concern.file_path;
	if (typeof concern.line === "number") note.line = concern.line;
	return note;
}

export function questionLocation(question: GrillQuestion): {
	file_path?: string;
	line?: number;
} {
	if (question.file_path && typeof question.line === "number") {
		return { file_path: question.file_path, line: question.line };
	}
	const range = question.ranges?.find(
		(entry) => entry.kind === "changed-new" || entry.kind === "added",
	) ?? question.ranges?.[0];
	return {
		file_path: question.file_path ?? range?.file_path ?? question.files?.[0],
		line: question.line ?? range?.start_line,
	};
}

function questionNote(question: GrillQuestion): SectionFeedbackNote | null {
	const text = question.question.trim();
	if (!text) return null;
	const location = questionLocation(question);
	const note: SectionFeedbackNote = {
		kind: "grill_question",
		label: "Question",
		question_id: question.question_id,
		title: question.title,
		text,
		pr_choice: question.pr_choice,
		recommended_answer: question.recommended_answer,
		file_path: location.file_path,
		line: location.line,
	};
	if (typeof question.agrees_with_pr === "boolean") {
		note.agrees_with_pr = question.agrees_with_pr;
	}
	return note;
}

function lineFeedbackNotes(section: ReviewSection): SectionFeedbackNote[] {
	return [
		...section.concerns.map((concern) => concernNote(concern)),
		...(section.grill_questions ?? []).map((question) =>
			questionNote(question),
		),
	]
		.filter((note): note is SectionFeedbackNote => note !== null);
}

function hasVisibleLine(
	note: SectionFeedbackNote,
	visibleFiles: Set<string>,
): note is SectionFeedbackNote & { file_path: string; line: number } {
	return (
		!!note.file_path &&
		typeof note.line === "number" &&
		note.line > 0 &&
		visibleFiles.has(note.file_path)
	);
}

export function sectionFeedbackToDiffAnnotations(
	section: ReviewSection,
	visibleFiles: Iterable<string>,
): DiffLineAnnotation<SectionFeedbackAnnotationMetadata>[] {
	const visible = visibleFileSet(visibleFiles);
	const groups = new Map<
		string,
		{ file_path: string; line: number; notes: SectionFeedbackNote[] }
	>();

	for (const note of lineFeedbackNotes(section)) {
		if (!hasVisibleLine(note, visible)) continue;
		const key = `${note.file_path}\0${note.line}`;
		const group =
			groups.get(key) ??
			{ file_path: note.file_path, line: note.line, notes: [] };
		group.notes.push(note);
		groups.set(key, group);
	}

	return Array.from(groups.values()).map((group) => ({
		lineNumber: group.line,
		side: "additions",
		metadata: {
			kind: "section_feedback",
			file_path: group.file_path,
			line: group.line,
			notes: group.notes,
		},
	}));
}

export function sectionFeedbackTopNotes(
	section: ReviewSection,
	visibleFiles: Iterable<string>,
): SectionFeedbackNote[] {
	const visible = visibleFileSet(visibleFiles);
	const notes: SectionFeedbackNote[] = [];

	for (const note of lineFeedbackNotes(section)) {
		if (hasVisibleLine(note, visible)) continue;
		notes.push(note);
	}

	return notes;
}
