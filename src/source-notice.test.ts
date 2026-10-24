import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspectSourceNotice, prepareSourceNotice, sourceNoticeMatches } from "./source-notice.js";
import { SourceRepo, makeTempDir } from "./testing/fixtures.js";

const publicUrl = "https://example.com/upstream/project.git";
const marker = "<!-- repo-sync-source-notice -->";

function gitRaw(
  path: string,
  args: string[],
  input?: string | Buffer,
  author = "repo-sync",
): Buffer {
  const result = spawnSync("git", args, {
    cwd: path,
    input,
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: author,
      GIT_AUTHOR_EMAIL: `${author}@localhost`,
      GIT_COMMITTER_NAME: author,
      GIT_COMMITTER_EMAIL: `${author}@localhost`,
      GIT_AUTHOR_DATE: "1700000100 +0000",
      GIT_COMMITTER_DATE: "1700000100 +0000",
    },
  });
  if (result.status !== 0) throw new Error(result.stderr.toString());
  return result.stdout;
}

describe("source notice commits", () => {
  let testDir: string;
  let source: SourceRepo;
  let commit: string;
  let counter = 0;

  beforeAll(() => {
    testDir = makeTempDir("source-notice");
  });

  beforeEach(() => {
    source = SourceRepo.create(join(testDir, `source-${counter++}`));
    commit = source.commit("Original source", {
      "README.md": "# Project\n\nRead me.\n",
      "main.ts": "export {};\n",
    });
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function blob(sha: string, file = "README.md"): Buffer {
    return gitRaw(source.path, ["show", `${sha}:${file}`]);
  }

  function commitMessage(sha: string): Buffer {
    const raw = gitRaw(source.path, ["cat-file", "commit", sha]);
    return raw.subarray(raw.indexOf("\n\n") + 2);
  }

  function forged(
    tree: string,
    parents: string[],
    message: string | Buffer,
    author = "repo-sync",
  ): string {
    return gitRaw(
      source.path,
      ["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent])],
      message,
      author,
    )
      .toString()
      .trim();
  }

  it("creates a separate single-parent linked commit without changing source refs, index, or worktree", () => {
    const index = readFileSync(join(source.path, ".git/index"));
    const readme = readFileSync(join(source.path, "README.md"));
    const notice = prepareSourceNotice(source.path, commit, "linked", publicUrl);

    expect(notice).not.toBe(commit);
    expect(source.head()).toBe(commit);
    expect(source.git("show", "-s", "--format=%P", notice)).toBe(commit);
    expect(source.git("diff-tree", "--no-commit-id", "--name-only", "-r", commit, notice)).toBe(
      "README.md",
    );
    expect(source.git("show", "-s", "--format=%an <%ae>", notice)).toBe(
      "repo-sync <repo-sync@localhost>",
    );
    expect(blob(notice).toString()).toContain(`[${publicUrl}](${publicUrl})`);
    expect(blob(notice).subarray(-readme.length).equals(readme)).toBe(true);
    expect(readFileSync(join(source.path, ".git/index")).equals(index)).toBe(true);
    expect(readFileSync(join(source.path, "README.md")).equals(readme)).toBe(true);
    expect(inspectSourceNotice(source.path, notice)).toEqual({
      sourceCommit: commit,
      mode: "linked",
      publicUrl,
    });
  });

  it("uses the exact generic banner without a public link", () => {
    const notice = prepareSourceNotice(source.path, commit, "generic");
    expect(blob(notice).toString()).toContain(
      "This repository is automatically mirrored from an external repository.",
    );
    expect(blob(notice).toString()).not.toContain("https://");
    expect(inspectSourceNotice(source.path, notice)).toEqual({
      sourceCommit: commit,
      mode: "generic",
    });
  });

  it("preserves arbitrary README bytes, whitespace, and executable mode", () => {
    const original = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("\r\n# Project\r\n\r\n"),
      Buffer.from([0xff]),
      Buffer.from("\n\n\n"),
    ]);
    writeFileSync(join(source.path, "README.md"), original);
    source.git("update-index", "--chmod=+x", "README.md");
    source.git("config", "core.filemode", "false");
    commit = source.commit("Byte-preserving README");
    const notice = prepareSourceNotice(source.path, commit, "generic");
    expect(blob(notice).subarray(-original.length).equals(original)).toBe(true);
    expect(source.git("ls-tree", notice, "README.md")).toMatch(/^100755 blob /);
    expect(inspectSourceNotice(source.path, notice)?.sourceCommit).toBe(commit);
    expect(prepareSourceNotice(source.path, commit, "none")).toBe(commit);
  });

  it("changes modes without accumulating banners and none restores the exact source tree", () => {
    const linked = prepareSourceNotice(source.path, commit, "linked", publicUrl);
    const generic = prepareSourceNotice(source.path, commit, "generic");
    expect(blob(generic).toString().split(marker)).toHaveLength(2);
    expect(blob(generic).toString()).not.toContain(publicUrl);
    expect(blob(generic).subarray(blob(generic).indexOf("\n\n") + 2)).toEqual(blob(commit));
    expect(sourceNoticeMatches(source.path, linked, commit, "generic")).toBe(false);
    expect(sourceNoticeMatches(source.path, generic, commit, "generic")).toBe(true);
    expect(sourceNoticeMatches(source.path, generic, commit, "none")).toBe(false);
    expect(prepareSourceNotice(source.path, commit, "none")).toBe(commit);
    expect(sourceNoticeMatches(source.path, commit, commit, "none")).toBe(true);
  });

  it("restores README absence when none is selected", () => {
    rmSync(join(source.path, "README.md"));
    commit = source.commit("No README");
    const notice = prepareSourceNotice(source.path, commit, "generic");
    expect(blob(notice).toString()).toContain(marker);
    const none = prepareSourceNotice(source.path, commit, "none");
    expect(none).toBe(commit);
    expect(source.git("ls-tree", "--name-only", none, "README.md")).toBe("");
  });

  it("updates only recognized marker blocks and retains unrelated leading blank lines", () => {
    const linked = prepareSourceNotice(source.path, commit, "linked", publicUrl);
    const firstBannerEnd = blob(linked).indexOf("\n\n") + 2;
    const original = Buffer.from("\n\n# Actual README\n\n");
    writeFileSync(
      join(source.path, "README.md"),
      Buffer.concat([blob(linked).subarray(0, firstBannerEnd), original]),
    );
    commit = source.commit("Existing managed banner");
    const updated = prepareSourceNotice(source.path, commit, "generic");
    expect(blob(updated).subarray(-original.length).equals(original)).toBe(true);
    expect(blob(updated).toString().split(marker)).toHaveLength(2);

    const unowned = `${marker}\nThis is a quoted example, not a generated banner.\n<!-- end-repo-sync-source-notice -->\n\n`;
    source.write("README.md", unowned);
    commit = source.commit("Unrelated marker example");
    const preserved = prepareSourceNotice(source.path, commit, "generic");
    expect(blob(preserved).subarray(-Buffer.byteLength(unowned)).toString()).toBe(unowned);
  });

  it("recognizes legacy linked commits only with the exact identity and expected README-only tree", () => {
    const current = prepareSourceNotice(source.path, commit, "linked", publicUrl);
    const tree = source.git("rev-parse", `${current}^{tree}`);
    const legacy = forged(tree, [commit], "Add source repository notice\n");
    expect(inspectSourceNotice(source.path, legacy)).toEqual({
      sourceCommit: commit,
      mode: "linked",
      publicUrl,
    });
    expect(sourceNoticeMatches(source.path, legacy, commit, "linked", publicUrl)).toBe(true);
    const unrelated = source.commit("Add source repository notice", {
      "README.md": "User changes\n",
    });
    expect(inspectSourceNotice(source.path, unrelated)).toBeUndefined();
  });

  it.each(["README.md", "main.ts"])(
    "rejects a forged metadata message with unrelated edits to %s",
    (file) => {
      const genuine = prepareSourceNotice(source.path, commit, "linked", publicUrl);
      source.write("README.md", blob(genuine).toString());
      source.write(file, `${file === "README.md" ? blob(genuine).toString() : ""}unrelated edit\n`);
      const changed = source.commit("Manual edit");
      const tree = source.git("rev-parse", `${changed}^{tree}`);
      const fake = forged(tree, [commit], commitMessage(genuine));
      expect(inspectSourceNotice(source.path, fake)).toBeUndefined();
    },
  );

  it("rejects a legacy message that also changes another file", () => {
    const genuine = prepareSourceNotice(source.path, commit, "linked", publicUrl);
    source.write("README.md", blob(genuine).toString());
    const changed = source.commit("Manual edit", { "main.ts": "manual\n" });
    const fake = forged(
      source.git("rev-parse", `${changed}^{tree}`),
      [commit],
      "Add source repository notice\n",
    );
    expect(inspectSourceNotice(source.path, fake)).toBeUndefined();
  });

  it("rejects wrong identity, extra parents, and noncanonical metadata", () => {
    const genuine = prepareSourceNotice(source.path, commit, "generic");
    const tree = source.git("rev-parse", `${genuine}^{tree}`);
    const another = source.commit("Second source commit");
    expect(
      inspectSourceNotice(source.path, forged(tree, [commit], commitMessage(genuine), "manual")),
    ).toBeUndefined();
    expect(
      inspectSourceNotice(source.path, forged(tree, [commit, another], commitMessage(genuine))),
    ).toBeUndefined();
    expect(
      inspectSourceNotice(
        source.path,
        forged(tree, [commit], `${commitMessage(genuine).toString()}extra\n`),
      ),
    ).toBeUndefined();
  });

  it("matches idempotently without writing objects and notices URL-only changes", () => {
    const notice = prepareSourceNotice(source.path, commit, "linked", publicUrl);
    const before = source.git("count-objects", "-v");
    expect(sourceNoticeMatches(source.path, notice, commit, "linked", publicUrl)).toBe(true);
    expect(
      sourceNoticeMatches(source.path, notice, commit, "linked", "https://example.com/changed"),
    ).toBe(false);
    expect(source.git("count-objects", "-v")).toBe(before);
  });

  it("rejects README symlinks without touching their targets", () => {
    const outside = join(testDir, "outside-readme");
    writeFileSync(outside, "outside\n");
    rmSync(join(source.path, "README.md"));
    symlinkSync(outside, join(source.path, "README.md"));
    commit = source.commit("Symlink README");
    expect(() => prepareSourceNotice(source.path, commit, "generic")).toThrow(/not a regular file/);
    expect(readFileSync(outside, "utf-8")).toBe("outside\n");
  });

  it("uses raw Git blobs without invoking configured filters or hooks", () => {
    const touched = join(testDir, "filter-executed");
    source.write(".gitattributes", "*.md filter=custom\n");
    commit = source.commit("Attributes");
    source.git("config", "filter.custom.clean", `touch ${touched}`);
    writeFileSync(join(source.path, ".git/hooks/pre-commit"), `#!/bin/sh\ntouch ${touched}\n`, {
      mode: 0o755,
    });
    const notice = prepareSourceNotice(source.path, commit, "generic");
    expect(inspectSourceNotice(source.path, notice)?.sourceCommit).toBe(commit);
    expect(existsSync(touched)).toBe(false);
  });

  it("works with SHA-256 repositories", () => {
    source = SourceRepo.create(join(testDir, `source-${counter++}`), { objectFormat: "sha256" });
    commit = source.commit("SHA-256 source", { "README.md": "SHA-256\n" });
    const notice = prepareSourceNotice(source.path, commit, "generic");
    expect(notice).toHaveLength(64);
    expect(inspectSourceNotice(source.path, notice)?.sourceCommit).toBe(commit);
  });
});
