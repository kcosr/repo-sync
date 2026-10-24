# Changelog

## [Unreleased]

### Breaking Changes

### Added

- Added `import` command and `source: archive` entries to seed and update repositories from source ZIPs with complete Git history. Imports are local, validated and transactional, and record provenance in `<cacheDir>/imports/`. Broad `pull` skips archive entries, and `push` never force-updates or prunes them ([#5](https://github.com/kcosr/repo-sync/pull/5))

### Changed

- CLI now rejects unknown options, options missing a value and extra positional arguments ([#5](https://github.com/kcosr/repo-sync/pull/5))

### Fixed

- Fixed `status` reporting the `<remote>/HEAD` ref that Git 2.48+ creates as a branch deleted from public ([#5](https://github.com/kcosr/repo-sync/pull/5))

### Removed

## [0.0.4] - 2026-02-17

### Breaking Changes

### Added

- Added `build:bun` script to compile a standalone Bun executable at `./bin/repo-sync` ([#4](https://github.com/kcosr/repo-sync/pull/4))

### Changed

### Fixed

### Removed

## [0.0.3] - 2026-02-17

### Breaking Changes

### Added

- Added `clone` command to create/update local work clones at `<cacheDir>/work/<repo-name>` from cached mirrors ([#3](https://github.com/kcosr/repo-sync/pull/3))

### Changed

### Fixed

- Fixed failed `git commit` handling to capture stdout so "nothing to commit" is treated as up-to-date during `markSource` runs ([#3](https://github.com/kcosr/repo-sync/pull/3))
- Fixed push ref syncing to avoid pushing remote-tracking refs by using explicit branch/tag refspecs with prune ([#3](https://github.com/kcosr/repo-sync/pull/3))

### Removed

## [0.0.2] - 2026-02-17

### Breaking Changes

### Added

### Changed

- Added top-level `cacheDir` config to control repo cache location, and moved `markSource` working clones under `<cacheDir>/work/<repo-name>` with `markSourceDeleteClone` controlling cleanup ([#2](https://github.com/kcosr/repo-sync/pull/2))

### Fixed

### Removed

## [0.0.1] - 2026-01-19

### Breaking Changes

### Added

- Added `markSource` config option to automatically add source repository notice to README files ([#1](https://github.com/kcosr/repo-sync/pull/1))

### Changed

### Fixed

### Removed

## [0.0.0] - 2026-01-17

Initial release.
