# Cognitive Review Itinerary Phase 1: Scratchpad, Hunk Summaries, and Adaptive Unified Diff

**Status**: Active (Solution Spec)

## Context

Code review is a comprehension-heavy activity, not merely defect-spotting. Reviewers must build understanding of a change before they can evaluate it well. Working memory is limited to approximately four chunks, and external memory aids (cognitive offloading) become more valuable as internal demand rises. Eye-tracking evidence shows that unified diff views produce lower visual strain than split views for bug detection tasks. Yet current review tools — including guided-review-app's existing section-based model — provide no structured scratchpad for organizing thoughts, no hunk-level summaries to reduce context-switching, and default to split diff with no adaptive context folding.

The repository already provides the right foundations: a single Zustand store (src/lib/store.ts), a review persistence layer using serde_json::Value (flexible to schema additions), a diff rendering component using @pierre/diffs (src/components/DiffView.tsx) with line annotation support, and a fenced-block protocol for agent communication (src-tauri/src/fenced.rs). This spec implements three high-priority features that upgrade guided-review-app from a section browser to a cognitive scaffolding tool.

## Solution

Three features implemented in order, each grounded in specific research evidence and codebase architecture:

### 1. Reviewer Scratchpad & Decision Log

**Evidence base**: Cognitive offloading (Risko & Gilbert) shows external memory aids become more valuable as internal demand rises. Review comprehension research (Gonçalves et al.) shows reviewers carry hypotheses, tests, and discussion-state across review sections.

**Implementation**: A new Zustand slice `scratchpad: Record<string, ScratchpadEntry>` keyed by section_id, with four editable fields: Hypothesis, Evidence Found, Unresolved Question, Draft Comment. Persisted as `scratchpad_entries` in the existing ReviewSnapshot JSON — no schema version bump needed because the Rust side stores snapshot as opaque serde_json::Value. The scratchpad panel renders as a collapsible tab within the right column (shared with ChatPanel). One-click conversion of a draft note to a PR comment reuses the existing CommentDraftCard and buildAgentPublishCommentPrompt.

### 2. Hunk Micro-Summaries & Rationale Cards

**Evidence base**: PR summaries reduce review time (Rastogi et al.). Comment usefulness research (Turzo, Widyasari) shows that concise, technically clear explanations with structured categories improve actionability. The seven explanation categories (Widyasari et al.) provide a template: observation, rationale, impact, suggestion.

**Implementation**: A new fenced block tag `acp-hunk-summary` added to fenced.rs. The frontend receives parsed summaries via a new store action and renders editable cards above each hunk in DiffView. Each card has four fields: What changed, Why it matters, What could break, Evidence/tests. Low-confidence text is italicized with a warning indicator. Before the agent learns the new block, the existing `additional_concerns_hint` field in StartSectionTaskRequest requests summaries as plain text — the frontend populates empty editable cards as a fallback.

### 3. Unified-First Adaptive Diff View

**Evidence base**: Direct eye-tracking evidence (Alcocer et al.) shows lower visual strain with unified diff for bug detection. Change blindness and visual-search theory (Simons, Wolfe) support minimizing forced left-right comparison when the evaluation task is semantic.

**Implementation**: Harden the existing `diffStyle: "unified"` default (line 328 of DiffView.tsx). Add a one-click split toggle stored in Zustand as `diffViewMode`. Implement hunk-level context folding via custom CSS/JS on the DiffView wrapper: unchanged lines beyond 3 context per hunk are collapsed by default with an 'Expand semantic context' button. This works on the rendered DOM, not the library internals, so it survives @pierre/diffs upgrades. Collapse state is per-hunk and stored in Zustand's `collapsedHunks`.

## Trade-offs & Rationale

| Decision | Rationale |
|---|---|
| Scratchpad as tab within ChatPanel, not separate panel | Reuses existing panel infrastructure, keeps diff area stable, collapsed by default |
| No schema version bump for scratchpad | Rust stores snapshot as serde_json::Value — additive fields without breaking deserialization are safer than coordinated version bumps |
| Hunk folding via CSS/JS on rendered DOM, not library API | @pierre/diffs lacks per-hunk collapse; DOM-level approach is fast, maintainable, and survives upgrades |
| Agent fallback via additional_concerns_hint | Unblocks hunk summaries before agent learns the new fenced block; empty editable cards give a safe degradation path |
| Unified as single default (no user preference stored) | Follows strongest direct evidence; split view is one click away; avoids complexity of per-user pref storage |

## Action Plan

### Step 1: Scratchpad (4 tasks)
- **Add scratchpad state**: `src/lib/store.ts` — extend AppState with `scratchpad: Record<string, ScratchpadEntry>`. Actions: setScratchpadField, clearScratchpad. No new dependencies.
- **Add persistence**: `src/lib/reviewPersistence.ts` — extend ReviewSnapshot with optional `scratchpad_entries`. Update createReviewSnapshot and restore flow. No Rust changes needed. Update reviewPersistence.test.ts.
- **Create UI component**: `src/components/ScratchpadPanel.tsx` — four textarea fields per section, auto-save on blur, 'Convert to draft' button. Uses existing ui/textarea and ui/button. Collapsible by default.
- **Integrate into layout**: `src/components/ChatPanel.tsx` — add tab toggle between Chat and Scratchpad. Store active tab in local state.

### Step 2: Hunk Summaries (5 tasks)
- **Add state**: `src/lib/store.ts` — extend AppState with `hunkSummaries: Record<string, HunkSummaryEntry>`. Actions: setHunkSummary, updateHunkSummaryField.
- **Add fenced block**: `src-tauri/src/fenced.rs` — add ACP_HUNK_SUMMARY constant, whitelist tag, handle_block arm. Parse into typed event. Add Rust test.
- **Add event wiring**: `src-tauri/src/events.rs` — add event constant. `src/lib/acp.ts` — add typed event. `src/App.tsx` — add event handler calling store.setHunkSummary. Also handle plain-text fallback via appendStreamingText.
- **Document fallback**: `src-tauri/src/commands.rs` — add comment documenting additional_concerns_hint as fallback path. Frontend: populate additional_concerns_hint with summary request template string.
- **Render cards**: `src/components/DiffView.tsx` — insert HunkSummaryCard above each hunk. Create `src/components/HunkSummaryCard.tsx` with four editable fields, collapsible, low-confidence indicator. Update DiffView.test.ts.

### Step 3: Adaptive Unified Diff (3 tasks)
- **Add state**: `src/lib/store.ts` — add `diffViewMode: 'unified' | 'split'` and `collapsedHunks: Record<string, string[]>`. Actions: setDiffViewMode, toggleHunkCollapse, expandAllHunks, collapseAllHunks.
- **Implement toggle**: `src/components/DiffView.tsx` — read diffStyle from store, add Split/Unified toggle button, keyboard shortcuts 'u'/'s'.
- **Implement folding**: `src/components/DiffView.tsx` — after render, apply CSS-based collapse to hunk rows with >3 context lines. Add per-hunk expand button and 'Expand all'/'Collapse all' toolbar buttons. Use CSS transitions for smooth animation. Store per-hunk state in local state or Zustand.

### Step 4: Tests (3 tasks)
- **`src/lib/store.test.ts`**: Add tests for setScratchpadField, setHunkSummary, setDiffViewMode actions.
- **`src/components/DiffView.test.ts`**: Update static assertions for HunkSummaryCard rendering and split toggle button presence.
- **`src-tauri/src/fenced.rs`**: Add inline test for acp-hunk-summary block parsing.
- **`src/lib/reviewPersistence.test.ts`**: Add scratchpad roundtrip test (with and without scratchpad_entries).

## Success Criteria

1. User can open scratchpad, type notes in all four fields, navigate away, return, and see saved content (persisted across sessions via libsql).
2. 'Convert to draft comment' button populates a CommentDraftCard with the draft field content.
3. Hunk summary cards appear above each hunk in new section analyses. Each field is editable. Low-confidence text is visually marked.
4. Fallback: when agent does not emit hunk summaries, empty editable cards appear with an 'Add summary' prompt.
5. Unified diff is the single default view. Split toggle switches within <50ms. Context folding collapses unchanged lines beyond 3 per hunk; expand/collapse works in <100ms.
6. All existing tests pass (`npm run check`, `cargo test`).