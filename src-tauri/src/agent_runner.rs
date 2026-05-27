use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const PATH_BEGIN_MARKER: &str = "__GUIDED_REVIEW_PATH_BEGIN__";
const PATH_END_MARKER: &str = "__GUIDED_REVIEW_PATH_END__";
const COMMON_AGENT_PATH_DIRS: &[&str] = &[
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
];

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentKind {
    ClaudeCode,
    Codex,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningEffort {
    Low,
    Medium,
    High,
    Xhigh,
}

impl ReasoningEffort {
    pub fn as_config_value(self) -> &'static str {
        match self {
            ReasoningEffort::Low => "low",
            ReasoningEffort::Medium => "medium",
            ReasoningEffort::High => "high",
            ReasoningEffort::Xhigh => "xhigh",
        }
    }
}

impl AgentKind {
    pub fn label(self) -> &'static str {
        match self {
            AgentKind::ClaudeCode => "Claude Code",
            AgentKind::Codex => "Codex",
        }
    }

    pub fn launch_command(self) -> &'static str {
        match self {
            AgentKind::ClaudeCode => "npx -y @zed-industries/claude-code-acp",
            AgentKind::Codex => "npx -y @zed-industries/codex-acp",
        }
    }

    pub fn supports_reasoning_effort(self) -> bool {
        matches!(self, AgentKind::Codex)
    }

    pub fn reasoning_effort_options(self) -> Vec<ReasoningEffort> {
        if self.supports_reasoning_effort() {
            vec![
                ReasoningEffort::Low,
                ReasoningEffort::Medium,
                ReasoningEffort::High,
                ReasoningEffort::Xhigh,
            ]
        } else {
            Vec::new()
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentLaunchConfig {
    pub kind: AgentKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<ReasoningEffort>,
}

impl AgentLaunchConfig {
    pub fn launch_command(self) -> String {
        let command = self.kind.launch_command();
        match (self.kind, self.reasoning_effort) {
            (AgentKind::Codex, Some(effort)) => {
                format!(
                    r#"{command} -c model_reasoning_effort="{}""#,
                    effort.as_config_value()
                )
            }
            _ => command.to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedAgentCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub path_env: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentInfo {
    pub kind: AgentKind,
    pub label: &'static str,
    pub launch_command: &'static str,
    pub supports_reasoning_effort: bool,
    pub reasoning_effort_options: Vec<ReasoningEffort>,
}

pub fn list_agents() -> Vec<AgentInfo> {
    [AgentKind::ClaudeCode, AgentKind::Codex]
        .into_iter()
        .map(|kind| AgentInfo {
            kind,
            label: kind.label(),
            launch_command: kind.launch_command(),
            supports_reasoning_effort: kind.supports_reasoning_effort(),
            reasoning_effort_options: kind.reasoning_effort_options(),
        })
        .collect()
}

pub fn prepare_agent_command(agent_command: &str) -> Result<PreparedAgentCommand> {
    let path_env = agent_process_path();
    prepare_agent_command_with_path(agent_command, &path_env)
}

fn prepare_agent_command_with_path(
    agent_command: &str,
    path_env: impl AsRef<std::ffi::OsStr>,
) -> Result<PreparedAgentCommand> {
    let parts = shell_words::split(agent_command)
        .with_context(|| format!("parsing agent command: {agent_command}"))?;
    if parts.is_empty() {
        return Err(anyhow!("empty agent command"));
    }

    let program_name = &parts[0];
    let path_env = path_env.as_ref().to_string_lossy().into_owned();
    let program = resolve_program_in_path(program_name, &path_env).ok_or_else(|| {
        anyhow!(
            "could not find agent command {:?} in PATH; install Node.js/npm or make npx available to the app",
            program_name
        )
    })?;

    Ok(PreparedAgentCommand {
        program,
        args: parts[1..].to_vec(),
        path_env,
    })
}

fn agent_process_path() -> String {
    static LOGIN_SHELL_PATH: OnceLock<Option<String>> = OnceLock::new();

    let current_path = std::env::var("PATH").unwrap_or_default();
    let shell_path = LOGIN_SHELL_PATH
        .get_or_init(login_shell_path)
        .as_deref()
        .unwrap_or("");
    let common_path = std::env::join_paths(COMMON_AGENT_PATH_DIRS)
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();

    merge_path_values([current_path.as_str(), shell_path, common_path.as_str()])
}

fn login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "/bin/zsh".to_string());
    let shell_command = format!("printf '{PATH_BEGIN_MARKER}%s{PATH_END_MARKER}' \"$PATH\"");
    let output = std::process::Command::new(shell)
        .arg("-lc")
        .arg(shell_command)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    extract_marked_path(&stdout)
}

fn extract_marked_path(output: &str) -> Option<String> {
    let start = output.find(PATH_BEGIN_MARKER)? + PATH_BEGIN_MARKER.len();
    let rest = &output[start..];
    let end = rest.find(PATH_END_MARKER)?;
    let path = rest[..end].trim();
    if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    }
}

fn merge_path_values<I, S>(paths: I) -> String
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let mut seen = HashSet::new();
    let mut merged = Vec::new();

    for path in paths {
        for dir in std::env::split_paths(&path) {
            if dir.as_os_str().is_empty() {
                continue;
            }
            let key = dir.to_string_lossy().into_owned();
            if seen.insert(key) {
                merged.push(dir);
            }
        }
    }

    std::env::join_paths(merged)
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}

fn resolve_program_in_path(program: &str, path_env: &str) -> Option<PathBuf> {
    let program_path = Path::new(program);
    if program_path.components().count() > 1 {
        return Some(program_path.to_path_buf());
    }

    std::env::split_paths(path_env)
        .map(|dir| dir.join(program))
        .find(|candidate| is_executable_file(candidate))
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }

    #[cfg(not(unix))]
    {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_agents_excludes_fake_agent() {
        let agents = list_agents();
        let kinds: Vec<AgentKind> = agents.into_iter().map(|agent| agent.kind).collect();

        assert_eq!(kinds, vec![AgentKind::ClaudeCode, AgentKind::Codex]);
    }

    #[test]
    fn list_agents_reports_reasoning_effort_support() {
        let agents = list_agents();
        let claude = agents
            .iter()
            .find(|agent| agent.kind == AgentKind::ClaudeCode)
            .unwrap();
        let codex = agents
            .iter()
            .find(|agent| agent.kind == AgentKind::Codex)
            .unwrap();

        assert!(!claude.supports_reasoning_effort);
        assert!(claude.reasoning_effort_options.is_empty());
        assert!(codex.supports_reasoning_effort);
        assert_eq!(
            codex.reasoning_effort_options,
            vec![
                ReasoningEffort::Low,
                ReasoningEffort::Medium,
                ReasoningEffort::High,
                ReasoningEffort::Xhigh
            ]
        );
    }

    #[test]
    fn codex_launch_command_includes_reasoning_effort_override() {
        let config = AgentLaunchConfig {
            kind: AgentKind::Codex,
            reasoning_effort: Some(ReasoningEffort::High),
        };

        assert_eq!(
            config.launch_command(),
            r#"npx -y @zed-industries/codex-acp -c model_reasoning_effort="high""#
        );
    }

    #[test]
    fn launch_command_omits_default_reasoning_effort() {
        let config = AgentLaunchConfig {
            kind: AgentKind::Codex,
            reasoning_effort: None,
        };

        assert_eq!(config.launch_command(), "npx -y @zed-industries/codex-acp");
    }

    #[test]
    fn prepares_agent_command_from_supplied_path() {
        let temp_dir =
            std::env::temp_dir().join(format!("guided-review-agent-path-{}", std::process::id()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let npx_path = temp_dir.join("npx");
        std::fs::write(&npx_path, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&npx_path).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&npx_path, perms).unwrap();
        }

        let path_env = std::env::join_paths([temp_dir.as_path()]).unwrap();
        let command =
            prepare_agent_command_with_path("npx -y @zed-industries/codex-acp", &path_env).unwrap();

        assert_eq!(command.program, npx_path);
        assert_eq!(
            command.args,
            vec!["-y".to_string(), "@zed-industries/codex-acp".to_string()]
        );

        let _ = std::fs::remove_file(npx_path);
        let _ = std::fs::remove_dir(temp_dir);
    }

    #[test]
    fn extracts_shell_path_even_when_startup_files_print_text() {
        assert_eq!(
            extract_marked_path(
                "welcome\n__GUIDED_REVIEW_PATH_BEGIN__/opt/homebrew/bin:/usr/bin__GUIDED_REVIEW_PATH_END__\n"
            ),
            Some("/opt/homebrew/bin:/usr/bin".to_string())
        );
    }

    #[test]
    fn merge_path_values_keeps_first_copy_of_each_dir() {
        let merged = merge_path_values(["/usr/bin:/bin", "/opt/homebrew/bin:/usr/bin"]);
        let parts: Vec<_> = std::env::split_paths(&merged).collect();

        assert_eq!(parts[0], std::path::PathBuf::from("/usr/bin"));
        assert_eq!(parts[1], std::path::PathBuf::from("/bin"));
        assert_eq!(parts[2], std::path::PathBuf::from("/opt/homebrew/bin"));
    }
}
