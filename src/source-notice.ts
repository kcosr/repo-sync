import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceNoticeMode } from "./types.js";

const IDENTITY = "repo-sync <repo-sync@localhost>";
const MESSAGE = "Update source repository notice\n\nRepo-Sync-Source-Notice: ";
const START = "<!-- repo-sync-source-notice -->";
const END = "<!-- end-repo-sync-source-notice -->\n\n";
const README_NAMES = [
  "README.md",
  "readme.md",
  "README.MD",
  "README",
  "readme",
  "README.txt",
  "readme.txt",
];

export interface SourceNotice {
  sourceCommit: string;
  mode: SourceNoticeMode;
  publicUrl?: string;
}

function git(repoPath: string, args: string[], input?: Buffer | string, index?: string): Buffer {
  const result = spawnSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      cwd: repoPath,
      input,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        LC_ALL: "C",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_ATTR_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "repo-sync",
        GIT_AUTHOR_EMAIL: "repo-sync@localhost",
        GIT_COMMITTER_NAME: "repo-sync",
        GIT_COMMITTER_EMAIL: "repo-sync@localhost",
        ...(index ? { GIT_INDEX_FILE: index } : {}),
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(
      result.error?.message || result.stderr?.toString().trim() || `git ${args[0]} failed`,
    );
  }
  return result.stdout;
}

function banner(mode: Exclude<SourceNoticeMode, "none">, publicUrl?: string): string {
  if (mode === "linked" && (!publicUrl || /[\r\n\0]/.test(publicUrl))) {
    throw new Error("A linked source notice requires a source URL without line breaks");
  }
  const source = mode === "linked" ? `[${publicUrl}](${publicUrl})` : "an external repository";
  return `${START}\n> **📦 Mirrored Repository**\n>\n> This repository is automatically mirrored from ${source}.\n> Do not commit directly to this repository.\n${END}`;
}

/** Recognizes the exact owned prefix, leaving every byte after its two newlines untouched. */
function readBanner(
  content: Buffer,
): { mode: "linked" | "generic"; publicUrl?: string; length: number } | undefined {
  if (!content.subarray(0, Buffer.byteLength(START)).equals(Buffer.from(START))) return undefined;
  const end = content.indexOf(END);
  if (end < 0) return undefined;
  const length = end + Buffer.byteLength(END);
  const prefix = content.subarray(0, length).toString("utf-8");
  if (prefix === banner("generic")) return { mode: "generic", length };
  const source = prefix
    .split("\n")[3]
    ?.match(/^> This repository is automatically mirrored from \[(.+)\]\(\1\)\.$/);
  if (source && prefix === banner("linked", source[1])) {
    return { mode: "linked", publicUrl: source[1], length };
  }
  return undefined;
}

interface TreeFile {
  name: string;
  mode: string;
  object: string;
}

function treeFiles(repoPath: string, commit: string): TreeFile[] {
  return git(repoPath, ["ls-tree", "-z", commit, "--", ...README_NAMES])
    .toString("utf-8")
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [metadata, name] = line.split("\t");
      const [mode, , object] = metadata.split(" ");
      return { name, mode, object };
    });
}

function desiredReadme(
  repoPath: string,
  source: string,
  mode: "linked" | "generic",
  publicUrl?: string,
) {
  const files = treeFiles(repoPath, source);
  const file = README_NAMES.map((name) => files.find((entry) => entry.name === name)).find(Boolean);
  if (file && file.mode !== "100644" && file.mode !== "100755") {
    throw new Error(`Cannot add a source notice: ${file.name} is not a regular file`);
  }
  let original = file ? git(repoPath, ["cat-file", "blob", file.object]) : Buffer.alloc(0);
  let previous = readBanner(original);
  while (previous) {
    original = original.subarray(previous.length);
    previous = readBanner(original);
  }
  return {
    name: file?.name ?? "README.md",
    mode: file?.mode ?? "100644",
    content: Buffer.concat([Buffer.from(banner(mode, publicUrl)), original]),
  };
}

function message(mode: "linked" | "generic", publicUrl?: string): string {
  return `${MESSAGE}${JSON.stringify({ version: 1, mode, ...(mode === "linked" ? { publicUrl } : {}) })}\n`;
}

/** Recognizes only our identity, single-parent shape, metadata, and exact README-only change. */
export function inspectSourceNotice(repoPath: string, sha: string): SourceNotice | undefined {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) return undefined;
  const commit = git(repoPath, ["cat-file", "commit", sha]).toString("utf-8");
  const split = commit.indexOf("\n\n");
  const headers = commit.slice(0, split).split("\n");
  const parents = headers.filter((line) => line.startsWith("parent "));
  if (parents.length !== 1) return undefined;
  for (const role of ["author", "committer"]) {
    const fields = headers.filter((line) => line.startsWith(`${role} `));
    if (fields.length !== 1 || !fields[0].startsWith(`${role} ${IDENTITY} `)) return undefined;
  }
  const sourceCommit = parents[0].slice("parent ".length);
  const body = commit.slice(split + 2);
  let mode: "linked" | "generic";
  let publicUrl: string | undefined;
  if (body === "Add source repository notice\n") {
    const files = treeFiles(repoPath, sha);
    const file = README_NAMES.map((name) => files.find((entry) => entry.name === name)).find(
      Boolean,
    );
    if (!file || (file.mode !== "100644" && file.mode !== "100755")) return undefined;
    const legacy = readBanner(git(repoPath, ["cat-file", "blob", file.object]));
    if (legacy?.mode !== "linked") return undefined;
    mode = "linked";
    publicUrl = legacy.publicUrl;
  } else {
    if (!body.startsWith(MESSAGE)) return undefined;
    try {
      const metadata = JSON.parse(body.slice(MESSAGE.length));
      if (metadata.version !== 1 || (metadata.mode !== "linked" && metadata.mode !== "generic"))
        return undefined;
      if (metadata.mode === "linked" && typeof metadata.publicUrl !== "string") return undefined;
      mode = metadata.mode;
      publicUrl = mode === "linked" ? metadata.publicUrl : undefined;
      if (body !== message(mode, publicUrl)) return undefined;
    } catch {
      return undefined;
    }
  }
  const expected = desiredReadme(repoPath, sourceCommit, mode, publicUrl);
  const changed = git(repoPath, [
    "diff-tree",
    "--no-commit-id",
    "--no-renames",
    "--ignore-submodules=none",
    "--name-only",
    "-r",
    "-z",
    sourceCommit,
    sha,
  ])
    .toString("utf-8")
    .split("\0")
    .filter(Boolean);
  if (changed.some((path) => path !== expected.name)) return undefined;
  const actual = treeFiles(repoPath, sha).find((entry) => entry.name === expected.name);
  if (!actual || actual.mode !== expected.mode) return undefined;
  const expectedObject = git(repoPath, ["hash-object", "--stdin", "--no-filters"], expected.content)
    .toString()
    .trim();
  if (actual.object !== expectedObject) return undefined;
  return { sourceCommit, mode, ...(publicUrl === undefined ? {} : { publicUrl }) };
}

/** Read-only comparison: status never creates new commits or touches an index. */
export function sourceNoticeMatches(
  repoPath: string,
  sha: string,
  sourceCommit: string,
  mode: SourceNoticeMode,
  publicUrl?: string,
): boolean {
  if (mode === "none") return sha === sourceCommit;
  const notice = inspectSourceNotice(repoPath, sha);
  return (
    notice?.sourceCommit === sourceCommit &&
    notice.mode === mode &&
    (mode !== "linked" || notice.publicUrl === publicUrl)
  );
}

/** Creates a disposable derived commit without moving source refs or touching a worktree. */
export function prepareSourceNotice(
  repoPath: string,
  sourceCommit: string,
  mode: SourceNoticeMode,
  publicUrl?: string,
): string {
  if (mode === "none") return sourceCommit;
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sourceCommit))
    throw new Error("Source commit must be a full object ID");
  const readme = desiredReadme(repoPath, sourceCommit, mode, publicUrl);
  const temporary = mkdtempSync(join(tmpdir(), "repo-sync-notice-"));
  const index = join(temporary, "index");
  try {
    git(repoPath, ["read-tree", sourceCommit], undefined, index);
    const blob = git(repoPath, ["hash-object", "-w", "--stdin", "--no-filters"], readme.content)
      .toString()
      .trim();
    git(
      repoPath,
      ["update-index", "--add", "--cacheinfo", `${readme.mode},${blob},${readme.name}`],
      undefined,
      index,
    );
    const tree = git(repoPath, ["write-tree"], undefined, index).toString().trim();
    return git(repoPath, ["commit-tree", tree, "-p", sourceCommit], message(mode, publicUrl))
      .toString()
      .trim();
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
