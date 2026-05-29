use crate::gh;
use crate::section::{LineRange, RangeKind};
use anyhow::{anyhow, Context, Result};
use git2::{DiffOptions, Repository};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::process::Command;
use url::Url;

pub fn repos_dir() -> Result<PathBuf> {
    let base = dirs::data_dir()
        .ok_or_else(|| anyhow!("could not resolve user data dir"))?
        .join("co.garden.guided-review")
        .join("repos");
    std::fs::create_dir_all(&base).with_context(|| format!("creating {}", base.display()))?;
    Ok(base)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClonedRepo {
    pub path: PathBuf,
    pub head_ref: String,
    pub head_sha: String,
    pub base_ref: String,
    pub display_slug: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GithubRepoInfo {
    pub repo_url: String,
    pub owner: String,
    pub repo: String,
    pub slug: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PullRequestMetadata {
    pub title: String,
    pub body: String,
    pub url: String,
    pub base_ref_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PublishedPrComment {
    pub id: u64,
    pub author_login: String,
    pub body: String,
    pub html_url: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub side: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_side: Option<String>,
    #[serde(default)]
    pub is_outdated: bool,
}

#[derive(Debug, Deserialize)]
struct GhPullRequestMetadata {
    title: String,
    body: Option<String>,
    url: String,
    #[serde(rename = "baseRefName", default)]
    base_ref_name: String,
}

#[derive(Debug, Deserialize)]
struct GhUser {
    login: String,
}

#[derive(Debug, Deserialize)]
struct GhPullRequestReviewComment {
    id: u64,
    user: Option<GhUser>,
    body: String,
    html_url: String,
    created_at: String,
    path: Option<String>,
    line: Option<u32>,
    side: Option<String>,
    original_line: Option<u32>,
    original_side: Option<String>,
    #[serde(default)]
    outdated: bool,
}

#[derive(Debug, Deserialize)]
struct GhPullRequestReviewSummary {
    id: u64,
    user: Option<GhUser>,
    body: Option<String>,
    html_url: String,
    submitted_at: Option<String>,
    state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionSource {
    Pr {
        repo_url: String,
        number: u64,
    },
    Branch {
        repo_url: String,
        branch: String,
    },
    Sha {
        repo_url: String,
        sha: String,
    },
    Local {
        path: PathBuf,
    },
    LocalPr {
        path: PathBuf,
        repo_url: String,
        number: u64,
    },
    LocalBranch {
        path: PathBuf,
        branch: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum RefSpec {
    Branch(String),
    PullRequest(u64),
    Sha(String),
}

fn slug_from_url(url: &str) -> Result<String> {
    let parsed = Url::parse(url).or_else(|_| {
        if let Some(rest) = url.strip_prefix("git@github.com:") {
            Url::parse(&format!("ssh://git@github.com/{}", rest))
        } else {
            Err(url::ParseError::RelativeUrlWithoutBase)
        }
    })?;
    let segments: Vec<_> = parsed
        .path_segments()
        .ok_or_else(|| anyhow!("url has no path segments"))?
        .filter(|s| !s.is_empty())
        .collect();
    if segments.len() < 2 {
        return Err(anyhow!("expected /<owner>/<repo> in {url}"));
    }
    let owner = segments[0];
    let repo = segments[1].trim_end_matches(".git");
    Ok(format!("{owner}-{repo}"))
}

pub async fn resolve_source(source: &SessionSource) -> Result<ClonedRepo> {
    match source {
        SessionSource::Pr { repo_url, number } => {
            clone_or_fetch(repo_url, &RefSpec::PullRequest(*number)).await
        }
        SessionSource::Branch { repo_url, branch } => {
            clone_or_fetch(repo_url, &RefSpec::Branch(branch.clone())).await
        }
        SessionSource::Sha { repo_url, sha } => {
            clone_or_fetch(repo_url, &RefSpec::Sha(sha.clone())).await
        }
        SessionSource::Local { path } => prepare_local(path).await,
        SessionSource::LocalPr {
            path,
            repo_url,
            number,
        } => prepare_local_pr(path, repo_url, *number).await,
        SessionSource::LocalBranch { path, branch } => prepare_local_branch(path, branch).await,
    }
}

fn local_display_slug(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

async fn prepare_local(path: &Path) -> Result<ClonedRepo> {
    if !path.is_dir() {
        return Err(anyhow!("not a directory: {}", path.display()));
    }
    let display_slug = local_display_slug(path);

    let head_ref = run_git_output(Some(path), &["rev-parse", "HEAD"])
        .await
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "HEAD".to_string());
    let head_sha = resolve_commit_sha(path, &head_ref).await?;

    let upstream = run_git_output(
        Some(path),
        &["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
    )
    .await
    .map(|s| s.trim().to_string());
    let base_ref = match upstream {
        Ok(up) => run_git_output(Some(path), &["merge-base", "HEAD", &up])
            .await
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|_| up),
        Err(_) => "HEAD~1".to_string(),
    };

    Ok(ClonedRepo {
        path: path.to_path_buf(),
        head_ref,
        head_sha,
        base_ref,
        display_slug,
    })
}

async fn prepare_local_pr(path: &Path, repo_url: &str, number: u64) -> Result<ClonedRepo> {
    if !path.is_dir() {
        return Err(anyhow!("not a directory: {}", path.display()));
    }

    let _ = run_git(Some(path), &["fetch", "--all", "--prune"]).await;
    let head_ref = format!("guided-review-pr-{number}");
    let pr_refspec = format!("+refs/pull/{number}/head:{head_ref}");
    run_git(Some(path), &["fetch", "origin", &pr_refspec]).await?;
    let head_sha = resolve_commit_sha(path, &head_ref).await?;
    let base_ref = resolve_pull_request_base_ref(path, repo_url, number, &head_ref).await?;

    Ok(ClonedRepo {
        path: path.to_path_buf(),
        head_ref,
        head_sha,
        base_ref,
        display_slug: local_display_slug(path),
    })
}

async fn prepare_local_branch(path: &Path, branch: &str) -> Result<ClonedRepo> {
    if !path.is_dir() {
        return Err(anyhow!("not a directory: {}", path.display()));
    }

    let _ = run_git(Some(path), &["fetch", "--all", "--prune"]).await;
    let head_ref = resolve_local_branch_ref(path, branch).await?;
    let head_sha = resolve_commit_sha(path, &head_ref).await?;
    let base_ref = match inspect_origin(path).await {
        Ok(origin) => resolve_branch_base_ref(path, &origin.repo_url, branch, &head_ref).await?,
        Err(_) => resolve_local_base_ref(path, &head_ref).await?,
    };

    Ok(ClonedRepo {
        path: path.to_path_buf(),
        head_ref,
        head_sha,
        base_ref,
        display_slug: local_display_slug(path),
    })
}

async fn resolve_local_branch_ref(path: &Path, branch: &str) -> Result<String> {
    let trimmed = branch.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("branch name is required"));
    }

    if !trimmed.starts_with("origin/") && !trimmed.starts_with("refs/") {
        let remote_ref = format!("origin/{trimmed}");
        if git_commit_exists(path, &remote_ref).await {
            return Ok(remote_ref);
        }
    }

    if git_commit_exists(path, trimmed).await {
        return Ok(trimmed.to_string());
    }

    Err(anyhow!("branch not found: {trimmed}"))
}

async fn git_commit_exists(path: &Path, refspec: &str) -> bool {
    let commit_ref = format!("{refspec}^{{commit}}");
    run_git_output(Some(path), &["rev-parse", "--verify", &commit_ref])
        .await
        .is_ok()
}

async fn resolve_commit_sha(path: &Path, refspec: &str) -> Result<String> {
    let commit_ref = format!("{refspec}^{{commit}}");
    run_git_output(Some(path), &["rev-parse", "--verify", &commit_ref])
        .await
        .map(|s| s.trim().to_string())
        .with_context(|| format!("resolving commit SHA for {refspec}"))
}

async fn resolve_local_base_ref(path: &Path, head_ref: &str) -> Result<String> {
    let default_branch = resolve_default_branch(path)
        .await
        .unwrap_or_else(|_| "origin/main".to_string());
    let merge_base = run_git_output(Some(path), &["merge-base", head_ref, &default_branch])
        .await
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| default_branch.clone());
    Ok(merge_base)
}

async fn resolve_pull_request_base_ref(
    path: &Path,
    repo_url: &str,
    number: u64,
    head_ref: &str,
) -> Result<String> {
    let Ok(metadata) = fetch_pull_request_metadata(repo_url, number).await else {
        return resolve_local_base_ref(path, head_ref).await;
    };
    if let Some(base_ref) =
        resolve_pull_request_target_base_ref(path, head_ref, &metadata.base_ref_name).await?
    {
        return Ok(base_ref);
    }

    resolve_local_base_ref(path, head_ref).await
}

async fn resolve_branch_base_ref(
    path: &Path,
    repo_url: &str,
    branch: &str,
    head_ref: &str,
) -> Result<String> {
    let lookup_branch = branch_pr_lookup_name(branch);
    let Ok(metadata) = fetch_pull_request_metadata_for_branch(repo_url, lookup_branch).await else {
        return resolve_local_base_ref(path, head_ref).await;
    };
    if let Some(base_ref) =
        resolve_pull_request_target_base_ref(path, head_ref, &metadata.base_ref_name).await?
    {
        return Ok(base_ref);
    }

    resolve_local_base_ref(path, head_ref).await
}

async fn resolve_pull_request_target_base_ref(
    path: &Path,
    head_ref: &str,
    base_branch: &str,
) -> Result<Option<String>> {
    let base_branch = base_branch.trim();
    if base_branch.is_empty() {
        return Ok(None);
    }
    let remote_ref = format!("origin/{base_branch}");
    let refspec = format!("+refs/heads/{base_branch}:refs/remotes/{remote_ref}");
    let _ = run_git(Some(path), &["fetch", "origin", &refspec]).await;
    let merge_base = run_git_output(Some(path), &["merge-base", head_ref, &remote_ref])
        .await
        .map(|s| s.trim().to_string())
        .unwrap_or(remote_ref);
    Ok(Some(merge_base))
}

fn branch_pr_lookup_name(branch: &str) -> &str {
    branch
        .trim()
        .strip_prefix("origin/")
        .unwrap_or(branch.trim())
}

pub async fn clone_or_fetch(url: &str, refspec: &RefSpec) -> Result<ClonedRepo> {
    let slug = slug_from_url(url)?;
    let path = repos_dir()?.join(&slug);

    if !path.join(".git").exists() {
        run_git(None, &["clone", url, &path.to_string_lossy()]).await?;
    } else {
        run_git(Some(&path), &["fetch", "--all", "--prune"]).await?;
    }

    let (base_ref, head_ref) = match refspec {
        RefSpec::Branch(name) => {
            run_git(Some(&path), &["fetch", "origin", name]).await?;
            let head = format!("origin/{name}");
            let base = resolve_branch_base_ref(&path, url, name, &head).await?;
            (base, head)
        }
        RefSpec::PullRequest(n) => {
            let head_local = format!("pr-{n}");
            run_git(
                Some(&path),
                &[
                    "fetch",
                    "origin",
                    &format!("+refs/pull/{n}/head:{head_local}"),
                ],
            )
            .await?;
            let base = resolve_pull_request_base_ref(&path, url, *n, &head_local).await?;
            (base, head_local)
        }
        RefSpec::Sha(sha) => {
            run_git(Some(&path), &["fetch", "origin", sha]).await?;
            (format!("{sha}^"), sha.clone())
        }
    };
    let head_sha = resolve_commit_sha(&path, &head_ref).await?;

    Ok(ClonedRepo {
        path,
        head_ref,
        head_sha,
        base_ref,
        display_slug: slug,
    })
}

async fn resolve_default_branch(path: &Path) -> Result<String> {
    let out = run_git_output(
        Some(path),
        &["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
    )
    .await
    .or_else(|_| Ok::<String, anyhow::Error>("origin/main".into()))?;
    Ok(out.trim().to_string())
}

pub fn parse_pr_url(url: &str) -> Option<(String, String, u64)> {
    let parsed = Url::parse(url).ok()?;
    if !matches!(
        parsed.host_str(),
        Some("github.com") | Some("www.github.com")
    ) {
        return None;
    }
    let segs: Vec<&str> = parsed.path_segments()?.filter(|s| !s.is_empty()).collect();
    if segs.len() >= 4 && segs[2] == "pull" {
        let number: u64 = segs[3].parse().ok()?;
        return Some((segs[0].to_string(), segs[1].to_string(), number));
    }
    None
}

pub async fn inspect_origin(path: &Path) -> Result<GithubRepoInfo> {
    if !path.is_dir() {
        return Err(anyhow!("not a directory: {}", path.display()));
    }
    if !path.join(".git").exists() {
        return Err(anyhow!("selected folder is not a Git repository"));
    }

    let remote = run_git_output(Some(path), &["config", "--get", "remote.origin.url"])
        .await
        .context("selected repository has no origin remote")?;

    parse_github_repo_url(remote.trim())
        .ok_or_else(|| anyhow!("selected repository origin is not a GitHub repository"))
}

pub fn parse_github_repo_url(remote: &str) -> Option<GithubRepoInfo> {
    let trimmed = remote.trim();
    let path = if let Some(rest) = trimmed.strip_prefix("git@github.com:") {
        rest.to_string()
    } else {
        let parsed = Url::parse(trimmed).ok()?;
        if !matches!(
            parsed.host_str(),
            Some("github.com") | Some("www.github.com")
        ) {
            return None;
        }
        parsed.path().trim_start_matches('/').to_string()
    };

    let mut segments = path.split('/').filter(|s| !s.is_empty());
    let owner = segments.next()?.to_string();
    let repo = segments.next()?.trim_end_matches(".git").to_string();
    if owner.is_empty() || repo.is_empty() {
        return None;
    }

    let slug = format!("{owner}/{repo}").to_lowercase();
    Some(GithubRepoInfo {
        repo_url: format!("https://github.com/{owner}/{repo}"),
        owner,
        repo,
        slug,
    })
}

pub fn gh_pr_view_args(owner: &str, repo: &str, number: u64) -> Vec<String> {
    gh_pr_view_target_args(owner, repo, number.to_string())
}

pub fn gh_pr_view_branch_args(owner: &str, repo: &str, branch: &str) -> Vec<String> {
    gh_pr_view_target_args(owner, repo, branch.to_string())
}

fn gh_pr_view_target_args(owner: &str, repo: &str, target: String) -> Vec<String> {
    vec![
        "pr".to_string(),
        "view".to_string(),
        target,
        "--repo".to_string(),
        format!("{owner}/{repo}"),
        "--json".to_string(),
        "title,body,url,baseRefName".to_string(),
    ]
}

pub fn gh_review_comments_args(owner: &str, repo: &str, number: u64) -> Vec<String> {
    vec![
        "api".to_string(),
        "--paginate".to_string(),
        "--slurp".to_string(),
        format!("/repos/{owner}/{repo}/pulls/{number}/comments?per_page=100"),
    ]
}

pub fn gh_review_summaries_args(owner: &str, repo: &str, number: u64) -> Vec<String> {
    vec![
        "api".to_string(),
        "--paginate".to_string(),
        "--slurp".to_string(),
        format!("/repos/{owner}/{repo}/pulls/{number}/reviews?per_page=100"),
    ]
}

pub fn parse_pull_request_metadata_json(raw: &str) -> Result<PullRequestMetadata> {
    let gh: GhPullRequestMetadata = serde_json::from_str(raw)?;
    Ok(PullRequestMetadata {
        title: gh.title,
        body: gh.body.unwrap_or_default(),
        url: gh.url,
        base_ref_name: gh.base_ref_name,
    })
}

fn parse_paginated_gh_array<T: DeserializeOwned>(raw: &str) -> Result<Vec<T>> {
    let value: serde_json::Value = serde_json::from_str(raw)?;
    match value.as_array() {
        Some(pages) if pages.first().is_some_and(|page| page.is_array()) => {
            let mut items = Vec::new();
            for page in pages {
                items.extend(serde_json::from_value::<Vec<T>>(page.clone())?);
            }
            Ok(items)
        }
        _ => serde_json::from_value(value).map_err(Into::into),
    }
}

pub fn parse_pull_request_review_comments_json(raw: &str) -> Result<Vec<PublishedPrComment>> {
    let gh: Vec<GhPullRequestReviewComment> = parse_paginated_gh_array(raw)?;
    Ok(gh
        .into_iter()
        .map(|comment| PublishedPrComment {
            id: comment.id,
            author_login: comment.user.map(|user| user.login).unwrap_or_default(),
            body: comment.body,
            html_url: comment.html_url,
            created_at: comment.created_at,
            file_path: comment.path,
            line: comment.line,
            side: comment.side,
            original_line: comment.original_line,
            original_side: comment.original_side,
            is_outdated: comment.outdated,
        })
        .collect())
}

pub fn parse_pull_request_review_summaries_json(raw: &str) -> Result<Vec<PublishedPrComment>> {
    let gh: Vec<GhPullRequestReviewSummary> = parse_paginated_gh_array(raw)?;
    Ok(gh
        .into_iter()
        .filter(|review| !review.state.eq_ignore_ascii_case("PENDING"))
        .filter_map(|review| {
            let body = review.body.unwrap_or_default().trim().to_string();
            if body.is_empty() {
                return None;
            }
            Some(PublishedPrComment {
                id: review.id,
                author_login: review.user.map(|user| user.login).unwrap_or_default(),
                body,
                html_url: review.html_url,
                created_at: review.submitted_at.unwrap_or_default(),
                file_path: None,
                line: None,
                side: None,
                original_line: None,
                original_side: None,
                is_outdated: false,
            })
        })
        .collect())
}

pub async fn fetch_pull_request_metadata(
    repo_url: &str,
    number: u64,
) -> Result<PullRequestMetadata> {
    let repo = parse_github_repo_url(repo_url)
        .ok_or_else(|| anyhow!("PR metadata requires a GitHub repository URL"))?;
    let args = gh_pr_view_args(&repo.owner, &repo.repo, number);
    let raw = gh::output(&args).await?;
    parse_pull_request_metadata_json(&raw)
}

pub async fn fetch_pull_request_metadata_for_branch(
    repo_url: &str,
    branch: &str,
) -> Result<PullRequestMetadata> {
    let repo = parse_github_repo_url(repo_url)
        .ok_or_else(|| anyhow!("PR metadata requires a GitHub repository URL"))?;
    let args = gh_pr_view_branch_args(&repo.owner, &repo.repo, branch);
    let raw = gh::output(&args).await?;
    parse_pull_request_metadata_json(&raw)
}

pub async fn fetch_pull_request_review_comments(
    repo_url: &str,
    number: u64,
) -> Result<Vec<PublishedPrComment>> {
    let repo = parse_github_repo_url(repo_url)
        .ok_or_else(|| anyhow!("PR comments require a GitHub repository URL"))?;
    let comment_args = gh_review_comments_args(&repo.owner, &repo.repo, number);
    let comments_raw = gh::output(&comment_args).await?;
    let mut comments = parse_pull_request_review_comments_json(&comments_raw)?;

    let review_args = gh_review_summaries_args(&repo.owner, &repo.repo, number);
    let summaries_raw = gh::output(&review_args).await?;
    comments.extend(parse_pull_request_review_summaries_json(&summaries_raw)?);
    Ok(comments)
}

async fn run_git(cwd: Option<&Path>, args: &[&str]) -> Result<()> {
    let mut cmd = Command::new("git");
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    cmd.args(args).stdin(Stdio::null());
    let status = cmd
        .status()
        .await
        .with_context(|| format!("running git {args:?}"))?;
    if !status.success() {
        return Err(anyhow!("git {args:?} failed: {status}"));
    }
    Ok(())
}

async fn run_git_output(cwd: Option<&Path>, args: &[&str]) -> Result<String> {
    let mut cmd = Command::new("git");
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let out = cmd.output().await?;
    if !out.status.success() {
        return Err(anyhow!(
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

pub fn get_file_at_ref(repo_path: &Path, file_path: &str, refspec: &str) -> Result<Option<String>> {
    let repo = Repository::open(repo_path)?;
    let object = repo.revparse_single(refspec)?;
    let commit = object.peel_to_commit()?;
    let tree = commit.tree()?;
    match tree.get_path(Path::new(file_path)) {
        Ok(entry) => {
            let blob = entry.to_object(&repo)?.peel_to_blob()?;
            Ok(Some(String::from_utf8_lossy(blob.content()).into_owned()))
        }
        Err(e) if e.code() == git2::ErrorCode::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiffPatch {
    pub file_path: String,
    pub patch: String,
}

pub fn get_diff(
    repo_path: &Path,
    base_ref: &str,
    head_ref: &str,
    file_path: Option<&str>,
) -> Result<Vec<DiffPatch>> {
    let repo = Repository::open(repo_path)?;
    let base_tree = repo.revparse_single(base_ref)?.peel_to_commit()?.tree()?;
    let head_tree = repo.revparse_single(head_ref)?.peel_to_commit()?.tree()?;

    let mut opts = DiffOptions::new();
    if let Some(p) = file_path {
        opts.pathspec(p);
    }
    let diff = repo.diff_tree_to_tree(Some(&base_tree), Some(&head_tree), Some(&mut opts))?;

    use std::cell::RefCell;
    let out: RefCell<Vec<DiffPatch>> = RefCell::new(Vec::new());
    diff.foreach(
        &mut |delta, _| {
            let path = delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path())
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();
            out.borrow_mut().push(DiffPatch {
                file_path: path,
                patch: String::new(),
            });
            true
        },
        None,
        None,
        Some(&mut |_, _, line| {
            let mut patches = out.borrow_mut();
            if let Some(last) = patches.last_mut() {
                let origin = line.origin();
                if matches!(origin, ' ' | '+' | '-') {
                    last.patch.push(origin);
                }
                last.patch
                    .push_str(&String::from_utf8_lossy(line.content()));
            }
            true
        }),
    )?;

    Ok(out.into_inner())
}

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

#[derive(Debug, Clone)]
struct ChangedLineRun {
    origin: char,
    start_line: u32,
    end_line: u32,
}

#[derive(Debug, Default)]
struct ChangedHunkAccumulator {
    file_path: String,
    runs: Vec<ChangedLineRun>,
    has_added: bool,
    has_removed: bool,
}

impl ChangedHunkAccumulator {
    fn set_file(&mut self, file_path: String) {
        self.file_path = file_path;
    }

    fn push_line(&mut self, origin: char, line: u32) {
        match origin {
            '+' => self.has_added = true,
            '-' => self.has_removed = true,
            _ => return,
        }

        if let Some(last) = self.runs.last_mut() {
            if last.origin == origin && last.end_line + 1 == line {
                last.end_line = line;
                return;
            }
        }

        self.runs.push(ChangedLineRun {
            origin,
            start_line: line,
            end_line: line,
        });
    }

    fn flush_into(&mut self, out: &mut Vec<LineRange>) {
        if self.runs.is_empty() {
            return;
        }
        let mixed_hunk = self.has_added && self.has_removed;
        for run in self.runs.drain(..) {
            let kind = match (run.origin, mixed_hunk) {
                ('+', true) => RangeKind::ChangedNew,
                ('-', true) => RangeKind::ChangedOld,
                ('+', false) => RangeKind::Added,
                ('-', false) => RangeKind::Removed,
                _ => continue,
            };
            out.push(LineRange {
                file_path: self.file_path.clone(),
                start_line: run.start_line,
                end_line: run.end_line,
                kind,
            });
        }
        self.has_added = false;
        self.has_removed = false;
    }
}

fn diff_delta_path(delta: git2::DiffDelta<'_>) -> String {
    delta
        .new_file()
        .path()
        .or_else(|| delta.old_file().path())
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

pub fn get_changed_ranges(
    repo_path: &Path,
    base_ref: &str,
    head_ref: &str,
    file_paths: &[String],
) -> Result<Vec<LineRange>> {
    if file_paths.is_empty() {
        return Ok(Vec::new());
    }

    let repo = Repository::open(repo_path)?;
    let base_tree = repo.revparse_single(base_ref)?.peel_to_commit()?.tree()?;
    let head_tree = repo.revparse_single(head_ref)?.peel_to_commit()?.tree()?;

    let mut opts = DiffOptions::new();
    for file_path in file_paths {
        opts.pathspec(file_path);
    }
    let diff = repo.diff_tree_to_tree(Some(&base_tree), Some(&head_tree), Some(&mut opts))?;

    use std::cell::RefCell;
    let out: RefCell<Vec<LineRange>> = RefCell::new(Vec::new());
    let pending = RefCell::new(ChangedHunkAccumulator::default());

    diff.foreach(
        &mut |delta, _| {
            pending.borrow_mut().flush_into(&mut out.borrow_mut());
            pending.borrow_mut().set_file(diff_delta_path(delta));
            true
        },
        None,
        Some(&mut |delta, _| {
            pending.borrow_mut().flush_into(&mut out.borrow_mut());
            pending.borrow_mut().set_file(diff_delta_path(delta));
            true
        }),
        Some(&mut |delta, _, line| {
            if pending.borrow().file_path.is_empty() {
                pending.borrow_mut().set_file(diff_delta_path(delta));
            }
            match line.origin() {
                '+' => {
                    if let Some(line_no) = line.new_lineno() {
                        pending.borrow_mut().push_line('+', line_no);
                    }
                }
                '-' => {
                    if let Some(line_no) = line.old_lineno() {
                        pending.borrow_mut().push_line('-', line_no);
                    }
                }
                _ => {}
            }
            true
        }),
    )?;
    pending.borrow_mut().flush_into(&mut out.borrow_mut());

    Ok(out.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::section::RangeKind;
    use std::fs;
    use std::process::Command as StdCommand;
    use uuid::Uuid;

    fn temp_repo_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("guided-review-app-{name}-{}", Uuid::new_v4()))
    }

    fn run_git_sync(path: &Path, args: &[&str]) {
        let output = StdCommand::new("git")
            .current_dir(path)
            .args(args)
            .output()
            .unwrap_or_else(|e| panic!("running git {args:?}: {e}"));
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn git_output_sync(path: &Path, args: &[&str]) -> String {
        let output = StdCommand::new("git")
            .current_dir(path)
            .args(args)
            .output()
            .unwrap_or_else(|e| panic!("running git {args:?}: {e}"));
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn write_and_commit(path: &Path, file_name: &str, body: &str, message: &str) {
        fs::write(path.join(file_name), body).unwrap();
        run_git_sync(path, &["add", file_name]);
        run_git_sync(path, &["commit", "-m", message]);
    }

    fn init_changed_range_repo(name: &str) -> PathBuf {
        let repo_path = temp_repo_path(name);
        fs::create_dir_all(&repo_path).unwrap();
        run_git_sync(&repo_path, &["init", "-b", "main"]);
        run_git_sync(&repo_path, &["config", "user.name", "Guided Review Test"]);
        run_git_sync(
            &repo_path,
            &["config", "user.email", "guided-review-test@example.com"],
        );
        fs::create_dir_all(repo_path.join("src")).unwrap();
        repo_path
    }

    #[test]
    fn changed_ranges_reports_added_file_lines() {
        let repo_path = init_changed_range_repo("range-added");
        write_and_commit(&repo_path, "README.md", "base\n", "base");
        let base = git_output_sync(&repo_path, &["rev-parse", "HEAD"]);
        write_and_commit(&repo_path, "src/new.ts", "one\ntwo\n", "add file");
        let head = git_output_sync(&repo_path, &["rev-parse", "HEAD"]);

        let ranges =
            get_changed_ranges(&repo_path, &base, &head, &["src/new.ts".to_string()]).unwrap();

        assert_eq!(ranges.len(), 1);
        assert_eq!(ranges[0].file_path, "src/new.ts");
        assert_eq!(ranges[0].start_line, 1);
        assert_eq!(ranges[0].end_line, 2);
        assert_eq!(ranges[0].kind, RangeKind::Added);

        fs::remove_dir_all(repo_path).unwrap();
    }

    #[test]
    fn changed_ranges_reports_removed_file_lines() {
        let repo_path = init_changed_range_repo("range-removed");
        write_and_commit(&repo_path, "src/old.ts", "one\ntwo\n", "base");
        let base = git_output_sync(&repo_path, &["rev-parse", "HEAD"]);
        fs::remove_file(repo_path.join("src/old.ts")).unwrap();
        run_git_sync(&repo_path, &["add", "src/old.ts"]);
        run_git_sync(&repo_path, &["commit", "-m", "remove file"]);
        let head = git_output_sync(&repo_path, &["rev-parse", "HEAD"]);

        let ranges =
            get_changed_ranges(&repo_path, &base, &head, &["src/old.ts".to_string()]).unwrap();

        assert_eq!(ranges.len(), 1);
        assert_eq!(ranges[0].file_path, "src/old.ts");
        assert_eq!(ranges[0].start_line, 1);
        assert_eq!(ranges[0].end_line, 2);
        assert_eq!(ranges[0].kind, RangeKind::Removed);

        fs::remove_dir_all(repo_path).unwrap();
    }

    #[test]
    fn changed_ranges_reports_modified_hunks_on_both_sides() {
        let repo_path = init_changed_range_repo("range-modified");
        write_and_commit(&repo_path, "src/edit.ts", "one\ntwo\nthree\n", "base");
        let base = git_output_sync(&repo_path, &["rev-parse", "HEAD"]);
        write_and_commit(&repo_path, "src/edit.ts", "one\nTWO\nthree\n", "edit line");
        let head = git_output_sync(&repo_path, &["rev-parse", "HEAD"]);

        let ranges =
            get_changed_ranges(&repo_path, &base, &head, &["src/edit.ts".to_string()]).unwrap();

        assert_eq!(ranges.len(), 2);
        assert_eq!(ranges[0].file_path, "src/edit.ts");
        assert_eq!(ranges[0].start_line, 2);
        assert_eq!(ranges[0].end_line, 2);
        assert_eq!(ranges[0].kind, RangeKind::ChangedOld);
        assert_eq!(ranges[1].file_path, "src/edit.ts");
        assert_eq!(ranges[1].start_line, 2);
        assert_eq!(ranges[1].end_line, 2);
        assert_eq!(ranges[1].kind, RangeKind::ChangedNew);

        fs::remove_dir_all(repo_path).unwrap();
    }

    #[test]
    fn changed_ranges_filters_to_requested_files() {
        let repo_path = init_changed_range_repo("range-filter");
        write_and_commit(&repo_path, "src/a.ts", "a\n", "base a");
        write_and_commit(&repo_path, "src/b.ts", "b\n", "base b");
        let base = git_output_sync(&repo_path, &["rev-parse", "HEAD"]);
        write_and_commit(&repo_path, "src/a.ts", "A\n", "edit a");
        write_and_commit(&repo_path, "src/b.ts", "B\n", "edit b");
        let head = git_output_sync(&repo_path, &["rev-parse", "HEAD"]);

        let ranges =
            get_changed_ranges(&repo_path, &base, &head, &["src/a.ts".to_string()]).unwrap();

        assert!(ranges.iter().all(|range| range.file_path == "src/a.ts"));
        assert_eq!(ranges.len(), 2);

        fs::remove_dir_all(repo_path).unwrap();
    }

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
        write_and_commit(
            &repo_path,
            "src/remove.ts",
            "remove\n",
            "new pr restore remove",
        );
        let new_head = git_output_sync(&repo_path, &["rev-parse", "HEAD"]);

        let changed =
            changed_diff_files(&repo_path, &base, &old_head, &base, &new_head).unwrap();

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

    #[test]
    fn parse_github_repo_url_accepts_common_github_formats() {
        let cases = [
            "https://github.com/openai/codex",
            "https://github.com/openai/codex.git",
            "git@github.com:openai/codex.git",
            "ssh://git@github.com/openai/codex.git",
        ];

        for remote in cases {
            let info = parse_github_repo_url(remote).expect(remote);
            assert_eq!(info.repo_url, "https://github.com/openai/codex");
            assert_eq!(info.owner, "openai");
            assert_eq!(info.repo, "codex");
            assert_eq!(info.slug, "openai/codex");
        }
    }

    #[test]
    fn parse_github_repo_url_rejects_non_github_remotes() {
        assert!(parse_github_repo_url("https://gitlab.com/openai/codex").is_none());
        assert!(parse_github_repo_url("not-a-url").is_none());
    }

    #[test]
    fn parse_pull_request_metadata_json_reads_gh_pr_view_output() {
        let metadata = parse_pull_request_metadata_json(
            r###"{
                "title": "Improve guided review",
                "body": "## Summary\nMake review easier.",
                "url": "https://github.com/openai/codex/pull/123",
                "baseRefName": "release/2026-05"
            }"###,
        )
        .unwrap();

        assert_eq!(metadata.title, "Improve guided review");
        assert_eq!(metadata.body, "## Summary\nMake review easier.");
        assert_eq!(metadata.url, "https://github.com/openai/codex/pull/123");
        assert_eq!(metadata.base_ref_name, "release/2026-05");
    }

    #[test]
    fn gh_pr_view_args_target_the_expected_repo_and_fields() {
        assert_eq!(
            gh_pr_view_args("openai", "codex", 123),
            vec![
                "pr",
                "view",
                "123",
                "--repo",
                "openai/codex",
                "--json",
                "title,body,url,baseRefName",
            ]
        );
    }

    #[test]
    fn gh_pr_view_branch_args_target_the_expected_repo_and_fields() {
        assert_eq!(
            gh_pr_view_branch_args("openai", "codex", "feature/review-target"),
            vec![
                "pr",
                "view",
                "feature/review-target",
                "--repo",
                "openai/codex",
                "--json",
                "title,body,url,baseRefName",
            ]
        );
    }

    #[test]
    fn gh_review_comments_args_target_the_pr_review_comments_endpoint() {
        assert_eq!(
            gh_review_comments_args("garden-co", "jazz", 787),
            vec![
                "api",
                "--paginate",
                "--slurp",
                "/repos/garden-co/jazz/pulls/787/comments?per_page=100",
            ]
        );
    }

    #[test]
    fn gh_review_summaries_args_target_the_pr_reviews_endpoint() {
        assert_eq!(
            gh_review_summaries_args("garden-co", "jazz", 787),
            vec![
                "api",
                "--paginate",
                "--slurp",
                "/repos/garden-co/jazz/pulls/787/reviews?per_page=100",
            ]
        );
    }

    #[test]
    fn parse_pull_request_review_comments_json_keeps_diff_location() {
        let comments = parse_pull_request_review_comments_json(
            r###"[
                [
                    {
                        "id": 101,
                        "user": { "login": "mona" },
                        "body": "This has already been reviewed.",
                        "html_url": "https://github.com/garden-co/jazz/pull/787#discussion_r101",
                        "created_at": "2026-05-05T10:00:00Z",
                        "path": "src/main.ts",
                        "line": 12,
                        "side": "RIGHT",
                        "original_line": 9,
                        "original_side": "RIGHT",
                        "outdated": false
                    }
                ]
            ]"###,
        )
        .unwrap();

        assert_eq!(comments.len(), 1);
        assert_eq!(comments[0].id, 101);
        assert_eq!(comments[0].author_login, "mona");
        assert_eq!(comments[0].file_path.as_deref(), Some("src/main.ts"));
        assert_eq!(comments[0].line, Some(12));
        assert_eq!(comments[0].side.as_deref(), Some("RIGHT"));
        assert!(!comments[0].is_outdated);
    }

    #[test]
    fn parse_pull_request_review_summaries_json_keeps_top_level_bodies() {
        let comments = parse_pull_request_review_summaries_json(
            r###"[
                [
                    {
                        "id": 202,
                        "user": { "login": "hubot" },
                        "body": "Top-level review feedback.",
                        "html_url": "https://github.com/garden-co/jazz/pull/787#pullrequestreview-202",
                        "submitted_at": "2026-05-05T11:00:00Z",
                        "state": "COMMENTED"
                    },
                    {
                        "id": 203,
                        "user": { "login": "hubot" },
                        "body": "",
                        "html_url": "https://github.com/garden-co/jazz/pull/787#pullrequestreview-203",
                        "submitted_at": "2026-05-05T11:10:00Z",
                        "state": "COMMENTED"
                    }
                ]
            ]"###,
        )
        .unwrap();

        assert_eq!(comments.len(), 1);
        assert_eq!(comments[0].id, 202);
        assert_eq!(comments[0].author_login, "hubot");
        assert_eq!(comments[0].body, "Top-level review feedback.");
        assert_eq!(comments[0].created_at, "2026-05-05T11:00:00Z");
        assert_eq!(comments[0].file_path, None);
    }

    #[tokio::test]
    async fn prepare_local_branch_serializes_resolved_head_sha() {
        let repo_path = temp_repo_path("head-sha");
        fs::create_dir_all(&repo_path).unwrap();
        run_git_sync(&repo_path, &["init", "-b", "main"]);
        run_git_sync(&repo_path, &["config", "user.name", "Guided Review Test"]);
        run_git_sync(
            &repo_path,
            &["config", "user.email", "guided-review-test@example.com"],
        );

        write_and_commit(&repo_path, "README.md", "base\n", "base");
        run_git_sync(&repo_path, &["branch", "feature"]);
        run_git_sync(&repo_path, &["checkout", "feature"]);
        write_and_commit(&repo_path, "README.md", "feature\n", "feature");
        let feature_sha = git_output_sync(&repo_path, &["rev-parse", "feature"]);

        let prepared = prepare_local_branch(&repo_path, "feature").await.unwrap();
        let json = serde_json::to_value(prepared).unwrap();

        assert_eq!(json["head_sha"], feature_sha);

        fs::remove_dir_all(repo_path).unwrap();
    }

    #[tokio::test]
    async fn prepare_local_branch_prefers_fetched_origin_branch() {
        let remote_path = temp_repo_path("branch-origin-remote");
        let local_path = temp_repo_path("branch-origin-local");
        fs::create_dir_all(&remote_path).unwrap();

        run_git_sync(&remote_path, &["init", "-b", "main"]);
        run_git_sync(&remote_path, &["config", "user.name", "Guided Review Test"]);
        run_git_sync(
            &remote_path,
            &["config", "user.email", "guided-review-test@example.com"],
        );
        write_and_commit(&remote_path, "README.md", "base\n", "base");
        run_git_sync(&remote_path, &["checkout", "-b", "feature/review"]);
        write_and_commit(&remote_path, "README.md", "old review\n", "old review");
        run_git_sync(&remote_path, &["checkout", "main"]);

        run_git_sync(
            Path::new("."),
            &[
                "clone",
                &remote_path.to_string_lossy(),
                &local_path.to_string_lossy(),
            ],
        );
        run_git_sync(
            &local_path,
            &["checkout", "-b", "feature/review", "origin/feature/review"],
        );

        run_git_sync(&remote_path, &["checkout", "feature/review"]);
        write_and_commit(
            &remote_path,
            "README.md",
            "latest review\n",
            "latest review",
        );
        let latest_sha = git_output_sync(&remote_path, &["rev-parse", "feature/review"]);
        run_git_sync(&remote_path, &["checkout", "main"]);

        let prepared = prepare_local_branch(&local_path, "feature/review")
            .await
            .unwrap();

        assert_eq!(prepared.head_ref, "origin/feature/review");
        assert_eq!(prepared.head_sha, latest_sha);

        fs::remove_dir_all(&remote_path).unwrap();
        fs::remove_dir_all(&local_path).unwrap();
    }

    #[tokio::test]
    async fn prepare_local_pr_fetches_from_origin_not_an_explicit_url() {
        let remote_path = temp_repo_path("pr-origin-remote");
        let local_path = temp_repo_path("pr-origin-local");
        fs::create_dir_all(&remote_path).unwrap();

        run_git_sync(&remote_path, &["init", "-b", "main"]);
        run_git_sync(&remote_path, &["config", "user.name", "Guided Review Test"]);
        run_git_sync(
            &remote_path,
            &["config", "user.email", "guided-review-test@example.com"],
        );
        write_and_commit(&remote_path, "README.md", "base\n", "base");
        run_git_sync(&remote_path, &["checkout", "-b", "feature"]);
        write_and_commit(&remote_path, "README.md", "pr\n", "pr");
        let pr_sha = git_output_sync(&remote_path, &["rev-parse", "feature"]);
        run_git_sync(&remote_path, &["update-ref", "refs/pull/391/head", &pr_sha]);
        run_git_sync(&remote_path, &["checkout", "main"]);

        run_git_sync(
            Path::new("."),
            &[
                "clone",
                &remote_path.to_string_lossy(),
                &local_path.to_string_lossy(),
            ],
        );
        run_git_sync(&local_path, &["config", "user.name", "Guided Review Test"]);
        run_git_sync(
            &local_path,
            &["config", "user.email", "guided-review-test@example.com"],
        );

        let prepared = prepare_local_pr(
            &local_path,
            "https://github.com/guided-review/test-repo",
            391,
        )
        .await
        .unwrap();

        assert_eq!(prepared.head_ref, "guided-review-pr-391");
        assert_eq!(prepared.head_sha, pr_sha);

        fs::remove_dir_all(&remote_path).unwrap();
        fs::remove_dir_all(&local_path).unwrap();
    }

    #[tokio::test]
    async fn resolve_pull_request_target_base_ref_uses_pr_target_branch() {
        let remote_path = temp_repo_path("pr-target-base-remote");
        let local_path = temp_repo_path("pr-target-base-local");
        fs::create_dir_all(&remote_path).unwrap();

        run_git_sync(&remote_path, &["init", "-b", "main"]);
        run_git_sync(&remote_path, &["config", "user.name", "Guided Review Test"]);
        run_git_sync(
            &remote_path,
            &["config", "user.email", "guided-review-test@example.com"],
        );
        write_and_commit(&remote_path, "README.md", "main\n", "main base");
        let main_sha = git_output_sync(&remote_path, &["rev-parse", "main"]);

        run_git_sync(&remote_path, &["checkout", "-b", "release/2026-05"]);
        write_and_commit(&remote_path, "README.md", "release\n", "release base");
        let release_sha = git_output_sync(&remote_path, &["rev-parse", "release/2026-05"]);

        run_git_sync(&remote_path, &["checkout", "-b", "feature"]);
        write_and_commit(&remote_path, "README.md", "feature\n", "feature change");
        run_git_sync(&remote_path, &["checkout", "main"]);

        run_git_sync(
            Path::new("."),
            &[
                "clone",
                &remote_path.to_string_lossy(),
                &local_path.to_string_lossy(),
            ],
        );
        run_git_sync(
            &local_path,
            &[
                "fetch",
                "origin",
                "+refs/heads/feature:guided-review-pr-391",
            ],
        );

        let base_ref = resolve_pull_request_target_base_ref(
            &local_path,
            "guided-review-pr-391",
            "release/2026-05",
        )
        .await
        .unwrap()
        .unwrap();

        assert_eq!(base_ref, release_sha);
        assert_ne!(base_ref, main_sha);

        fs::remove_dir_all(&remote_path).unwrap();
        fs::remove_dir_all(&local_path).unwrap();
    }
}
