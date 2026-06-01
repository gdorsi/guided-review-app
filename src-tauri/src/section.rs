use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

fn schema_version_1() -> u32 {
    1
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    High,
    Medium,
    Low,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum RangeKind {
    Context,
    ChangedOld,
    ChangedNew,
    Added,
    Removed,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct LineRange {
    pub file_path: String,
    pub start_line: u32,
    pub end_line: u32,
    pub kind: RangeKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Concern {
    pub text: String,
    pub severity: Severity,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ReviewSection {
    pub schema_version: u32,
    pub section_id: String,
    pub title: String,
    pub intent: String,
    pub files: Vec<String>,
    #[serde(default)]
    pub ranges: Vec<LineRange>,
    pub concerns: Vec<Concern>,
    #[serde(default)]
    pub grill_questions: Vec<GrillQuestion>,
    pub base_ref: String,
    pub head_ref: String,
    pub pause_prompt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SectionMapEntry {
    pub section_id: String,
    pub title: String,
    pub intent: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SectionMap {
    pub schema_version: u32,
    pub sections: Vec<SectionMapEntry>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SectionProgressPhase {
    Started,
    Ranges,
    Feedback,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SectionProgressUpdate {
    pub section_id: String,
    pub phase: SectionProgressPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ranges: Option<Vec<LineRange>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub concerns: Option<Vec<Concern>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grill_questions: Option<Vec<GrillQuestion>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_ref: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommentKind {
    Inline,
    TopLevel,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum CommentSide {
    Left,
    Right,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommentDraft {
    pub kind: CommentKind,
    pub body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub side: Option<CommentSide>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommentResultStatus {
    Published,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommentResult {
    pub draft_id: String,
    pub status: CommentResultStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GrillQuestion {
    #[serde(default = "schema_version_1")]
    pub schema_version: u32,
    pub question_id: String,
    pub title: String,
    pub question: String,
    pub pr_choice: String,
    pub recommended_answer: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub ranges: Vec<LineRange>,
    #[serde(default)]
    pub base_ref: String,
    #[serde(default)]
    pub head_ref: String,
}
