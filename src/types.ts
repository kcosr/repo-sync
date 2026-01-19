export interface RepoConfig {
  name: string;
  public: string;
  private: string;
  markSource?: boolean;
}

export interface Config {
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
  publicUrl: string;
  privateUrl: string;
  pulled: boolean;
  pulledAt?: Date;
  branches: RefComparison[];
  tags: RefComparison[];
  error?: string;
}

export type SyncAction = "push" | "skip" | "error";
