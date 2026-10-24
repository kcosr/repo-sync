import { rmSync } from "node:fs";
import { ensureCacheDir, getRepoTempPath, getWorkDir, isArchiveRepo } from "./config.js";
import {
  type PushRefsOptions,
  addRemote,
  cloneMirror,
  cloneWorkDir,
  compareRefs,
  fetchOrigin,
  fetchRemote,
  getDefaultBranch,
  getLocalRefs,
  getRemoteBranchHead,
  getRemoteRefs,
  getRepoCloneTime,
  isImportedCache,
  pushRefs,
  repoExists,
} from "./git.js";
import { inspectSourceNotice, prepareSourceNotice, sourceNoticeMatches } from "./source-notice.js";
import type { RefComparison, RemoteRepoConfig, RepoConfig, RepoStatus } from "./types.js";

export interface PullResult {
  success: boolean;
  repoPath: string;
  isNew: boolean;
  error?: string;
}

export interface StatusResult {
  status: RepoStatus;
  canPush: boolean;
  hasChanges: boolean;
  errors: string[];
}

export interface PushResult {
  success: boolean;
  pushed: boolean;
  error?: string;
}

export interface CloneResult {
  success: boolean;
  clonePath: string;
  error?: string;
}

export interface SyncOptions {
  cacheDir?: string;
}

function notReadyError(repo: RepoConfig): string {
  return isArchiveRepo(repo)
    ? "Not imported yet. Run 'repo-sync import' first."
    : "Not pulled yet. Run 'repo-sync pull' first.";
}

export function pull(repo: RemoteRepoConfig, options?: SyncOptions): PullResult {
  ensureCacheDir(options?.cacheDir);
  const repoPath = getRepoTempPath(repo.name, options?.cacheDir);
  const exists = repoExists(repoPath);

  if (exists && isImportedCache(repoPath)) {
    return {
      success: false,
      repoPath,
      isNew: false,
      error: `Cache was created by 'repo-sync import'; run 'repo-sync clean ${repo.name}' before pulling from a public remote`,
    };
  }

  if (exists) {
    // Fetch latest from origin (public)
    console.log(`  Fetching updates from ${repo.public}...`);
    const fetchResult = fetchOrigin(repoPath);
    if (!fetchResult.success) {
      return {
        success: false,
        repoPath,
        isNew: false,
        error: `Failed to fetch: ${fetchResult.error}`,
      };
    }
  } else {
    // Clone fresh
    console.log(`  Cloning from ${repo.public}...`);
    const cloneResult = cloneMirror(repo.public, repoPath);
    if (!cloneResult.success) {
      return {
        success: false,
        repoPath,
        isNew: true,
        error: `Failed to clone: ${cloneResult.error}`,
      };
    }
  }

  // Ensure private remote is configured
  const remoteResult = addRemote(repoPath, "private", repo.private);
  if (!remoteResult.success) {
    return {
      success: false,
      repoPath,
      isNew: !exists,
      error: `Failed to add private remote: ${remoteResult.error}`,
    };
  }

  return {
    success: true,
    repoPath,
    isNew: !exists,
  };
}

interface PushPlan {
  branch: string;
  sourceCommit?: string;
  privateCommit?: string;
}

export function status(repo: RepoConfig, options?: SyncOptions): StatusResult {
  const { plan: _plan, ...result } = inspectStatus(repo, options);
  return result;
}

function inspectStatus(
  repo: RepoConfig,
  options?: SyncOptions,
): StatusResult & { plan?: PushPlan } {
  const repoPath = getRepoTempPath(repo.name, options?.cacheDir);
  const archive = isArchiveRepo(repo);
  const errors: string[] = [];

  const baseStatus: RepoStatus = {
    name: repo.name,
    source: archive ? "archive" : "remote",
    publicUrl: archive ? undefined : repo.public,
    privateUrl: repo.private,
    pulled: false,
    branches: [],
    tags: [],
  };

  if (!repoExists(repoPath)) {
    return {
      status: {
        ...baseStatus,
        error: notReadyError(repo),
      },
      canPush: false,
      hasChanges: false,
      errors: [archive ? "Not imported yet" : "Not pulled yet"],
    };
  }

  baseStatus.pulled = true;
  if (archive) {
    // Imports never rewrite cache configuration, so pick up private URL changes here.
    const remoteResult = addRemote(repoPath, "private", repo.private);
    if (!remoteResult.success) {
      const error = `Failed to configure private remote: ${remoteResult.error}`;
      return {
        status: { ...baseStatus, error },
        canPush: false,
        hasChanges: false,
        errors: [error],
      };
    }
  } else {
    baseStatus.pulledAt = getRepoCloneTime(repoPath);
  }

  // Fetch from private to compare
  console.log("  Fetching refs from private remote...");
  // Archive entries prune so refs deleted on (or left behind by a previous) private URL vanish.
  const fetchResult = fetchRemote(repoPath, "private", archive);
  if (!fetchResult.success && archive) {
    // Stale tracking refs could make an unreachable destination look up to date.
    const error = `Could not fetch from private: ${fetchResult.error}`;
    return {
      status: { ...baseStatus, error },
      canPush: false,
      hasChanges: false,
      errors: [error],
    };
  }
  if (!fetchResult.success) {
    // This might be expected if private repo is empty or doesn't exist yet
    console.log("  Note: Could not fetch from private (may be empty or new)");
  }

  // An incomplete listing must never become a push or deletion plan.
  let localRefs: Map<string, string>;
  let privateRefs: Map<string, string>;
  try {
    localRefs = getLocalRefs(repoPath);
    privateRefs = getRemoteRefs(repoPath, "private");
  } catch (error) {
    const message = `Could not inspect refs: ${error instanceof Error ? error.message : error}`;
    return {
      status: { ...baseStatus, error: message },
      canPush: false,
      hasChanges: false,
      errors: [message],
    };
  }

  // Source branches stay pristine. Only verified generated destination tips are
  // compared using their original source parent, independent of the selected mode.
  const branch = getDefaultBranch(repoPath);
  const branchKey = `heads/${branch}`;
  const localCommit = localRefs.get(branchKey);
  const privateCommit = privateRefs.get(branchKey);
  const comparisonRefs = new Map(privateRefs);
  let sourceCommit = localCommit;
  let replaceNotice = false;
  try {
    if (localCommit && !archive) {
      // Older markSource versions wrote their notice back into the source cache.
      const cachedNotice = inspectSourceNotice(repoPath, localCommit);
      if (cachedNotice) {
        const upstream = getRemoteBranchHead(repoPath, "origin", branch);
        if (
          !upstream.success ||
          ![localCommit, cachedNotice.sourceCommit].includes(upstream.output)
        ) {
          throw new Error(
            "Run 'repo-sync pull' to refresh the source cache before changing its notice",
          );
        }
        // An upstream commit must be preserved even if it resembles our notice.
        sourceCommit = upstream.output;
        localRefs.set(branchKey, sourceCommit);
      }
    }
    if (privateCommit && privateCommit !== sourceCommit) {
      const notice = inspectSourceNotice(repoPath, privateCommit);
      if (notice) {
        comparisonRefs.set(branchKey, notice.sourceCommit);
        replaceNotice = true;
      }
    }
    const mode = repo.sourceNotice ?? "none";
    if (archive && mode === "linked") {
      throw new Error(
        "Archive repositories do not support linked notices; use sourceNotice: generic",
      );
    }
    if (sourceCommit && (mode !== "none" || replaceNotice)) {
      baseStatus.sourceNoticeChanged =
        !privateCommit ||
        !sourceNoticeMatches(
          repoPath,
          privateCommit,
          sourceCommit,
          mode,
          archive ? undefined : repo.public,
        );
    }
  } catch (error) {
    const message = `Could not inspect source notice: ${error instanceof Error ? error.message : error}`;
    return {
      status: { ...baseStatus, error: message },
      canPush: false,
      hasChanges: false,
      errors: [message],
    };
  }

  // Compare
  const { branches, tags } = compareRefs(repoPath, localRefs, comparisonRefs);
  baseStatus.branches = branches;
  baseStatus.tags = tags;

  // Git tags are immutable on archive destinations, even if their commits are related.
  const changedTags = archive
    ? tags.filter((tag) => tag.localRef && tag.privateRef && tag.localRef !== tag.privateRef)
    : [];
  if (changedTags.length > 0) {
    for (const tag of changedTags) tag.status = "diverged";
    errors.push(
      `Existing tags cannot change on private: ${changedTags.map((tag) => tag.name).join(", ")}`,
    );
  }

  // Determine if we can push
  const hasBehind = [...branches, ...tags].some((r) => r.status === "behind");
  const hasDiverged = [...branches, ...tags].some((r) => r.status === "diverged");
  // Archive imports never delete: refs only on private are kept, so they are not changes.
  const hasChanges =
    !!baseStatus.sourceNoticeChanged ||
    [...branches, ...tags].some(
      (r) => r.status === "ahead" || r.status === "new" || (!archive && r.status === "missing"),
    );

  if (hasBehind) {
    errors.push(
      archive
        ? "Private has commits not in the imported history"
        : "Private has commits not in public - this shouldn't happen",
    );
  }
  if (hasDiverged) {
    errors.push("Refs have diverged - manual intervention may be needed");
  }

  return {
    status: baseStatus,
    canPush: !hasBehind && !hasDiverged,
    hasChanges,
    errors,
    plan: { branch, sourceCommit, privateCommit },
  };
}

export function push(repo: RepoConfig, options?: SyncOptions): PushResult {
  const repoPath = getRepoTempPath(repo.name, options?.cacheDir);

  if (!repoExists(repoPath)) {
    return {
      success: false,
      pushed: false,
      error: notReadyError(repo),
    };
  }

  const statusResult = inspectStatus(repo, options);
  if (!statusResult.canPush) {
    return {
      success: false,
      pushed: false,
      error: statusResult.errors.join("; "),
    };
  }

  if (!statusResult.hasChanges) {
    return {
      success: true,
      pushed: false,
    };
  }

  const plan = statusResult.plan;
  if (!plan) return { success: false, pushed: false, error: "Could not prepare push" };
  const archive = isArchiveRepo(repo);
  let branchOverride: PushRefsOptions["branchOverride"];
  if (plan.sourceCommit) {
    try {
      const mode = repo.sourceNotice ?? "none";
      const publicUrl = archive ? undefined : repo.public;
      const desiredCommit =
        plan.privateCommit &&
        sourceNoticeMatches(repoPath, plan.privateCommit, plan.sourceCommit, mode, publicUrl)
          ? plan.privateCommit
          : prepareSourceNotice(repoPath, plan.sourceCommit, mode, publicUrl);
      branchOverride = {
        branch: plan.branch,
        commit: desiredCommit,
        expected: plan.privateCommit ?? "",
      };
    } catch (error) {
      return {
        success: false,
        pushed: false,
        error: `Failed to prepare source notice: ${error instanceof Error ? error.message : error}`,
      };
    }
  }

  console.log(`  Pushing to ${repo.private}...`);
  const pushResult = pushRefs(repoPath, "private", {
    mirror: !archive,
    // The exact lease also protects a first notice or branch creation from races.
    // Replacing a generated tip is allowed only after its source parent passes
    // the ancestry comparison above; other source-history rewrites are refused.
    branchOverride,
  });
  if (!pushResult.success) {
    return {
      success: false,
      pushed: false,
      error: `Failed to push: ${pushResult.error}`,
    };
  }

  return {
    success: true,
    pushed: true,
  };
}

export function clean(repo: RepoConfig, options?: SyncOptions): void {
  const repoPath = getRepoTempPath(repo.name, options?.cacheDir);
  if (repoExists(repoPath)) {
    rmSync(repoPath, { recursive: true, force: true });
  }
}

export function clone(repo: RepoConfig, options?: SyncOptions): CloneResult {
  const repoPath = getRepoTempPath(repo.name, options?.cacheDir);
  const cloneBaseDir = getWorkDir(options?.cacheDir);
  const clonePath = `${cloneBaseDir}/${repo.name.replace(/[^a-zA-Z0-9._-]/g, "-")}`;

  if (!repoExists(repoPath)) {
    return {
      success: false,
      clonePath,
      error: notReadyError(repo),
    };
  }

  const branch = getDefaultBranch(repoPath);
  const cloneResult = cloneWorkDir(repoPath, branch, cloneBaseDir, repo.name, {
    fastForwardOnly: isArchiveRepo(repo),
  });
  if (!cloneResult.success) {
    return {
      success: false,
      clonePath: cloneResult.clonePath,
      error: cloneResult.error,
    };
  }

  return {
    success: true,
    clonePath: cloneResult.clonePath,
  };
}

export function formatRefComparison(ref: RefComparison): string {
  const shortLocal = ref.localRef?.substring(0, 7) || "-------";
  const shortPrivate = ref.privateRef?.substring(0, 7) || "-------";

  switch (ref.status) {
    case "same":
      return `  ${ref.name}: ${shortLocal} (up to date)`;
    case "ahead":
      return `  ${ref.name}: ${shortPrivate} → ${shortLocal} (+${ref.aheadCount} commits)`;
    case "behind":
      return `  ${ref.name}: ${shortLocal} ← ${shortPrivate} (private is ${ref.behindCount} ahead!) ⚠️`;
    case "new":
      return `  ${ref.name}: ${shortLocal} (new)`;
    case "missing":
      return `  ${ref.name}: deleted from public (was ${shortPrivate})`;
    case "diverged":
      return `  ${ref.name}: ${shortLocal} ≠ ${shortPrivate} (diverged!) ⚠️`;
    default:
      return `  ${ref.name}: unknown status`;
  }
}

export function formatStatus(result: StatusResult): string {
  const lines: string[] = [];
  const { status: s } = result;
  const archive = s.source === "archive";

  lines.push(`\n${s.name}`);
  if (archive) {
    lines.push("  Source:  archive import");
  } else {
    lines.push(`  Public:  ${s.publicUrl}`);
  }
  lines.push(`  Private: ${s.privateUrl}`);

  if (!s.pulled) {
    lines.push(archive ? "  Status:  Not imported yet" : "  Status:  Not pulled yet");
    return lines.join("\n");
  }

  if (s.pulledAt) {
    lines.push(`  Pulled:  ${s.pulledAt.toLocaleString()}`);
  }

  const isChange = (r: RefComparison) =>
    r.status !== "same" && !(archive && r.status === "missing");
  const changedBranches = s.branches.filter(isChange);
  const changedTags = s.tags.filter(isChange);

  if (s.sourceNoticeChanged) {
    lines.push("  Source notice: update pending");
  }

  if (s.error) {
    lines.push("  Status:  Unknown (see errors)");
  } else if (changedBranches.length === 0 && changedTags.length === 0 && !s.sourceNoticeChanged) {
    lines.push("  Status:  Up to date ✓");
  } else {
    if (changedBranches.length > 0) {
      lines.push("  Branches:");
      for (const b of changedBranches) {
        lines.push(formatRefComparison(b));
      }
    }
    if (changedTags.length > 0) {
      lines.push("  Tags:");
      for (const t of changedTags) {
        lines.push(formatRefComparison(t));
      }
    }
  }

  if (archive) {
    const kept = [
      ...s.branches.filter((b) => b.status === "missing").map((b) => `branch ${b.name}`),
      ...s.tags.filter((t) => t.status === "missing").map((t) => `tag ${t.name}`),
    ];
    if (kept.length > 0) {
      lines.push("  Kept on private (not managed by imports):");
      for (const ref of kept) {
        lines.push(`    ${ref}`);
      }
    }
  }

  if (result.errors.length > 0) {
    lines.push("  Errors:");
    for (const e of result.errors) {
      lines.push(`    ⚠️  ${e}`);
    }
  }

  return lines.join("\n");
}
