import { rmSync } from "node:fs";
import { ensureCacheDir, getRepoTempPath } from "./config.js";
import {
  addRemote,
  addSourceNotice,
  cloneMirror,
  compareRefs,
  fetchOrigin,
  fetchRemote,
  getDefaultBranch,
  getLocalRefs,
  getRemoteRefs,
  getRepoCloneTime,
  pushMirror,
  repoExists,
} from "./git.js";
import type { RefComparison, RepoConfig, RepoStatus } from "./types.js";

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

export function pull(repo: RepoConfig): PullResult {
  ensureCacheDir();
  const repoPath = getRepoTempPath(repo.name);
  const exists = repoExists(repoPath);

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

export function status(repo: RepoConfig): StatusResult {
  const repoPath = getRepoTempPath(repo.name);
  const errors: string[] = [];

  const baseStatus: RepoStatus = {
    name: repo.name,
    publicUrl: repo.public,
    privateUrl: repo.private,
    pulled: false,
    branches: [],
    tags: [],
  };

  if (!repoExists(repoPath)) {
    return {
      status: {
        ...baseStatus,
        error: "Not pulled yet. Run 'repo-sync pull' first.",
      },
      canPush: false,
      hasChanges: false,
      errors: ["Not pulled yet"],
    };
  }

  baseStatus.pulled = true;
  baseStatus.pulledAt = getRepoCloneTime(repoPath);

  // Fetch from private to compare
  console.log("  Fetching refs from private remote...");
  const fetchResult = fetchRemote(repoPath, "private");
  if (!fetchResult.success) {
    // This might be expected if private repo is empty or doesn't exist yet
    console.log("  Note: Could not fetch from private (may be empty or new)");
  }

  // Get refs
  const localRefs = getLocalRefs(repoPath);
  const privateRefs = getRemoteRefs(repoPath, "private");

  // Compare
  const { branches, tags } = compareRefs(repoPath, localRefs, privateRefs);
  baseStatus.branches = branches;
  baseStatus.tags = tags;

  // Determine if we can push
  const hasBehind = [...branches, ...tags].some((r) => r.status === "behind");
  const hasDiverged = [...branches, ...tags].some((r) => r.status === "diverged");
  const hasChanges = [...branches, ...tags].some(
    (r) => r.status === "ahead" || r.status === "new" || r.status === "missing",
  );

  if (hasBehind) {
    errors.push("Private has commits not in public - this shouldn't happen");
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

export function push(repo: RepoConfig): PushResult {
  const repoPath = getRepoTempPath(repo.name);

  if (!repoExists(repoPath)) {
    return {
      success: false,
      pushed: false,
      error: "Not pulled yet. Run 'repo-sync pull' first.",
    };
  }

  // When markSource is enabled, we skip the divergence check since we expect
  // our source notice commit to make the repos diverge. We'll force push.
  if (!repo.markSource) {
    // Check status first (only when not marking source)
    const statusResult = status(repo);
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
  }

  // Add source notice if configured
  if (repo.markSource) {
    console.log("  Adding source notice to README...");
    const branch = getDefaultBranch(repoPath);
    const noticeResult = addSourceNotice(repoPath, repo.public, branch);
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
  const pushResult = pushMirror(repoPath, "private");
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

export function clean(repo: RepoConfig): void {
  const repoPath = getRepoTempPath(repo.name);
  if (repoExists(repoPath)) {
    rmSync(repoPath, { recursive: true, force: true });
  }
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

  lines.push(`\n${s.name}`);
  lines.push(`  Public:  ${s.publicUrl}`);
  lines.push(`  Private: ${s.privateUrl}`);

  if (!s.pulled) {
    lines.push("  Status:  Not pulled yet");
    return lines.join("\n");
  }

  if (s.pulledAt) {
    lines.push(`  Pulled:  ${s.pulledAt.toLocaleString()}`);
  }

  const changedBranches = s.branches.filter((b) => b.status !== "same");
  const changedTags = s.tags.filter((t) => t.status !== "same");

  if (changedBranches.length === 0 && changedTags.length === 0) {
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

  if (result.errors.length > 0) {
    lines.push("  Errors:");
    for (const e of result.errors) {
      lines.push(`    ⚠️  ${e}`);
    }
  }

  return lines.join("\n");
}
