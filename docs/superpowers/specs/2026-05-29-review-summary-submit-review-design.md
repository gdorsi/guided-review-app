# Review Summary & Submit Review — Design

## Goal

Add a way to curate which drafted comments belong to the review, collect them in a
final **Review Summary** section in the center panel, and submit the review three ways
(comment on GitHub, approve + comment, or write a local `REVIEW.md`).

## Current state

- The agent drafts comments via `acp-comment-draft` blocks. Each becomes a
  `CommentDraftState` in a flat `commentDrafts` array (`store.ts`).
- Comments are shown only in the **`CommentDraftsFooter`** at the bottom of the left
  `SectionList`, with an **Approve → "Submit approved comments"** flow that delegates
  publishing to the agent (`commentPublish.ts::requestAgentPublishApprovedDrafts`).
  `applyCommentResult` currently **removes** a draft when its result arrives.
- Sections live in `sections: SectionState[]`. `pr_description` is a synthetic *first*
  section (kind discriminator). Review sections come from the agent's section map.
- The center panel always renders `<DiffPane />` (`App.tsx`).
- `acp.getFileAtRef({ repo_path, file_path, refspec })` returns full file text at a ref.
- Comment drafts are persisted inside `ReviewSnapshot.comment_drafts`.

## Approved decisions

1. **Mark replaces Approve (option A).** "Mark as part of the review" is the selection
   mechanism. The left footer stays as the inbox of *all* drafted comments; each card
   gets a **mark/unmark** toggle (and keeps edit/discard). The old "Submit approved
   comments" button is removed — the only submit path is the **Submit review** button in
   Review Summary.
2. **Review Summary renders in the center panel** when selected (replacing the diff).
3. **Submit review** is a GitHub-style split button with three modes:
   - *Submit comments to GitHub* (default): host asks the agent to create **one PR review
     with event `COMMENT`** containing all marked comments.
   - *Approve and submit*: same, event `APPROVE`.
   - *Write comments to `REVIEW.md`*: the **host** writes `<repo>/REVIEW.md` directly via
     a new Tauri command (no agent round-trip).
4. **3-line code peek**: target line ±1, read from the reviewed version — `head_ref` for
   `RIGHT`/default side, `base_ref` for `LEFT`. Top-level comments show no peek.
5. **Review Summary always exists as the last section** (mirrors `pr_description` first),
   even when empty; **Submit review is disabled until ≥1 comment is marked**.
6. **After a successful GitHub submit**, marked comments **stay** in Review Summary with a
   "published ✓ + link" badge (record of what was sent) rather than vanishing.

## Data model

`CommentDraftState` (`store.ts`) gains a selection flag:

```ts
export interface CommentDraftState {
	id: string;
	draft: CommentDraft;
	marked: boolean;            // NEW — part of the review? default false
	status: "pending" | "publishing" | "published" | "error";  // lifecycle only
	url?: string;
	error?: string;
}
```

- `marked` is the selection (replaces "approved").
- `status` tracks publish lifecycle only. The legacy `"approved"`/`"rejected"` values are
  no longer produced. On **restore**, normalize each draft: if `marked` is missing, set
  `marked = (status === "approved")`; coerce legacy statuses to `"pending"`.

New section kind:

```ts
export interface ReviewSummarySectionState extends BaseSectionState {
	kind: "review_summary";
}
export type SectionState =
	| PrDescriptionSectionState
	| ReviewSectionState
	| ReviewSummarySectionState;
```

`REVIEW_SUMMARY_SECTION_ID = "review-summary"`.

### Keeping the summary pinned last

- `setSectionMap` and `restoreSavedReview` rebuild the array as
  `[prDescription?, ...reviewSections, reviewSummary]` (strip any existing summary first,
  append exactly one).
- `upsertSection` / `upsertSectionProgress` insert a *new* review section **before** the
  trailing `review_summary` (splice at the summary index) instead of pushing to the end.
- The summary is created when the section map first arrives (and on restore). It needs no
  chat session, no `sessionBySection` entry, and `setCurrentSection` may select it.

## UI

### Left inbox — `CommentDraftCard` / `CommentDraftsFooter`

- Replace the **Approve** button with a **Mark for review** toggle (checkbox-style; shows
  marked state with a check + accent border). Keep Edit and Discard.
- Remove the "Approved locally…" helper text and the **"Submit approved comments"** footer
  button. Footer header can show `N marked` count. Footer still lists *all* drafts.

### Review Summary — new `ReviewSummaryView` (center panel)

- Rendered by `App.tsx` in the center `Panel` when
  `currentSectionId === REVIEW_SUMMARY_SECTION_ID` (else `<DiffPane />`).
- Reads `commentDrafts.filter(d => d.marked)`. Empty state when none.
- Each comment card: type badge, title, `file:line`, **3-line code peek** (target line
  highlighted), comment body, **unmark ✕**. Top-level comments omit the peek.
  Published comments show a "published ✓ + GitHub link" badge and hide the unmark control.
- Footer: **Submit review** split button (see below).
- The summary also appears as a selectable row in `SectionList` (kind `review_summary`,
  rendered with a fixed title "Review Summary" and a marked-count subtitle).

### Code peek

- A `useCodePeek(comment)` hook: resolves `refspec` from `side`, calls `acp.getFileAtRef`,
  caches by `${file_path}@${refspec}`, returns the 3 lines around `line` (clamped to file
  bounds) or an `unavailable` flag. Pure line-window selection extracted as a testable
  function `selectPeekLines(allLines, line)` → `{ lines: {n, text, isTarget}[] }`.

### Submit review split button — `SubmitReviewButton`

- GitHub-style: primary button labeled **"Submit review"** + caret. Dropdown lists the 3
  modes, each with title + description, a checkmark on the **active** mode (default
  *Submit comments to GitHub*). Selecting a mode sets it active and closes; the primary
  button executes the active mode. (Radix dropdown menu — add
  `@radix-ui/react-dropdown-menu` if not already a dep; style to match `ui/`.)
- When there is **no PR target** (source kind not `pr`/`local_pr`), the two GitHub modes
  are disabled with a tooltip ("No PR to submit to"); `REVIEW.md` is always enabled, and
  the active mode falls back to `REVIEW.md`.
- Disabled entirely while a submit is in flight or when nothing is marked.

## Backend / wiring

### `commentPublish.ts`

- Add `requestAgentPublishReview({ session_id, target, head_sha, comments, event, sendMessage, updateCommentDraft })`
  where `event: "COMMENT" | "APPROVE"`. Sets each marked comment `status: "publishing"`,
  builds a prompt instructing the agent to create **one PR review** with the given event
  containing all the comments, and on error reverts status to `"pending"` with the error.
- `buildAgentPublishReviewPrompt` mirrors `buildAgentPublishCommentPrompt` but states the
  review event explicitly and "create a single review, do not approve unless event is
  APPROVE".
- Remove `requestAgentPublishApprovedDrafts`/`approveCommentDraft` (replaced).

### `applyCommentResult` (store)

- Change from **removing** the draft to **updating in place**: set
  `status: "published" | "error"`, `url`, `error`, keep `marked`. (Implements decision 6.)

### `REVIEW.md` — new Rust command

- `write_review_md_cmd(args: WriteReviewMdArgs) -> Result<String, String>` in
  `commands.rs`, writing `<repo_path>/REVIEW.md`, returning the written path.
- `WriteReviewMdArgs { repo_path, base_ref, head_ref, pr_title?, comments: Vec<ReviewMdComment> }`
  where `ReviewMdComment { kind, title?, body, file_path?, line?, side? }`.
- Content builder (pure fn `render_review_md(...)`, unit-tested): a title header
  (PR title / branch), inline comments **grouped by file** with `file:line`, the body, and
  a fenced snippet (3-line peek read via the existing `repo.rs` file-at-ref helper at the
  appropriate ref), then a "General comments" section for top-level comments. Format is
  optimized for a coding agent to read and act on.
- Frontend: `acp.writeReviewMd(args)`; on success show inline confirmation and (via
  `tauri-plugin-opener`) an "Open REVIEW.md" affordance.

### Agent protocol (`src-tauri/agent-skill.md`)

- Document that when the host asks to publish, it may request a **single PR review with a
  specific event** (`COMMENT` or `APPROVE`); the agent emits one `acp-comment-result` per
  draft as today.

## Persistence

- `marked` rides along in `ReviewSnapshot.comment_drafts` (no new fields needed).
- Restore normalizes drafts (legacy `approved` → `marked`) and ensures exactly one
  `review_summary` section pinned last.

## Edge cases & error handling

- No marked comments → empty Review Summary, Submit disabled.
- No PR target → GitHub modes disabled, `REVIEW.md` only.
- Code peek fetch returns null/throws → "code unavailable" placeholder.
- `line` near file start/end → clamp the 3-line window.
- Submit while publishing → button guarded/disabled.
- Published comments → badge + link, unmark hidden.

## Testing

- **TS (`npm test`)**: store — mark toggle, summary pinned last across
  setSectionMap/upsert/restore, restore normalization (legacy `approved` → `marked`),
  `applyCommentResult` updates in place; `selectPeekLines` clamping/centering;
  `buildAgentPublishReviewPrompt` for COMMENT vs APPROVE. Keep existing
  `sharedBoundaryLength`/streaming tests green.
- **Rust (`cargo test`)**: `render_review_md` — grouping by file, top-level section,
  snippet extraction, clamping, empty input.

## Out of scope (YAGNI)

- `REQUEST_CHANGES` event (only COMMENT + APPROVE).
- Editing comment bodies from within Review Summary (edit stays in the left inbox).
- Reordering comments or submitting a subset of the marked set.
