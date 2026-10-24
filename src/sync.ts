import { rmSync } from "node:fs";
import { ensureCacheDir, getRepoTempPath, getWorkDir, isArchiveRepo } from "./config.js";
import {
  addRemote,
  addSourceNotice,
  cloneMirror,
  cloneWorkDir,
  compareRefs,
  fetchOrigin,
  fetchRemote,
  getDefaultBranch,
  getLocalRefs,
  getParentCommit,
  getRemoteRefs,
  getRepoCloneTime,
  isImportedCache,
  isSourceNoticeCommit,
  pushMirror,
  pushRefs,
  repoExists,
} from "./git.js";
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

export function status(repo: RepoConfig, options?: SyncOptions): StatusResult {
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

  // Get refs
  const localRefs = getLocalRefs(repoPath);
  const privateRefs = getRemoteRefs(repoPath, "private");

  // If markSource is enabled, check if private's default branch HEAD is our notice commit
  // If so, use its parent for comparison instead
  if (!archive && repo.markSource) {
    const defaultBranch = getDefaultBranch(repoPath);
    const branchKey = `heads/${defaultBranch}`;
    const privateBranchSha = privateRefs.get(branchKey);

    if (privateBranchSha) {
      // Check if this is our notice commit by checking the commit message
      const privateRef = `refs/remotes/private/${defaultBranch}`;
      if (isSourceNoticeCommit(repoPath, privateRef)) {
        // Get the parent (the actual source commit)
        const parentSha = getParentCommit(repoPath, privateRef);
        if (parentSha) {
          console.log("  Note: Comparing against parent of notice commit");
          privateRefs.set(branchKey, parentSha);
        }
      }
    }
  }

  // Compare
  const { branches, tags } = compareRefs(repoPath, localRefs, privateRefs);
  baseStatus.branches = branches;
  baseStatus.tags = tags;

  // Determine if we can push
  const hasBehind = [...branches, ...tags].some((r) => r.status === "behind");
  const hasDiverged = [...branches, ...tags].some((r) => r.status === "diverged");
  // Archive imports never delete: refs only on private are kept, so they are not changes.
  const hasChanges = [...branches, ...tags].some(
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

  // Check status first (compares against parent of notice commit if markSource is enabled)
  const statusResult = status(repo, options);
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

  // Add source notice if configured
  if (!isArchiveRepo(repo) && repo.markSource) {
    console.log("  Adding source notice to README...");
    const branch = getDefaultBranch(repoPath);
    const noticeResult = addSourceNotice(repoPath, repo.public, branch, {
      cloneBaseDir: getWorkDir(options?.cacheDir),
      deleteClone: repo.markSourceDeleteClone,
      cloneName: repo.name,
    });
    if (!noticeResult.success) {
      return {
        success: false,
        pushed: false,
        error: `Failed to add source notice: ${noticeResult.error}`,
      };
    }
  }

  // Push
  console.log(`  Pushing to ${repo.private}...`);
  const pushResult = isArchiveRepo(repo)
    ? pushRefs(repoPath, "private")
    : pushMirror(repoPath, "private");
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

  if (s.error) {
    lines.push("  Status:  Unknown (see errors)");
  } else if (changedBranches.length === 0 && changedTags.length === 0) {
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
