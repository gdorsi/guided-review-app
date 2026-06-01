import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ChatMessage } from "./types/section";
import type { LocalProject } from "./projectSource";
import type { AppState, ChatTab, CommentDraftState, SectionState } from "./store";

const storage = new Map<string, string>();

globalThis.localStorage = {
	getItem: (key: string) => storage.get(key) ?? null,
	setItem: (key: string, value: string) => {
		storage.set(key, value);
	},
	removeItem: (key: string) => {
		storage.delete(key);
	},
	clear: () => {
		storage.clear();
	},
	key: (index: number) => Array.from(storage.keys())[index] ?? null,
	get length() {
		return storage.size;
	},
} as Storage;

const repo = {
	path: "/Users/guidodorsi/dev/codex",
	head_ref: "guided-review-pr-123",
	head_sha: "abc123",
	base_ref: "origin/main",
	display_slug: "codex",
};

const prSession = {
	session_id: "session-123",
	repo,
	source: {
		kind: "local_pr" as const,
		path: "/Users/guidodorsi/dev/codex",
		repo_url: "https://github.com/openai/codex",
		number: 123,
	},
	pull_request: {
		title: "Improve guided review",
		body: "## Summary\n\nMake the review easier to follow.",
		url: "https://github.com/openai/codex/pull/123",
		base_ref_name: "main",
	},
};

const publishedComment = {
	id: 101,
	author_login: "mona",
	body: "This has already been reviewed.",
	html_url: "https://github.com/openai/codex/pull/123#discussion_r101",
	created_at: "2026-05-05T10:00:00Z",
	file_path: "src/main.ts",
	line: 12,
	side: "RIGHT" as const,
	is_outdated: false,
};

async function resetReviewState() {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);
	useApp.setState({
		session: null,
		sections: [],
		currentSectionId: null,
		processingSectionIds: [],
		chatTabs: [],
		activeChatTabId: null,
		chatByTab: {},
		sessionByChatTab: {},
		chatTabForSession: {},
		commentDrafts: [],
		publishedComments: [],
		publishedCommentsFetchedAt: null,
		publishedCommentsError: null,
		streaming: false,
		errors: [],
		stderr: [],
		structuredReviewBlockOpen: false,
		structuredReviewBlockPrefix: "",
		structuredReviewMarkdownFenceOpen: false,
		diffFocus: null,
		diffFocusError: null,
	});
}

const OVERVIEW_CHAT_TAB_ID = "overview";

function overviewChat(state: AppState) {
	return state.chatByTab[OVERVIEW_CHAT_TAB_ID] ?? [];
}

function clearChatState(useApp: { setState: (patch: object) => void }) {
	useApp.setState({
		currentSectionId: null,
		chatTabs: [
			{
				id: OVERVIEW_CHAT_TAB_ID,
				title: "Overview",
				createdAt: Date.now(),
			},
		],
		activeChatTabId: OVERVIEW_CHAT_TAB_ID,
		chatByTab: {},
		sessionByChatTab: {},
		chatTabForSession: {},
		streaming: false,
		structuredReviewBlockOpen: false,
		structuredReviewBlockPrefix: "",
		structuredReviewMarkdownFenceOpen: false,
	});
}

test("setSession creates and selects the PR description section when metadata is available", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);
	await resetReviewState();

	useApp.getState().setSession(prSession);

	const [section] = useApp.getState().sections;
	assert.equal(section?.kind, "pr_description");
	assert.equal(section?.id, "pr-description");
	assert.equal(section?.title, "Overview");
	assert.equal(section?.intent, "Improve guided review");
	assert.equal(section?.status, "in_review");
	assert.equal(
		section?.kind === "pr_description" ? section.body : "",
		"## Summary\n\nMake the review easier to follow.",
	);
	assert.equal(useApp.getState().currentSectionId, "pr-description");
});

test("setSession stores one-off published PR comment context", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);
	await resetReviewState();

	const before = Date.now();
	useApp.getState().setSession({
		...prSession,
		published_comments: [publishedComment],
		published_comments_error: "some comments could not be read",
	});
	const after = Date.now();

	assert.deepEqual(useApp.getState().publishedComments, [publishedComment]);
	assert.equal(
		useApp.getState().publishedCommentsError,
		"some comments could not be read",
	);
	const fetchedAt = useApp.getState().publishedCommentsFetchedAt;
	assert.equal(typeof fetchedAt, "number");
	assert(fetchedAt! >= before);
	assert(fetchedAt! <= after);
});

test("upsertSection stores grill questions alongside section feedback", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);
	await resetReviewState();

	useApp.getState().setSession(prSession);
	useApp.getState().upsertSection({
		schema_version: 1,
		section_id: "api",
		title: "API",
		intent: "Review API changes",
		files: ["src-tauri/src/fenced.rs"],
		ranges: [],
		base_ref: "",
		head_ref: "",
		concerns: [],
		grill_questions: [
			{
				question_id: "error-boundary-policy",
				title: "Error boundary policy",
				question: "Should malformed JSON fail closed?",
				pr_choice: "The PR keeps the review going.",
				recommended_answer: "Fail closed when state is ambiguous.",
				file_path: "src-tauri/src/fenced.rs",
				line: 120,
			},
		],
		pause_prompt: "",
	});

	const item = useApp.getState().sections[1];
	assert.equal(item?.kind, "review_section");
	assert.equal(
		item?.kind === "review_section"
			? item.section?.grill_questions[0]?.question_id
			: "",
		"error-boundary-policy",
	);
});

test("refreshSessionMetadata updates PR metadata without rebuilding review state", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);
	await resetReviewState();

	useApp.getState().setSession({
		...prSession,
		published_comments: [publishedComment],
	});
	useApp.getState().setSectionMap([
		{
			section_id: "api",
			title: "API",
			intent: "Review API changes",
			files: ["src/api.ts"],
		},
	]);
	useApp.getState().setCurrentSection("api", "test");
	useApp.getState().addUserMessage("question", OVERVIEW_CHAT_TAB_ID);

	const before = Date.now();
	useApp.getState().refreshSessionMetadata({
		repo: {
			...repo,
			head_sha: "def456",
			head_ref: "guided-review-pr-123",
		},
		pull_request: {
			title: "Updated PR",
			body: "Updated body",
			url: "https://github.com/openai/codex/pull/123",
			base_ref_name: "main",
		},
		pull_request_error: undefined,
		published_comments: [],
		published_comments_error: "comments unavailable",
	});
	const after = Date.now();

	const state = useApp.getState();
	assert.equal(state.session?.repo.head_sha, "def456");
	assert.equal(state.session?.pull_request?.title, "Updated PR");
	assert.equal(state.currentSectionId, "api");
	assert.deepEqual(
		state.sections.map((section: SectionState) => section.id),
		["pr-description", "api", "review-summary"],
	);
	assert.deepEqual(
			state.chatTabs.map((tab: ChatTab) => tab.id),
		[OVERVIEW_CHAT_TAB_ID],
	);
	assert.equal(state.activeChatTabId, OVERVIEW_CHAT_TAB_ID);
	assert.equal(overviewChat(state).length, 1);
	assert.deepEqual(state.publishedComments, []);
	assert.equal(state.publishedCommentsError, "comments unavailable");
	assert(state.publishedCommentsFetchedAt! >= before);
	assert(state.publishedCommentsFetchedAt! <= after);
});

test("setSession seeds only the Overview chat tab attached to the parent session", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);
	await resetReviewState();

	useApp.getState().setSession(prSession);

	const state = useApp.getState();
	assert.deepEqual(
			state.chatTabs.map((tab: ChatTab) => ({
			id: tab.id,
			title: tab.title,
			hasCreatedAt: typeof tab.createdAt === "number",
			hasSectionId: "sectionId" in tab,
		})),
		[
			{
				id: "overview",
				title: "Overview",
				hasCreatedAt: true,
				hasSectionId: false,
			},
		],
	);
	assert.equal(state.activeChatTabId, "overview");
	assert.deepEqual(state.chatByTab.overview, []);
	assert.equal(state.sessionByChatTab.overview, prSession.session_id);
	assert.equal(state.chatTabForSession[prSession.session_id], "overview");
});

test("setPrDescriptionBody updates the synthetic PR description section", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);
	await resetReviewState();

	useApp.getState().setSession(prSession);
	useApp.getState().setPrDescriptionBody("A concise branch summary.");

	const [section] = useApp.getState().sections;
	assert.equal(
		section?.kind === "pr_description" ? section.body : "",
		"A concise branch summary.",
	);
});

test("setSectionMap keeps PR description first and appends agent sections", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);
	await resetReviewState();

	useApp.getState().setSession(prSession);
	useApp.getState().setSectionMap([
		{
			section_id: "overview",
			title: "Overview",
			intent: "Understand the change",
		},
		{
			section_id: "tests",
			title: "Tests",
			intent: "Check coverage",
		},
	]);

	assert.deepEqual(
		useApp
			.getState()
			.sections.map((section: SectionState) => section.id),
		["pr-description", "overview", "tests", "review-summary"],
	);
	assert.equal(useApp.getState().sections[0]?.kind, "pr_description");
	assert.equal(useApp.getState().currentSectionId, "pr-description");
});

test("setSectionMap seeds preview section files and map-owned ranges", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);
	await resetReviewState();

	useApp.getState().setSession(prSession);
	useApp.getState().setSectionMap([
		{
			section_id: "validation-flow",
			title: "Validation flow",
			intent: "Checks before saving",
			files: ["src/lib/store.ts"],
			ranges: [
				{
					file_path: "src/lib/store.ts",
					start_line: 120,
					end_line: 180,
					kind: "changed-new",
				},
			],
		},
	]);

	const section = useApp.getState().sections[1];
	assert.equal(section?.kind, "review_section");
	assert.equal(section?.status, "pending");
	assert.deepEqual(
		section?.kind === "review_section" ? section.section?.files : [],
		["src/lib/store.ts"],
	);
	assert.deepEqual(
		section?.kind === "review_section" ? section.section?.ranges : [],
		[
			{
				file_path: "src/lib/store.ts",
				start_line: 120,
				end_line: 180,
				kind: "changed-new",
			},
		],
	);
	assert.equal(
		section?.kind === "review_section" ? section.section?.base_ref : "",
		repo.base_ref,
	);
	assert.equal(
		section?.kind === "review_section" ? section.section?.head_ref : "",
		repo.head_ref,
	);
	assert.deepEqual(
		section?.kind === "review_section" ? section.section?.concerns : [],
		[],
	);
});

test("auto-opening the first review section keeps PR description selected", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);
	await resetReviewState();

	useApp.getState().setSession(prSession);
	useApp.getState().setSectionMap([
		{
			section_id: "overview",
			title: "Overview",
			intent: "Understand the change",
		},
	]);
	useApp.getState().startSectionProcessing("overview");

	assert.equal(useApp.getState().currentSectionId, "pr-description");
	assert.deepEqual(useApp.getState().processingSectionIds, ["overview"]);
});

test("startSectionProcessing preserves a non-PR-description selection", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);
	await resetReviewState();

	useApp.getState().setSession(prSession);
	useApp.getState().setSectionMap([
		{
			section_id: "overview",
			title: "Overview",
			intent: "Understand the change",
		},
		{
			section_id: "tests",
			title: "Tests",
			intent: "Check coverage",
		},
	]);
	useApp.getState().setCurrentSection("tests", "user_click");

	useApp.getState().startSectionProcessing("overview");

	assert.equal(useApp.getState().currentSectionId, "tests");
	assert.deepEqual(useApp.getState().processingSectionIds, ["overview"]);
});

test("upsertSection keeps PR description selected while first real section loads", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);
	await resetReviewState();

	useApp.getState().setSession(prSession);
	useApp.getState().setSectionMap([
		{
			section_id: "overview",
			title: "Overview",
			intent: "Understand the change",
		},
	]);
	useApp.getState().startSectionProcessing("overview");
	useApp.getState().upsertSection({
		schema_version: 1,
		section_id: "overview",
		title: "Overview",
		intent: "Understand the change",
		files: [],
		ranges: [],
		concerns: [],
		base_ref: "base",
		head_ref: "head",
		pause_prompt: "",
	});

	assert.equal(useApp.getState().currentSectionId, "pr-description");
	assert.deepEqual(useApp.getState().processingSectionIds, []);
	assert.equal(useApp.getState().sections[1]?.kind, "review_section");
	assert.equal(useApp.getState().sections[1]?.status, "in_review");
	assert.equal(
		useApp.getState().sections[1]?.kind === "review_section"
			? useApp.getState().sections[1]?.feedbackLoaded
			: false,
		true,
	);
});

test("upsertSection preserves a non-PR-description selection when feedback arrives for another section", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);
	await resetReviewState();

	useApp.getState().setSession(prSession);
	useApp.getState().setSectionMap([
		{
			section_id: "overview",
			title: "Overview",
			intent: "Understand the change",
		},
		{
			section_id: "tests",
			title: "Tests",
			intent: "Check coverage",
		},
	]);
	useApp.getState().setCurrentSection("tests", "user_click");
	useApp.getState().startSectionProcessing("overview");

	useApp.getState().upsertSection({
		schema_version: 1,
		section_id: "overview",
		title: "Overview",
		intent: "Understand the change",
		files: [],
		ranges: [],
		concerns: [],
		base_ref: "base",
		head_ref: "head",
		pause_prompt: "",
	});

	assert.equal(useApp.getState().currentSectionId, "tests");
	assert.deepEqual(useApp.getState().processingSectionIds, []);
});

test("feedback-only section merges into map preview without replacing structure", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);
	const { parseReviewSectionPayload } = await import(
		new URL("./reviewSectionPayload.ts", import.meta.url).href
	);
	await resetReviewState();

	useApp.getState().setSession(prSession);
	useApp.getState().setSectionMap([
		{
			section_id: "validation-flow",
			title: "Validation flow",
			intent: "Checks before saving",
			files: ["src/lib/store.ts"],
			ranges: [
				{
					file_path: "src/lib/store.ts",
					start_line: 120,
					end_line: 180,
					kind: "changed-new",
				},
			],
		},
	]);
	useApp.getState().startSectionProcessing("validation-flow");

	const feedback = parseReviewSectionPayload({
		section_id: "validation-flow",
		concerns: [
			{
				text: "Empty input can still be submitted.",
				severity: "medium",
				file_path: "src/lib/store.ts",
				line: 148,
			},
		],
		pause_prompt: "Want to leave a comment?",
	});
	assert(feedback);

	useApp.getState().upsertSection(feedback);

	const section = useApp.getState().sections[1];
	assert.equal(section?.kind, "review_section");
	assert.equal(section?.status, "in_review");
	assert.deepEqual(useApp.getState().processingSectionIds, []);
	assert.deepEqual(
		section?.kind === "review_section" ? section.section?.files : [],
		["src/lib/store.ts"],
	);
	assert.deepEqual(
		section?.kind === "review_section" ? section.section?.ranges : [],
		[
			{
				file_path: "src/lib/store.ts",
				start_line: 120,
				end_line: 180,
				kind: "changed-new",
			},
		],
	);
	assert.equal(
		section?.kind === "review_section"
			? section.section?.concerns[0]?.text
			: "",
		"Empty input can still be submitted.",
	);
	assert.equal(
		section?.kind === "review_section" ? section.section?.pause_prompt : "",
		"Want to leave a comment?",
	);
});

test("legacy full section cannot overwrite map-owned files and ranges", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);
	await resetReviewState();

	useApp.getState().setSession(prSession);
	useApp.getState().setSectionMap([
		{
			section_id: "validation-flow",
			title: "Validation flow",
			intent: "Checks before saving",
			files: ["src/lib/store.ts"],
			ranges: [
				{
					file_path: "src/lib/store.ts",
					start_line: 120,
					end_line: 180,
					kind: "changed-new",
				},
			],
		},
	]);

	useApp.getState().upsertSection({
		schema_version: 1,
		section_id: "validation-flow",
		title: "Legacy title",
		intent: "Legacy intent",
		files: ["src/lib/other.ts"],
		ranges: [
			{
				file_path: "src/lib/other.ts",
				start_line: 1,
				end_line: 2,
				kind: "changed-new",
			},
		],
		concerns: [],
		base_ref: "wrong-base",
		head_ref: "wrong-head",
		pause_prompt: "",
	});

	const section = useApp.getState().sections[1];
	assert.equal(section?.kind, "review_section");
	assert.equal(section?.title, "Validation flow");
	assert.deepEqual(
		section?.kind === "review_section" ? section.section?.files : [],
		["src/lib/store.ts"],
	);
	assert.deepEqual(
		section?.kind === "review_section" ? section.section?.ranges : [],
		[
			{
				file_path: "src/lib/store.ts",
				start_line: 120,
				end_line: 180,
				kind: "changed-new",
			},
		],
	);
	assert.equal(
		section?.kind === "review_section" ? section.section?.base_ref : "",
		repo.base_ref,
	);
	assert.equal(
		section?.kind === "review_section" ? section.section?.head_ref : "",
		repo.head_ref,
	);
});

test("upsertSectionProgress merges progressive range and feedback updates", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);
	await resetReviewState();

	useApp.getState().setSession(prSession);
	useApp.getState().setSectionMap([
		{
			section_id: "validation-flow",
			title: "Validation flow",
			intent: "Checks before saving",
		},
	]);

	useApp.getState().upsertSectionProgress({
		section_id: "validation-flow",
		phase: "ranges",
		files: ["src/lib/store.ts"],
		ranges: [
			{
				file_path: "src/lib/store.ts",
				start_line: 120,
				end_line: 180,
				kind: "changed-new",
			},
		],
	});

	useApp.getState().upsertSectionProgress({
		section_id: "validation-flow",
		phase: "feedback",
		concerns: [
			{
				text: "Empty input can still be submitted.",
				severity: "medium",
				file_path: "src/lib/store.ts",
				line: 148,
			},
		],
	});

	const section = useApp.getState().sections[1];
	assert.equal(section?.kind, "review_section");
	assert.equal(section?.status, "in_review");
	assert.deepEqual(useApp.getState().processingSectionIds, ["validation-flow"]);
	assert.deepEqual(
		section?.kind === "review_section" ? section.section?.files : [],
		["src/lib/store.ts"],
	);
	assert.deepEqual(
		section?.kind === "review_section" ? section.section?.ranges : [],
		[
			{
				file_path: "src/lib/store.ts",
				start_line: 120,
				end_line: 180,
				kind: "changed-new",
			},
		],
	);
	assert.equal(
		section?.kind === "review_section"
			? section.section?.concerns[0]?.text
			: "",
		"Empty input can still be submitted.",
	);
	assert.equal(
		section?.kind === "review_section" ? section.section?.base_ref : "",
		repo.base_ref,
	);
	assert.equal(
		section?.kind === "review_section" ? section.section?.head_ref : "",
		repo.head_ref,
	);
	assert.equal(useApp.getState().currentSectionId, "pr-description");
});

test("upsertSectionProgress preserves a non-PR-description selection", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);
	await resetReviewState();

	useApp.getState().setSession(prSession);
	useApp.getState().setSectionMap([
		{
			section_id: "validation-flow",
			title: "Validation flow",
			intent: "Checks before saving",
		},
		{
			section_id: "tests",
			title: "Tests",
			intent: "Check coverage",
		},
	]);
	useApp.getState().setCurrentSection("tests", "user_click");

	useApp.getState().upsertSectionProgress({
		section_id: "validation-flow",
		phase: "ranges",
		files: ["src/lib/store.ts"],
		ranges: [
			{
				file_path: "src/lib/store.ts",
				start_line: 120,
				end_line: 180,
				kind: "changed-new",
			},
		],
	});

	assert.equal(useApp.getState().currentSectionId, "tests");
	assert.deepEqual(useApp.getState().processingSectionIds, ["validation-flow"]);
});

test("App-style flow surfaces a chat card for a feedback-only section using the merged title and files", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);
	const { parseReviewSectionPayload } = await import(
		new URL("./reviewSectionPayload.ts", import.meta.url).href
	);
	await resetReviewState();

	useApp.getState().setSession(prSession);
	useApp.getState().setSectionMap([
		{
			section_id: "validation-flow",
			title: "Validation flow",
			intent: "Checks before saving",
			files: ["src/lib/store.ts"],
			ranges: [
				{
					file_path: "src/lib/store.ts",
					start_line: 120,
					end_line: 180,
					kind: "changed-new",
				},
			],
		},
	]);

	const feedback = parseReviewSectionPayload({
		section_id: "validation-flow",
		concerns: [
			{
				text: "Empty input can still be submitted.",
				severity: "medium",
				file_path: "src/lib/store.ts",
				line: 148,
			},
		],
		pause_prompt: "Want to leave a comment?",
	});
	assert(feedback);

	// Mirrors App.tsx handleReviewSection: upsert the data, then append a chat
	// card built from the merged stored section so map-owned title/files survive
	// a feedback-only payload.
	useApp.getState().upsertSection(feedback);
	const merged = useApp
		.getState()
		.sections.find((s: SectionState) => s.id === "validation-flow");
	assert.equal(merged?.kind, "review_section");
	if (merged?.kind === "review_section" && merged.section) {
		useApp.getState().addReviewSectionItem(merged.section);
	}

	const chat = overviewChat(useApp.getState());
	const last = chat[chat.length - 1];
	assert.equal(last?.item?.type, "review_section");
	assert.equal(
		last?.item?.type === "review_section" ? last.item.section.title : "",
		"Validation flow",
	);
	assert.deepEqual(
		last?.item?.type === "review_section" ? last.item.section.files : [],
		["src/lib/store.ts"],
	);
	assert.deepEqual(
		last?.item?.type === "review_section" ? last.item.section.ranges : [],
		[
			{
				file_path: "src/lib/store.ts",
				start_line: 120,
				end_line: 180,
				kind: "changed-new",
			},
		],
	);
	assert.equal(
		last?.item?.type === "review_section"
			? last.item.section.concerns[0]?.text
			: "",
		"Empty input can still be submitted.",
	);
});

test("App-style flow appends a fresh chat card every time feedback arrives for the same section", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);
	await resetReviewState();

	useApp.getState().setSession(prSession);
	useApp.getState().setSectionMap([
		{
			section_id: "overview",
			title: "Overview",
			intent: "Understand the change",
		},
	]);

	function deliverFeedback(text: string) {
		useApp.getState().upsertSection({
			schema_version: 1,
			section_id: "overview",
			title: "Overview",
			intent: "Understand the change",
			files: [],
			ranges: [],
			concerns: [
				{ text, severity: "medium" },
			],
			base_ref: "base",
			head_ref: "head",
			pause_prompt: "",
		});
		const merged = useApp
			.getState()
			.sections.find((s: SectionState) => s.id === "overview");
		if (merged?.kind === "review_section" && merged.section) {
			useApp.getState().addReviewSectionItem(merged.section);
		}
	}

	deliverFeedback("first finding");
	deliverFeedback("second finding");

	const cards = overviewChat(useApp.getState()).filter(
		(m: ChatMessage) => m.item?.type === "review_section",
	);
	assert.equal(cards.length, 2);
});

test("setProject saves and clears the last selected project path", async () => {
	const { LAST_PROJECT_PATH_KEY } = await import(
		new URL("./projectSource.ts", import.meta.url).href
	);
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);
	const project: LocalProject = {
		path: "/Users/guidodorsi/dev/codex",
		origin: {
			repo_url: "https://github.com/openai/codex",
			owner: "openai",
			repo: "codex",
			slug: "openai/codex",
		},
	};
	storage.clear();
	await resetReviewState();

	useApp.getState().setProject(project);

	assert.equal(storage.get(LAST_PROJECT_PATH_KEY), project.path);

	useApp.getState().setProject(null);

	assert.equal(storage.get(LAST_PROJECT_PATH_KEY), undefined);
});

test("appendAssistantChunk merges overlapping text chunks", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);

	clearChatState(useApp);
	useApp.getState().appendAssistantChunk("This");
	useApp
		.getState()
		.appendAssistantChunk("This function checks which agent providers");

	assert.equal(
		overviewChat(useApp.getState())[0]?.text,
		"This function checks which agent providers",
	);
});

test("appendAssistantChunk keeps normal chunks while removing shared boundaries", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);

	clearChatState(useApp);
	useApp
		.getState()
		.appendAssistantChunk("available for Codex, Claude Code");
	useApp
		.getState()
		.appendAssistantChunk("Claude Code, and Cursor on this machine.");

	assert.equal(
		overviewChat(useApp.getState())[0]?.text,
		"available for Codex, Claude Code, and Cursor on this machine.",
	);
});

test("section processing state clears when the requested section arrives", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);

	useApp.setState({
		sections: [
			{
				id: "metadata-retention-logic",
				kind: "review_section",
				title: "Metadata retention decision logic",
				intent: "Review metadata behavior",
				status: "pending",
			},
		],
		currentSectionId: null,
		processingSectionIds: [],
	});

	useApp.getState().startSectionProcessing("metadata-retention-logic");

	assert.deepEqual(useApp.getState().processingSectionIds, [
		"metadata-retention-logic",
	]);

	useApp.getState().upsertSection({
		schema_version: 1,
		section_id: "metadata-retention-logic",
		title: "Metadata retention decision logic",
		intent: "Review metadata behavior",
		files: [],
		ranges: [],
		concerns: [],
		base_ref: "base",
		head_ref: "head",
		pause_prompt: "",
	});

	assert.deepEqual(useApp.getState().processingSectionIds, []);
});

test("section processing tracks multiple background section tasks independently", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);

	useApp.setState({
		sections: [],
		currentSectionId: null,
		processingSectionIds: [],
	});

	useApp.getState().startSectionProcessing("metadata-retention-logic");
	useApp.getState().startSectionProcessing("validation-flow");
	useApp.getState().startSectionProcessing("metadata-retention-logic");

	assert.deepEqual(useApp.getState().processingSectionIds, [
		"metadata-retention-logic",
		"validation-flow",
	]);

	useApp.getState().finishSectionProcessing("metadata-retention-logic");

	assert.deepEqual(useApp.getState().processingSectionIds, ["validation-flow"]);
});

test("addSectionMapItem stores readable section map details", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);

	clearChatState(useApp);

	useApp.getState().addSectionMapItem([
		{
			section_id: "overview",
			title: "Overview",
			intent: "Understand the public boundary",
		},
		{
			section_id: "tests",
			title: "Tests",
			intent: "Check test coverage",
		},
	]);

	assert.equal(overviewChat(useApp.getState()).length, 1);
	assert.equal(overviewChat(useApp.getState())[0]?.role, "assistant");
	const mapItem = overviewChat(useApp.getState())[0]?.item;
	assert.equal(mapItem?.type, "section_map");
	assert.equal(
		mapItem?.type === "section_map" ? mapItem.sections.length : -1,
		2,
	);
});

test("addReviewSectionItem stores readable files and feedback", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);

	clearChatState(useApp);

	useApp.getState().addReviewSectionItem({
		schema_version: 1,
		section_id: "logic",
		title: "Core logic",
		intent: "Review behavior changes",
		files: ["src/lib.rs", "src/main.rs"],
		ranges: [],
		concerns: [
			{
				text: "Missing empty input check.",
				severity: "medium",
				file_path: "src/lib.rs",
				line: 24,
			},
			{
				text: "No test for an empty input.",
				severity: "low",
				file_path: "src/lib.rs",
				line: 24,
			},
		],
		base_ref: "base",
		head_ref: "head",
		pause_prompt: "Questions?",
	});

	const item = overviewChat(useApp.getState())[0]?.item;
	assert.equal(item?.type, "review_section");
	assert.deepEqual(item?.section.files, ["src/lib.rs", "src/main.rs"]);
	assert.equal(item?.section.concerns[0]?.text, "Missing empty input check.");
	assert.equal(
		item?.section.concerns[1]?.text,
		"No test for an empty input.",
	);
});

test("creating chat tabs appends review-level tabs and switches the active tab", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);
	await resetReviewState();

	useApp.getState().setSession(prSession);

	const first = useApp.getState().createChatTab();
	const second = useApp.getState().createChatTab();

	const state = useApp.getState();
	assert.equal(first.title, "Chat 2");
	assert.equal(second.title, "Chat 3");
	assert.deepEqual(
		state.chatTabs.map((tab: ChatTab) => tab.title),
		["Overview", "Chat 2", "Chat 3"],
	);
	assert.equal(state.activeChatTabId, second.id);
	assert.equal("sectionId" in first, false);
});

test("section changes do not change the active chat tab", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);
	await resetReviewState();

	useApp.getState().setSession(prSession);
	useApp.getState().setSectionMap([
		{
			section_id: "logic",
			title: "Core logic",
			intent: "Review behavior changes",
		},
	]);
	const secondTab = useApp.getState().createChatTab();

	useApp.getState().setCurrentSection("logic", "user_click");

	const state = useApp.getState();
	assert.equal(state.currentSectionId, "logic");
	assert.equal(state.activeChatTabId, secondTab.id);
});

test("chat tabs keep independent timelines routed by ACP session", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);
	await resetReviewState();

	useApp.getState().setSession(prSession);

	const store = useApp.getState();
	const overviewTabId = store.activeChatTabId!;
	const secondTab = store.createChatTab();

	store.attachChatTabSession(overviewTabId, "session-overview");
	store.attachChatTabSession(secondTab.id, "session-chat-b");
	store.appendAssistantChunk("Default tab reply.", {
		sessionId: "session-overview",
		kind: "response",
	});
	store.appendAssistantChunk("Second tab reply.", {
		sessionId: "session-chat-b",
		kind: "response",
	});

	const state = useApp.getState();
	assert.equal(state.chatByTab[overviewTabId][0]?.text, "Default tab reply.");
	assert.equal(state.chatByTab[secondTab.id][0]?.text, "Second tab reply.");
	assert.equal(state.chatTabs.length, 2);
});

test("closing a chat tab removes its session route and keeps another tab active", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);
	await resetReviewState();

	useApp.getState().setSession(prSession);

	const store = useApp.getState();
	const firstTabId = store.activeChatTabId;
	const secondTab = store.createChatTab();
	store.attachChatTabSession(secondTab.id, "session-chat-b");
	store.appendAssistantChunk("Second tab reply.", {
		sessionId: "session-chat-b",
		kind: "response",
	});

	const result = store.closeChatTab(secondTab.id);

	const state = useApp.getState();
	assert.equal(result.closedSessionId, "session-chat-b");
	assert.equal(state.activeChatTabId, firstTabId);
	assert.equal(state.chatTabForSession["session-chat-b"], undefined);
	assert.equal(state.sessionByChatTab[secondTab.id], undefined);
	assert.equal(state.chatByTab[secondTab.id], undefined);
	assert.deepEqual(state.chatTabs.map((tab: ChatTab) => tab.id), ["overview"]);
});

test("tool calls stay inside the active assistant thinking thread", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);

	clearChatState(useApp);

	useApp.getState().appendAssistantChunk("I will check");
	useApp.getState().addToolCallItem({
		tool_call_id: "tool-1",
		title: "Search repo",
		kind: "search",
		status: "in_progress",
	});
	useApp.getState().appendAssistantChunk(" and explain.");

	const [message] = overviewChat(useApp.getState()) as ChatMessage[];
	assert.equal(overviewChat(useApp.getState()).length, 1);
	assert.equal(message?.role, "assistant");
	assert.equal(message?.text, "I will check and explain.");
	assert.deepEqual(message?.parts, [
		{ type: "thinking", text: "I will check" },
		{
			type: "tool_call",
			toolCall: {
				tool_call_id: "tool-1",
				title: "Search repo",
				kind: "search",
				status: "in_progress",
			},
		},
		{ type: "thinking", text: " and explain." },
	]);
});

test("replayed assistant chunks dedupe after inline tool calls", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);

	clearChatState(useApp);

	useApp.getState().appendAssistantChunk("I will check");
	useApp.getState().addToolCallItem({
		tool_call_id: "tool-1",
		title: "Search repo",
		kind: "search",
		status: "completed",
	});
	useApp.getState().appendAssistantChunk("I will check and explain.");

	const [message] = overviewChat(useApp.getState()) as ChatMessage[];
	assert.equal(message?.text, "I will check and explain.");
	assert.deepEqual(message?.parts, [
		{ type: "thinking", text: "I will check" },
		{
			type: "tool_call",
			toolCall: {
				tool_call_id: "tool-1",
				title: "Search repo",
				kind: "search",
				status: "completed",
			},
		},
		{ type: "thinking", text: " and explain." },
	]);
});

test("inline tool call statuses update inside assistant message parts", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);

	clearChatState(useApp);

	useApp.getState().appendAssistantChunk("Checking");
	useApp.getState().addToolCallItem({
		tool_call_id: "tool-1",
		title: "Search repo",
		kind: "search",
		status: "in_progress",
	});
	useApp.getState().updateToolCallItem("tool-1", "completed");

	const [message] = overviewChat(useApp.getState()) as ChatMessage[];
	assert.deepEqual(message?.parts?.[1], {
		type: "tool_call",
		toolCall: {
			tool_call_id: "tool-1",
			title: "Search repo",
			kind: "search",
			status: "completed",
		},
	});
});

test("appendAssistantChunk hides structured review fences from chat text", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);

	clearChatState(useApp);

	useApp.getState().appendAssistantChunk(
		[
			"Here is the map.",
			"```acp-section-map",
			'{ "sections": [] }',
			"```",
			"Ready.",
		].join("\n"),
	);

	assert.equal(
		overviewChat(useApp.getState())[0]?.text,
		"Here is the map.\nReady.",
	);
});

test("appendAssistantChunk hides PR description fences from chat text", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);

	clearChatState(useApp);

	useApp.getState().appendAssistantChunk(
		[
			"Preparing the intro.",
			"```acp-pr-description",
			"A concise PR summary.",
			"```",
			"Ready.",
		].join("\n"),
	);

	assert.equal(
		overviewChat(useApp.getState())[0]?.text,
		"Preparing the intro.\nReady.",
	);
});

test("structured review fences split around a readable item stay hidden", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);

	clearChatState(useApp);

	useApp.getState().appendAssistantChunk(
		[
			"A focused bug-fix PR.",
			"",
			"```acp-section-map",
			"{",
			'  "sections": [',
			'    { "section_id": "query-rules", "title": "Query support rule changes", "intent": "Core logic" },',
			'    { "section_id": "changeset", "title": "Changeset", "intent": "Release metadata',
		].join("\n"),
	);
	useApp.getState().addSectionMapItem([
		{
			section_id: "query-rules",
			title: "Query support rule changes",
			intent: "Core logic",
		},
		{
			section_id: "changeset",
			title: "Changeset",
			intent: "Release metadata for this patch",
		},
	]);
	useApp.getState().appendAssistantChunk(
		[
			' for this patch" }',
			"  ]",
			"}",
			"```",
			"",
			"Ready when you are.",
		].join("\n"),
	);

	const chat = overviewChat(useApp.getState()) as ChatMessage[];
	assert.equal(chat.length, 3);
	assert.equal(chat[0]?.text.trimEnd(), "A focused bug-fix PR.");
	assert.equal(chat[1]?.item?.type, "section_map");
	assert.equal(chat[2]?.text.trim(), "Ready when you are.");
	assert(!chat.some((message) => message.text.includes("```acp-section-map")));
	assert(!chat.some((message) => message.text.includes("Release metadata")));
});

test("split structured section-map opener stays hidden from response chat", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);

	clearChatState(useApp);

	for (const chunk of [
		"```",
		"ac",
		"p",
		"-section",
		"-map",
		"\n",
		"{\n",
		'  "sections": []\n',
		"}\n",
	]) {
		useApp.getState().appendAssistantChunk(chunk, { kind: "response" });
	}
	useApp.getState().addSectionMapItem([
		{
			section_id: "query-rules",
			title: "Query support rule changes",
			intent: "Core logic",
		},
	]);
	useApp.getState().appendAssistantChunk("```", { kind: "response" });

	const chat = overviewChat(useApp.getState()) as ChatMessage[];
	assert.equal(chat.length, 1);
	assert.equal(chat[0]?.item?.type, "section_map");
	assert(!chat.some((message) => message.text.includes("```acp-section-map")));
	assert(!chat.some((message) => message.text.includes('"sections"')));
});

test("split structured section block does not create an empty response", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);

	clearChatState(useApp);

	for (const chunk of [
		"```",
		"ac",
		"p",
		"-section",
		"\n",
		"{\n",
		'  "section_id": "query-rules",\n',
		'  "title": "Query rules",\n',
		'  "intent": "Review query behavior",\n',
	]) {
		useApp.getState().appendAssistantChunk(chunk, { kind: "response" });
	}
	useApp.getState().addReviewSectionItem({
		schema_version: 1,
		section_id: "query-rules",
		title: "Query rules",
		intent: "Review query behavior",
		files: ["src/lib/store.ts"],
		ranges: [],
		concerns: [],
		grill_questions: [],
		base_ref: "base",
		head_ref: "head",
		pause_prompt: "",
	});
	useApp.getState().appendAssistantChunk(
		[
			'  "files": ["src/lib/store.ts"],',
			'  "ranges": [],',
			'  "concerns": [],',
			'  "grill_questions": [],',
			'  "base_ref": "base",',
			'  "head_ref": "head",',
			'  "pause_prompt": ""',
			"}",
			"```",
		].join("\n"),
		{ kind: "response" },
	);

	const chat = overviewChat(useApp.getState()) as ChatMessage[];
	assert.equal(chat.length, 1);
	assert.equal(chat[0]?.item?.type, "review_section");
	assert(!chat.some((message) => message.text.includes("```acp-section")));
	assert(!chat.some((message) => message.text.includes('"section_id"')));
});

test("split normal markdown code fence remains visible as response chat", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);

	clearChatState(useApp);

	useApp.getState().appendAssistantChunk("```", { kind: "response" });
	useApp.getState().appendAssistantChunk("ts\nconst ok = true;\n```", {
		kind: "response",
	});

	const [message] = overviewChat(useApp.getState()) as ChatMessage[];
	assert.equal(message?.text, "```ts\nconst ok = true;\n```");
	assert.deepEqual(message?.parts, [
		{ type: "assistant_response", markdown: "```ts\nconst ok = true;\n```" },
	]);
});

test("split inline backtick remains visible as response chat", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);

	clearChatState(useApp);

	useApp.getState().appendAssistantChunk("Use `", { kind: "response" });
	useApp.getState().appendAssistantChunk("code` now", { kind: "response" });

	const [message] = overviewChat(useApp.getState()) as ChatMessage[];
	assert.equal(message?.text, "Use `code` now");
	assert.deepEqual(message?.parts, [
		{ type: "assistant_response", markdown: "Use `code` now" },
	]);
});

test("processed display-message chunks preserve collapsed thinking and add a response", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);

	clearChatState(useApp);

	useApp.getState().appendAssistantChunk("I am checking files...");
	useApp.getState().addToolCallItem({
		tool_call_id: "tool-1",
		title: "Read file",
		kind: "read",
		status: "completed",
	});
	useApp.getState().appendAssistantChunk("The section is clear.", {
		replaceStreaming: true,
	});

	const [message] = overviewChat(useApp.getState()) as ChatMessage[];
	assert.equal(message?.text, "The section is clear.");
	assert.deepEqual(message?.parts, [
		{ type: "thinking", text: "I am checking files..." },
		{
			type: "tool_call",
			toolCall: {
				tool_call_id: "tool-1",
				title: "Read file",
				kind: "read",
				status: "completed",
			},
		},
		{ type: "assistant_response", markdown: "The section is clear." },
	]);
});

test("agent message chunks render as assistant responses outside thinking", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);

	clearChatState(useApp);

	useApp.getState().appendAssistantChunk(
		"Short answer: yes, but it is probably acceptable for the MVP.",
		{ kind: "response" },
	);

	const [message] = overviewChat(useApp.getState()) as ChatMessage[];
	assert.equal(
		message?.text,
		"Short answer: yes, but it is probably acceptable for the MVP.",
	);
	assert.deepEqual(message?.parts, [
		{
			type: "assistant_response",
			markdown: "Short answer: yes, but it is probably acceptable for the MVP.",
		},
	]);
});

test("response chunks remain outside an existing thinking thread", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);

	clearChatState(useApp);

	useApp.getState().appendAssistantChunk("I am checking files...");
	useApp.getState().addToolCallItem({
		tool_call_id: "tool-1",
		title: "Read file",
		kind: "read",
		status: "completed",
	});
	useApp.getState().appendAssistantChunk("Short answer: yes", {
		kind: "response",
	});
	useApp.getState().appendAssistantChunk(
		", but it is probably acceptable for the MVP.",
		{ kind: "response" },
	);

	const [message] = overviewChat(useApp.getState()) as ChatMessage[];
	assert.equal(
		message?.text,
		"Short answer: yes, but it is probably acceptable for the MVP.",
	);
	assert.deepEqual(message?.parts, [
		{ type: "thinking", text: "I am checking files..." },
		{
			type: "tool_call",
			toolCall: {
				tool_call_id: "tool-1",
				title: "Read file",
				kind: "read",
				status: "completed",
			},
		},
		{
			type: "assistant_response",
			markdown: "Short answer: yes, but it is probably acceptable for the MVP.",
		},
	]);
});

test("dismissCommentDraft removes the matching draft only", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);

	useApp.setState({
		commentDrafts: [
			{
				id: "draft-123",
				status: "publishing",
				draft: {
					kind: "top_level",
					body: "Looks good.",
				},
			},
			{
				id: "draft-456",
				status: "pending",
				draft: {
					kind: "top_level",
					body: "Keep this one.",
				},
			},
		],
	});

	useApp.getState().dismissCommentDraft("draft-123");

	assert.deepEqual(
		useApp
			.getState()
			.commentDrafts.map((draft: { id: string }) => draft.id),
		["draft-456"],
	);
});

test("editCommentDraftBody updates a draft body without changing its status", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);

	useApp.setState({
		commentDrafts: [
			{
				id: "draft-123",
				status: "approved",
				draft: {
					kind: "inline",
					body: "Original text.",
					file_path: "src/main.rs",
					line: 12,
					side: "RIGHT",
				},
			},
		],
	});

	useApp.getState().editCommentDraftBody("draft-123", "Edited text.");

	assert.deepEqual(useApp.getState().commentDrafts, [
		{
			id: "draft-123",
			status: "approved",
			draft: {
				kind: "inline",
				body: "Edited text.",
				file_path: "src/main.rs",
				line: 12,
				side: "RIGHT",
			},
		},
	]);
});

test("applyCommentResult updates published drafts in place", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);

	useApp.setState({
		commentDrafts: [
			{
				id: "draft-123",
				marked: true,
				status: "publishing",
				draft: {
					kind: "top_level",
					body: "Looks good.",
				},
			},
		],
	});

	useApp.getState().applyCommentResult({
		draft_id: "draft-123",
		status: "published",
		url: "https://github.com/garden-co/jazz/pull/787#discussion_r1",
	});

	const [draft] = useApp.getState().commentDrafts;
	assert.equal(draft?.id, "draft-123");
	assert.equal(draft?.status, "published");
	assert.equal(draft?.marked, true);
	assert.equal(
		draft?.url,
		"https://github.com/garden-co/jazz/pull/787#discussion_r1",
	);
});

test("applyCommentResult updates failed drafts in place with error status", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);

	useApp.setState({
		commentDrafts: [
			{
				id: "draft-456",
				marked: true,
				status: "publishing",
				draft: {
					kind: "inline",
					body: "Please check this.",
					file_path: "src/main.rs",
					line: 12,
					side: "RIGHT",
				},
			},
		],
	});

	useApp.getState().applyCommentResult({
		draft_id: "draft-456",
		status: "failed",
		error: "GitHub rejected the comment.",
	});

	const [draft] = useApp.getState().commentDrafts;
	assert.equal(draft?.id, "draft-456");
	assert.equal(draft?.status, "error");
	assert.equal(draft?.error, "GitHub rejected the comment.");
	assert.equal(draft?.url, undefined);
});

test("store does not keep diff file collapse state", async () => {
	const source = await readFile(new URL("./store.ts", import.meta.url), "utf8");

	assert.doesNotMatch(source, /expandedFiles/);
	assert.doesNotMatch(source, /collapsedFiles/);
	assert.doesNotMatch(source, /toggleFileExpanded/);
	assert.doesNotMatch(source, /expandFiles/);
	assert.doesNotMatch(source, /collapseAllFiles/);
});

test("addCommentDraft starts unmarked and pending", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);
	await resetReviewState();

	useApp.getState().addCommentDraft("draft-1", {
		kind: "top_level",
		body: "A note.",
	});

	const [draft] = useApp.getState().commentDrafts;
	assert.equal(draft?.marked, false);
	assert.equal(draft?.status, "pending");
});

test("setCommentMarked sets the marked flag", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);
	await resetReviewState();
	useApp.getState().addCommentDraft("draft-1", { kind: "top_level", body: "x" });

	useApp.getState().setCommentMarked("draft-1", true);
	assert.equal(useApp.getState().commentDrafts[0]?.marked, true);

	useApp.getState().setCommentMarked("draft-1", false);
	assert.equal(useApp.getState().commentDrafts[0]?.marked, false);
});

test("setSectionMap appends Review Summary as the last section", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);
	await resetReviewState();
	useApp.getState().setSession(prSession);

	useApp.getState().setSectionMap([
		{ section_id: "api", title: "API", intent: "x", files: ["a.ts"] },
	]);

	const sections = useApp.getState().sections;
	const last = sections[sections.length - 1];
	assert.equal(last?.kind, "review_summary");
	assert.equal(last?.id, "review-summary");
	assert.equal(
		sections.filter((s: SectionState) => s.kind === "review_summary").length,
		1,
	);
});

test("upsertSection keeps the Review Summary pinned last", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);
	await resetReviewState();
	useApp.getState().setSession(prSession);
	useApp.getState().setSectionMap([
		{ section_id: "api", title: "API", intent: "x", files: ["a.ts"] },
	]);

	useApp.getState().upsertSection({
		schema_version: 1,
		section_id: "added-late",
		title: "Late",
		intent: "y",
		files: [],
		ranges: [],
		concerns: [],
		base_ref: "origin/main",
		head_ref: "head",
		pause_prompt: "",
	});

	const sections = useApp.getState().sections;
	assert.equal(sections[sections.length - 1]?.kind, "review_summary");
	assert.equal(
		sections.filter((s: SectionState) => s.kind === "review_summary").length,
		1,
	);
});

test("upsertSectionProgress keeps the Review Summary pinned last", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);
	await resetReviewState();
	useApp.getState().setSession(prSession);
	useApp.getState().setSectionMap([
		{ section_id: "api", title: "API", intent: "x", files: ["a.ts"] },
	]);

	useApp.getState().upsertSectionProgress({
		section_id: "progress-late",
		phase: "started",
		title: "Progress late",
		intent: "z",
	});

	const sections = useApp.getState().sections;
	assert.equal(sections[sections.length - 1]?.kind, "review_summary");
	assert.equal(
		sections.filter((s: SectionState) => s.kind === "review_summary").length,
		1,
	);
});

test("restoreSavedReview pins one summary last and maps legacy approved drafts", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);
	await resetReviewState();

	useApp.getState().restoreSavedReview(prSession, {
		current_section_id: "api",
		sections: [
			{
				id: "review-summary",
				kind: "review_summary",
				title: "Review Summary",
				intent: "",
				status: "in_review",
			},
			{
				id: "api",
				kind: "review_section",
				title: "API",
				intent: "x",
				status: "in_review",
			},
		],
		comment_drafts: [
			{
				id: "legacy",
				status: "approved",
				draft: { kind: "top_level", body: "old" },
			} as CommentDraftState,
		],
		published_comments: [],
		published_comments_error: null,
	});

	const sections = useApp.getState().sections;
	assert.equal(sections[sections.length - 1]?.kind, "review_summary");
	assert.equal(
		sections.filter((s: SectionState) => s.kind === "review_summary").length,
		1,
	);
	const [draft] = useApp.getState().commentDrafts;
	assert.equal(draft?.marked, true);
	assert.equal(draft?.status, "pending");
});

test("toggleConcernDraft adds a marked draft, then removes it", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);
	await resetReviewState();

	const draft = {
		kind: "inline" as const,
		body: "[medium] Null check",
		file_path: "a.ts",
		line: 4,
		side: "RIGHT" as const,
	};

	useApp.getState().toggleConcernDraft("concern:sec1:a.ts:4:abc", draft);
	let drafts = useApp.getState().commentDrafts;
	assert.equal(drafts.length, 1);
	assert.equal(drafts[0]?.id, "concern:sec1:a.ts:4:abc");
	assert.equal(drafts[0]?.marked, true);
	assert.equal(drafts[0]?.status, "pending");

	useApp.getState().toggleConcernDraft("concern:sec1:a.ts:4:abc", draft);
	drafts = useApp.getState().commentDrafts;
	assert.equal(drafts.length, 0);
});
