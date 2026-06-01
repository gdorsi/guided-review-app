# Grill-Me Review Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a working grill-me PR review mode alongside the existing section walkthrough.

**Architecture:** Keep the existing ACP session process and three-pane layout. Add distinct grill protocol/state types, route new fenced events into the store, and teach the left pane and diff pane to render either sections or grill questions without forcing questions into `ReviewSection`.

**Tech Stack:** React 19, Zustand, Tauri events, Rust serde wire types, existing node tests and Rust unit tests.

---

### Task 1: Grill Protocol And Payload Tests

**Files:**
- Create: `src/lib/types/grill.ts`
- Create: `src/lib/grillPayload.ts`
- Create: `src/lib/grillPayload.test.ts`
- Modify: `src-tauri/src/section.rs`
- Modify: `src-tauri/src/events.rs`
- Modify: `src-tauri/src/fenced.rs`

- [ ] **Step 1: Write failing TypeScript parser tests**

Add tests that parse `acp-grill-question`, `acp-grill-answer`, and `acp-grill-complete` tool payloads, including invalid required fields.

- [ ] **Step 2: Run TypeScript parser tests and verify RED**

Run: `npx tsx --test src/lib/grillPayload.test.ts`
Expected: FAIL because `src/lib/grillPayload.ts` does not exist.

- [ ] **Step 3: Write failing Rust fenced parser tests**

Add tests in `src-tauri/src/fenced.rs` for the three grill tags.

- [ ] **Step 4: Run Rust parser tests and verify RED**

Run: `cd src-tauri && cargo test grill`
Expected: FAIL because grill events and types do not exist.

- [ ] **Step 5: Implement minimal protocol types and parsers**

Create TS grill types and payload parsers. Add Rust structs, events, and fenced tag handling with the existing strict-then-JSON5 parser.

- [ ] **Step 6: Run parser tests and verify GREEN**

Run both parser commands again. Expected: PASS.

### Task 2: Store, Persistence, And Mode Tests

**Files:**
- Modify: `src/lib/store.ts`
- Modify: `src/lib/reviewPersistence.ts`
- Modify: `src/lib/types/section.ts`
- Modify: `src/lib/store.test.ts`
- Modify: `src/lib/reviewPersistence.test.ts`

- [ ] **Step 1: Write failing store and persistence tests**

Add tests proving legacy snapshots default to `sections`, grill questions persist/restore, and answer summaries update existing questions.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx tsx --test src/lib/store.test.ts src/lib/reviewPersistence.test.ts`
Expected: FAIL because review mode and grill state are missing.

- [ ] **Step 3: Implement store and persistence support**

Add `ReviewMode`, `GrillQuestionState`, `reviewMode`, `setReviewMode`, `upsertGrillQuestion`, `upsertGrillAnswer`, and `markGrillComplete`. Extend snapshots with optional `review_mode`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the same focused tests. Expected: PASS.

### Task 3: Launcher, App Event Routing, And Prompt Tests

**Files:**
- Modify: `src/components/ReviewLauncher.tsx`
- Modify: `src/components/ReviewLauncher.test.ts`
- Modify: `src/App.tsx`
- Modify: `src/App.test.ts`
- Modify: `src-tauri/agent-skill.md`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src/lib/acp.ts`

- [ ] **Step 1: Write failing source tests**

Add tests that the launcher exposes a mode control, section mode still requests `acp-section-map`, grill mode requests `acp-grill-question`, and `App.tsx` listens for grill events.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx tsx --test src/components/ReviewLauncher.test.ts src/App.test.ts`
Expected: FAIL because grill mode UI and event routing are missing.

- [ ] **Step 3: Implement launcher and event routing**

Add mode selection, send mode-specific kickoff prompts, add ACP event types/listeners, enrich grill question ranges, and update store from grill events/tool calls.

- [ ] **Step 4: Update embedded agent prompt**

Document grill-mode blocks and instructions without breaking section-mode assertions.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the same focused tests. Expected: PASS.

### Task 4: Left Pane And Diff Rendering Tests

**Files:**
- Modify: `src/components/SectionList.tsx`
- Modify: `src/components/SectionList.test.ts`
- Modify: `src/components/DiffView.tsx`
- Modify: `src/components/DiffView.test.ts`

- [ ] **Step 1: Write failing source tests**

Add tests that the left pane switches to `Questions` in grill mode and the diff pane derives files from `grill_question` items.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx tsx --test src/components/SectionList.test.ts src/components/DiffView.test.ts`
Expected: FAIL because grill rendering is missing.

- [ ] **Step 3: Implement UI rendering**

Render grill questions in the left pane. Refactor `DiffPane` to derive a generic diff target from either a review section or a grill question while preserving the current CodeView changes in the dirty worktree.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the same focused tests. Expected: PASS.

### Task 5: Full Verification

**Files:**
- All changed files.

- [ ] **Step 1: Run TypeScript tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 2: Run TypeScript check**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 3: Run Rust tests**

Run: `cd src-tauri && cargo test`
Expected: PASS.

- [ ] **Step 4: Report status**

Report implemented scope, verification evidence, and any pre-existing unrelated dirty files.
