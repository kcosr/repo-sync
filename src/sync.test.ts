import { formatRefComparison, formatStatus } from "./sync.js";
import type { RefComparison, RepoStatus } from "./types.js";

describe("sync", () => {
  describe("formatRefComparison", () => {
    it("should format same status", () => {
      const ref: RefComparison = {
        name: "main",
        localRef: "abc1234567890",
        privateRef: "abc1234567890",
        status: "same",
      };

      const result = formatRefComparison(ref);

      expect(result).toContain("main");
      expect(result).toContain("abc1234");
      expect(result).toContain("up to date");
    });

    it("should format ahead status with commit count", () => {
      const ref: RefComparison = {
        name: "main",
        localRef: "def5678901234",
        privateRef: "abc1234567890",
        status: "ahead",
        aheadCount: 5,
      };

      const result = formatRefComparison(ref);

      expect(result).toContain("main");
      expect(result).toContain("+5 commits");
      expect(result).toContain("→");
    });

    it("should format new status", () => {
      const ref: RefComparison = {
        name: "feature-branch",
        localRef: "abc1234567890",
        privateRef: null,
        status: "new",
      };

      const result = formatRefComparison(ref);

      expect(result).toContain("feature-branch");
      expect(result).toContain("new");
    });

    it("should format behind status with warning", () => {
      const ref: RefComparison = {
        name: "main",
        localRef: "abc1234567890",
        privateRef: "def5678901234",
        status: "behind",
        behindCount: 3,
      };

      const result = formatRefComparison(ref);

      expect(result).toContain("main");
      expect(result).toContain("3 ahead");
      expect(result).toContain("⚠️");
    });

    it("should format diverged status with warning", () => {
      const ref: RefComparison = {
        name: "main",
        localRef: "abc1234567890",
        privateRef: "xyz9876543210",
        status: "diverged",
      };

      const result = formatRefComparison(ref);

      expect(result).toContain("diverged");
      expect(result).toContain("⚠️");
    });

    it("should format missing status", () => {
      const ref: RefComparison = {
        name: "old-branch",
        localRef: null,
        privateRef: "abc1234567890",
        status: "missing",
      };

      const result = formatRefComparison(ref);

      expect(result).toContain("deleted from public");
    });
  });

  describe("formatStatus", () => {
    it("should format not pulled status", () => {
      const result = formatStatus({
        status: {
          name: "test-repo",
          publicUrl: "https://github.com/org/test.git",
          privateUrl: "git@private.com:vendor/test.git",
          pulled: false,
          branches: [],
          tags: [],
        },
        canPush: false,
        hasChanges: false,
        errors: ["Not pulled yet"],
      });

      expect(result).toContain("test-repo");
      expect(result).toContain("Not pulled yet");
    });

    it("should format up to date status", () => {
      const result = formatStatus({
        status: {
          name: "test-repo",
          publicUrl: "https://github.com/org/test.git",
          privateUrl: "git@private.com:vendor/test.git",
          pulled: true,
          pulledAt: new Date("2024-01-15T10:00:00Z"),
          branches: [{ name: "main", localRef: "abc123", privateRef: "abc123", status: "same" }],
          tags: [],
        },
        canPush: true,
        hasChanges: false,
        errors: [],
      });

      expect(result).toContain("test-repo");
      expect(result).toContain("Up to date ✓");
    });

    it("should format status with changes", () => {
      const result = formatStatus({
        status: {
          name: "test-repo",
          publicUrl: "https://github.com/org/test.git",
          privateUrl: "git@private.com:vendor/test.git",
          pulled: true,
          branches: [
            {
              name: "main",
              localRef: "def456",
              privateRef: "abc123",
              status: "ahead",
              aheadCount: 10,
            },
          ],
          tags: [{ name: "v1.0.0", localRef: "tag123", privateRef: null, status: "new" }],
        },
        canPush: true,
        hasChanges: true,
        errors: [],
      });

      expect(result).toContain("test-repo");
      expect(result).toContain("Branches:");
      expect(result).toContain("main");
      expect(result).toContain("+10 commits");
      expect(result).toContain("Tags:");
      expect(result).toContain("v1.0.0");
    });

    it("should format status with errors", () => {
      const result = formatStatus({
        status: {
          name: "test-repo",
          publicUrl: "https://github.com/org/test.git",
          privateUrl: "git@private.com:vendor/test.git",
          pulled: true,
          branches: [{ name: "main", localRef: "abc", privateRef: "xyz", status: "diverged" }],
          tags: [],
        },
        canPush: false,
        hasChanges: true,
        errors: ["Refs have diverged - manual intervention may be needed"],
      });

      expect(result).toContain("Errors:");
      expect(result).toContain("manual intervention");
    });
  });
});
