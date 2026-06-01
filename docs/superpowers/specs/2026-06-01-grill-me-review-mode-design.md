# Grill-Me Review Mode Design

## Summary

Add a true alternative review mode for PRs called "Grill-me". It is separate from the current section-based walkthrough. Instead of generating a section map and auto-loading section feedback, the agent asks one design-review question at a time. Each question owns the related diff context, the user answers in chat, and answers that disagree with the PR's current choice are stored as unapproved comment drafts for later submission.

This is a design spec only. It does not prescribe implementation sequencing.

## Goals

- Let the user choose between the existing section review and the new grill-me review before starting a PR session.
- In grill-me mode, ask one question at a time.
- For each question, show what the PR currently does and the related diff.
- If the answer can be found by inspecting the repository, the agent should inspect the repository instead of asking the user.
- If the user's answer disagrees with the PR's choice, create a comment draft automatically.
- Reuse the existing comment draft approval and publishing flow. Nothing is published without user approval.
- Persist grill-me progress in saved PR review state.

## Non-Goals

- Do not replace section-based reviews.
- Do not add host-side GitHub publishing. Publishing remains delegated to the agent through existing `acp-comment-result` handling.
- Do not build a generic custom prompt system.
- Do not require the agent to reveal its full decision tree up front.
- Do not store private agent reasoning.

## Product Behavior

The launcher gets a review mode control with two options:

- `Sections`: current behavior.
- `Grill-me`: question-driven review.

Starting a grill-me review launches the same ACP session type, but sends a different kickoff prompt and expects grill-specific structured blocks. The first visible agent output is one grill question, not a section map.

A grill question appears in the left pane as the selected review item. The diff pane shows only the files and ranges attached to that question. The chat pane shows the question and accepts the user's answer. After the answer, the agent either:

- asks the next question,
- creates one or more comment drafts because the answer disagrees with the PR choice,
- explains that the answer agrees with the PR choice, then asks the next question,
- or marks the grill-me review complete.

The agent should not ask questions that can be answered by reading the diff or surrounding code. For those, it should inspect the code and move on to the next unresolved decision.

## Agent Protocol

Keep existing section tags unchanged. Add grill-specific tags so the host can route mode-specific state without overloading `acp-section`.

### `acp-grill-question`

Emitted when the agent asks the next question.

```json
{
  "schema_version": 1,
  "question_id": "error-boundary-policy",
  "title": "Error boundary policy",
  "question": "Should this path fail closed when the agent returns malformed JSON?",
  "pr_choice": "The PR currently falls back to an empty concern list and continues the review.",
  "recommended_answer": "Yes, fail closed for protocol errors that make the review state ambiguous.",
  "files": ["src-tauri/src/fenced.rs"],
  "ranges": [
    {
      "file_path": "src-tauri/src/fenced.rs",
      "start_line": 120,
      "end_line": 140,
      "kind": "changed-new"
    }
  ]
}
```

Rules:

- `question_id`, `title`, `question`, `pr_choice`, `recommended_answer`, and `files` are required. `files` may be an empty array only for PR-level questions with no narrower diff context.
- `ranges` is optional. If omitted, the host enriches the question with local changed ranges for `files`.
- `pr_choice` is the concise "what has been done in the PR" text shown with the question.
- `recommended_answer` is the agent's current best answer before the user responds.
- The agent emits exactly one question per turn.

### `acp-grill-answer`

Optional structured summary emitted after processing a user answer.

```json
{
  "schema_version": 1,
  "question_id": "error-boundary-policy",
  "answer_summary": "The user wants malformed protocol output to fail closed.",
  "agrees_with_pr": false,
  "comment_draft_ids": ["draft-123"]
}
```

Rules:

- The host can operate without this block, but it is useful for persisted history and UI status.
- `comment_draft_ids` links disagreement summaries to existing comment drafts emitted through `acp-comment-draft`.
- The host treats comment drafts as the source of truth for what will be submitted.

### `acp-grill-complete`

Emitted when the agent has no more useful questions.

```json
{
  "schema_version": 1,
  "summary": "All design branches were resolved. Two disagreements are saved as comment drafts."
}
```

## Agent Prompt

The host keeps `src-tauri/agent-skill.md` as the section-mode contract and adds a parallel grill-me contract, either in the same file behind mode headings or as a separate embedded markdown file.

The grill-me kickoff includes:

- repo path, base ref, head ref, PR metadata, and published comment context,
- instruction to privately form a decision tree but emit only the next question,
- instruction to inspect code instead of asking answerable questions,
- instruction to provide `pr_choice` and `recommended_answer` for every question,
- instruction to emit `acp-comment-draft` when the user's answer disagrees with the PR choice,
- instruction to stop after each question or answer-handling turn.

The existing `guided_review_show_message` tool remains available for conversational text, but the question itself must be structured.

## Frontend State Model

Add a review mode field:

```ts
type ReviewMode = "sections" | "grill";
```

Store it on active session state and saved review snapshots.

Add grill item types alongside section state:

```ts
interface GrillQuestion {
  schema_version: 1;
  question_id: string;
  title: string;
  question: string;
  pr_choice: string;
  recommended_answer: string;
  files: string[];
  ranges: LineRange[];
  base_ref: string;
  head_ref: string;
  answer_summary?: string;
  agrees_with_pr?: boolean;
  comment_draft_ids?: string[];
}

type GrillQuestionStatus = "active" | "answered" | "commented" | "complete";
```

Extend the left-pane list model so it can render either:

- section review items in section mode,
- grill question items in grill mode.

Do not force grill questions through `ReviewSection`. They have different semantics: a section is a review grouping; a grill question is a decision checkpoint with a PR choice and answer.

## UI Design

The high-level layout stays the same: left navigation, center diff, right chat.

In grill mode:

- The left pane title changes from `Sections` to `Questions`.
- Each question row shows title, status, and a short summary of the question.
- The selected question expands to show `pr_choice`, `recommended_answer`, and answer status.
- The center pane loads the selected question's diff using the same file-at-ref and `@pierre/diffs` rendering path as section mode.
- The right chat pane is where the user answers.
- Comment drafts continue to appear in the existing footer.

The UI should not show a full future question tree. That would conflict with the one-question-at-a-time workflow and can become stale after answers.

## Diff Behavior

Grill questions use the same local diff ownership pattern as sections:

- Agent supplies `files`.
- Agent may supply `ranges`.
- Host enriches missing ranges with `get_changed_ranges_cmd`.
- Diff pane fetches old and new file contents from local git.
- Published comments and draft feedback annotations can reuse the existing annotation pipeline where applicable.

If a question has an empty `files` array, the host should still render the question in the left/chat panes and show an empty-state message in the diff pane. The agent should use file-less questions only when the decision is PR-level and no smaller diff context exists.

## Comment Draft Behavior

When a user answer disagrees with the PR choice, the agent emits `acp-comment-draft` using the existing format.

Defaults:

- Inline draft when the disagreement maps to a file and line.
- Top-level draft when the disagreement is architectural or spans files.
- Draft starts unapproved.
- User can edit, approve, dismiss, and submit through the existing flow.

The host should not try to infer disagreement itself. The agent owns that judgment because it has the question, answer, PR choice, and code context.

## Persistence

Saved review snapshots should include:

- `review_mode`,
- grill questions and statuses,
- current grill question id,
- comment drafts,
- published comments,
- PR metadata already stored today.

Backward compatibility:

- Existing saved reviews without `review_mode` default to `sections`.
- Existing section snapshots continue to load unchanged.
- Grill snapshots should not be resumed as section reviews.

History entries can initially keep the same display format. A later UI improvement can add a small mode badge.

## Backend Changes

Rust protocol types:

- Add `GrillQuestion`, `GrillAnswer`, and `GrillComplete` wire structs.
- Add Tauri events for `acp://grill-question`, `acp://grill-answer`, and `acp://grill-complete`.
- Extend `fenced.rs` to parse the new tags with the same strict-then-JSON5 parser used by section tags.
- Keep comment draft/result parsing unchanged.

Commands:

- `start_session_cmd` can stay mode-agnostic.
- No new process model is required.
- Section background task commands remain section-only.
- Grill mode uses the main ACP turn loop because question sequencing depends on user answers.

## Telemetry

Add mode-aware telemetry attributes where sessions and messages are started:

- `review.mode`
- `grill.question_id`
- `grill.question_count`
- `grill.agrees_with_pr`
- `grill.comment_draft_count`

Avoid logging full question, answer, or comment bodies unless existing privacy controls explicitly allow assistant text capture.

## Testing

Frontend unit tests:

- Launcher sends section kickoff for `sections` and grill kickoff for `grill`.
- Store defaults legacy snapshots to `sections`.
- Store persists and restores grill question state.
- Grill question events enrich ranges and select the first question.
- Diff pane renders grill question files without requiring `ReviewSection`.
- Comment drafts emitted during grill mode appear in the existing draft footer.

Rust tests:

- `fenced.rs` parses `acp-grill-question`, `acp-grill-answer`, and `acp-grill-complete`.
- Parser accepts JSON5 for grill blocks.
- Invalid grill payloads emit an error event without breaking existing section parsing.
- Embedded grill prompt contains examples of each required block.

Manual checks:

- Start a section review and confirm existing behavior is unchanged.
- Start a grill review and confirm the first visible item is a question.
- Answer in agreement and confirm no draft is created.
- Answer in disagreement and confirm an unapproved draft appears.
- Submit an approved draft and confirm existing publish flow still works.

## Implementation Notes

The main design constraint is to avoid pretending grill questions are sections. Sharing rendering helpers is useful, but the state type should remain distinct so future behavior can grow naturally.

Suggested code boundaries:

- `src/lib/types/grill.ts` for grill wire and store types.
- `src/lib/grillPayload.ts` for tool/fenced payload parsing, mirroring `reviewSectionPayload.ts`.
- Small mode-aware wrappers in `App.tsx` for event handling.
- A generic diff target adapter so `DiffPane` can render either selected section files or selected grill question files.
- A parallel prompt file or clearly separated section in `src-tauri/agent-skill.md`.

## Open Decisions

All known product decisions for the first version are resolved:

- Grill-me is a true separate mode.
- The agent emits one next question at a time.
- Disagreement creates unapproved comment drafts automatically.
- The agent owns the question-to-diff mapping through structured files and ranges.

Remaining implementation choices should be made during planning, not product design.
