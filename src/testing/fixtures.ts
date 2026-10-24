import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type ZipEntrySpec, writeZip, zipEntriesFromDirectory } from "./zip-writer.js";

export function makeTempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `repo-sync-${label}-`));
}

// Git only reads configuration from HOME; pointing it at a missing directory keeps fixtures
// independent of the developer's settings without leaving anything behind.
const fixtureHome = join(tmpdir(), "repo-sync-fixture-home-unused");
let clock = 1_700_000_000;

/** Runs git for fixtures with no user configuration and deterministic identities. */
export function git(cwd: string, args: string[]): string {
  const date = `${clock++} +0000`;
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: {
      PATH: process.env.PATH,
      HOME: fixtureHome,
      XDG_CONFIG_HOME: fixtureHome,
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
      GIT_COMMITTER_DATE: date,
      GIT_ALLOW_PROTOCOL: "file",
    },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

export interface ArchiveOptions {
  root?: string;
  transform?: (entries: ZipEntrySpec[]) => ZipEntrySpec[];
}

export class SourceRepo {
  private constructor(readonly path: string) {}

  static open(path: string): SourceRepo {
    return new SourceRepo(path);
  }

  static create(path: string, options: { objectFormat?: "sha1" | "sha256" } = {}): SourceRepo {
    mkdirSync(path, { recursive: true });
    git(path, [
      "init",
      "--quiet",
      "--initial-branch=main",
      `--object-format=${options.objectFormat ?? "sha1"}`,
    ]);
    return new SourceRepo(path);
  }

  write(file: string, content: string, mode?: number): void {
    const target = join(this.path, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    if (mode !== undefined) {
      chmodSync(target, mode);
    }
  }

  commit(message: string, files: Record<string, string> = {}): string {
    for (const [file, content] of Object.entries(files)) {
      this.write(file, content);
    }
    git(this.path, ["add", "-A"]);
    git(this.path, ["commit", "--quiet", "--allow-empty", "-m", message]);
    return this.head();
  }

  head(): string {
    return git(this.path, ["rev-parse", "HEAD"]);
  }

  git(...args: string[]): string {
    return git(this.path, args);
  }

  /** Writes a source ZIP of this checkout (working tree plus `.git`) under `root`. */
  archive(zipPath: string, options: ArchiveOptions = {}): string {
    const entries = zipEntriesFromDirectory(this.path, options.root ?? basename(this.path));
    return writeZip(zipPath, options.transform ? options.transform(entries) : entries);
  }
}

export function initBare(path: string): string {
  mkdirSync(path, { recursive: true });
  git(path, ["init", "--quiet", "--bare", "--initial-branch=main"]);
  return path;
}
