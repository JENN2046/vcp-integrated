# Linux candidate build

The detached worktree was clean before dependencies were installed and after npm run build. The checkout is c1b8ffc6272f64626fc6465434372bcb632aabe4, tree 81b3497e17deba0313b0edd7123067dafdb11cda. See input.txt for versions and lock digests.

- Node 24.22.1 and npm 11.19.1 ran all three locked npm ci installs. On desktop the repository's setup intentionally skips package lifecycle scripts and runs the version-locked Electron installer separately. The Electron 44.9.3 Linux x64 archive matched the SHA256 supplied by the locked package.
- Public tarballs that were slow on the registry were prefilled by digest. The original lockfiles were retained. The serial dependency wrapper was superseded by equivalent independent lockfile installs so the server and mobile could complete while desktop tarballs downloaded. The completed desktop install used the offline cache.
- Fresh Linux Rust targets built CDS release with Rust 1.96.1 and Vexus with Rust 1.89.0, with both projects locked. The later npm run build used those freshly built target directories. CDS authority SHA256 matches its binary. The Vexus native ABI assertion and a server better-sqlite3 in-memory SELECT 1 passed.
- The full build generated contracts, renderer rules, the Agent name owner and four sandbox preload entries. SHA256SUMS covers 29 outputs and sha256sum -c verified every entry from the worktree root.
- The rebuilt PWA points to index-Cuf1bKRk.js. pwa-comparison.txt verifies that it contains the settled Work status absent from the stale index-Bsu6-SLg.js.
- The candidate desktop selection and interruption fixture passed all 37 tests.
- The complete desktop chat-kernel suite produced 607/631 on the candidate and 605/631 on its immediate parent 56560aa. The same 24 fixture failures reproduce on both. The candidate clears the two additional selection-race failures present on the parent.
