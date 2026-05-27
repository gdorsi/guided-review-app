use crate::agent_runner::{prepare_agent_command, AgentKind, ReasoningEffort};
use crate::events::*;
use crate::fenced::FencedBuffers;
use crate::section::SectionProgressUpdate;
use crate::telemetry;
use agent_client_protocol::mcp_server::{McpConnectionTo, McpServer, McpTool};
use agent_client_protocol::schema::{
    ContentBlock, ContentChunk, InitializeRequest, ProtocolVersion, RequestPermissionOutcome,
    RequestPermissionRequest, RequestPermissionResponse, SelectedPermissionOutcome, SessionId,
    SessionNotification, SessionUpdate, ToolCall, ToolCallUpdate,
};
use agent_client_protocol::util::MatchDispatch;
use agent_client_protocol::{
    on_receive_notification, on_receive_request, Agent, ByteStreams, Client, SessionMessage,
};
use anyhow::{anyhow, Context, Result};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, Emitter};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};
use tracing::Instrument;
use uuid::Uuid;

const CAPTURE_ASSISTANT_TEXT_ENV: &str = "GUIDED_REVIEW_CAPTURE_ASSISTANT_TEXT";

pub struct AcpSession {
    pub session_id: String,
    pub agent_kind: AgentKind,
    pub reasoning_effort: Option<ReasoningEffort>,
    pub cwd: PathBuf,
    prompt_tx: mpsc::UnboundedSender<PromptRequestMsg>,
    prompt_count: std::sync::atomic::AtomicU64,
    pub join: tokio::task::JoinHandle<()>,
}

fn buffers() -> &'static FencedBuffers {
    static B: OnceLock<FencedBuffers> = OnceLock::new();
    B.get_or_init(FencedBuffers::new)
}

struct PromptRequestMsg {
    text: String,
    prompt_index: u64,
    origin: Option<String>,
    reason: Option<String>,
    section_id: Option<String>,
    event_options: PromptEventOptions,
}

#[derive(Clone)]
struct SessionEventOptions {
    event_session_id: Option<String>,
    emit_text_chunks: bool,
    emit_tool_calls: bool,
    emit_turn_done: bool,
    auto_shutdown_after_turn: bool,
}

impl Default for SessionEventOptions {
    fn default() -> Self {
        Self {
            event_session_id: None,
            emit_text_chunks: true,
            emit_tool_calls: true,
            emit_turn_done: true,
            auto_shutdown_after_turn: false,
        }
    }
}

#[derive(Clone, Default)]
pub struct PromptEventOptions {
    event_session_id: Option<String>,
    emit_text_chunks: Option<bool>,
    emit_tool_calls: Option<bool>,
    emit_turn_done: Option<bool>,
}

impl PromptEventOptions {
    pub fn background_section_task(event_session_id: String) -> Self {
        Self {
            event_session_id: Some(event_session_id),
            emit_text_chunks: Some(false),
            emit_tool_calls: Some(false),
            emit_turn_done: Some(false),
        }
    }
}

impl SessionEventOptions {
    fn for_prompt(&self, prompt: &PromptEventOptions) -> Self {
        Self {
            event_session_id: prompt
                .event_session_id
                .clone()
                .or_else(|| self.event_session_id.clone()),
            emit_text_chunks: prompt.emit_text_chunks.unwrap_or(self.emit_text_chunks),
            emit_tool_calls: prompt.emit_tool_calls.unwrap_or(self.emit_tool_calls),
            emit_turn_done: prompt.emit_turn_done.unwrap_or(self.emit_turn_done),
            auto_shutdown_after_turn: self.auto_shutdown_after_turn,
        }
    }
}

#[derive(Clone)]
struct GuidedReviewUpdateSectionTool {
    app: AppHandle,
    session_id: Arc<std::sync::Mutex<Option<String>>>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
struct GuidedReviewUpdateSectionResult {
    accepted: bool,
}

impl McpTool<Agent> for GuidedReviewUpdateSectionTool {
    type Input = SectionProgressUpdate;
    type Output = GuidedReviewUpdateSectionResult;

    fn name(&self) -> String {
        "guided_review_update_section".to_string()
    }

    fn description(&self) -> String {
        "Progressively updates the current guided review section with feedback only.".to_string()
    }

    fn title(&self) -> Option<String> {
        Some("Update guided review section".to_string())
    }

    async fn call_tool(
        &self,
        input: SectionProgressUpdate,
        _context: McpConnectionTo<Agent>,
    ) -> std::result::Result<GuidedReviewUpdateSectionResult, agent_client_protocol::Error> {
        let session_id = self
            .session_id
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
            .unwrap_or_default();
        let span = tracing::info_span!("acp.section_progress", session_id = %session_id);
        let _enter = span.enter();
        let accepted = self
            .app
            .emit(
                EV_SECTION_PROGRESS,
                SectionProgressEvent {
                    session_id,
                    update: input,
                    telemetry_context: telemetry::current_context(),
                },
            )
            .is_ok();
        Ok(GuidedReviewUpdateSectionResult { accepted })
    }
}

#[derive(Clone)]
struct GuidedReviewShowMessageTool;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
struct GuidedReviewShowMessageInput {
    markdown: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
struct GuidedReviewShowMessageResult {
    accepted: bool,
}

impl McpTool<Agent> for GuidedReviewShowMessageTool {
    type Input = GuidedReviewShowMessageInput;
    type Output = GuidedReviewShowMessageResult;

    fn name(&self) -> String {
        "guided_review_show_message".to_string()
    }

    fn description(&self) -> String {
        "Shows a processed Markdown response to the user in the guided review chat.".to_string()
    }

    fn title(&self) -> Option<String> {
        Some("Show message".to_string())
    }

    async fn call_tool(
        &self,
        _input: GuidedReviewShowMessageInput,
        _context: McpConnectionTo<Agent>,
    ) -> std::result::Result<GuidedReviewShowMessageResult, agent_client_protocol::Error> {
        Ok(GuidedReviewShowMessageResult { accepted: true })
    }
}

#[derive(Default)]
struct StreamDiagnosticState {
    chunks: u64,
    assembled_text: String,
    overlap_events: u64,
    replacement_events: u64,
    max_overlap_len: usize,
}

struct ChunkDiagnostic {
    chunk_index: u64,
    chunk_len: usize,
    assembled_len_before: usize,
    assembled_len_after: usize,
    raw_overlap_len: usize,
    applied_overlap_len: usize,
    replaces_previous: bool,
    overlap_events: u64,
    replacement_events: u64,
    max_overlap_len: usize,
    previous_tail: String,
    chunk_head: String,
}

#[derive(Default)]
struct TurnDiagnosticSummary {
    chunks: u64,
    assembled_len: usize,
    overlap_events: u64,
    replacement_events: u64,
    max_overlap_len: usize,
}

#[derive(Default)]
struct StreamDiagnostics {
    inner: std::sync::Mutex<HashMap<String, StreamDiagnosticState>>,
}

fn stream_diagnostics() -> &'static StreamDiagnostics {
    static D: OnceLock<StreamDiagnostics> = OnceLock::new();
    D.get_or_init(StreamDiagnostics::default)
}

impl StreamDiagnostics {
    fn record_chunk(&self, session_id: &str, chunk: &str) -> ChunkDiagnostic {
        let mut guard = self.inner.lock().expect("poisoned");
        let state = guard.entry(session_id.to_string()).or_default();
        let assembled_len_before = state.assembled_text.len();
        let raw_overlap_len = shared_boundary_len(&state.assembled_text, chunk);
        let replaces_previous =
            !state.assembled_text.is_empty() && chunk.starts_with(&state.assembled_text);
        let applied_overlap_len = if replaces_previous || raw_overlap_len >= 4 {
            raw_overlap_len
        } else {
            0
        };
        let previous_tail = preview_tail(&state.assembled_text, 32);
        let chunk_head = preview_head(chunk, 32);

        state.chunks += 1;
        if applied_overlap_len > 0 {
            state.overlap_events += 1;
            state.max_overlap_len = state.max_overlap_len.max(applied_overlap_len);
        }
        if replaces_previous {
            state.replacement_events += 1;
            state.assembled_text = chunk.to_string();
        } else if applied_overlap_len > 0 {
            state.assembled_text.push_str(&chunk[applied_overlap_len..]);
        } else {
            state.assembled_text.push_str(chunk);
        }

        ChunkDiagnostic {
            chunk_index: state.chunks,
            chunk_len: chunk.len(),
            assembled_len_before,
            assembled_len_after: state.assembled_text.len(),
            raw_overlap_len,
            applied_overlap_len,
            replaces_previous,
            overlap_events: state.overlap_events,
            replacement_events: state.replacement_events,
            max_overlap_len: state.max_overlap_len,
            previous_tail,
            chunk_head,
        }
    }

    fn finish_turn(&self, session_id: &str) -> TurnDiagnosticSummary {
        let mut guard = self.inner.lock().expect("poisoned");
        let Some(state) = guard.remove(session_id) else {
            return TurnDiagnosticSummary::default();
        };

        TurnDiagnosticSummary {
            chunks: state.chunks,
            assembled_len: state.assembled_text.len(),
            overlap_events: state.overlap_events,
            replacement_events: state.replacement_events,
            max_overlap_len: state.max_overlap_len,
        }
    }
}

#[derive(Default, Clone)]
pub struct AcpSessions {
    inner: Arc<Mutex<HashMap<String, Arc<AcpSession>>>>,
}

impl AcpSessions {
    pub async fn insert(&self, sess: AcpSession) {
        let id = sess.session_id.clone();
        self.inner.lock().await.insert(id, Arc::new(sess));
    }

    pub async fn get(&self, id: &str) -> Option<Arc<AcpSession>> {
        self.inner.lock().await.get(id).cloned()
    }

    pub async fn remove(&self, id: &str) -> Option<Arc<AcpSession>> {
        self.inner.lock().await.remove(id)
    }

    pub async fn shutdown_all(&self) {
        let mut guard = self.inner.lock().await;
        for (_, sess) in guard.drain() {
            sess.join.abort();
        }
    }
}

pub async fn start_session(
    app: AppHandle,
    agent_kind: AgentKind,
    reasoning_effort: Option<ReasoningEffort>,
    cwd: PathBuf,
) -> Result<AcpSession> {
    start_session_with_options(
        app,
        agent_kind,
        reasoning_effort,
        cwd,
        SessionEventOptions::default(),
    )
    .await
}

async fn start_session_with_options(
    app: AppHandle,
    agent_kind: AgentKind,
    reasoning_effort: Option<ReasoningEffort>,
    cwd: PathBuf,
    event_options: SessionEventOptions,
) -> Result<AcpSession> {
    let (session_id_tx, session_id_rx) = oneshot::channel::<String>();
    let (prompt_tx, mut prompt_rx) = mpsc::unbounded_channel::<PromptRequestMsg>();

    let agent_command = crate::agent_runner::AgentLaunchConfig {
        kind: agent_kind,
        reasoning_effort,
    }
    .launch_command();
    let prepared_command = prepare_agent_command(&agent_command)?;
    let program = prepared_command.program.clone();

    let mut cmd = Command::new(&program);
    cmd.args(&prepared_command.args)
        .current_dir(&cwd)
        .env("PATH", &prepared_command.path_env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    tracing::info!(
        agent = ?agent_kind,
        reasoning_effort = ?reasoning_effort,
        program = %program.display(),
        "agent command prepared"
    );
    scrub_nested_agent_env(&mut cmd);
    let mut child = cmd
        .spawn()
        .with_context(|| format!("spawning agent {:?}", program.display().to_string()))?;

    let child_stdin = child.stdin.take().ok_or_else(|| anyhow!("no stdin"))?;
    let child_stdout = child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;
    let child_stderr = child.stderr.take();

    let app_for_task = app.clone();

    if let Some(stderr) = child_stderr {
        let app_for_stderr = app.clone();
        let agent_label = format!("{:?}", agent_kind);
        let stderr_span = tracing::info_span!("acp.agent_stderr", agent = %agent_label);
        tokio::spawn(
            async move {
                use tokio::io::{AsyncBufReadExt, BufReader};
                let mut reader = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    tracing::warn!(line = %line, "agent stderr");
                    let _ = app_for_stderr.emit(
                        EV_AGENT_STDERR,
                        AgentStderrEvent {
                            session_id: String::new(),
                            line,
                            telemetry_context: telemetry::current_context(),
                        },
                    );
                }
            }
            .instrument(stderr_span),
        );
    }

    let session_cwd = cwd.clone();
    let join = tokio::spawn(async move {
        let transport = ByteStreams::new(child_stdin.compat_write(), child_stdout.compat());
        let app_for_notif = app_for_task.clone();
        let app_for_loop = app_for_task.clone();
        let result_event_session_id = event_options.event_session_id.clone();
        let options_for_notif = event_options.clone();
        let options_for_loop = event_options.clone();

        let result = Client
            .builder()
            .name("guided-review")
            .on_receive_notification(
                async move |notification: SessionNotification, _cx| {
                    handle_notification(&app_for_notif, notification, &options_for_notif);
                    Ok(())
                },
                on_receive_notification!(),
            )
            .on_receive_request(
                async move |req: RequestPermissionRequest, responder, _cx| {
                    let option_id = req.options.first().map(|o| o.option_id.clone());
                    let outcome = match option_id {
                        Some(id) => {
                            RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(id))
                        }
                        None => RequestPermissionOutcome::Cancelled,
                    };
                    responder.respond(RequestPermissionResponse::new(outcome))
                },
                on_receive_request!(),
            )
            .connect_with(transport, async move |cx| {
                let init = cx
                    .send_request(InitializeRequest::new(ProtocolVersion::V1))
                    .block_task()
                    .await
                    .inspect_err(|e| tracing::error!(error = %e, "initialize failed"))?;
                tracing::info!(
                    agent_info = ?init.agent_info,
                    auth_methods = init.auth_methods.len(),
                    "initialized",
                );

                let section_progress_session_id =
                    Arc::new(std::sync::Mutex::new(options_for_loop.event_session_id.clone()));
                let section_progress_server = McpServer::<Agent, _>::builder("guided-review")
                    .instructions(
                        "Use guided_review_show_message for any user-visible Markdown reply. Use guided_review_update_section only for review feedback. Do not send files or ranges; the section map and local Git own those.",
                    )
                    .tool(GuidedReviewUpdateSectionTool {
                        app: app_for_loop.clone(),
                        session_id: section_progress_session_id.clone(),
                    })
                    .tool(GuidedReviewShowMessageTool)
                    .build();
                let mut active_session = cx
                    .build_session(cwd)
                    .with_mcp_server(section_progress_server)?
                    .block_task()
                    .start_session()
                    .await
                    .inspect_err(|e| tracing::error!(error = %e, "newSession failed (likely auth — try `claude /login` for Claude Code, `codex login` for Codex)"))?;
                let session_id: SessionId = active_session.session_id().clone();
                let session_id_str = session_id.to_string();
                if let Ok(mut guard) = section_progress_session_id.lock() {
                    if guard.is_none() {
                        *guard = Some(session_id_str.clone());
                    }
                }
                let _ = session_id_tx.send(session_id_str.clone());

                while let Some(msg) = prompt_rx.recv().await {
                    let turn_options = options_for_loop.for_prompt(&msg.event_options);
                    let event_session_id = turn_options
                        .event_session_id
                        .clone()
                        .unwrap_or_else(|| session_id_str.clone());
                    let turn_span = tracing::info_span!(
                        "acp.prompt_turn",
                        session_id = %session_id_str,
                        prompt_len = msg.text.len(),
                        prompt_index = msg.prompt_index,
                        prompt_origin = msg.origin.as_deref().unwrap_or("unknown"),
                        prompt_reason = msg.reason.as_deref().unwrap_or("unknown"),
                        section_id = msg.section_id.as_deref().unwrap_or(""),
                    );
                    async {
                        match active_session.send_prompt(msg.text) {
                            Ok(()) => loop {
                                match active_session.read_update().await {
                                    Ok(SessionMessage::SessionMessage(dispatch)) => {
                                        if let Err(e) = MatchDispatch::new(dispatch)
                                            .if_notification(
                                                async |notification: SessionNotification| {
                                                    handle_notification(
                                                        &app_for_loop,
                                                        notification,
                                                        &turn_options,
                                                    );
                                                    Ok(())
                                                },
                                            )
                                            .await
                                            .otherwise_ignore()
                                        {
                                            tracing::warn!(error = %e, "session update ignored after dispatch error");
                                        }
                                    }
                                    Ok(SessionMessage::StopReason(stop_reason)) => {
                                        let stop = format!("{stop_reason:?}");
                                        let summary =
                                            stream_diagnostics().finish_turn(&session_id_str);
                                        tracing::info!(
                                            stop_reason = %stop,
                                            chunks = summary.chunks,
                                            assembled_len = summary.assembled_len,
                                            overlap_events = summary.overlap_events,
                                            replacement_events = summary.replacement_events,
                                            max_overlap_len = summary.max_overlap_len,
                                            "turn complete",
                                        );
                                        if turn_options.emit_turn_done {
                                            let _ = app_for_loop.emit(
                                                EV_TURN_DONE,
                                                TurnDoneEvent {
                                                    session_id: event_session_id.clone(),
                                                    stop_reason: stop,
                                                    telemetry_context: telemetry::current_context(),
                                                },
                                            );
                                        }
                                        break;
                                    }
                                    Ok(_) => {}
                                    Err(e) => {
                                        let summary =
                                            stream_diagnostics().finish_turn(&session_id_str);
                                        tracing::error!(error = %e, "reading session update failed");
                                        tracing::warn!(
                                            chunks = summary.chunks,
                                            assembled_len = summary.assembled_len,
                                            overlap_events = summary.overlap_events,
                                            replacement_events = summary.replacement_events,
                                            max_overlap_len = summary.max_overlap_len,
                                            "turn ended before completion",
                                        );
                                        emit_error(
                                            &app_for_loop,
                                            Some(event_session_id.clone()),
                                            format!("prompt failed: {e}"),
                                        );
                                        break;
                                    }
                                }
                            },
                            Err(e) => {
                                let summary = stream_diagnostics().finish_turn(&session_id_str);
                                tracing::error!(error = %e, "prompt failed");
                                tracing::warn!(
                                    chunks = summary.chunks,
                                    assembled_len = summary.assembled_len,
                                    overlap_events = summary.overlap_events,
                                    replacement_events = summary.replacement_events,
                                    max_overlap_len = summary.max_overlap_len,
                                    "turn ended before completion",
                                );
                                emit_error(
                                    &app_for_loop,
                                    Some(event_session_id.clone()),
                                    format!("prompt failed: {e}"),
                                );
                            }
                        }
                    }
                    .instrument(turn_span)
                    .await;
                    if options_for_loop.auto_shutdown_after_turn {
                        break;
                    }
                }
                Ok(())
            })
            .await;

        if let Err(e) = result {
            emit_error(
                &app_for_task,
                result_event_session_id,
                format!("acp connection ended: {e}"),
            );
        }

        let _ = child.kill().await;
    });

    let session_id = session_id_rx
        .await
        .map_err(|_| anyhow!("agent process exited before sending session id"))?;

    Ok(AcpSession {
        session_id,
        agent_kind,
        reasoning_effort,
        cwd: session_cwd,
        prompt_tx,
        prompt_count: std::sync::atomic::AtomicU64::new(0),
        join,
    })
}

impl AcpSession {
    pub fn send_prompt(
        &self,
        text: String,
        origin: Option<String>,
        reason: Option<String>,
        section_id: Option<String>,
    ) -> Result<()> {
        self.send_prompt_with_event_options(
            text,
            origin,
            reason,
            section_id,
            PromptEventOptions::default(),
        )
    }

    pub fn send_prompt_with_event_options(
        &self,
        text: String,
        origin: Option<String>,
        reason: Option<String>,
        section_id: Option<String>,
        event_options: PromptEventOptions,
    ) -> Result<()> {
        let prompt_index = self
            .prompt_count
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            + 1;
        self.prompt_tx
            .send(PromptRequestMsg {
                text,
                prompt_index,
                origin,
                reason,
                section_id,
                event_options,
            })
            .map_err(|_| anyhow!("session has shut down"))
    }
}

fn handle_notification(app: &AppHandle, notif: SessionNotification, options: &SessionEventOptions) {
    let session_id = notif.session_id.to_string();
    let event_session_id = options
        .event_session_id
        .as_deref()
        .unwrap_or(session_id.as_str());
    let _span = tracing::debug_span!("acp.notification", session_id = %session_id).entered();
    match notif.update {
        SessionUpdate::AgentMessageChunk(chunk) => {
            let text = content_chunk_text(&chunk);
            let diagnostic = stream_diagnostics().record_chunk(&session_id, &text);
            let chunk_span = tracing::debug_span!(
                "acp.agent_message_chunk",
                session_id = %session_id,
                chunk_index = diagnostic.chunk_index,
                chunk_len = diagnostic.chunk_len,
            );
            let _enter = chunk_span.enter();
            if capture_assistant_text_enabled() {
                tracing::debug!(
                    chunk_index = diagnostic.chunk_index,
                    chunk_len = diagnostic.chunk_len,
                    assembled_len_before = diagnostic.assembled_len_before,
                    assembled_len_after = diagnostic.assembled_len_after,
                    raw_overlap_len = diagnostic.raw_overlap_len,
                    applied_overlap_len = diagnostic.applied_overlap_len,
                    replaces_previous = diagnostic.replaces_previous,
                    overlap_events = diagnostic.overlap_events,
                    replacement_events = diagnostic.replacement_events,
                    max_overlap_len = diagnostic.max_overlap_len,
                    previous_tail = %diagnostic.previous_tail,
                    chunk_head = %diagnostic.chunk_head,
                    text = %text,
                    "agent_message_chunk",
                );
            } else {
                tracing::debug!(
                    chunk_index = diagnostic.chunk_index,
                    chunk_len = diagnostic.chunk_len,
                    assembled_len_before = diagnostic.assembled_len_before,
                    assembled_len_after = diagnostic.assembled_len_after,
                    raw_overlap_len = diagnostic.raw_overlap_len,
                    applied_overlap_len = diagnostic.applied_overlap_len,
                    replaces_previous = diagnostic.replaces_previous,
                    overlap_events = diagnostic.overlap_events,
                    replacement_events = diagnostic.replacement_events,
                    max_overlap_len = diagnostic.max_overlap_len,
                    "agent_message_chunk",
                );
            }
            if diagnostic.applied_overlap_len > 0 {
                tracing::warn!(
                    chunk_index = diagnostic.chunk_index,
                    chunk_len = diagnostic.chunk_len,
                    assembled_len_before = diagnostic.assembled_len_before,
                    applied_overlap_len = diagnostic.applied_overlap_len,
                    replaces_previous = diagnostic.replaces_previous,
                    "agent_message_chunk_overlap_detected",
                );
            }
            buffers().append(
                app,
                &session_id,
                event_session_id,
                &text,
                !options.emit_text_chunks,
            );
            if options.emit_text_chunks {
                let _ = app.emit(
                    EV_TEXT_CHUNK,
                    TextChunkEvent {
                        session_id: event_session_id.to_string(),
                        message_id: format!("turn-{}", Uuid::new_v4()),
                        text,
                        kind: "response".to_string(),
                        telemetry_context: telemetry::current_context(),
                    },
                );
            }
        }
        SessionUpdate::AgentThoughtChunk(_) | SessionUpdate::UserMessageChunk(_) => {}
        SessionUpdate::ToolCall(tc) => {
            tracing::info!(
                tool_call_id = %tc.tool_call_id,
                title = %tc.title,
                kind = ?tc.kind,
                status = ?tc.status,
                "tool_call",
            );
            if options.emit_tool_calls {
                emit_tool_call(app, event_session_id, &tc);
            }
        }
        SessionUpdate::ToolCallUpdate(tcu) => {
            tracing::info!(tool_call_id = %tcu.tool_call_id, "tool_call_update");
            if options.emit_tool_calls {
                emit_tool_call_update(app, event_session_id, &tcu);
            }
        }
        _ => {}
    }
}

fn content_chunk_text(chunk: &ContentChunk) -> String {
    match &chunk.content {
        ContentBlock::Text(t) => t.text.clone(),
        _ => String::new(),
    }
}

fn shared_boundary_len(current: &str, chunk: &str) -> usize {
    let max_overlap = current.len().min(chunk.len());
    for overlap in (1..=max_overlap).rev() {
        if !chunk.is_char_boundary(overlap) {
            continue;
        }
        let current_start = current.len() - overlap;
        if !current.is_char_boundary(current_start) {
            continue;
        }
        if current[current_start..].eq(&chunk[..overlap]) {
            return overlap;
        }
    }
    0
}

fn preview_head(text: &str, max_chars: usize) -> String {
    text.chars().take(max_chars).collect()
}

fn preview_tail(text: &str, max_chars: usize) -> String {
    let mut chars: Vec<char> = text.chars().rev().take(max_chars).collect();
    chars.reverse();
    chars.into_iter().collect()
}

fn capture_assistant_text_enabled() -> bool {
    let override_value = std::env::var(CAPTURE_ASSISTANT_TEXT_ENV).ok();
    capture_assistant_text_enabled_for(override_value.as_deref(), cfg!(debug_assertions))
}

fn capture_assistant_text_enabled_for(override_value: Option<&str>, debug_build: bool) -> bool {
    match override_value.map(str::trim) {
        Some("1") => true,
        Some("0") => false,
        _ => debug_build,
    }
}

fn emit_tool_call(app: &AppHandle, session_id: &str, tc: &ToolCall) {
    let span = tracing::info_span!(
        "acp.tool_call",
        session_id = %session_id,
        tool_call_id = %tc.tool_call_id,
    );
    let _enter = span.enter();
    let _ = app.emit(
        EV_TOOL_CALL,
        ToolCallEvent {
            session_id: session_id.to_string(),
            tool_call_id: tc.tool_call_id.to_string(),
            title: tc.title.clone(),
            kind: format!("{:?}", tc.kind),
            status: format!("{:?}", tc.status),
            raw_input: tc.raw_input.clone(),
            telemetry_context: telemetry::current_context(),
        },
    );
}

fn emit_tool_call_update(app: &AppHandle, session_id: &str, tcu: &ToolCallUpdate) {
    let span = tracing::info_span!(
        "acp.tool_call_update",
        session_id = %session_id,
        tool_call_id = %tcu.tool_call_id,
    );
    let _enter = span.enter();
    let _ = app.emit(
        EV_TOOL_CALL_UPDATE,
        ToolCallUpdateEvent {
            session_id: session_id.to_string(),
            tool_call_id: tcu.tool_call_id.to_string(),
            status: tcu
                .fields
                .status
                .map(|s| format!("{s:?}"))
                .unwrap_or_default(),
            raw_output: tcu.fields.raw_output.clone(),
            telemetry_context: telemetry::current_context(),
        },
    );
}

fn emit_error(app: &AppHandle, session_id: Option<String>, error: String) {
    let span = tracing::warn_span!(
        "acp.error_event",
        session_id = session_id.as_deref().unwrap_or("")
    );
    let _enter = span.enter();
    let _ = app.emit(
        EV_ERROR,
        ErrorEvent {
            session_id,
            error,
            telemetry_context: telemetry::current_context(),
        },
    );
}

fn scrub_nested_agent_env(cmd: &mut Command) {
    // Claude Code refuses to start when CLAUDECODE / CLAUDE_CODE_* are set
    // (it thinks it's nested inside another Claude Code session). Same idea
    // for Codex — strip its session vars when re-launching.
    const PREFIXES: &[&str] = &["CLAUDECODE", "CLAUDE_CODE_", "CODEX_", "ACP_"];
    for (k, _) in std::env::vars() {
        if PREFIXES.iter().any(|p| k.starts_with(p)) {
            cmd.env_remove(&k);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        capture_assistant_text_enabled_for, shared_boundary_len, PromptEventOptions,
        SessionEventOptions,
    };

    #[test]
    fn captures_text_by_default_in_debug_builds() {
        assert!(capture_assistant_text_enabled_for(None, true));
    }

    #[test]
    fn skips_text_by_default_in_release_builds() {
        assert!(!capture_assistant_text_enabled_for(None, false));
    }

    #[test]
    fn env_var_can_force_text_capture_on() {
        assert!(capture_assistant_text_enabled_for(Some("1"), false));
    }

    #[test]
    fn env_var_can_force_text_capture_off() {
        assert!(!capture_assistant_text_enabled_for(Some("0"), true));
    }

    #[test]
    fn detects_streaming_chunk_boundary_overlap() {
        assert_eq!(shared_boundary_len("This", "This function checks"), 4);
        assert_eq!(
            shared_boundary_len("Codex, Claude Code", "Claude Code, Cursor"),
            "Claude Code".len()
        );
    }

    #[test]
    fn handles_utf8_overlap_boundaries() {
        assert_eq!(
            shared_boundary_len("agent says café", "café today"),
            "café".len()
        );
    }

    #[test]
    fn background_section_task_prompt_options_suppress_chat_events() {
        let options = SessionEventOptions::default().for_prompt(
            &PromptEventOptions::background_section_task("parent".to_string()),
        );

        assert_eq!(options.event_session_id.as_deref(), Some("parent"));
        assert!(!options.emit_text_chunks);
        assert!(!options.emit_tool_calls);
        assert!(!options.emit_turn_done);
        assert!(!options.auto_shutdown_after_turn);
    }

    #[test]
    fn default_prompt_options_preserve_session_event_options() {
        let session_options = SessionEventOptions {
            event_session_id: Some("alias".to_string()),
            emit_text_chunks: false,
            emit_tool_calls: false,
            emit_turn_done: false,
            auto_shutdown_after_turn: true,
        };

        let options = session_options.for_prompt(&PromptEventOptions::default());

        assert_eq!(options.event_session_id.as_deref(), Some("alias"));
        assert!(!options.emit_text_chunks);
        assert!(!options.emit_tool_calls);
        assert!(!options.emit_turn_done);
        assert!(options.auto_shutdown_after_turn);
    }
}
