# Collaboration validation

Build the PWA and install locked dependencies as described in the root README. Run with Node 24 and Chromium.

```sh
CHROME_BIN=/path/to/chrome npm run test:collaboration
```

The default suite stages ToolBox in a temporary directory and restricts Node test network calls to loopback. The browser uses an isolated profile. Tests exercise the built PWA, independent Core pairing and Work routes, submission and Steering receipts, approved tool lifecycle, native sticker access, attachment recovery, and missed or late preview events. Model endpoints use synthetic data.

The archived Shared collaboration suite and its original commands are available at `032ad5f`. See the repository's architecture document for acceptance results and remaining limits.
