export type RepoSource = "remote" | "archive";

export type SourceNoticeMode = "linked" | "generic" | "none";

interface RepoConfigBase {
  name: string;
  private: string;
  sourceNotice?: SourceNoticeMode;
}

export interface RemoteRepoConfig extends RepoConfigBase {
  source?: "remote";
  public: string;
}

export interface ArchiveRepoConfig extends RepoConfigBase {
  source: "archive";
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
  sourceNoticeChanged?: boolean;
  branches: RefComparison[];
  tags: RefComparison[];
  error?: string;
}

export type SyncAction = "push" | "skip" | "error";
