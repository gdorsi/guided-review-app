# PR Upstream Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a header button that refreshes a PR-backed review from upstream and reprocesses only existing sections whose files changed.

**Architecture:** The backend owns fetching and diff-snapshot comparison. The frontend owns preserving review state, identifying affected sections by file list intersection, and queueing existing background section tasks with a focused reprocessing hint.

**Tech Stack:** Tauri 2 commands in Rust, `git2` diff helpers, React 19, TypeScript, Zustand, Node test runner, Cargo tests.

---

## File Structure

- Modify `src-tauri/src/repo.rs`
  - Add a small public helper that compares old and new diff snapshots by file path and patch text.
  - Add focused Cargo tests using the existing temporary git repo helpers.

- Modify `src-tauri/src/commands.rs`
  - Add `UpdatePrFromUpstreamRequest` and `UpdatePrFromUpstreamResponse`.
  - Add `update_pr_from_upstream_cmd` that reuses `resolve_source`, `pull_request_metadata_for_source`, and `published_comments_for_source`.

- Modify `src-tauri/src/lib.rs`
  - Register the new Tauri command.

- Modify `src/lib/acp.ts`
  - Add TypeScript request/response types for the command.
  - Add `acp.updatePrFromUpstream`.

- Create `src/lib/prUpdate.ts`
  - Own PR-backed session checks, file-based affected-section detection, and update hint formatting.

- Create `src/lib/prUpdate.test.ts`
  - Test affected-section detection and hint formatting.

- Modify `src/lib/store.ts`
  - Add a metadata-only session refresh action that does not rebuild sections or chat state.

- Modify `src/lib/store.test.ts`
  - Test that metadata refresh preserves review state and updates published comment context.

- Modify `src/App.tsx`
  - Render the update button for PR-backed sessions.
  - Call the new command.
  - Refresh store metadata.
  - Queue affected sections with `additional_concerns_hint`.

- Modify `src/App.test.ts`
  - Add source-level checks that the update flow is wired through `updatePrFromUpstream`, `findSectionsAffectedByChangedFiles`, and `additional_concerns_hint`.

## Task 1: Backend Diff Snapshot Comparison

**Files:**
- Modify: `src-tauri/src/repo.rs`
- Test: `src-tauri/src/repo.rs`

- [ ] **Step 1: Write the failing Cargo test**

Add this test inside `#[cfg(test)] mod tests` in `src-tauri/src/repo.rs`:

```rust
#[test]
fn changed_diff_files_reports_added_removed_and_patch_changed_files() {
    let repo_path = init_changed_range_repo("changed-diff-files");
    write_and_commit(&repo_path, "src/keep.ts", "keep\n", "base keep");
    write_and_commit(&repo_path, "src/edit.ts", "old\n", "base edit");
    write_and_commit(&repo_path, "src/remove.ts", "remove\n", "base remove");
    let base = git_output_sync(&repo_path, &["rev-parse", "HEAD"]);

    fs::remove_file(repo_path.join("src/remove.ts")).unwrap();
    run_git_sync(&repo_path, &["add", "src/remove.ts"]);
    write_and_commit(&repo_path, "src/edit.ts", "old pr\n", "old pr edit");
    let old_head = git_output_sync(&repo_path, &["rev-parse", "HEAD"]);

    write_and_commit(&repo_path, "src/edit.ts", "new pr\n", "new pr edit");
    write_and_commit(&repo_path, "src/add.ts", "add\n", "new pr add");
    write_and_commit(&repo_path, "src/remove.ts", "remove\n", "new pr restore remove");
    let new_head = git_output_sync(&repo_path, &["rev-parse", "HEAD"]);

    let changed = changed_diff_files(&repo_path, &base, &old_head, &base, &new_head).unwrap();

    assert_eq!(
        changed,
        vec![
            "src/add.ts".to_string(),
            "src/edit.ts".to_string(),
            "src/remove.ts".to_string(),
        ]
    );

    fs::remove_dir_all(repo_path).unwrap();
}
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```sh
cd src-tauri && cargo test changed_diff_files_reports_added_removed_and_patch_changed_files
```

Expected: compile failure because `changed_diff_files` is not defined.

- [ ] **Step 3: Implement the diff comparison helper**

Add `BTreeMap` near the imports in `src-tauri/src/repo.rs`:

```rust
use std::collections::{BTreeMap, BTreeSet};
```

Add this helper after `get_diff`:

```rust
fn diff_patch_map(patches: Vec<DiffPatch>) -> BTreeMap<String, String> {
    patches
        .into_iter()
        .map(|patch| (patch.file_path, patch.patch))
        .collect()
}

pub fn changed_diff_files(
    repo_path: &Path,
    old_base_ref: &str,
    old_head_ref: &str,
    new_base_ref: &str,
    new_head_ref: &str,
) -> Result<Vec<String>> {
    let old = diff_patch_map(get_diff(repo_path, old_base_ref, old_head_ref, None)?);
    let new = diff_patch_map(get_diff(repo_path, new_base_ref, new_head_ref, None)?);
    let paths: BTreeSet<String> = old.keys().chain(new.keys()).cloned().collect();

    Ok(paths
        .into_iter()
        .filter(|path| old.get(path) != new.get(path))
        .collect())
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run:

```sh
cd src-tauri && cargo test changed_diff_files_reports_added_removed_and_patch_changed_files
```

Expected: PASS.

- [ ] **Step 5: Commit the backend helper**

Run:

```sh
git add src-tauri/src/repo.rs
git commit -m "Add PR diff snapshot comparison"
```

## Task 2: Backend Upstream Refresh Command

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/commands.rs`

- [ ] **Step 1: Write the failing command-shape tests**

Add these tests inside `#[cfg(test)] mod tests` in `src-tauri/src/commands.rs`:

```rust
#[test]
fn pr_backed_source_accepts_remote_and_local_pr_sources() {
    assert!(is_pr_backed_source(&SessionSource::Pr {
        repo_url: "https://github.com/garden-co/review".to_string(),
        number: 17,
    }));
    assert!(is_pr_backed_source(&SessionSource::LocalPr {
        path: PathBuf::from("/tmp/review"),
        repo_url: "https://github.com/garden-co/review".to_string(),
        number: 17,
    }));
}

#[test]
fn pr_backed_source_rejects_non_pr_sources() {
    assert!(!is_pr_backed_source(&SessionSource::Local {
        path: PathBuf::from("/tmp/review"),
    }));
    assert!(!is_pr_backed_source(&SessionSource::LocalBranch {
        path: PathBuf::from("/tmp/review"),
        branch: "feature".to_string(),
    }));
}

#[test]
fn update_pr_from_upstream_response_serializes_changed_files() {
    let response = UpdatePrFromUpstreamResponse {
        repo: ClonedRepo {
            path: PathBuf::from("/tmp/review"),
            head_ref: "guided-review-pr-17".to_string(),
            head_sha: "next-sha".to_string(),
            base_ref: "origin/main".to_string(),
            display_slug: "review".to_string(),
        },
        pull_request: None,
        pull_request_error: Some("metadata unavailable".to_string()),
        published_comments: Vec::new(),
        published_comments_error: None,
        changed_files: vec!["src/app.ts".to_string()],
    };

    let value = serde_json::to_value(response).unwrap();

    assert_eq!(value["repo"]["head_sha"], "next-sha");
    assert_eq!(value["pull_request_error"], "metadata unavailable");
    assert_eq!(value["changed_files"][0], "src/app.ts");
}
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```sh
cd src-tauri && cargo test pr_backed_source_
```

Expected: compile failure because `is_pr_backed_source` and `UpdatePrFromUpstreamResponse` are not defined.

- [ ] **Step 3: Implement request/response types and command**

Update the `crate::repo` import in `src-tauri/src/commands.rs` to include `changed_diff_files`:

```rust
use crate::repo::{
    changed_diff_files, fetch_pull_request_metadata, fetch_pull_request_metadata_for_branch,
    fetch_pull_request_review_comments, get_changed_ranges, get_diff, get_file_at_ref,
    inspect_origin, parse_pr_url, resolve_source, ClonedRepo, DiffPatch, GithubRepoInfo,
    PublishedPrComment, PullRequestMetadata, SessionSource,
};
```

Add these types after `StartSessionResponse`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdatePrFromUpstreamRequest {
    pub source: SessionSource,
    pub previous_repo: ClonedRepo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdatePrFromUpstreamResponse {
    pub repo: ClonedRepo,
    pub pull_request: Option<PullRequestMetadata>,
    pub pull_request_error: Option<String>,
    pub published_comments: Vec<PublishedPrComment>,
    pub published_comments_error: Option<String>,
    pub changed_files: Vec<String>,
}
```

Add this helper near `saved_review_for_source`:

```rust
fn is_pr_backed_source(source: &SessionSource) -> bool {
    matches!(source, SessionSource::Pr { .. } | SessionSource::LocalPr { .. })
}
```

Add this command after `start_session_cmd`:

```rust
#[tauri::command]
pub async fn update_pr_from_upstream_cmd(
    req: UpdatePrFromUpstreamRequest,
    telemetry_context: Option<TelemetryContext>,
) -> Result<UpdatePrFromUpstreamResponse, String> {
    let span = tracing::info_span!("pr.update_from_upstream", source = ?req.source);
    telemetry::set_span_parent(&span, telemetry_context.as_ref());
    async move {
        if !is_pr_backed_source(&req.source) {
            return Err("upstream update requires a PR-backed review".to_string());
        }

        let previous = req.previous_repo;
        let refreshed = resolve_source(&req.source).await.map_err(|e| {
            tracing::error!(error = %e, "resolve_source failed during PR update");
            e.to_string()
        })?;
        let (pull_request, pull_request_error) = pull_request_metadata_for_source(&req.source).await;
        let (published_comments, published_comments_error) =
            published_comments_for_source(&req.source).await;
        let changed_files = tokio::task::spawn_blocking({
            let path = refreshed.path.clone();
            let old_base_ref = previous.base_ref.clone();
            let old_head_sha = previous.head_sha.clone();
            let new_base_ref = refreshed.base_ref.clone();
            let new_head_sha = refreshed.head_sha.clone();
            move || {
                changed_diff_files(
                    &path,
                    &old_base_ref,
                    &old_head_sha,
                    &new_base_ref,
                    &new_head_sha,
                )
            }
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

        Ok(UpdatePrFromUpstreamResponse {
            repo: refreshed,
            pull_request,
            pull_request_error,
            published_comments,
            published_comments_error,
            changed_files,
        })
    }
    .instrument(span)
    .await
}
```

- [ ] **Step 4: Register the command**

Add `update_pr_from_upstream_cmd` to `tauri::generate_handler!` in `src-tauri/src/lib.rs`:

```rust
            start_session_cmd,
            update_pr_from_upstream_cmd,
            send_message_cmd,
```

- [ ] **Step 5: Run the command-shape tests**

Run:

```sh
cd src-tauri && cargo test pr_backed_source_ && cargo test update_pr_from_upstream_response_serializes_changed_files
```

Expected: PASS.

- [ ] **Step 6: Run backend tests touched so far**

Run:

```sh
cd src-tauri && cargo test changed_diff_files_reports_added_removed_and_patch_changed_files && cargo test pr_backed_source_ && cargo test update_pr_from_upstream_response_serializes_changed_files
```

Expected: PASS.

- [ ] **Step 7: Commit the refresh command**

Run:

```sh
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "Add PR upstream refresh command"
```

## Task 3: Frontend PR Update Helpers

**Files:**
- Create: `src/lib/prUpdate.ts`
- Create: `src/lib/prUpdate.test.ts`

- [ ] **Step 1: Write the failing helper tests**

Create `src/lib/prUpdate.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
	buildUpstreamChangeHint,
	findSectionsAffectedByChangedFiles,
	isPrBackedSession,
} from "./prUpdate";
import type { SessionInfo, SectionState } from "./store";

function reviewSection(id: string, files: string[]): SectionState {
	return {
		id,
		kind: "review_section",
		title: id,
		intent: id,
		status: "in_review",
		feedbackLoaded: true,
		section: {
			schema_version: 1,
			section_id: id,
			title: id,
			intent: id,
			files,
			ranges: [],
			concerns: [],
			base_ref: "origin/main",
			head_ref: "guided-review-pr-17",
			pause_prompt: "",
		},
	};
}

test("isPrBackedSession accepts PR-backed session sources", () => {
	const localPr = {
		session_id: "s1",
		repo: {
			path: "/tmp/review",
			head_ref: "guided-review-pr-17",
			head_sha: "abc",
			base_ref: "origin/main",
			display_slug: "review",
		},
		source: {
			kind: "local_pr",
			path: "/tmp/review",
			repo_url: "https://github.com/garden-co/review",
			number: 17,
		},
	} satisfies SessionInfo;

	assert.equal(isPrBackedSession(localPr), true);
	assert.equal(isPrBackedSession({ ...localPr, source: { kind: "local", path: "/tmp/review" } }), false);
	assert.equal(isPrBackedSession(null), false);
});

test("findSectionsAffectedByChangedFiles uses file-list intersection", () => {
	const sections: SectionState[] = [
		{
			id: "pr-description",
			kind: "pr_description",
			title: "PR description",
			intent: "Overview",
			status: "in_review",
			body: "Summary",
		},
		reviewSection("api", ["src/api.ts", "src/shared.ts"]),
		reviewSection("tests", ["src/api.test.ts"]),
		reviewSection("docs", []),
	];

	const affected = findSectionsAffectedByChangedFiles(sections, [
		"src/shared.ts",
		"README.md",
	]);

	assert.deepEqual(
		affected.map((section) => section.id),
		["api"],
	);
});

test("buildUpstreamChangeHint lists changed files in sorted order", () => {
	const hint = buildUpstreamChangeHint(["src/b.ts", "src/a.ts"]);

	assert.match(hint, /PR changed upstream/);
	assert.match(hint, /- src\/a\.ts\n- src\/b\.ts/);
});
```

- [ ] **Step 2: Run helper tests and verify they fail**

Run:

```sh
npm test -- src/lib/prUpdate.test.ts
```

Expected: module not found for `./prUpdate`.

- [ ] **Step 3: Implement helper module**

Create `src/lib/prUpdate.ts`:

```ts
import type { SessionInfo, ReviewSectionState, SectionState } from "./store";

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
```

- [ ] **Step 4: Run helper tests and verify they pass**

Run:

```sh
npm test -- src/lib/prUpdate.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit frontend helper**

Run:

```sh
git add src/lib/prUpdate.ts src/lib/prUpdate.test.ts
git commit -m "Add PR update section helpers"
```

## Task 4: Store Metadata Refresh

**Files:**
- Modify: `src/lib/store.ts`
- Modify: `src/lib/store.test.ts`

- [ ] **Step 1: Write the failing store test**

Add this test to `src/lib/store.test.ts` after the `setSession stores one-off published PR comment context` test:

```ts
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
	useApp.getState().addUserMessage("question", "api");

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
		["pr-description", "api"],
	);
	assert.equal(state.chatBySection.api?.length, 1);
	assert.deepEqual(state.publishedComments, []);
	assert.equal(state.publishedCommentsError, "comments unavailable");
	assert(state.publishedCommentsFetchedAt! >= before);
	assert(state.publishedCommentsFetchedAt! <= after);
});
```

- [ ] **Step 2: Run the store test and verify it fails**

Run:

```sh
npm test -- src/lib/store.test.ts
```

Expected: compile failure because `refreshSessionMetadata` does not exist on the store.

- [ ] **Step 3: Add the store action type**

In `src/lib/store.ts`, add this interface after `AssistantChunkMeta`:

```ts
interface RefreshSessionMetadataRequest {
	repo: ClonedRepo;
	pull_request?: PullRequestMetadata;
	pull_request_error?: string;
	published_comments: PublishedPrComment[];
	published_comments_error?: string;
}
```

Add the action to `AppState`:

```ts
	refreshSessionMetadata: (req: RefreshSessionMetadataRequest) => void;
```

- [ ] **Step 4: Implement the store action**

Add this action after `setSession`:

```ts
		refreshSessionMetadata: (req) =>
			set((state) => {
				if (!state.session) return {};
				recordClientTelemetry("client.store.session_metadata.refreshed", {
					"acp.session_id": state.session.session_id,
					"repo.previous_head_sha": state.session.repo.head_sha,
					"repo.next_head_sha": req.repo.head_sha,
					"pull_request.has_metadata": !!req.pull_request,
					"pull_request.has_error": !!req.pull_request_error,
				});
				return {
					session: {
						...state.session,
						repo: req.repo,
						pull_request: req.pull_request,
						pull_request_error: req.pull_request_error,
						published_comments: req.published_comments,
						published_comments_error: req.published_comments_error,
					},
					publishedComments: req.published_comments,
					publishedCommentsFetchedAt: Date.now(),
					publishedCommentsError: req.published_comments_error ?? null,
				};
			}),
```

- [ ] **Step 5: Run the store test and verify it passes**

Run:

```sh
npm test -- src/lib/store.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit store refresh action**

Run:

```sh
git add src/lib/store.ts src/lib/store.test.ts
git commit -m "Preserve review state during PR refresh"
```

## Task 5: ACP Wrapper and App Update Button

**Files:**
- Modify: `src/lib/acp.ts`
- Modify: `src/App.tsx`
- Modify: `src/App.test.ts`

- [ ] **Step 1: Write the failing App source test**

Add this test to `src/App.test.ts`:

```ts
test("App exposes PR upstream update and reprocesses affected sections", async () => {
	const source = await readFile(new URL("./App.tsx", import.meta.url), "utf8");

	assert.match(source, /updatePrFromUpstream/);
	assert.match(source, /findSectionsAffectedByChangedFiles/);
	assert.match(source, /buildUpstreamChangeHint/);
	assert.match(source, /additional_concerns_hint/);
	assert.match(source, /Update/);
});
```

- [ ] **Step 2: Run the App test and verify it fails**

Run:

```sh
npm test -- src/App.test.ts
```

Expected: FAIL because the App source does not contain the upstream update flow.

- [ ] **Step 3: Add ACP request/response types**

In `src/lib/acp.ts`, add these interfaces after `StartSessionResponse`:

```ts
export interface UpdatePrFromUpstreamRequest {
	source: SessionSource;
	previous_repo: ClonedRepo;
}

export interface UpdatePrFromUpstreamResponse {
	repo: ClonedRepo;
	pull_request?: PullRequestMetadata;
	pull_request_error?: string;
	published_comments: PublishedPrComment[];
	published_comments_error?: string;
	changed_files: string[];
}
```

- [ ] **Step 4: Add the ACP wrapper**

Add this method after `startSession` in `src/lib/acp.ts`:

```ts
	updatePrFromUpstream: async (req: UpdatePrFromUpstreamRequest) => {
		recordClientTelemetry("client.acp.pr_update.requested", {
			"session.source.kind": req.source.kind,
			"repo.previous_head_sha": req.previous_repo.head_sha,
		});
		try {
			const response = await invokeWithTelemetry<UpdatePrFromUpstreamResponse>(
				"update_pr_from_upstream_cmd",
				{ req },
				{
					"session.source.kind": req.source.kind,
					"repo.previous_head_sha": req.previous_repo.head_sha,
				},
			);
			recordClientTelemetry("client.acp.pr_update.succeeded", {
				"session.source.kind": req.source.kind,
				"repo.next_head_sha": response.repo.head_sha,
				"pr_update.changed_file_count": response.changed_files.length,
			});
			return response;
		} catch (e) {
			recordClientTelemetryError("client.acp.pr_update.failed", e, {
				"session.source.kind": req.source.kind,
				"repo.previous_head_sha": req.previous_repo.head_sha,
			});
			throw e;
		}
	},
```

- [ ] **Step 5: Import PR update helpers and icon**

In `src/App.tsx`, update imports:

```ts
import { useCallback, useEffect, useState } from "react";
```

Update the icon import:

```ts
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
```

Add helper imports:

```ts
import {
	buildUpstreamChangeHint,
	changedFilesForSection,
	findSectionsAffectedByChangedFiles,
	isPrBackedSession,
} from "@/lib/prUpdate";
```

- [ ] **Step 6: Add store action and component state in App**

In `App`, add the store action near `setPrDescriptionBody`:

```ts
	const refreshSessionMetadata = useApp((s) => s.refreshSessionMetadata);
```

Add local state near the `ghCliDismissed` state:

```ts
	const [updatingPr, setUpdatingPr] = useState(false);
	const [prUpdateStatus, setPrUpdateStatus] = useState<string | null>(null);
```

- [ ] **Step 7: Extract the existing section task starter for reuse**

Move `startSectionTask` out of the event-listener `useEffect` and place it inside `App` before the persistence effect:

```ts
	const startSectionTask = useCallback(async (
		sess: SessionInfo,
		target: SectionTaskTarget,
		reason: "auto_open_first" | "auto_load_next" | "upstream_update",
		additionalConcernsHint?: string,
	): Promise<boolean> => {
		startSectionProcessing(target.sectionId);
		recordClientTelemetry("client.acp.section_task.auto_load_sending", {
			"acp.session_id": sess.session_id,
			"section.id": target.sectionId,
			"section.title": target.title,
			"section.auto_load_reason": reason,
		});
		try {
			const state = useApp.getState();
			const publishedCommentContext = formatPublishedCommentsForPrompt(
				state.session?.session_id === sess.session_id
					? state.publishedComments
					: (sess.published_comments ?? []),
				state.session?.session_id === sess.session_id
					? (state.publishedCommentsError ?? undefined)
					: sess.published_comments_error,
			);
			await acp.startSectionTask({
				parent_session_id: sess.session_id,
				section_id: target.sectionId,
				title: target.title,
				intent: target.intent,
				files: target.files,
				base_ref: sess.repo.base_ref,
				head_ref: sess.repo.head_ref,
				published_comment_context: publishedCommentContext,
				additional_concerns_hint: additionalConcernsHint,
			});
			recordClientTelemetry("client.acp.section_task.auto_load_sent", {
				"acp.session_id": sess.session_id,
				"section.id": target.sectionId,
				"section.auto_load_reason": reason,
			});
			return true;
		} catch (e) {
			finishSectionProcessing(target.sectionId);
			recordClientTelemetryError("client.acp.section_task.auto_load_failed", e, {
				"acp.session_id": sess.session_id,
				"section.id": target.sectionId,
				"section.auto_load_reason": reason,
			});
			pushError(`section auto-load failed: ${e}`);
			return false;
		}
	}, [finishSectionProcessing, pushError, startSectionProcessing]);
```

Remove the nested `startSectionTask` declaration from the event-listener `useEffect`.

- [ ] **Step 8: Add the update click handler**

Add this function inside `App` before `return`:

```ts
	async function updatePrFromUpstream() {
		if (!session || !isPrBackedSession(session) || updatingPr) return;
		setUpdatingPr(true);
		setPrUpdateStatus(null);
		recordClientTelemetry("client.pr_update.started", {
			"acp.session_id": session.session_id,
			"repo.previous_head_sha": session.repo.head_sha,
		});
		try {
			const response = await acp.updatePrFromUpstream({
				source: session.source,
				previous_repo: session.repo,
			});
			refreshSessionMetadata({
				repo: response.repo,
				pull_request: response.pull_request,
				pull_request_error: response.pull_request_error,
				published_comments: response.published_comments,
				published_comments_error: response.published_comments_error,
			});
			const state = useApp.getState();
			const affectedSections = findSectionsAffectedByChangedFiles(
				state.sections,
				response.changed_files,
			);
			if (response.changed_files.length === 0) {
				setPrUpdateStatus("PR is already up to date.");
				return;
			}
			if (affectedSections.length === 0) {
				setPrUpdateStatus("PR updated; no existing sections own the changed files.");
				return;
			}
			setPrUpdateStatus(`Reprocessing ${affectedSections.length} section${affectedSections.length === 1 ? "" : "s"}.`);
			const refreshedSession = useApp.getState().session;
			if (!refreshedSession) return;
			for (const section of affectedSections) {
				const changedFiles = changedFilesForSection(
					section,
					response.changed_files,
				);
				await startSectionTask(
					refreshedSession,
					targetFromReviewSection(section),
					"upstream_update",
					buildUpstreamChangeHint(changedFiles),
				);
			}
			recordClientTelemetry("client.pr_update.reprocess_queued", {
				"acp.session_id": refreshedSession.session_id,
				"section.count": affectedSections.length,
				"pr_update.changed_file_count": response.changed_files.length,
			});
		} catch (e) {
			recordClientTelemetryError("client.pr_update.failed", e, {
				"acp.session_id": session.session_id,
			});
			pushError(`PR update failed: ${e}`);
		} finally {
			setUpdatingPr(false);
		}
	}
```

- [ ] **Step 9: Render the update button**

Replace the session metadata block in the header with:

```tsx
				{session && (
					<div className="flex min-w-0 items-center gap-2">
						<SavedReviewFreshnessBadge
							isStale={session.saved_review_is_stale}
						/>
						<span className="truncate font-mono text-[11px] text-muted-foreground">
							{session.repo.head_ref} ← {session.repo.base_ref}
						</span>
						{isPrBackedSession(session) && (
							<Button
								type="button"
								size="sm"
								variant="outline"
								className="h-7 px-2"
								disabled={updatingPr}
								onClick={() => void updatePrFromUpstream()}
								title="Update PR from upstream"
							>
								{updatingPr ? (
									<Loader2 className="size-3.5 animate-spin" />
								) : (
									<RefreshCw className="size-3.5" />
								)}
								{updatingPr ? "Updating" : "Update"}
							</Button>
						)}
						{prUpdateStatus && (
							<span className="max-w-[240px] truncate text-[11px] text-muted-foreground" title={prUpdateStatus}>
								{prUpdateStatus}
							</span>
						)}
					</div>
				)}
```

- [ ] **Step 10: Update the event-listener effect dependencies**

Add `startSectionTask` to the event-listener `useEffect` dependency array:

```ts
		startSectionTask,
```

- [ ] **Step 11: Run frontend tests for App and helpers**

Run:

```sh
npm test -- src/App.test.ts src/lib/prUpdate.test.ts src/lib/store.test.ts
```

Expected: PASS.

- [ ] **Step 12: Commit the app update UI**

Run:

```sh
git add src/lib/acp.ts src/App.tsx src/App.test.ts
git commit -m "Add PR upstream update button"
```

## Task 6: Verification and Cleanup

**Files:**
- Verify all changed files.

- [ ] **Step 1: Run TypeScript check**

Run:

```sh
npm run check
```

Expected: PASS.

- [ ] **Step 2: Run frontend tests**

Run:

```sh
npm test
```

Expected: PASS.

- [ ] **Step 3: Run Rust tests**

Run:

```sh
cd src-tauri && cargo test
```

Expected: PASS.

- [ ] **Step 4: Inspect working tree**

Run:

```sh
git status --short
```

Expected: only intentional feature changes are present. Existing user-owned edits to package/Cargo/repo files must not be reverted.

- [ ] **Step 5: Manual app check**

Run:

```sh
npm run tauri -- dev
```

Expected:

- App launches.
- Start a local PR review.
- Header shows `Update` for the PR-backed session.
- Clicking `Update` with no upstream changes shows a no-op status.
- After the PR ref changes upstream, clicking `Update` reprocesses only sections whose `section.files` intersect the returned changed files.

- [ ] **Step 6: Final commit after verification**

If Task 6 required fixes, commit them:

```sh
git add src src-tauri
git commit -m "Verify PR upstream update flow"
```

If Task 6 made no file changes, do not create an empty commit.

## Self-Review

Spec coverage:

- Visible update button: Task 5.
- Refresh local PR refs and metadata without discarding review state: Tasks 2 and 4.
- File-based changed-section detection: Task 3.
- Reprocess only affected sections: Task 5.
- Preserve selection, chats, drafts, and unchanged sections: Task 4.
- No-op result: Task 5.
- No section-map regeneration: Task 5 uses existing sections only.
- Mutable PR refs anchored by previous `head_sha`: Task 2 passes `previous.head_sha` to `changed_diff_files`.

Placeholder scan:

- The plan contains concrete file paths, test snippets, implementation snippets, commands, expected outcomes, and commit messages.

Type consistency:

- Rust command names use `update_pr_from_upstream_cmd`.
- TypeScript wrapper uses `updatePrFromUpstream`.
- Store action uses `refreshSessionMetadata`.
- Section helper names match imports in `App.tsx`.
