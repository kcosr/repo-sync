export type RepoSource = "remote" | "archive";

export interface RemoteRepoConfig {
  name: string;
  source?: "remote";
  public: string;
  private: string;
  markSource?: boolean;
  markSourceDeleteClone?: boolean;
}

export interface ArchiveRepoConfig {
  name: string;
  source: "archive";
  private: string;
}

export type RepoConfig = RemoteRepoConfig | ArchiveRepoConfig;

export interface ArchiveLimits {
  maxBytes: number;
  maxEntries: number;
}

export interface Config {
  cacheDir?: string;
  archiveLimits?: Partial<ArchiveLimits>;
  repos: RepoConfig[];
}

export type ImportOutcome = "created" | "fast-forward" | "unchanged";

export interface ImportRecord {
  repo: string;
  result: ImportOutcome | "rejected";
  importedAt: string;
  archive: {
    path: string;
    sha256: string | null;
    size: number | null;
    root: string | null;
    head: string | null;
  };
  commit: string;
  branch: string;
  previousCommit: string | null;
  validation: {
    passed: boolean;
    checks: string[];
    error?: string;
  };
}

export interface RefComparison {
  name: string;
  localRef: string | null;
  privateRef: string | null;
  status: "ahead" | "behind" | "same" | "diverged" | "new" | "missing";
  aheadCount?: number;
  behindCount?: number;
}

export interface RepoStatus {
  name: string;
  source: RepoSource;
  publicUrl?: string;
  privateUrl: string;
  pulled: boolean;
  pulledAt?: Date;
  lastImport?: ImportRecord;
  branches: RefComparison[];
  tags: RefComparison[];
  error?: string;
}

export type SyncAction = "push" | "skip" | "error";
