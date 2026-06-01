# Review Summary & Submit Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the reviewer mark drafted comments as part of the review, collect them in a final "Review Summary" center-panel section with a 3-line code peek, and submit the review three ways (comment on GitHub, approve+comment, or write a local `REVIEW.md`).

**Architecture:** A `marked` boolean on each comment draft replaces the old "approve" step. A synthetic `review_summary` section (kind discriminator, mirroring the existing `pr_description` section) is pinned last and rendered by `DiffPane` as a new `ReviewSummaryView`. GitHub submits reuse the agent-delegated publish path with an explicit review event (`COMMENT`/`APPROVE`); `REVIEW.md` is written host-side by a new Rust command.

**Tech Stack:** React 19 + TypeScript + Zustand + Tailwind v4 + Radix (`@radix-ui/react-dropdown-menu`, already a dep); Tauri 2 + Rust (`git2` via the existing `repo::get_file_at_ref`). Tests: `tsx --test` (node:test) for TS, `cargo test` for Rust.

**Sequencing note:** To keep every intermediate commit compiling, the `CommentDraftState.status` union is left unchanged (it still lists `"approved"`/`"rejected"`); new code simply never produces those values, and restore maps a legacy `"approved"` status to `marked: true`. The old `commentPublish` approve/publish functions are kept until their last consumer is removed (Task 9), then deleted there.

---

### Task 1: Add `marked` selection + update-in-place publish result (store)

**Files:**
- Modify: `src/lib/store.ts` (`CommentDraftState`, `AppState`, `addCommentDraft`, `applyCommentResult`; add `setCommentMarked`)
- Test: `src/lib/store.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/store.test.ts`:

```ts
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

test("setCommentMarked toggles the marked flag", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);
	await resetReviewState();
	useApp.getState().addCommentDraft("draft-1", { kind: "top_level", body: "x" });

	useApp.getState().setCommentMarked("draft-1", true);
	assert.equal(useApp.getState().commentDrafts[0]?.marked, true);

	useApp.getState().setCommentMarked("draft-1", false);
	assert.equal(useApp.getState().commentDrafts[0]?.marked, false);
});

test("applyCommentResult updates the draft in place instead of removing it", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);
	await resetReviewState();
	useApp.getState().addCommentDraft("draft-1", { kind: "top_level", body: "x" });
	useApp.getState().setCommentMarked("draft-1", true);

	useApp.getState().applyCommentResult({
		draft_id: "draft-1",
		status: "published",
		url: "https://github.com/o/r/pull/1#discussion_r1",
	});

	const [draft] = useApp.getState().commentDrafts;
	assert.equal(draft?.status, "published");
	assert.equal(draft?.marked, true);
	assert.equal(draft?.url, "https://github.com/o/r/pull/1#discussion_r1");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `setCommentMarked is not a function`; `applyCommentResult` test fails because the draft is removed.

- [ ] **Step 3: Add `marked` to the type and the new action signature**

In `src/lib/store.ts`, update `CommentDraftState`:

```ts
export interface CommentDraftState {
	id: string;
	draft: CommentDraft;
	marked: boolean;
	status:
		| "pending"
		| "approved"
		| "publishing"
		| "published"
		| "rejected"
		| "error";
	url?: string;
	error?: string;
}
```

In the `AppState` interface, next to `editCommentDraftBody`, add:

```ts
	setCommentMarked: (id: string, marked: boolean) => void;
```

- [ ] **Step 4: Implement the action changes**

In `src/lib/store.ts`, change `addCommentDraft` to default `marked: false`:

```ts
	addCommentDraft: (id, draft) =>
		set((state) => ({
			commentDrafts: [
				...state.commentDrafts,
				{ id, draft, marked: false, status: "pending" },
			],
		})),
```

Add `setCommentMarked` right after `editCommentDraftBody`:

```ts
	setCommentMarked: (id, marked) =>
		set((state) => ({
			commentDrafts: state.commentDrafts.map((d) =>
				d.id === id ? { ...d, marked } : d,
			),
		})),
```

Replace `applyCommentResult` to update in place:

```ts
	applyCommentResult: (result) =>
		set((state) => ({
			commentDrafts: state.commentDrafts.map((d) =>
				d.id === result.draft_id
					? {
							...d,
							status: result.status === "published" ? "published" : "error",
							url: result.url ?? d.url,
							error: result.error,
						}
					: d,
			),
		})),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS (all store tests green).

- [ ] **Step 6: Typecheck**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/store.ts src/lib/store.test.ts
git commit -m "Add marked flag and in-place comment result to store"
```

---

### Task 2: Review Summary synthetic section, pinned last (store)

**Files:**
- Modify: `src/lib/store.ts` (new kind + helpers; `setSectionMap`, `upsertSection`, `upsertSectionProgress`, `restoreSavedReview`)
- Test: `src/lib/store.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/store.test.ts`:

```ts
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
	assert.equal(sections.filter((s) => s.kind === "review_summary").length, 1);
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
	assert.equal(sections.filter((s) => s.kind === "review_summary").length, 1);
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
			// legacy record: no `marked`, status "approved"
			{
				id: "legacy",
				status: "approved",
				draft: { kind: "top_level", body: "old" },
			},
		],
		published_comments: [],
		published_comments_error: null,
	});

	const sections = useApp.getState().sections;
	assert.equal(sections[sections.length - 1]?.kind, "review_summary");
	assert.equal(sections.filter((s) => s.kind === "review_summary").length, 1);
	const [draft] = useApp.getState().commentDrafts;
	assert.equal(draft?.marked, true);
	assert.equal(draft?.status, "pending");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — summary section is not appended; legacy draft has no `marked`.

- [ ] **Step 3: Add the new section kind and constant**

In `src/lib/store.ts`, near `PR_DESCRIPTION_SECTION_ID`:

```ts
export const REVIEW_SUMMARY_SECTION_ID = "review-summary";
```

After the `ReviewSectionState` interface, add the new kind and extend the union:

```ts
export interface ReviewSummarySectionState extends BaseSectionState {
	kind: "review_summary";
}

export type SectionState =
	| PrDescriptionSectionState
	| ReviewSectionState
	| ReviewSummarySectionState;
```

(Delete the old two-member `SectionState` union definition.)

- [ ] **Step 4: Add the pin/insert/normalize helpers**

In `src/lib/store.ts`, after `restoreSectionFeedbackLoaded`:

```ts
function reviewSummarySection(): ReviewSummarySectionState {
	return {
		id: REVIEW_SUMMARY_SECTION_ID,
		kind: "review_summary",
		title: "Review Summary",
		intent: "Marked comments and submit your review.",
		status: "in_review",
	};
}

function withReviewSummaryLast(sections: SectionState[]): SectionState[] {
	const withoutSummary = sections.filter((s) => s.kind !== "review_summary");
	return [...withoutSummary, reviewSummarySection()];
}

function insertReviewSection(
	sections: SectionState[],
	updated: ReviewSectionState,
): SectionState[] {
	const summaryIdx = sections.findIndex((s) => s.kind === "review_summary");
	if (summaryIdx === -1) return [...sections, updated];
	return [
		...sections.slice(0, summaryIdx),
		updated,
		...sections.slice(summaryIdx),
	];
}

function normalizeRestoredDraft(draft: CommentDraftState): CommentDraftState {
	const marked =
		typeof draft.marked === "boolean" ? draft.marked : draft.status === "approved";
	const status =
		draft.status === "approved" || draft.status === "rejected"
			? "pending"
			: draft.status;
	return { ...draft, marked, status };
}
```

- [ ] **Step 5: Pin the summary in `setSectionMap`**

In `setSectionMap`, wrap the returned `sections` array with `withReviewSummaryLast`. Change the `return { sections: [ ... ] }` to:

```ts
				return {
					sections: withReviewSummaryLast([
						...(prDescription ? [prDescription] : []),
						...entries.map((e): ReviewSectionState => {
							const existing = existingReviewSections.get(e.section_id);
							const section = mergeMapEntrySection(e, existing, state.session);
							const feedbackLoaded = inferFeedbackLoaded(existing);
							return {
								id: e.section_id,
								kind: "review_section",
								title: e.title,
								intent: e.intent,
								status:
									existing?.status === "completed"
										? "completed"
										: feedbackLoaded || (section && hasSectionFeedback(section))
											? "in_review"
											: "pending",
								section,
								feedbackLoaded,
							};
						}),
					]),
				};
```

- [ ] **Step 6: Insert-before-summary in `upsertSection`**

In `upsertSection`, replace the `if (idx >= 0) sections[idx] = updated; else sections.push(updated);` line with:

```ts
				let nextSections = sections;
				if (idx >= 0) {
					nextSections = [...sections];
					nextSections[idx] = updated;
				} else {
					nextSections = insertReviewSection(sections, updated);
				}
```

Then change the `return { sections, ... }` to use `nextSections`:

```ts
				return {
					sections: nextSections,
					processingSectionIds: removeProcessingSectionId(
						state.processingSectionIds,
						section.section_id,
					),
				};
```

- [ ] **Step 7: Insert-before-summary in `upsertSectionProgress`**

In `upsertSectionProgress`, apply the same pattern. Replace `if (idx >= 0) sections[idx] = updated; else sections.push(updated);` with:

```ts
				let nextSections = sections;
				if (idx >= 0) {
					nextSections = [...sections];
					nextSections[idx] = updated;
				} else {
					nextSections = insertReviewSection(sections, updated);
				}
```

And change the `return` to:

```ts
				return {
					sections: nextSections,
					processingSectionIds: addProcessingSectionId(
						state.processingSectionIds,
						update.section_id,
					),
				};
```

- [ ] **Step 8: Pin summary and normalize drafts in `restoreSavedReview`**

In `restoreSavedReview`, change the `restoredSections` line and the `commentDrafts` field:

```ts
			const restoredSections = withReviewSummaryLast(
				snapshot.sections.map(restoreSectionFeedbackLoaded),
			);
```

```ts
				commentDrafts: snapshot.comment_drafts.map(normalizeRestoredDraft),
```

- [ ] **Step 9: Run the tests + typecheck**

Run: `npm test && npm run check`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/lib/store.ts src/lib/store.test.ts
git commit -m "Add Review Summary synthetic section pinned last"
```

---

### Task 3: Review-submit prompt builder + request (commentPublish)

**Files:**
- Modify: `src/lib/commentPublish.ts` (add new functions; keep old ones for now)
- Test: `src/lib/commentPublish.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/commentPublish.test.ts`:

```ts
test("buildAgentPublishReviewPrompt pins the COMMENT event", async () => {
	const { buildAgentPublishReviewPrompt } = await import("./commentPublish");
	const prompt = buildAgentPublishReviewPrompt({
		target: { owner: "garden-co", repo: "jazz", number: 787 },
		head_sha: "57d6bce",
		event: "COMMENT",
		drafts: [
			{ id: "d1", draft: { kind: "inline", body: "x", file_path: "a.ts", line: 4, side: "RIGHT" } },
		],
	});
	assert.match(prompt, /garden-co\/jazz#787/);
	assert.match(prompt, /"review_event": "COMMENT"/);
	assert.match(prompt, /do not approve/i);
	assert.match(prompt, /d1/);
	assert.match(prompt, /acp-comment-result/);
});

test("buildAgentPublishReviewPrompt pins the APPROVE event", async () => {
	const { buildAgentPublishReviewPrompt } = await import("./commentPublish");
	const prompt = buildAgentPublishReviewPrompt({
		target: { owner: "garden-co", repo: "jazz", number: 787 },
		head_sha: "57d6bce",
		event: "APPROVE",
		drafts: [{ id: "d1", draft: { kind: "top_level", body: "x" } }],
	});
	assert.match(prompt, /"review_event": "APPROVE"/);
	assert.match(prompt, /approve the PR/i);
});

test("requestAgentPublishReview marks all comments publishing and sends one prompt", async () => {
	const { requestAgentPublishReview } = await import("./commentPublish");
	const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
	const messages: Array<{ text: string; options: unknown }> = [];

	await requestAgentPublishReview({
		session_id: "s1",
		target: { owner: "garden-co", repo: "jazz", number: 787 },
		head_sha: "57d6bce",
		event: "COMMENT",
		comments: [
			{ id: "d1", marked: true, status: "pending", draft: { kind: "top_level", body: "a" } },
			{ id: "d2", marked: true, status: "pending", draft: { kind: "top_level", body: "b" } },
		],
		updateCommentDraft: (id, patch) => updates.push({ id, patch }),
		sendMessage: async (_s, text, options) => {
			messages.push({ text, options });
		},
	});

	assert.deepEqual(updates, [
		{ id: "d1", patch: { status: "publishing", error: undefined } },
		{ id: "d2", patch: { status: "publishing", error: undefined } },
	]);
	assert.equal(messages.length, 1);
	assert.match(messages[0]?.text ?? "", /d1/);
	assert.match(messages[0]?.text ?? "", /d2/);
	assert.deepEqual(messages[0]?.options, {
		origin: "comment_publish",
		reason: "submit_review_comment",
		suppressPreview: true,
	});
});

test("requestAgentPublishReview reverts to pending when send fails", async () => {
	const { requestAgentPublishReview } = await import("./commentPublish");
	const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
	await assert.rejects(
		requestAgentPublishReview({
			session_id: "s1",
			target: { owner: "garden-co", repo: "jazz", number: 787 },
			head_sha: "57d6bce",
			event: "COMMENT",
			comments: [
				{ id: "d1", marked: true, status: "pending", draft: { kind: "top_level", body: "a" } },
			],
			updateCommentDraft: (id, patch) => updates.push({ id, patch }),
			sendMessage: async () => {
				throw new Error("agent is busy");
			},
		}),
		/agent is busy/,
	);
	assert.deepEqual(updates, [
		{ id: "d1", patch: { status: "publishing", error: undefined } },
		{ id: "d1", patch: { status: "pending", error: "agent is busy" } },
	]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `buildAgentPublishReviewPrompt`/`requestAgentPublishReview` are not exported.

- [ ] **Step 3: Implement the new functions**

In `src/lib/commentPublish.ts`, add (do NOT remove the existing exports yet):

```ts
export type ReviewSubmitEvent = "COMMENT" | "APPROVE";

export const AGENT_REVIEW_PUBLISH_INSTRUCTIONS = [
	"Submit these comments as a single GitHub pull request review using your own GitHub tools and authentication.",
	"Create exactly ONE pull request review (not individual comments) using the review event specified below.",
	"Do not ask the host app to publish them. The host is only holding the marked comments.",
	"Use the target PR and head SHA below. For inline comments, keep the provided file path, line, and side.",
	"After each comment is attempted, emit exactly one `acp-comment-result` fenced JSON block for that draft.",
	'Use `status: "published"` and include `url` when GitHub returns one. Use `status: "failed"` and include `error` if GitHub rejects it.',
];

export function buildAgentPublishReviewPrompt(args: {
	target: PrTarget;
	head_sha: string;
	event: ReviewSubmitEvent;
	drafts: Pick<CommentDraftState, "id" | "draft">[];
}): string {
	const payload = {
		target: {
			owner: args.target.owner,
			repo: args.target.repo,
			number: args.target.number,
			label: `${args.target.owner}/${args.target.repo}#${args.target.number}`,
		},
		review_event: args.event,
		head_sha: args.head_sha,
		drafts: args.drafts.map((state) => ({ draft_id: state.id, ...state.draft })),
	};

	const eventNote =
		args.event === "APPROVE"
			? "Review event APPROVE: approve the PR and include these comments."
			: "Review event COMMENT: comment only, do not approve the PR.";

	return [
		...AGENT_REVIEW_PUBLISH_INSTRUCTIONS,
		"",
		eventNote,
		"Marked comments:",
		"```json",
		JSON.stringify(payload, null, 2),
		"```",
	].join("\n");
}

export async function requestAgentPublishReview(args: {
	session_id: string;
	target: PrTarget;
	head_sha: string;
	event: ReviewSubmitEvent;
	comments: CommentDraftState[];
	updateCommentDraft: (
		id: string,
		patch: { status: "publishing" | "pending"; error?: string },
	) => void;
	sendMessage: SendMessage;
}): Promise<void> {
	const drafts = args.comments;
	if (drafts.length === 0) return;

	for (const draft of drafts) {
		args.updateCommentDraft(draft.id, { status: "publishing", error: undefined });
	}

	try {
		await args.sendMessage(
			args.session_id,
			buildAgentPublishReviewPrompt({
				target: args.target,
				head_sha: args.head_sha,
				event: args.event,
				drafts,
			}),
			{
				origin: "comment_publish",
				reason:
					args.event === "APPROVE"
						? "submit_review_approve"
						: "submit_review_comment",
				suppressPreview: true,
			},
		);
	} catch (error) {
		const message = errorMessage(
			error,
			"Could not ask the agent to submit the review.",
		);
		for (const draft of drafts) {
			args.updateCommentDraft(draft.id, { status: "pending", error: message });
		}
		throw error;
	}
}
```

- [ ] **Step 4: Run the tests + typecheck**

Run: `npm test && npm run check`
Expected: PASS (old tests still green; new tests green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/commentPublish.ts src/lib/commentPublish.test.ts
git commit -m "Add single-review submit prompt for marked comments"
```

---

### Task 4: `REVIEW.md` Rust module + command + registration

**Files:**
- Create: `src-tauri/src/review_md.rs`
- Modify: `src-tauri/src/commands.rs` (add `write_review_md_cmd` + `use`)
- Modify: `src-tauri/src/lib.rs` (`mod review_md;` + register command)

- [ ] **Step 1: Write the module with failing tests**

Create `src-tauri/src/review_md.rs`:

```rust
use crate::repo::get_file_at_ref;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewMdComment {
    pub kind: String,
    #[serde(default)]
    pub title: Option<String>,
    pub body: String,
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub line: Option<u32>,
    #[serde(default)]
    pub side: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WriteReviewMdArgs {
    pub repo_path: PathBuf,
    pub base_ref: String,
    pub head_ref: String,
    #[serde(default)]
    pub pr_title: Option<String>,
    pub comments: Vec<ReviewMdComment>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SnippetLine {
    pub number: u32,
    pub text: String,
    pub is_target: bool,
}

struct RenderComment {
    title: Option<String>,
    body: String,
    file_path: Option<String>,
    line: Option<u32>,
    side: Option<String>,
    snippet: Vec<SnippetLine>,
}

/// 1-based target line; returns the target plus one neighbor on each side, clamped to file bounds.
pub fn snippet_around(content: &str, line: u32) -> Vec<SnippetLine> {
    let lines: Vec<&str> = content.lines().collect();
    if lines.is_empty() || line == 0 {
        return Vec::new();
    }
    let total = lines.len() as u32;
    let target = line.min(total);
    let start = if target <= 1 { 1 } else { target - 1 };
    let end = (target + 1).min(total);
    (start..=end)
        .map(|n| SnippetLine {
            number: n,
            text: lines[(n - 1) as usize].to_string(),
            is_target: n == target,
        })
        .collect()
}

fn render_review_md(pr_title: Option<&str>, comments: &[RenderComment]) -> String {
    let mut out = String::new();
    out.push_str("# Code Review\n\n");
    out.push_str(
        "> Generated by Guided Review. Each item below is a review comment to address.\n\n",
    );
    if let Some(title) = pr_title {
        if !title.is_empty() {
            out.push_str(&format!("**PR:** {title}\n\n"));
        }
    }

    let inline: Vec<&RenderComment> =
        comments.iter().filter(|c| c.file_path.is_some()).collect();
    let top: Vec<&RenderComment> =
        comments.iter().filter(|c| c.file_path.is_none()).collect();

    if !inline.is_empty() {
        out.push_str("## Inline comments\n\n");
        let mut files: Vec<&str> = Vec::new();
        for c in &inline {
            if let Some(f) = c.file_path.as_deref() {
                if !files.contains(&f) {
                    files.push(f);
                }
            }
        }
        for file in files {
            out.push_str(&format!("### {file}\n\n"));
            for c in inline.iter().filter(|c| c.file_path.as_deref() == Some(file)) {
                let loc = match (c.line, c.side.as_deref()) {
                    (Some(l), Some(s)) => format!("L{l} ({s})"),
                    (Some(l), None) => format!("L{l}"),
                    _ => "(file)".to_string(),
                };
                match c.title.as_deref() {
                    Some(t) if !t.is_empty() => {
                        out.push_str(&format!("- **{loc}** — {t}\n"))
                    }
                    _ => out.push_str(&format!("- **{loc}**\n")),
                }
                for bl in c.body.lines() {
                    out.push_str(&format!("  > {bl}\n"));
                }
                if !c.snippet.is_empty() {
                    out.push_str("\n  ```\n");
                    for sl in &c.snippet {
                        let marker = if sl.is_target { ">" } else { " " };
                        out.push_str(&format!("  {marker} {:>4}  {}\n", sl.number, sl.text));
                    }
                    out.push_str("  ```\n");
                }
                out.push('\n');
            }
        }
    }

    if !top.is_empty() {
        out.push_str("## General comments\n\n");
        for c in &top {
            if let Some(t) = c.title.as_deref() {
                if !t.is_empty() {
                    out.push_str(&format!("- **{t}**\n"));
                }
            }
            for bl in c.body.lines() {
                out.push_str(&format!("  > {bl}\n"));
            }
            out.push('\n');
        }
    }

    out
}

pub fn write_review_md(args: &WriteReviewMdArgs) -> Result<String> {
    let mut rendered: Vec<RenderComment> = Vec::new();
    for c in &args.comments {
        let snippet = match (c.file_path.as_deref(), c.line) {
            (Some(file), Some(line)) => {
                let refspec = if c.side.as_deref() == Some("LEFT") {
                    &args.base_ref
                } else {
                    &args.head_ref
                };
                match get_file_at_ref(&args.repo_path, file, refspec) {
                    Ok(Some(content)) => snippet_around(&content, line),
                    _ => Vec::new(),
                }
            }
            _ => Vec::new(),
        };
        rendered.push(RenderComment {
            title: c.title.clone(),
            body: c.body.clone(),
            file_path: c.file_path.clone(),
            line: c.line,
            side: c.side.clone(),
            snippet,
        });
    }

    let content = render_review_md(args.pr_title.as_deref(), &rendered);
    let path = args.repo_path.join("REVIEW.md");
    std::fs::write(&path, content)?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snippet_around_centers_and_clamps() {
        let content = "one\ntwo\nthree\nfour";
        let mid = snippet_around(content, 2);
        assert_eq!(mid.len(), 3);
        assert_eq!(mid[0].number, 1);
        assert!(mid[1].is_target);
        assert_eq!(mid[1].text, "two");

        let first = snippet_around(content, 1);
        assert_eq!(first.len(), 2);
        assert!(first[0].is_target);

        let last = snippet_around(content, 4);
        assert_eq!(last.len(), 2);
        assert!(last[1].is_target);
        assert_eq!(last[1].text, "four");
    }

    #[test]
    fn render_groups_inline_by_file_and_lists_general() {
        let comments = vec![
            RenderComment {
                title: Some("Null check".to_string()),
                body: "Guard this.".to_string(),
                file_path: Some("src/a.ts".to_string()),
                line: Some(24),
                side: Some("RIGHT".to_string()),
                snippet: snippet_around("a\nb\nc", 2),
            },
            RenderComment {
                title: None,
                body: "Split the PR.".to_string(),
                file_path: None,
                line: None,
                side: None,
                snippet: Vec::new(),
            },
        ];
        let out = render_review_md(Some("My PR"), &comments);
        assert!(out.contains("**PR:** My PR"));
        assert!(out.contains("### src/a.ts"));
        assert!(out.contains("L24 (RIGHT)"));
        assert!(out.contains("Guard this."));
        assert!(out.contains("## General comments"));
        assert!(out.contains("Split the PR."));
    }

    #[test]
    fn render_handles_no_comments() {
        let out = render_review_md(None, &[]);
        assert!(out.contains("# Code Review"));
        assert!(!out.contains("## Inline comments"));
        assert!(!out.contains("## General comments"));
    }
}
```

- [ ] **Step 2: Register the module**

In `src-tauri/src/lib.rs`, add `mod review_md;` after `mod repo;`:

```rust
mod repo;
mod review_md;
mod review_persistence;
```

- [ ] **Step 3: Run the Rust tests to verify they pass**

Run: `cd src-tauri && cargo test review_md`
Expected: PASS (3 tests in `review_md::tests`).

- [ ] **Step 4: Add the Tauri command**

In `src-tauri/src/commands.rs`, add near the other `use crate::...` imports at the top:

```rust
use crate::review_md::{write_review_md, WriteReviewMdArgs};
```

Add the command next to `get_changed_ranges_cmd` (before the `#[cfg(test)]` module):

```rust
#[tauri::command]
pub async fn write_review_md_cmd(
    args: WriteReviewMdArgs,
    telemetry_context: Option<TelemetryContext>,
) -> Result<String, String> {
    let span = command_span("write_review_md_cmd", telemetry_context.as_ref());
    async move {
        tokio::task::spawn_blocking(move || write_review_md(&args))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())
    }
    .instrument(span)
    .await
}
```

- [ ] **Step 5: Register the command in the handler**

In `src-tauri/src/lib.rs`, add to `tauri::generate_handler![ ... ]` after `get_changed_ranges_cmd,`:

```rust
            get_changed_ranges_cmd,
            write_review_md_cmd,
```

- [ ] **Step 6: Build the Rust side to verify it compiles**

Run: `cd src-tauri && cargo test`
Expected: PASS (all crate tests, including the new module).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/review_md.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "Add write_review_md host command"
```

---

### Task 5: `writeReviewMd` frontend binding (acp.ts)

**Files:**
- Modify: `src/lib/acp.ts`

- [ ] **Step 1: Extend the imports**

In `src/lib/acp.ts`, add `CommentKind` and `CommentSide` to the type import from `./types/section`:

```ts
import type {
	CommentDraft,
	CommentKind,
	CommentResult,
	CommentSide,
	LineRange,
	ReviewSection,
	SectionMap,
	SectionProgressUpdate,
} from "./types/section";
```

- [ ] **Step 2: Add the binding**

In the `acp` object, after `getChangedRanges`, add:

```ts
	writeReviewMd: (args: {
		repo_path: string;
		base_ref: string;
		head_ref: string;
		pr_title?: string | null;
		comments: {
			kind: CommentKind;
			title?: string;
			body: string;
			file_path?: string;
			line?: number;
			side?: CommentSide;
		}[];
	}) => invokeWithTelemetry<string>("write_review_md_cmd", { args }),
```

- [ ] **Step 3: Typecheck**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/acp.ts
git commit -m "Add writeReviewMd Tauri binding"
```

---

### Task 6: `selectPeekLines` pure helper

**Files:**
- Create: `src/lib/codePeek.ts`
- Test: `src/lib/codePeek.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/codePeek.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { selectPeekLines } from "./codePeek";

test("selectPeekLines centers on the target line", () => {
	const lines = selectPeekLines("one\ntwo\nthree\nfour", 2);
	assert.deepEqual(
		lines.map((l) => [l.number, l.text, l.isTarget]),
		[
			[1, "one", false],
			[2, "two", true],
			[3, "three", false],
		],
	);
});

test("selectPeekLines clamps at file start", () => {
	const lines = selectPeekLines("one\ntwo\nthree", 1);
	assert.equal(lines.length, 2);
	assert.equal(lines[0]?.isTarget, true);
});

test("selectPeekLines clamps at file end", () => {
	const lines = selectPeekLines("one\ntwo\nthree", 3);
	assert.equal(lines.length, 2);
	assert.equal(lines[1]?.isTarget, true);
	assert.equal(lines[1]?.text, "three");
});

test("selectPeekLines returns nothing for invalid input", () => {
	assert.deepEqual(selectPeekLines("", 1), []);
	assert.deepEqual(selectPeekLines("a\nb", 0), []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `./codePeek` cannot be found.

- [ ] **Step 3: Implement the helper**

Create `src/lib/codePeek.ts`:

```ts
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
```

- [ ] **Step 4: Run the test + typecheck**

Run: `npm test && npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/codePeek.ts src/lib/codePeek.test.ts
git commit -m "Add selectPeekLines helper for code peeks"
```

---

### Task 7: `CodePeek` component

**Files:**
- Create: `src/components/CodePeek.tsx`

- [ ] **Step 1: Implement the component**

Create `src/components/CodePeek.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useApp } from "@/lib/store";
import { acp } from "@/lib/acp";
import { selectPeekLines, type PeekLine } from "@/lib/codePeek";
import { cn } from "@/lib/utils";
import type { CommentDraft } from "@/lib/types/section";

const peekCache = new Map<string, string>();

export function CodePeek({ comment }: { comment: CommentDraft }) {
	const session = useApp((s) => s.session);
	const [lines, setLines] = useState<PeekLine[] | null>(null);
	const [error, setError] = useState(false);

	const filePath = comment.file_path;
	const line = comment.line;
	const refspec =
		comment.side === "LEFT" ? session?.repo.base_ref : session?.repo.head_ref;
	const repoPath = session?.repo.path;

	useEffect(() => {
		if (!repoPath || !filePath || !line || !refspec) return;
		let cancelled = false;
		const key = `${repoPath}::${filePath}::${refspec}`;
		(async () => {
			try {
				let content = peekCache.get(key);
				if (content === undefined) {
					const fetched = await acp.getFileAtRef({
						repo_path: repoPath,
						file_path: filePath,
						refspec,
					});
					content = fetched ?? "";
					peekCache.set(key, content);
				}
				if (!cancelled) setLines(selectPeekLines(content, line));
			} catch {
				if (!cancelled) setError(true);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [repoPath, filePath, line, refspec]);

	if (!filePath || !line) return null;
	if (error) {
		return (
			<div className="px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
				code unavailable
			</div>
		);
	}
	if (!lines) {
		return (
			<div className="px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
				loading…
			</div>
		);
	}
	return (
		<pre className="overflow-x-auto bg-background/60 py-1.5 font-mono text-[11px] leading-relaxed">
			{lines.map((l) => (
				<div
					key={l.number}
					className={cn(
						"px-3",
						l.isTarget && "bg-primary/15 border-l-2 border-primary",
					)}
				>
					<span className="mr-3 inline-block w-8 select-none text-right text-muted-foreground">
						{l.number}
					</span>
					<span className="text-foreground/90">{l.text || " "}</span>
				</div>
			))}
		</pre>
	);
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/CodePeek.tsx
git commit -m "Add CodePeek component"
```

---

### Task 8: Mark toggle on the comment card (CommentDraftCard)

**Files:**
- Modify: `src/components/CommentDraftCard.tsx`

- [ ] **Step 1: Replace approve with a mark toggle**

Rewrite `src/components/CommentDraftCard.tsx` to this:

```tsx
import { useEffect, useState } from "react";
import { useApp, type CommentDraftState } from "@/lib/store";
import { stripMarkdownForSummary } from "@/lib/markdownContent";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Check, ChevronDown, ChevronRight, Pencil, X } from "lucide-react";

export function CommentDraftCard({ state }: { state: CommentDraftState }) {
	const setCommentMarked = useApp((s) => s.setCommentMarked);
	const editCommentDraftBody = useApp((s) => s.editCommentDraftBody);
	const dismissCommentDraft = useApp((s) => s.dismissCommentDraft);
	const [expanded, setExpanded] = useState(state.status === "error");
	const [editing, setEditing] = useState(false);
	const [editBody, setEditBody] = useState(state.draft.body);
	const isPublished = state.status === "published";
	const isPublishing = state.status === "publishing";
	const canEdit = !isPublished && !isPublishing;
	const editedBodyIsEmpty = editBody.trim().length === 0;
	const headerTitle =
		state.draft.title?.trim() || deriveFallbackTitle(state.draft.body);

	useEffect(() => {
		if (state.status === "error") setExpanded(true);
	}, [state.status]);

	function startEditing() {
		setEditBody(state.draft.body);
		setEditing(true);
		setExpanded(true);
	}

	function cancelEditing() {
		setEditBody(state.draft.body);
		setEditing(false);
	}

	function saveEdit() {
		if (editedBodyIsEmpty) return;
		editCommentDraftBody(state.id, editBody);
		setEditing(false);
	}

	return (
		<Card
			className={cardClassName(state.marked)}
		>
			<button
				type="button"
				onClick={() => setExpanded((v) => !v)}
				aria-expanded={expanded}
				className="flex w-full items-center gap-2 text-left"
			>
				{expanded ? (
					<ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
				) : (
					<ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
				)}
				<span className="text-[10px] uppercase tracking-wider text-primary shrink-0">
					{state.draft.kind === "inline" ? "Inline" : "Top-level"}
				</span>
				<span className="min-w-0 flex-1 truncate text-sm font-medium">
					{headerTitle}
				</span>
				{state.marked && (
					<Check className="size-3.5 shrink-0 text-primary" aria-label="Marked for review" />
				)}
				<span className="text-[10px] uppercase tracking-wider text-muted-foreground shrink-0">
					{state.status}
				</span>
			</button>
			{expanded && (
				<div className="mt-2 space-y-1.5">
					<div className="flex items-center justify-end gap-1.5">
						{canEdit && !editing && (
							<Button
								type="button"
								size="icon"
								variant="ghost"
								className="size-6 text-muted-foreground hover:text-foreground"
								onClick={startEditing}
								aria-label="Edit comment draft"
								title="Edit comment draft"
							>
								<Pencil className="size-3.5" />
							</Button>
						)}
						{!editing && canEdit && (
							<Button
								type="button"
								size="icon"
								variant="ghost"
								className="size-6 text-muted-foreground hover:text-foreground"
								onClick={() => dismissCommentDraft(state.id)}
								aria-label="Discard comment draft"
							>
								<X className="size-3.5" />
							</Button>
						)}
					</div>
					{state.draft.kind === "inline" && (
						<div className="font-mono text-[11px] text-muted-foreground">
							{state.draft.file_path}:{state.draft.line}
							{state.draft.side ? ` (${state.draft.side})` : ""}
						</div>
					)}
					{editing && canEdit ? (
						<div className="space-y-2">
							<Textarea
								value={editBody}
								onChange={(event) => setEditBody(event.target.value)}
								aria-label="Comment body"
								className="min-h-24"
							/>
							<div className="flex gap-2">
								<Button size="sm" onClick={saveEdit} disabled={editedBodyIsEmpty}>
									Save
								</Button>
								<Button size="sm" variant="outline" onClick={cancelEditing}>
									Cancel
								</Button>
							</div>
						</div>
					) : (
						<div className="whitespace-pre-wrap text-sm">{state.draft.body}</div>
					)}
					{state.url && (
						<a
							className="inline-block text-xs text-[oklch(0.7_0.16_155)]"
							href={state.url}
							target="_blank"
							rel="noreferrer"
						>
							View on GitHub
						</a>
					)}
					{state.error && (
						<div className="text-xs text-destructive">{state.error}</div>
					)}
					{!editing && !isPublished && (
						<div className="flex pt-1">
							<Button
								size="sm"
								variant={state.marked ? "secondary" : "default"}
								onClick={() => setCommentMarked(state.id, !state.marked)}
								disabled={isPublishing}
							>
								{state.marked ? "Marked for review" : "Mark for review"}
							</Button>
						</div>
					)}
				</div>
			)}
		</Card>
	);
}

function cardClassName(marked: boolean): string {
	return marked
		? "bg-primary/10 border-primary px-2 py-1.5"
		: "bg-primary/5 border-primary/30 px-2 py-1.5";
}

function deriveFallbackTitle(body: string): string {
	const plain = stripMarkdownForSummary(body);
	if (!plain) return "(empty comment)";
	const words = plain.split(/\s+/).filter(Boolean);
	if (words.length === 0) return "(empty comment)";
	const head = words.slice(0, 5).join(" ");
	return words.length > 5 ? `${head}…` : head;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run check`
Expected: PASS. (Note: `approveCommentDraft` is no longer imported here; it still exists in `commentPublish.ts` and is removed in Task 9.)

- [ ] **Step 3: Commit**

```bash
git add src/components/CommentDraftCard.tsx
git commit -m "Replace approve with mark-for-review toggle on comment card"
```

---

### Task 9: Simplify the Comments inbox footer + remove dead publish code (SectionList, commentPublish)

**Files:**
- Modify: `src/components/SectionList.tsx`
- Modify: `src/lib/commentPublish.ts` (remove the old approve/publish exports)
- Modify: `src/lib/commentPublish.test.ts` (remove the old tests)

- [ ] **Step 1: Replace the footer and trim imports in SectionList**

In `src/components/SectionList.tsx`, replace the imports block (lines 1-16) with:

```tsx
import { useCallback } from "react";
import { useApp, type SectionState } from "@/lib/store";
import { cn } from "@/lib/utils";
import { LoaderCircle } from "lucide-react";
import { stripMarkdownForSummary } from "@/lib/markdownContent";
import { MarkdownViewer } from "./MarkdownViewer";
import { FeedbackList } from "./Concerns";
import { CommentDraftCard } from "./CommentDraftCard";
import { createDiffFocusRange } from "@/lib/diffFocus";
import type { Concern } from "@/lib/types/section";
```

Then replace the entire `CommentDraftsFooter` function with:

```tsx
function CommentDraftsFooter() {
	const drafts = useApp((s) => s.commentDrafts);
	const markedCount = drafts.filter((d) => d.marked).length;

	return (
		<div className="flex max-h-[45%] flex-col border-t border-border bg-card/50">
			<div className="flex items-center justify-between border-b border-border px-4 py-2 text-sm font-semibold text-muted-foreground">
				<span>Comments</span>
				<span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">
					{markedCount}/{drafts.length} marked
				</span>
			</div>
			<div className="flex flex-col gap-2 overflow-y-auto px-3 py-2">
				{drafts.map((d) => (
					<CommentDraftCard key={d.id} state={d} />
				))}
			</div>
		</div>
	);
}
```

(The `useState`, `acp`, `Button`, `prTargetFromSessionSource`, and `requestAgentPublishApprovedDrafts` imports are now gone — they were only used by the old footer.)

- [ ] **Step 2: Remove the dead exports from commentPublish.ts**

In `src/lib/commentPublish.ts`, delete `AGENT_COMMENT_PUBLISHING_INSTRUCTIONS`, `buildAgentPublishCommentPrompt`, `approvedCommentDrafts`, `approveCommentDraft`, `requestAgentPublishApprovedDrafts`, and the now-unused `CommentDraftStatusPatch` type. Keep `prTargetFromSessionSource`, `sendMessageTelemetryAttrs`, `errorMessage`, `ReviewSubmitEvent`, `buildAgentPublishReviewPrompt`, and `requestAgentPublishReview`.

- [ ] **Step 3: Remove the old tests**

In `src/lib/commentPublish.test.ts`, delete the imports of `buildAgentPublishCommentPrompt` and `requestAgentPublishApprovedDrafts` and the three tests that use them (`buildAgentPublishCommentPrompt includes all approved drafts`, `requestAgentPublishApprovedDrafts sends one private agent publish prompt`, `requestAgentPublishApprovedDrafts restores approved drafts when send fails`). Keep the `sendMessageTelemetryAttrs` test and the Task 3 tests. The top import becomes:

```ts
import { sendMessageTelemetryAttrs } from "./commentPublish";
```

(The Task 3 tests use dynamic `import("./commentPublish")`, so they need no static import.)

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test && npm run check`
Expected: PASS — no unused-import or missing-export errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/SectionList.tsx src/lib/commentPublish.ts src/lib/commentPublish.test.ts
git commit -m "Simplify comments inbox and remove old approve/publish path"
```

---

### Task 10: `SubmitReviewButton` split button

**Files:**
- Create: `src/components/SubmitReviewButton.tsx`

- [ ] **Step 1: Implement the component**

Create `src/components/SubmitReviewButton.tsx`:

```tsx
import { useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, LoaderCircle } from "lucide-react";
import { useApp } from "@/lib/store";
import { acp } from "@/lib/acp";
import {
	prTargetFromSessionSource,
	requestAgentPublishReview,
	type ReviewSubmitEvent,
} from "@/lib/commentPublish";
import { cn } from "@/lib/utils";

type Mode = "comment" | "approve" | "review_md";

const MODES: { id: Mode; label: string; description: string; github: boolean }[] = [
	{
		id: "comment",
		label: "Submit comments to GitHub",
		description: "Posts the marked comments as a PR review. No approval.",
		github: true,
	},
	{
		id: "approve",
		label: "Approve and submit",
		description: "Approves the PR and posts the marked comments.",
		github: true,
	},
	{
		id: "review_md",
		label: "Write comments to REVIEW.md",
		description: "Generates a local file in the repo for an AI to read and fix.",
		github: false,
	},
];

export function SubmitReviewButton() {
	const session = useApp((s) => s.session);
	const drafts = useApp((s) => s.commentDrafts);
	const updateCommentDraft = useApp((s) => s.updateCommentDraft);
	const pushError = useApp((s) => s.pushError);

	const marked = drafts.filter((d) => d.marked);
	const target = prTargetFromSessionSource(session?.source);
	const githubAvailable = !!target;
	const [mode, setMode] = useState<Mode>("comment");
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState<string | null>(null);

	const effectiveMode: Mode = githubAvailable ? mode : "review_md";
	const disabled = busy || marked.length === 0 || !session;

	async function run() {
		if (!session || disabled) return;
		setBusy(true);
		setDone(null);
		try {
			if (effectiveMode === "review_md") {
				const path = await acp.writeReviewMd({
					repo_path: session.repo.path,
					base_ref: session.repo.base_ref,
					head_ref: session.repo.head_ref,
					pr_title: session.pull_request?.title ?? null,
					comments: marked.map((d) => ({
						kind: d.draft.kind,
						title: d.draft.title,
						body: d.draft.body,
						file_path: d.draft.file_path,
						line: d.draft.line,
						side: d.draft.side,
					})),
				});
				setDone(`Wrote ${path}`);
			} else {
				if (!target) {
					pushError("No PR to submit to.");
					return;
				}
				const event: ReviewSubmitEvent =
					effectiveMode === "approve" ? "APPROVE" : "COMMENT";
				await requestAgentPublishReview({
					session_id: session.session_id,
					target,
					head_sha: session.repo.head_sha,
					event,
					comments: marked,
					updateCommentDraft,
					sendMessage: acp.sendMessage,
				});
				setDone(
					event === "APPROVE"
						? "Approval + comments sent to the agent."
						: "Comments sent to the agent.",
				);
			}
		} catch (e) {
			pushError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="space-y-2">
			<div className="inline-flex overflow-hidden rounded-md border border-[oklch(0.5_0.15_155)]">
				<button
					type="button"
					onClick={run}
					disabled={disabled}
					className="inline-flex items-center gap-2 bg-[oklch(0.6_0.15_155)] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[oklch(0.55_0.15_155)] disabled:opacity-50"
				>
					{busy && <LoaderCircle className="size-3.5 animate-spin" />}
					Submit review
				</button>
				<DropdownMenu.Root>
					<DropdownMenu.Trigger asChild>
						<button
							type="button"
							disabled={busy}
							aria-label="Choose submit mode"
							className="flex items-center border-l border-[oklch(0.5_0.15_155)] bg-[oklch(0.6_0.15_155)] px-2 text-white transition-colors hover:bg-[oklch(0.55_0.15_155)] disabled:opacity-50"
						>
							<ChevronDown className="size-4" />
						</button>
					</DropdownMenu.Trigger>
					<DropdownMenu.Portal>
						<DropdownMenu.Content
							align="start"
							sideOffset={6}
							className="z-50 w-[360px] rounded-lg border border-border bg-card p-1 shadow-xl"
						>
							{MODES.map((m) => {
								const itemDisabled = m.github && !githubAvailable;
								const active = effectiveMode === m.id;
								return (
									<DropdownMenu.Item
										key={m.id}
										disabled={itemDisabled}
										onSelect={(event) => {
											event.preventDefault();
											if (!itemDisabled) setMode(m.id);
										}}
										className={cn(
											"flex cursor-pointer gap-2 rounded-md px-3 py-2 text-sm outline-none data-[highlighted]:bg-accent",
											itemDisabled && "cursor-not-allowed opacity-40",
										)}
									>
										<span className="mt-0.5 w-4 shrink-0">
											{active && <Check className="size-4 text-primary" />}
										</span>
										<span className="min-w-0">
											<span className="block font-medium">{m.label}</span>
											<span className="block text-xs text-muted-foreground">
												{m.description}
												{itemDisabled ? " (no PR for this session)" : ""}
											</span>
										</span>
									</DropdownMenu.Item>
								);
							})}
						</DropdownMenu.Content>
					</DropdownMenu.Portal>
				</DropdownMenu.Root>
			</div>
			{marked.length === 0 && (
				<p className="text-xs text-muted-foreground">
					Mark at least one comment to submit.
				</p>
			)}
			{done && <p className="text-xs text-[oklch(0.75_0.15_155)]">{done}</p>}
		</div>
	);
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/SubmitReviewButton.tsx
git commit -m "Add Submit review split button"
```

---

### Task 11: `ReviewSummaryView` + wire it into the center panel

**Files:**
- Create: `src/components/ReviewSummaryView.tsx`
- Modify: `src/components/DiffView.tsx` (import + early-return branch)

- [ ] **Step 1: Implement ReviewSummaryView**

Create `src/components/ReviewSummaryView.tsx`:

```tsx
import { useApp } from "@/lib/store";
import { CodePeek } from "./CodePeek";
import { SubmitReviewButton } from "./SubmitReviewButton";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";

export function ReviewSummaryView() {
	const drafts = useApp((s) => s.commentDrafts);
	const setCommentMarked = useApp((s) => s.setCommentMarked);
	const marked = drafts.filter((d) => d.marked);

	return (
		<section className="flex h-full min-h-0 min-w-0 flex-col overflow-y-auto">
			<header className="border-b border-border bg-card/40 px-6 py-4">
				<h2 className="text-base font-semibold">Review Summary</h2>
				<p className="mt-1 text-sm text-muted-foreground">
					{marked.length === 0
						? "No comments marked yet."
						: `${marked.length} comment${marked.length === 1 ? "" : "s"} marked for this review.`}
				</p>
			</header>
			<div className="flex flex-1 flex-col gap-4 p-6">
				{marked.length === 0 ? (
					<div className="rounded-md border border-border bg-card/40 px-4 py-6 text-center text-sm text-muted-foreground">
						Mark comments from the Comments list to include them in the review.
					</div>
				) : (
					marked.map((d) => (
						<div
							key={d.id}
							className="overflow-hidden rounded-lg border border-border bg-card"
						>
							<div className="flex items-center gap-2 border-b border-border bg-card/60 px-3 py-2">
								<span className="text-[10px] uppercase tracking-wider text-primary shrink-0">
									{d.draft.kind === "inline" ? "Inline" : "Top-level"}
								</span>
								<span className="min-w-0 flex-1 truncate text-sm font-medium">
									{d.draft.title?.trim() || d.draft.body.slice(0, 60)}
								</span>
								{d.draft.file_path && (
									<span className="font-mono text-[11px] text-muted-foreground shrink-0">
										{d.draft.file_path}:{d.draft.line}
									</span>
								)}
								{d.status === "published" ? (
									d.url ? (
										<a
											href={d.url}
											target="_blank"
											rel="noreferrer"
											className="text-[11px] text-[oklch(0.75_0.15_155)] shrink-0"
										>
											published ✓
										</a>
									) : (
										<span className="text-[11px] text-[oklch(0.75_0.15_155)] shrink-0">
											published ✓
										</span>
									)
								) : (
									<Button
										size="icon"
										variant="ghost"
										className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
										aria-label="Unmark comment"
										onClick={() => setCommentMarked(d.id, false)}
									>
										<X className="size-3.5" />
									</Button>
								)}
							</div>
							{d.draft.kind === "inline" && <CodePeek comment={d.draft} />}
							<div className="whitespace-pre-wrap px-3 py-2 text-sm">
								{d.draft.body}
							</div>
							{d.status === "publishing" && (
								<div className="px-3 pb-2 text-xs text-muted-foreground">
									Publishing…
								</div>
							)}
							{d.status === "error" && d.error && (
								<div className="px-3 pb-2 text-xs text-destructive">{d.error}</div>
							)}
						</div>
					))
				)}
			</div>
			<div className="border-t border-border bg-card/40 px-6 py-4">
				<SubmitReviewButton />
			</div>
		</section>
	);
}
```

- [ ] **Step 2: Wire it into DiffPane**

In `src/components/DiffView.tsx`, add the import near the other component imports (after the `MarkdownViewer` import):

```tsx
import { ReviewSummaryView } from "./ReviewSummaryView";
```

Then, in `DiffPane`, immediately after the `if (current.kind === "pr_description") { ... }` block (around line 744) and before `if (current && !section) {`, add:

```tsx
	if (current.kind === "review_summary") {
		return <ReviewSummaryView />;
	}
```

- [ ] **Step 3: Typecheck**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/ReviewSummaryView.tsx src/components/DiffView.tsx
git commit -m "Render Review Summary in the center panel"
```

---

### Task 12: Document the review event in the agent protocol + full verification

**Files:**
- Modify: `src-tauri/agent-skill.md`

- [ ] **Step 1: Document the review event**

In `src-tauri/agent-skill.md`, in the `## Workflow` list, replace item 6 with:

```markdown
6. When the host asks you to publish, it may request that you submit the marked comments as a **single pull request review** with a specific event: `COMMENT` (comment only, do not approve) or `APPROVE` (approve the PR and include the comments). Create one review with that event using your own GitHub tools and auth. After each draft is attempted, emit one ` ```acp-comment-result ` block with that draft's result.
```

In the `### ` ```acp-comment-result ` ` section, after the first sentence, add:

```markdown
When the host requested an `APPROVE` review event, submit the review as an approval; otherwise submit it as a plain comment review. Either way, emit one `acp-comment-result` per draft.
```

- [ ] **Step 2: Full verification**

Run each and confirm output:

```bash
npm run check
```
Expected: no type errors.

```bash
npm test
```
Expected: all tests pass (store, codePeek, commentPublish, and existing suites).

```bash
cd src-tauri && cargo test && cd ..
```
Expected: all Rust tests pass (including `review_md::tests`).

- [ ] **Step 3: Manual verification (`npm run tauri -- dev`)**

Walk through:
1. Start a review on a local PR checkout; let sections load. Confirm **Review Summary** is the last row in the left Sections list.
2. Ask the agent to leave a couple of comments. In the **Comments** inbox (bottom-left), expand a comment and click **Mark for review**; confirm the check appears and the inbox count updates.
3. Click **Review Summary**: the center panel shows each marked comment with a 3-line code peek (target line highlighted) and an unmark ✕. Unmark one; it disappears.
4. Open the **Submit review** dropdown: confirm three options with a check on "Submit comments to GitHub". Pick **Write comments to REVIEW.md**, click **Submit review**, confirm `Wrote …/REVIEW.md` and that the file exists with grouped comments + snippets.
5. (If a real PR + `gh` auth) Try **Submit comments to GitHub**; confirm comments go to "publishing" then "published ✓" with links and stay listed.
6. For a non-PR session (branch/local), confirm the two GitHub options are disabled and REVIEW.md still works.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/agent-skill.md
git commit -m "Document single-review submit event in agent protocol"
```

---

## Self-Review

**Spec coverage:**
- Mark replaces approve → Tasks 1, 8, 9. ✓
- Review Summary in center, pinned last, empty state, submit disabled until marked → Tasks 2, 10, 11. ✓
- 3-line peek (head/base by side, top-level none, clamp, unavailable) → Tasks 6, 7. ✓
- Submit modes (COMMENT/APPROVE via agent; REVIEW.md host-side) → Tasks 3, 4, 5, 10. ✓
- Post-submit keeps comments with published badge → Task 1 (`applyCommentResult`), Task 11 (badge). ✓
- No-PR-target disables GitHub modes → Task 10. ✓
- Persistence of `marked` + legacy normalization → Tasks 1, 2. ✓
- Agent protocol doc → Task 12. ✓

**Placeholder scan:** none — every code step has full code and exact commands.

**Type consistency:** `marked: boolean` and `setCommentMarked(id, marked)` used identically across store, card, summary, submit button. `ReviewSubmitEvent`/`requestAgentPublishReview`/`buildAgentPublishReviewPrompt` signatures match between Task 3 and Task 10. `WriteReviewMdArgs`/`ReviewMdComment` (Rust) mirror the `acp.writeReviewMd` arg shape (Task 5) and the `SubmitReviewButton` call (Task 10). `selectPeekLines`/`PeekLine` match between Task 6 and Task 7. `REVIEW_SUMMARY_SECTION_ID`/`review_summary` kind consistent across Tasks 2 and 11.
