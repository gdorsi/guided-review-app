use crate::acp_client::{start_session, AcpSessions, PromptEventOptions};
use crate::agent_runner::{list_agents, AgentInfo, AgentKind, ReasoningEffort};
use crate::gh::{check_installation, GhCliStatus};
use crate::projects::{self, RecentProject};
use crate::repo::{
    changed_diff_files, fetch_pull_request_metadata, fetch_pull_request_metadata_for_branch,
    fetch_pull_request_review_comments, get_changed_ranges, get_diff, get_file_at_ref,
    inspect_origin, parse_pr_url, resolve_source, ClonedRepo, DiffPatch, GithubRepoInfo,
    PublishedPrComment, PullRequestMetadata, SessionSource,
};
use crate::review_persistence::{
    target_from_source, ReviewPersistence, ReviewPersistenceTarget, SaveReviewState,
    SavedReviewRecord,
};
use crate::section::LineRange;
use crate::telemetry::{self, TelemetryContext};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};
use tracing::Instrument;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartSessionRequest {
    pub source: SessionSource,
    pub agent_kind: AgentKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<ReasoningEffort>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartSessionResponse {
    pub session_id: String,
    pub repo: ClonedRepo,
    pub source: SessionSource,
    pub pull_request: Option<PullRequestMetadata>,
    pub pull_request_error: Option<String>,
    pub published_comments: Vec<PublishedPrComment>,
    pub published_comments_error: Option<String>,
    pub saved_review: Option<SavedReviewRecord>,
}

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedReviewSummary {
    pub id: String,
    pub repo_url: String,
    pub number: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr_url: Option<String>,
    pub base_ref: String,
    pub head_ref: String,
    pub head_sha: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartSectionTaskRequest {
    pub parent_session_id: String,
    pub section_id: String,
    pub title: String,
    pub intent: String,
    pub files: Vec<String>,
    pub base_ref: String,
    pub head_ref: String,
    pub published_comment_context: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub additional_concerns_hint: Option<String>,
}

const AGENT_SKILL: &str = include_str!(".././agent-skill.md");

fn command_span(
    command: &'static str,
    telemetry_context: Option<&TelemetryContext>,
) -> tracing::Span {
    let span = tracing::info_span!("tauri.command", command);
    telemetry::set_span_parent(&span, telemetry_context);
    span
}

fn read_agent_skill_from_disk(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

fn agent_skill() -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("agent-skill.md");
    read_agent_skill_from_disk(&path).unwrap_or_else(|| AGENT_SKILL.to_string())
}

fn build_section_task_prompt(req: &StartSectionTaskRequest, repo_path: &Path) -> String {
    let files = if req.files.is_empty() {
        "- No files were listed for this section. Use the diff between the base and head refs to find the relevant files.".to_string()
    } else {
        req.files
            .iter()
            .map(|file| format!("- {file}"))
            .collect::<Vec<_>>()
            .join("\n")
    };

    let additional_concerns_hint = req
        .additional_concerns_hint
        .as_deref()
        .map(str::trim)
        .filter(|hint| !hint.is_empty())
        .map(|hint| format!("\n\n{hint}"))
        .unwrap_or_default();

    format!(
        r#"You are analysing one section of a code review inside the guided-review desktop app.

The repository is at `{repo_path}`.
Base ref: {base_ref}
Head ref: {head_ref}

Section: {section_id} — {title}
Intent: {intent}
Files:
{files}

{published_comment_context}{additional_concerns_hint}

Read the diff for this section with your built-in tools. Identify only real concerns that follow from the actual code. Use simple language.
Use compact, filler-free private notes while analysing. Keep concern text polished, normal, and beginner-friendly.

If the `guided_review_update_section` tool is available, call it once with:
{{"section_id":"{section_id}","phase":"started"}}

Emit exactly one final ```acp-section fenced block and no prose outside it.
The block must be feedback-only and must use this shape:

```acp-section
{{
  "section_id": "{section_id}",
  "concerns": [
    {{ "text": "...", "severity": "medium", "file_path": "src/...", "line": 24 }}
  ]
}}
```

Do not include `title`, `intent`, `files`, `ranges`, `base_ref`, or `head_ref`.
If there are no actionable concerns, emit `"concerns": []`.
"#,
        repo_path = repo_path.display(),
        base_ref = req.base_ref,
        head_ref = req.head_ref,
        section_id = req.section_id,
        title = req.title,
        intent = req.intent,
        files = files,
        published_comment_context = req.published_comment_context,
        additional_concerns_hint = additional_concerns_hint,
    )
}

#[tauri::command]
pub async fn list_agents_cmd(telemetry_context: Option<TelemetryContext>) -> Vec<AgentInfo> {
    let span = command_span("list_agents_cmd", telemetry_context.as_ref());
    let _enter = span.enter();
    list_agents()
}

#[tauri::command]
pub async fn agent_skill_cmd(telemetry_context: Option<TelemetryContext>) -> String {
    let span = command_span("agent_skill_cmd", telemetry_context.as_ref());
    let _enter = span.enter();
    agent_skill()
}

#[tauri::command]
pub async fn check_gh_cli_cmd(telemetry_context: Option<TelemetryContext>) -> GhCliStatus {
    let span = command_span("check_gh_cli_cmd", telemetry_context.as_ref());
    async { check_installation().await }.instrument(span).await
}

#[tauri::command]
pub async fn start_session_cmd(
    app: AppHandle,
    sessions: State<'_, AcpSessions>,
    req: StartSessionRequest,
    telemetry_context: Option<TelemetryContext>,
) -> Result<StartSessionResponse, String> {
    let span = tracing::info_span!(
        "session.start",
        agent = ?req.agent_kind,
        source = ?req.source,
    );
    telemetry::set_span_parent(&span, telemetry_context.as_ref());
    async move {
        let cloned = resolve_source(&req.source)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "resolve_source failed");
                e.to_string()
            })?;
        tracing::info!(repo = %cloned.display_slug, head = %cloned.head_ref, base = %cloned.base_ref, "repo ready");

        let (pull_request, pull_request_error) = pull_request_metadata_for_source(&req.source).await;
        let (published_comments, published_comments_error) =
            published_comments_for_source(&req.source).await;
        let saved_review = saved_review_for_source(&req.source, &cloned.head_sha).await;

        let session = start_session(
            app,
            req.agent_kind,
            req.reasoning_effort,
            cloned.path.clone(),
        )
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "start_session failed");
                e.to_string()
            })?;
        let session_id = session.session_id.clone();
        tracing::info!(session_id = %session_id, "acp session created");
        sessions.insert(session).await;

        let now = chrono_now();
        let recent = match &req.source {
            SessionSource::Pr {
                repo_url, number, ..
            } => {
                let (owner, repo) = parse_owner_repo(repo_url);
                Some(RecentProject::Pr {
                    repo_url: repo_url.clone(),
                    owner,
                    repo,
                    number: *number,
                    last_opened: now,
                })
            }
            SessionSource::Branch {
                repo_url, branch, ..
            } => {
                let (owner, repo) = parse_owner_repo(repo_url);
                Some(RecentProject::Branch {
                    repo_url: repo_url.clone(),
                    owner,
                    repo,
                    branch: branch.clone(),
                    last_opened: now,
                })
            }
            SessionSource::Sha { .. } => None,
            SessionSource::Local { path }
            | SessionSource::LocalPr { path, .. }
            | SessionSource::LocalBranch { path, .. } => Some(RecentProject::Local {
                path: path.clone(),
                label: cloned.display_slug.clone(),
                last_opened: now,
            }),
        };
        if let Some(r) = recent {
            let _ = projects::record(r).await;
        }

        Ok(StartSessionResponse {
            session_id,
            repo: cloned,
            source: req.source,
            pull_request,
            pull_request_error,
            published_comments,
            published_comments_error,
            saved_review,
        })
    }
    .instrument(span)
    .await
}

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
        let (pull_request, pull_request_error) =
            pull_request_metadata_for_source(&req.source).await;
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

fn is_pr_backed_source(source: &SessionSource) -> bool {
    matches!(
        source,
        SessionSource::Pr { .. } | SessionSource::LocalPr { .. }
    )
}

async fn saved_review_for_source(
    source: &SessionSource,
    current_head_sha: &str,
) -> Option<SavedReviewRecord> {
    let target = target_from_source(source)?;
    let store = match ReviewPersistence::open_default().await {
        Ok(store) => store,
        Err(e) => {
            tracing::warn!(error = %e, "review persistence unavailable");
            return None;
        }
    };
    match store.load(&target).await {
        Ok(Some(mut record)) => {
            record.is_stale = record.is_stale_for(current_head_sha);
            Some(record)
        }
        Ok(None) => None,
        Err(e) => {
            tracing::warn!(error = %e, "saved review unavailable");
            None
        }
    }
}

async fn published_comments_for_source(
    source: &SessionSource,
) -> (Vec<PublishedPrComment>, Option<String>) {
    let target = match source {
        SessionSource::Pr { repo_url, number }
        | SessionSource::LocalPr {
            repo_url, number, ..
        } => Some((repo_url, *number)),
        _ => None,
    };
    let Some((repo_url, number)) = target else {
        return (Vec::new(), None);
    };
    match fetch_pull_request_review_comments(repo_url, number).await {
        Ok(comments) => (comments, None),
        Err(e) => {
            let message = e.to_string();
            tracing::warn!(error = %message, "PR review comments unavailable");
            (Vec::new(), Some(message))
        }
    }
}

async fn pull_request_metadata_for_source(
    source: &SessionSource,
) -> (Option<PullRequestMetadata>, Option<String>) {
    let target = match source {
        SessionSource::Pr { repo_url, number }
        | SessionSource::LocalPr {
            repo_url, number, ..
        } => Some((repo_url, *number)),
        _ => None,
    };
    let Some((repo_url, number)) = target else {
        return (branch_pull_request_metadata_for_source(source).await, None);
    };
    match fetch_pull_request_metadata(repo_url, number).await {
        Ok(metadata) => (Some(metadata), None),
        Err(e) => {
            let message = e.to_string();
            tracing::warn!(error = %message, "PR metadata unavailable");
            (None, Some(message))
        }
    }
}

async fn branch_pull_request_metadata_for_source(
    source: &SessionSource,
) -> Option<PullRequestMetadata> {
    let target = match source {
        SessionSource::Branch { repo_url, branch } => Some((repo_url.clone(), branch.clone())),
        SessionSource::LocalBranch { path, branch } => inspect_origin(path)
            .await
            .ok()
            .map(|origin| (origin.repo_url, branch.clone())),
        _ => None,
    };
    let (repo_url, branch) = target?;
    fetch_pull_request_metadata_for_branch(&repo_url, branch_pr_lookup_name(&branch))
        .await
        .ok()
}

fn branch_pr_lookup_name(branch: &str) -> &str {
    branch
        .trim()
        .strip_prefix("origin/")
        .unwrap_or(branch.trim())
}

fn parse_owner_repo(url: &str) -> (String, String) {
    if let Some(parsed) = url::Url::parse(url).ok() {
        let segs: Vec<&str> = parsed
            .path_segments()
            .map(|s| s.collect())
            .unwrap_or_default();
        if segs.len() >= 2 {
            return (
                segs[0].to_string(),
                segs[1].trim_end_matches(".git").to_string(),
            );
        }
    }
    (String::new(), String::new())
}

fn chrono_now() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

#[tauri::command]
pub async fn parse_pr_url_cmd(
    url: String,
    telemetry_context: Option<TelemetryContext>,
) -> Option<(String, String, u64)> {
    let span = command_span("parse_pr_url_cmd", telemetry_context.as_ref());
    let _enter = span.enter();
    parse_pr_url(&url)
}

#[tauri::command]
pub async fn list_recent_projects_cmd(
    telemetry_context: Option<TelemetryContext>,
) -> Vec<RecentProject> {
    let span = command_span("list_recent_projects_cmd", telemetry_context.as_ref());
    async { projects::load().await.unwrap_or_default() }
        .instrument(span)
        .await
}

#[tauri::command]
pub async fn inspect_local_repo_origin_cmd(
    path: PathBuf,
    telemetry_context: Option<TelemetryContext>,
) -> Result<GithubRepoInfo, String> {
    let span = command_span("inspect_local_repo_origin_cmd", telemetry_context.as_ref());
    async { inspect_origin(&path).await.map_err(|e| e.to_string()) }
        .instrument(span)
        .await
}

#[tauri::command]
pub async fn record_recent_project_cmd(
    project: RecentProject,
    telemetry_context: Option<TelemetryContext>,
) -> Result<(), String> {
    let span = command_span("record_recent_project_cmd", telemetry_context.as_ref());
    async {
        projects::record(project)
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    .instrument(span)
    .await
}

#[tauri::command]
pub async fn save_review_state_cmd(
    req: SaveReviewState,
    telemetry_context: Option<TelemetryContext>,
) -> Result<SavedReviewRecord, String> {
    let span = command_span("save_review_state_cmd", telemetry_context.as_ref());
    async move {
        let store = ReviewPersistence::open_default()
            .await
            .map_err(|e| e.to_string())?;
        store.save(req).await.map_err(|e| e.to_string())
    }
    .instrument(span)
    .await
}

#[tauri::command]
pub async fn delete_saved_review_cmd(
    target: ReviewPersistenceTarget,
    telemetry_context: Option<TelemetryContext>,
) -> Result<(), String> {
    let span = command_span("delete_saved_review_cmd", telemetry_context.as_ref());
    async move {
        let store = ReviewPersistence::open_default()
            .await
            .map_err(|e| e.to_string())?;
        store.delete(&target).await.map_err(|e| e.to_string())
    }
    .instrument(span)
    .await
}

#[tauri::command]
pub async fn list_saved_reviews_for_repo_cmd(
    repo_url: String,
    telemetry_context: Option<TelemetryContext>,
) -> Result<Vec<SavedReviewSummary>, String> {
    let span = command_span(
        "list_saved_reviews_for_repo_cmd",
        telemetry_context.as_ref(),
    );
    async move {
        let store = ReviewPersistence::open_default()
            .await
            .map_err(|e| e.to_string())?;
        let records = store
            .list_by_repo(&repo_url)
            .await
            .map_err(|e| e.to_string())?;
        let summaries = records
            .into_iter()
            .map(|record| SavedReviewSummary {
                id: record.id,
                repo_url: record.repo_url,
                number: record.number,
                pr_title: record.pr_title,
                pr_url: record.pr_url,
                base_ref: record.base_ref,
                head_ref: record.head_ref,
                head_sha: record.head_sha,
                created_at: record.created_at,
                updated_at: record.updated_at,
            })
            .collect();
        Ok(summaries)
    }
    .instrument(span)
    .await
}

#[tauri::command]
pub async fn send_message_cmd(
    sessions: State<'_, AcpSessions>,
    session_id: String,
    text: String,
    origin: Option<String>,
    reason: Option<String>,
    section_id: Option<String>,
    suppress_preview: Option<bool>,
    telemetry_context: Option<TelemetryContext>,
) -> Result<(), String> {
    let span = tracing::info_span!("message.send", session_id = %session_id);
    telemetry::set_span_parent(&span, telemetry_context.as_ref());
    async move {
        let sess = sessions
            .get(&session_id)
            .await
            .ok_or_else(|| "unknown session".to_string())?;
        tracing::info!(
            len = text.len(),
            origin = origin.as_deref().unwrap_or("unknown"),
            reason = reason.as_deref().unwrap_or("unknown"),
            section_id = section_id.as_deref().unwrap_or(""),
            suppress_preview = suppress_preview.unwrap_or(false),
            "user prompt",
        );
        sess.send_prompt(text, origin, reason, section_id)
            .map_err(|e| e.to_string())
    }
    .instrument(span)
    .await
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartChatRequest {
    pub parent_session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartChatResponse {
    pub session_id: String,
}

#[tauri::command]
pub async fn start_chat_cmd(
    app: AppHandle,
    sessions: State<'_, AcpSessions>,
    req: StartChatRequest,
    telemetry_context: Option<TelemetryContext>,
) -> Result<StartChatResponse, String> {
    let span = tracing::info_span!(
        "chat.start",
        parent_session_id = %req.parent_session_id,
    );
    telemetry::set_span_parent(&span, telemetry_context.as_ref());
    async move {
        let parent = sessions
            .get(&req.parent_session_id)
            .await
            .ok_or_else(|| "unknown session".to_string())?;
        let agent_kind = parent.agent_kind;
        let reasoning_effort = parent.reasoning_effort;
        let cwd = parent.cwd.clone();
        drop(parent);
        let session = start_session(app, agent_kind, reasoning_effort, cwd)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "chat session start failed");
                e.to_string()
            })?;
        let session_id = session.session_id.clone();
        tracing::info!(
            session_id = %session_id,
            "chat session ready",
        );
        sessions.insert(session).await;
        Ok(StartChatResponse { session_id })
    }
    .instrument(span)
    .await
}

#[tauri::command]
pub async fn start_section_task_cmd(
    sessions: State<'_, AcpSessions>,
    req: StartSectionTaskRequest,
    telemetry_context: Option<TelemetryContext>,
) -> Result<(), String> {
    let span = tracing::info_span!(
        "section_task.start",
        parent_session_id = %req.parent_session_id,
        section_id = %req.section_id,
    );
    telemetry::set_span_parent(&span, telemetry_context.as_ref());
    async move {
        let parent = sessions
            .get(&req.parent_session_id)
            .await
            .ok_or_else(|| "unknown session".to_string())?;
        let prompt = build_section_task_prompt(&req, &parent.cwd);
        tracing::info!(
            agent = ?parent.agent_kind,
            repo = %parent.cwd.display(),
            file_count = req.files.len(),
            "queueing background section task on parent session",
        );
        parent
            .send_prompt_with_event_options(
                prompt,
                Some("section_background_task".to_string()),
                Some("load_section_feedback".to_string()),
                Some(req.section_id),
                PromptEventOptions::background_section_task(req.parent_session_id),
            )
            .map_err(|e| e.to_string())
    }
    .instrument(span)
    .await
}

#[tauri::command]
pub async fn end_session_cmd(
    sessions: State<'_, AcpSessions>,
    session_id: String,
    telemetry_context: Option<TelemetryContext>,
) -> Result<(), String> {
    let span = command_span("end_session_cmd", telemetry_context.as_ref());
    async move {
        if let Some(sess) = sessions.remove(&session_id).await {
            sess.join.abort();
        }
        Ok(())
    }
    .instrument(span)
    .await
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetFileAtRefArgs {
    pub repo_path: PathBuf,
    pub file_path: String,
    pub refspec: String,
}

#[tauri::command]
pub async fn get_file_at_ref_cmd(
    args: GetFileAtRefArgs,
    telemetry_context: Option<TelemetryContext>,
) -> Result<Option<String>, String> {
    let span = command_span("get_file_at_ref_cmd", telemetry_context.as_ref());
    async move {
        let path = args.repo_path;
        let file = args.file_path;
        let refspec = args.refspec;
        tokio::task::spawn_blocking(move || get_file_at_ref(&path, &file, &refspec))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())
    }
    .instrument(span)
    .await
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetDiffArgs {
    pub repo_path: PathBuf,
    pub base_ref: String,
    pub head_ref: String,
    pub file_path: Option<String>,
}

#[tauri::command]
pub async fn get_diff_cmd(
    args: GetDiffArgs,
    telemetry_context: Option<TelemetryContext>,
) -> Result<Vec<DiffPatch>, String> {
    let span = command_span("get_diff_cmd", telemetry_context.as_ref());
    async move {
        let path = args.repo_path;
        let base = args.base_ref;
        let head = args.head_ref;
        let file = args.file_path;
        tokio::task::spawn_blocking(move || get_diff(&path, &base, &head, file.as_deref()))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())
    }
    .instrument(span)
    .await
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetChangedRangesArgs {
    pub repo_path: PathBuf,
    pub base_ref: String,
    pub head_ref: String,
    pub file_paths: Vec<String>,
}

#[tauri::command]
pub async fn get_changed_ranges_cmd(
    args: GetChangedRangesArgs,
    telemetry_context: Option<TelemetryContext>,
) -> Result<Vec<LineRange>, String> {
    let span = command_span("get_changed_ranges_cmd", telemetry_context.as_ref());
    async move {
        let path = args.repo_path;
        let base = args.base_ref;
        let head = args.head_ref;
        let files = args.file_paths;
        tokio::task::spawn_blocking(move || get_changed_ranges(&path, &base, &head, &files))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())
    }
    .instrument(span)
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn reads_agent_skill_from_disk_when_available() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("guided-review-agent-skill-{unique}.md"));
        fs::write(&path, "fresh skill from disk").expect("write test skill");

        let skill = read_agent_skill_from_disk(&path);

        fs::remove_file(&path).expect("remove test skill");
        assert_eq!(skill.as_deref(), Some("fresh skill from disk"));
    }

    #[test]
    fn embedded_agent_skill_shows_acp_section_fence_with_json_body() {
        assert!(
            AGENT_SKILL.contains("```acp-section\n{\n  \"section_id\": \"api-changes\""),
            "agent skill should show the exact acp-section fence tag with a JSON body"
        );
    }

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

    #[test]
    fn embedded_agent_skill_documents_token_discipline_without_degrading_output() {
        assert!(
            AGENT_SKILL.contains("## Token discipline"),
            "agent skill should include explicit token-saving guidance"
        );
        assert!(
            AGENT_SKILL.contains("Use compact, filler-free notes"),
            "agent skill should permit terse private analysis"
        );
        assert!(
            AGENT_SKILL
                .contains("Do not use caveman-style fragments in any JSON field shown to the user"),
            "agent skill should keep visible structured fields polished"
        );
        assert!(
            AGENT_SKILL.contains("section `title`, section `intent`, concern `text`"),
            "agent skill should name the user-visible fields that stay well written"
        );
    }

    #[test]
    fn section_task_prompt_is_standalone_and_feedback_only() {
        let req = StartSectionTaskRequest {
            parent_session_id: "parent-session".to_string(),
            section_id: "metadata-retention".to_string(),
            title: "Metadata retention".to_string(),
            intent: "Check how saved metadata is preserved.".to_string(),
            files: vec!["src/lib/store.ts".to_string(), "src/App.tsx".to_string()],
            base_ref: "origin/main".to_string(),
            head_ref: "feature".to_string(),
            published_comment_context: "Existing published comments:\n- Already covered."
                .to_string(),
            additional_concerns_hint: None,
        };

        let prompt = build_section_task_prompt(&req, Path::new("/tmp/repo"));

        assert!(prompt.contains("repository is at `/tmp/repo`"));
        assert!(prompt.contains("Section: metadata-retention — Metadata retention"));
        assert!(prompt.contains("Files:\n- src/lib/store.ts\n- src/App.tsx"));
        assert!(prompt.contains("Base ref: origin/main"));
        assert!(prompt.contains("Head ref: feature"));
        assert!(prompt.contains("Existing published comments:\n- Already covered."));
        assert!(prompt.contains("Use compact, filler-free private notes"));
        assert!(prompt.contains("Keep concern text polished, normal, and beginner-friendly"));
        assert!(prompt.contains("Emit exactly one final ```acp-section fenced block"));
        assert!(prompt.contains(
            "Do not include `title`, `intent`, `files`, `ranges`, `base_ref`, or `head_ref`"
        ));
    }

    #[test]
    fn section_task_prompt_includes_additional_concerns_hint_when_present() {
        let req = StartSectionTaskRequest {
            parent_session_id: "parent-session".to_string(),
            section_id: "metadata-retention".to_string(),
            title: "Metadata retention".to_string(),
            intent: "Check how saved metadata is preserved.".to_string(),
            files: vec!["src/lib/store.ts".to_string()],
            base_ref: "origin/main".to_string(),
            head_ref: "feature".to_string(),
            published_comment_context: "No prior comments.".to_string(),
            additional_concerns_hint: Some(
                "Already surfaced:\n- Concern A\nReturn the full list.".to_string(),
            ),
        };

        let prompt = build_section_task_prompt(&req, Path::new("/tmp/repo"));

        assert!(prompt.contains("Already surfaced:\n- Concern A\nReturn the full list."));
    }

    #[test]
    fn section_task_command_uses_parent_session_instead_of_spawning_one() {
        let source = include_str!("commands.rs");
        let start = source
            .find("pub async fn start_section_task_cmd")
            .expect("start_section_task_cmd should exist");
        let end = source[start..]
            .find("pub async fn end_session_cmd")
            .expect("end_session_cmd should follow start_section_task_cmd");
        let body = &source[start..start + end];

        assert!(
            body.contains("send_prompt_with_event_options"),
            "section feedback should run in the existing parent session"
        );
        assert!(
            !body.contains("spawn_section_task"),
            "section feedback should not spawn a fresh ACP session per section"
        );
    }
}
