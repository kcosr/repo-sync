import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Config, RepoConfig } from "./types.js";

const DEFAULT_CONFIG_PATH = "repo-sync.yaml";
const DEFAULT_CACHE_DIR = join(homedir(), ".repo-sync");

export function getConfigPath(customPath?: string): string {
  return customPath || DEFAULT_CONFIG_PATH;
}

function resolveCacheDir(cacheDir?: string): string {
  if (!cacheDir) {
    return DEFAULT_CACHE_DIR;
  }
  if (cacheDir === "~") {
    return homedir();
  }
  if (cacheDir.startsWith("~/")) {
    return join(homedir(), cacheDir.slice(2));
  }
  return cacheDir;
}

export function getCacheDir(config?: Config): string {
  return resolveCacheDir(config?.cacheDir);
}

export function getTempDir(cacheDir?: string): string {
  return join(resolveCacheDir(cacheDir), "repos");
}

export function getWorkDir(cacheDir?: string): string {
  return join(resolveCacheDir(cacheDir), "work");
}

export function getRepoTempPath(repoName: string, cacheDir?: string): string {
  return join(getTempDir(cacheDir), `${repoName}.git`);
}

export function ensureCacheDir(cacheDir?: string): void {
  const repoDir = getTempDir(cacheDir);
  if (!existsSync(repoDir)) {
    mkdirSync(repoDir, { recursive: true });
  }
}

export function loadConfig(configPath?: string): Config {
  const path = getConfigPath(configPath);

  if (!existsSync(path)) {
    throw new Error(
      `Config file not found: ${path}\nCreate it with:\n\n  cat > ${path} << 'EOF'\nrepos:\n  - name: example-repo\n    public: https://github.com/org/example-repo.git\n    private: git@private.company.com:vendor/example-repo.git\nEOF`,
    );
  }

  const content = readFileSync(path, "utf-8");
  const config = parseYaml(content) as Config;

  if (config.cacheDir !== undefined) {
    if (typeof config.cacheDir !== "string") {
      throw new Error("Config 'cacheDir' must be a string");
    }
    if (config.cacheDir.trim().length === 0) {
      throw new Error("Config 'cacheDir' cannot be empty");
    }
  }

  if (!config.repos || !Array.isArray(config.repos)) {
    throw new Error("Config must have a 'repos' array");
  }

  for (const repo of config.repos) {
    validateRepoConfig(repo);
  }

  return config;
}

function validateRepoConfig(repo: RepoConfig): void {
  if (!repo.name || typeof repo.name !== "string") {
    throw new Error("Each repo must have a 'name' string");
  }
  if (!repo.public || typeof repo.public !== "string") {
    throw new Error(`Repo '${repo.name}' must have a 'public' URL`);
  }
  if (!repo.private || typeof repo.private !== "string") {
    throw new Error(`Repo '${repo.name}' must have a 'private' URL`);
  }
  if (repo.markSourceDeleteClone !== undefined && typeof repo.markSourceDeleteClone !== "boolean") {
    throw new Error(`Repo '${repo.name}' has invalid 'markSourceDeleteClone': expected boolean`);
  }
}

export function findRepo(config: Config, name: string): RepoConfig | undefined {
  return config.repos.find((r) => r.name === name);
}
