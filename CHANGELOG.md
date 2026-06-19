# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] - 2026-06-19

### Added
- **Interactive Line-by-Line Merge**: Allows users to select and resolve individual line slots within overlapping conflict blocks using side-by-side aligned card displays (padded with visual placeholders for unequal diffs).
- **Bulk Selection Baseline**: Clicking "Keep local" or "Keep remote" on text conflicts now pre-selects all slots accordingly to serve as a baseline, allowing you to fine-tune selections line-by-line before confirming.
- **Card-Level Action Buttons**: Positioned "Keep local" and "Keep remote" buttons directly inside their respective local/remote cards for intuitive alignment.
- **Sleek Footer Layout**: Centered the "Confirm" and "Skip" buttons in the footer with increased spacing.

### Fixed
- **Conflict Suggestion Loops**: Fixed a database out-of-sync bug by querying post-modify file metadata from the vault after a merge, preventing resolved files from immediately re-conflicting.
- **Parameter Pass-through**: Restored custom merged text forwarding by plumbing the third `mergedText` argument through suggest modal and sync manager resolve callbacks.
- **UI Position Conflict**: Moved the editor status indicator widget down to `top: 50px` to clear Obsidian's reading/editing view switcher, and offset notice popups to `top: 140px` to match.
- **Strict TypeScript Build**: Resolved strict-mode type casting compiler errors and cleaned up unused imports.

---

## [0.5.0] - 2026-06-19

### Added
- **Tab Switch & File Open Sync Triggers**: Added options and settings to automatically run sync when switching active editor tabs or opening a file, optimized with a 1-second debounce window to prevent S3 API request spam.

---

## [0.4.0] - 2026-06-19

### Added
- **Persistent Editor Status Indicator**: Added a floating top-right status widget in active editor tabs displaying persistent sync status and auto-collapsing real-time logs. Clicking the status widget opens the conflict resolver when conflicts are present.
- **In-Memory Logs View**: Added an in-memory sync log stream (up to 1,000 entries) and a dedicated workspace tab with a clean document vibe (`file-text` icon), clear button, and auto-scroll options.
- **Exclusion Indication**: Added a red dashed border and warning messages to the editor status indicator when editing sync-excluded notes or folders.
- **Notice Position Override**: Shifted default Obsidian notices down by 95px to prevent overlaps with the top-right editor status indicator.

---

## [0.3.0] - 2026-06-15

### Added
- **Side-by-Side Conflict Resolution Modal**: Created a dual-card comparison modal for resolving update conflicts, rendering local and remote file states side-by-side with color-coded line-by-line highlighting.
- **Fuzzy Sync Conflict Suggester**: Clicking the status bar badge or using the Command Palette action now displays a fuzzy suggest modal allowing the user to select and resolve pending file conflicts.
- **Selective Auto-Merge for Insertions**: Implemented chronological auto-merging for new added lines that did not exist in the ancestor file, while queueing actual file updates for user decision.
- **Node 22.x CI Build Fix**: Migrated from `eslint.config.mts` to `eslint.config.mjs` to resolve Jiti type loader bugs on Node 22.x environments.

### Fixed
- **Obsidian API & Guidelines Alignment**: Aligned UI commands to sentence case, adjusted timer logic to window-scoped context, and replaced deprecated button methods.
- **Clean Linter State**: Resolved all TypeScript unused catch variable and ESLint warnings.

---

## [0.2.3] - 2026-06-14

### Changed
- **Config Renaming**: Cleaned up internal configuration keys and bumped plugin properties.

---

## [0.2.2] - 2026-06-14

### Added
- **Path Exclusion Filtering**: Added settings and filters to exclude specific folders, paths, or file extensions from S3 syncing.

---

## [0.2.1] - 2026-06-13

### Added
- **Millisecond-Precision mtime Embedding**: Prefixed encrypted payloads with the local file modification time (`mtime`) at millisecond resolution to ensure extremely accurate order-of-events merging.
- **Backward-Compatible SYNC Header**: Added a 5-byte `SYNC` magic prefix (`SYNC` ASCII bytes + format version byte) preceding the embedded `mtime` to dynamically identify upgraded payloads, preventing potential note corruption on vaults upgraded from `0.1.0`.
- **Markerless Chronological Auto-Merge**: Overlapping text line edits are automatically resolved by chronological order of modification (earlier on top, later on bottom) without injecting messy git conflict markers.

### Fixed
- **Electron Host Header Issue**: Fixed `net::ERR_INVALID_ARGUMENT` connection error by stripping the manual `Host` header from request parameters immediately before calling `requestUrl`.

---

## [0.1.0] - 2026-06-13

### Added
- **S3 Sync Core**: Full-featured, self-contained S3 synchronization using Obsidian's native `requestUrl` to bypass CORS.
- **Zero-Knowledge Encryption**: AES-GCM-256 local client-side encryption using native Web Crypto API.
- **Key Obfuscation**: Zero-knowledge encryption of directory paths and file names to prevent metadata exposure in the S3 bucket.
- **Gzip Compression**: Pre-compression of notes using `CompressionStream` to reduce data footprint by 60% to 80%.
- **Settings UI**: Test Connection utility, custom S3 endpoint configurations, passphrase input, device naming, and sync interval scheduling.
- **Gitignore & Licenses**: Configured project rules and licensed the repository under the permissive MIT license.
