import type { ReviewSectionState, SectionState, SessionInfo } from "./store";

export function isPrBackedSession(session: SessionInfo | null): boolean {
	return session?.source.kind === "pr" || session?.source.kind === "local_pr";
}

function sectionChangedFiles(
	section: ReviewSectionState,
	changedFiles: Set<string>,
): string[] {
	return (section.section?.files ?? []).filter((file) => changedFiles.has(file));
}

export function changedFilesForSection(
	section: ReviewSectionState,
	changedFiles: Iterable<string>,
): string[] {
	return sectionChangedFiles(section, new Set(changedFiles));
}

export function findSectionsAffectedByChangedFiles(
	sections: SectionState[],
	changedFiles: Iterable<string>,
): ReviewSectionState[] {
	const changedFileSet = new Set(changedFiles);
	if (changedFileSet.size === 0) return [];
	return sections.filter(
		(section): section is ReviewSectionState =>
			section.kind === "review_section" &&
			sectionChangedFiles(section, changedFileSet).length > 0,
	);
}

export function buildUpstreamChangeHint(changedFiles: Iterable<string>): string {
	const files = Array.from(new Set(changedFiles)).sort();
	const fileList =
		files.length === 0
			? "- No files were reported by the host."
			: files.map((file) => `- ${file}`).join("\n");
	return [
		"This section is being reprocessed because the PR changed upstream.",
		"Focus on the current diff for these changed files before deciding whether the previous feedback still applies:",
		fileList,
	].join("\n");
}
