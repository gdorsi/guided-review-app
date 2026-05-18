use crate::section::{
    CommentDraft, CommentResult, ReviewSection, SectionMap, SectionProgressUpdate,
};
use crate::telemetry::TelemetryContext;
use serde::Serialize;

pub const EV_SECTION_MAP: &str = "acp://section-map";
pub const EV_SECTION: &str = "acp://section";
pub const EV_SECTION_PROGRESS: &str = "acp://section-progress";
pub const EV_PR_DESCRIPTION: &str = "acp://pr-description";
pub const EV_TEXT_CHUNK: &str = "acp://text-chunk";
pub const EV_TOOL_CALL: &str = "acp://tool-call";
pub const EV_TOOL_CALL_UPDATE: &str = "acp://tool-call-update";
pub const EV_TURN_DONE: &str = "acp://turn-done";
pub const EV_ERROR: &str = "acp://error";
pub const EV_COMMENT_DRAFT: &str = "acp://comment-draft";
pub const EV_COMMENT_RESULT: &str = "acp://comment-result";
pub const EV_AGENT_STDERR: &str = "acp://agent-stderr";

#[derive(Debug, Clone, Serialize)]
pub struct SectionMapEvent {
    pub session_id: String,
    pub map: SectionMap,
    pub suppress_chat: bool,
    pub telemetry_context: TelemetryContext,
}

#[derive(Debug, Clone, Serialize)]
pub struct SectionEvent {
    pub session_id: String,
    pub section: ReviewSection,
    pub suppress_chat: bool,
    pub telemetry_context: TelemetryContext,
}

#[derive(Debug, Clone, Serialize)]
pub struct PrDescriptionEvent {
    pub session_id: String,
    pub body: String,
    pub telemetry_context: TelemetryContext,
}

#[derive(Debug, Clone, Serialize)]
pub struct SectionProgressEvent {
    pub session_id: String,
    pub update: SectionProgressUpdate,
    pub telemetry_context: TelemetryContext,
}

#[derive(Debug, Clone, Serialize)]
pub struct TextChunkEvent {
    pub session_id: String,
    pub message_id: String,
    pub text: String,
    pub telemetry_context: TelemetryContext,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolCallEvent {
    pub session_id: String,
    pub tool_call_id: String,
    pub title: String,
    pub kind: String,
    pub status: String,
    pub raw_input: Option<serde_json::Value>,
    pub telemetry_context: TelemetryContext,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolCallUpdateEvent {
    pub session_id: String,
    pub tool_call_id: String,
    pub status: String,
    pub raw_output: Option<serde_json::Value>,
    pub telemetry_context: TelemetryContext,
}

#[derive(Debug, Clone, Serialize)]
pub struct TurnDoneEvent {
    pub session_id: String,
    pub stop_reason: String,
    pub telemetry_context: TelemetryContext,
}

#[derive(Debug, Clone, Serialize)]
pub struct ErrorEvent {
    pub session_id: Option<String>,
    pub error: String,
    pub telemetry_context: TelemetryContext,
}

#[derive(Debug, Clone, Serialize)]
pub struct CommentDraftEvent {
    pub session_id: String,
    pub draft_id: String,
    pub draft: CommentDraft,
    pub telemetry_context: TelemetryContext,
}

#[derive(Debug, Clone, Serialize)]
pub struct CommentResultEvent {
    pub session_id: String,
    pub result: CommentResult,
    pub telemetry_context: TelemetryContext,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentStderrEvent {
    pub session_id: String,
    pub line: String,
    pub telemetry_context: TelemetryContext,
}
