# PR Upstream Update Design

## Status

Approved for planning.

## Context

Guided reviews run against a local repository and a resolved PR diff snapshot. A PR-backed session stores the local repo path, base ref, head ref, head SHA, PR metadata, saved review state, section map, and per-section feedback.

The app already fetches PR refs when a session starts. Section feedback is loaded by queueing `start_section_task_cmd` for each review section. Each review section stores the files it owns, so the app can decide whether a later upstream PR change affects that section without asking the agent to rediscover the whole map.

## Goals

- Add a visible button to update the current PR review from upstream.
- Refresh the local PR refs and PR metadata without discarding the current review state.
- Detect changed sections with file-based matching.
- Reprocess only sections whose existing file list intersects files changed by the upstream update.
- Leave unchanged sections, current selection, chat history, drafts, and existing comments intact.
- Show a clear no-op result when the PR did not change or no existing section owns the changed files.

## Non-Goals

- No automatic background polling.
- No agent-driven change detection.
- No section map regeneration during update.
- No range-overlap detection for this feature.
- No update button for plain local or non-PR sessions.

## User Interface

Add an `Update` button in the header near the current `head_ref <- base_ref` label. The button is shown for PR-backed sessions (`pr` and `local_pr`) and disabled while an update is running.

Button states:

- idle: `Update`
- running: spinner plus `Updating`
- no changed section: keep the current review visible and surface a short status message
- changed sections: mark affected section rows as processing through the existing processing indicator
- error: use the existing app error toast path

The button should not reset the selected section. If the selected section is affected, its row and diff pane update as the existing section task response arrives.

## Backend Behavior

Add a Tauri command that accepts the current `SessionSource` and previous `ClonedRepo` snapshot.

The command should:

1. Resolve the source again with the existing `resolve_source` path. This reuses the current clone/fetch logic for `pr` and `local_pr`.
2. Fetch current PR metadata and published PR comments with the same helpers used by `start_session_cmd`.
3. Compute file paths in the old diff snapshot and the refreshed diff snapshot.
4. Return the refreshed repo metadata, PR metadata/comment context, and the union of file paths whose diff presence or patch text changed.

Diff comparison must anchor the old snapshot to immutable refs before or after the fetch. Use the previous `base_ref` and previous `head_sha` for the old diff, then the refreshed `base_ref` and refreshed `head_sha` for the new diff. Do not compare with the old `head_ref` after refreshing, because local PR refs are updated in place.

A file is considered changed when:

- it exists only in the old snapshot
- it exists only in the new snapshot
- it exists in both snapshots but the patch text differs

This keeps detection file-based while still noticing edits within a file.

## Frontend Data Flow

Add an ACP wrapper for the new refresh command.

When the update button succeeds:

1. Update the current session's `repo`, PR metadata, PR errors, and published comment context in the store.
2. Keep `session_id`, source, selected section, sections, chats, and draft comments unchanged.
3. Build a `Set` from returned changed files.
4. Find review sections where `section.section?.files` intersects the changed file set.
5. For each affected section, queue `startSectionTask` using the existing background task flow.
6. Pass an additional hint listing the changed files so the agent knows why the section is being reprocessed.

Affected section detection is intentionally file-based:

```ts
section.section?.files.some((file) => changedFiles.has(file))
```

If no section matches, the app should not ask the agent to do any work.

## Store Changes

Add a store action that refreshes session metadata without rebuilding the review:

- replace `session.repo`
- replace `session.pull_request` and `session.pull_request_error`
- replace `publishedComments`, `publishedCommentsError`, and `publishedCommentsFetchedAt`
- preserve `sections`, `currentSectionId`, chat state, processing state, drafts, and diff focus

Existing `setSession` remains the start-over path and should continue to reset review state.

## Agent Prompting

Reuse `start_section_task_cmd` and its existing `additional_concerns_hint`.

For update-triggered reprocessing, pass a hint like:

```text
This section is being reprocessed because the PR changed upstream. Focus on the current diff for these changed files before deciding whether the previous feedback still applies:
- src/example.ts
- src/other.ts
```

The final `acp-section` payload replaces the previous concerns for that section through the existing `upsertSection` behavior.

## Error Handling

- If there is no active PR-backed session, the button should be hidden or disabled.
- If refresh fails, keep the existing review untouched and show the error.
- If PR metadata or published comments cannot be fetched, keep the refresh successful but return the error fields like session startup does.
- If a changed file is not owned by any existing section, do not regenerate the map automatically.

## Testing

Frontend tests:

- A helper identifies affected sections by intersecting changed files with section file lists.
- The store metadata refresh action preserves sections and current selection.
- `App.tsx` exposes the update path and uses `additional_concerns_hint` for update-triggered section tasks.

Backend tests:

- Diff snapshot comparison reports added, removed, and patch-changed files.
- The refresh command response shape includes refreshed repo data and changed files.

Manual verification:

- Start a local PR review.
- Update the PR branch upstream.
- Click `Update`.
- Confirm only sections containing changed files reprocess.
- Confirm no-op updates do not reprocess any section.
