use crate::events::*;
use crate::section::{CommentDraft, CommentResult, ReviewSection, SectionMap};
use crate::telemetry;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

const TAG_SECTION_MAP: &str = "acp-section-map";
const TAG_SECTION: &str = "acp-section";
const TAG_COMMENT_DRAFT: &str = "acp-comment-draft";
const TAG_COMMENT_RESULT: &str = "acp-comment-result";
const TAG_PR_DESCRIPTION: &str = "acp-pr-description";

#[derive(Debug, Deserialize)]
struct SectionMapWire {
    #[serde(default)]
    schema_version: Option<u32>,
    sections: Vec<crate::section::SectionMapEntry>,
}

#[derive(Debug, Deserialize)]
struct SectionWire {
    #[serde(default)]
    schema_version: Option<u32>,
    section_id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    intent: String,
    #[serde(default)]
    files: Vec<String>,
    #[serde(default)]
    ranges: Vec<crate::section::LineRange>,
    #[serde(default)]
    concerns: Vec<crate::section::Concern>,
    #[serde(default)]
    base_ref: String,
    #[serde(default)]
    head_ref: String,
    #[serde(default)]
    pause_prompt: String,
}

pub struct FencedBuffers {
    inner: Mutex<HashMap<String, String>>,
}

impl FencedBuffers {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    pub fn append(
        &self,
        app: &AppHandle,
        buffer_id: &str,
        event_session_id: &str,
        chunk: &str,
        suppress_chat: bool,
    ) {
        let mut guard = self.inner.lock().expect("poisoned");
        let buf = guard.entry(buffer_id.to_string()).or_default();
        buf.push_str(chunk);
        let extracted = extract_fenced_blocks(buf);
        if extracted.is_empty() {
            return;
        }
        let consumed_to = extracted.last().map(|(_, _, end)| *end).unwrap_or(0);
        let remaining = buf[consumed_to..].to_string();
        *buf = remaining;
        drop(guard);

        for (tag, body, _) in extracted {
            handle_block(app, event_session_id, &tag, &body, suppress_chat);
        }
    }
}

fn parse_lenient<T: DeserializeOwned>(body: &str) -> Result<T, String> {
    match serde_json::from_str::<T>(body) {
        Ok(v) => Ok(v),
        Err(strict) => match json5::from_str::<T>(body) {
            Ok(v) => Ok(v),
            Err(lax) => Err(format!("strict: {strict}; lenient: {lax}")),
        },
    }
}

fn snippet(body: &str) -> String {
    let mut s = body.replace('\n', "⏎");
    if s.len() > 240 {
        s.truncate(240);
        s.push('…');
    }
    s
}

fn handle_block(app: &AppHandle, session_id: &str, tag: &str, body: &str, suppress_chat: bool) {
    match tag {
        TAG_SECTION_MAP => match parse_lenient::<SectionMapWire>(body) {
            Ok(wire) => {
                let map = SectionMap {
                    schema_version: wire.schema_version.unwrap_or(1),
                    sections: wire.sections,
                };
                let span = tracing::info_span!(
                    "acp.section_map",
                    session_id,
                    sections = map.sections.len(),
                );
                let _enter = span.enter();
                tracing::info!(
                    session_id,
                    sections = map.sections.len(),
                    "section_map parsed"
                );
                let _ = app.emit(
                    EV_SECTION_MAP,
                    SectionMapEvent {
                        session_id: session_id.to_string(),
                        map,
                        suppress_chat,
                        telemetry_context: telemetry::current_context(),
                    },
                );
            }
            Err(e) => {
                tracing::warn!(session_id, error = %e, body_snippet = %snippet(body), "failed to parse section_map");
                let _ = app.emit(
                    EV_ERROR,
                    ErrorEvent {
                        session_id: Some(session_id.to_string()),
                        error: format!("section map JSON invalid: {e}"),
                        telemetry_context: telemetry::current_context(),
                    },
                );
            }
        },
        TAG_SECTION => match parse_lenient::<SectionWire>(body) {
            Ok(wire) => {
                let section = ReviewSection {
                    schema_version: wire.schema_version.unwrap_or(1),
                    section_id: wire.section_id,
                    title: wire.title,
                    intent: wire.intent,
                    files: wire.files,
                    ranges: wire.ranges,
                    concerns: wire.concerns,
                    base_ref: wire.base_ref,
                    head_ref: wire.head_ref,
                    pause_prompt: wire.pause_prompt,
                };
                let span = tracing::info_span!(
                    "acp.section",
                    session_id,
                    section_id = %section.section_id,
                    files = section.files.len(),
                    concerns = section.concerns.len(),
                );
                let _enter = span.enter();
                tracing::info!(
                    session_id,
                    section_id = %section.section_id,
                    files = section.files.len(),
                    concerns = section.concerns.len(),
                    "section parsed",
                );
                let _ = app.emit(
                    EV_SECTION,
                    SectionEvent {
                        session_id: session_id.to_string(),
                        section,
                        suppress_chat,
                        telemetry_context: telemetry::current_context(),
                    },
                );
            }
            Err(e) => {
                tracing::warn!(session_id, error = %e, body_snippet = %snippet(body), "failed to parse section");
                let _ = app.emit(
                    EV_ERROR,
                    ErrorEvent {
                        session_id: Some(session_id.to_string()),
                        error: format!("section JSON invalid: {e}"),
                        telemetry_context: telemetry::current_context(),
                    },
                );
            }
        },
        TAG_COMMENT_DRAFT => match parse_lenient::<CommentDraft>(body) {
            Ok(draft) => {
                let span = tracing::info_span!("acp.comment_draft", session_id);
                let _enter = span.enter();
                tracing::info!(session_id, kind = ?draft.kind, "comment draft parsed");
                let draft_id = format!("draft-{}", uuid::Uuid::new_v4());
                let _ = app.emit(
                    EV_COMMENT_DRAFT,
                    CommentDraftEvent {
                        session_id: session_id.to_string(),
                        draft_id,
                        draft,
                        telemetry_context: telemetry::current_context(),
                    },
                );
            }
            Err(e) => {
                tracing::warn!(session_id, error = %e, body_snippet = %snippet(body), "failed to parse comment draft");
            }
        },
        TAG_PR_DESCRIPTION => {
            let trimmed = body.trim();
            if trimmed.is_empty() {
                tracing::warn!(session_id, "empty pr_description block");
            } else {
                let span = tracing::info_span!(
                    "acp.pr_description",
                    session_id,
                    body_len = trimmed.len(),
                );
                let _enter = span.enter();
                tracing::info!(
                    session_id,
                    body_len = trimmed.len(),
                    "pr_description parsed"
                );
                let _ = app.emit(
                    EV_PR_DESCRIPTION,
                    PrDescriptionEvent {
                        session_id: session_id.to_string(),
                        body: trimmed.to_string(),
                        telemetry_context: telemetry::current_context(),
                    },
                );
            }
        }
        TAG_COMMENT_RESULT => match parse_lenient::<CommentResult>(body) {
            Ok(result) => {
                let span = tracing::info_span!(
                    "acp.comment_result",
                    session_id,
                    draft_id = %result.draft_id,
                    status = ?result.status,
                );
                let _enter = span.enter();
                tracing::info!(
                    session_id,
                    draft_id = %result.draft_id,
                    status = ?result.status,
                    "comment result parsed",
                );
                let _ = app.emit(
                    EV_COMMENT_RESULT,
                    CommentResultEvent {
                        session_id: session_id.to_string(),
                        result,
                        telemetry_context: telemetry::current_context(),
                    },
                );
            }
            Err(e) => {
                tracing::warn!(session_id, error = %e, body_snippet = %snippet(body), "failed to parse comment result");
                let _ = app.emit(
                    EV_ERROR,
                    ErrorEvent {
                        session_id: Some(session_id.to_string()),
                        error: format!("comment result JSON invalid: {e}"),
                        telemetry_context: telemetry::current_context(),
                    },
                );
            }
        },
        _ => {}
    }
}

fn extract_fenced_blocks(buf: &str) -> Vec<(String, String, usize)> {
    let mut out = Vec::new();
    let mut search = 0usize;
    while let Some(rel) = buf[search..].find("```") {
        let open_start = search + rel;
        let after_open = open_start + 3;
        let line_end = match buf[after_open..].find('\n') {
            Some(i) => after_open + i,
            None => break,
        };
        let tag_line = buf[after_open..line_end].trim();
        if tag_line != TAG_SECTION_MAP
            && tag_line != TAG_SECTION
            && tag_line != TAG_COMMENT_DRAFT
            && tag_line != TAG_COMMENT_RESULT
            && tag_line != TAG_PR_DESCRIPTION
        {
            search = after_open;
            continue;
        }
        let body_start = line_end + 1;
        let close_rel = match buf[body_start..].find("\n```") {
            Some(i) => i,
            None => break,
        };
        let body = buf[body_start..body_start + close_rel].to_string();
        let close_end = body_start + close_rel + 4;
        let trimmed_close_end = match buf[close_end..].find('\n') {
            Some(i) => close_end + i + 1,
            None => close_end,
        };
        out.push((tag_line.to_string(), body, trimmed_close_end));
        search = trimmed_close_end;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{extract_fenced_blocks, parse_lenient};
    use crate::section::{CommentResult, CommentResultStatus};

    #[test]
    fn extracts_pr_description_blocks() {
        let blocks =
            extract_fenced_blocks("intro\n```acp-pr-description\nA concise PR summary.\n```\nnext");

        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].0, "acp-pr-description");
        assert_eq!(blocks[0].1, "A concise PR summary.");
    }

    #[test]
    fn parses_comment_result_block_body() {
        let result: CommentResult = parse_lenient(
            r#"{
                "draft_id": "draft-123",
                "status": "published",
                "url": "https://github.com/garden-co/jazz/pull/787#discussion_r1"
            }"#,
        )
        .unwrap();

        assert_eq!(result.draft_id, "draft-123");
        assert_eq!(result.status, CommentResultStatus::Published);
        assert_eq!(
            result.url.as_deref(),
            Some("https://github.com/garden-co/jazz/pull/787#discussion_r1")
        );
    }

    #[test]
    fn rejects_comment_result_without_draft_id() {
        let result = parse_lenient::<CommentResult>(
            r#"{
                "status": "published",
                "url": "https://github.com/garden-co/jazz/pull/787#discussion_r1"
            }"#,
        );

        assert!(result.is_err());
    }

    #[test]
    fn rejects_comment_result_with_invalid_status() {
        let result = parse_lenient::<CommentResult>(
            r#"{
                "draft_id": "draft-123",
                "status": "queued"
            }"#,
        );

        assert!(result.is_err());
    }
}
