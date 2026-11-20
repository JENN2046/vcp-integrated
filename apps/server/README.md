# VCPToolBox integrated server

The integrated development service uses the upstream VCPToolBox host, the
NativeSync service extension and the host integration files from the verified
candidate. The source mapping is in `../../provenance/server.json`. The host's
license is in `LICENSE`.

## Build for the isolated integration runtime

Use Node 24.22.3, npm 10.9.8, and Linux x64 with glibc. The native build uses
Rust 1.89.0, Cargo, a C toolchain and the checked-in Cargo lockfile.

```sh
PUPPETEER_SKIP_DOWNLOAD=1 npm ci --no-audit --no-fund
bash scripts/build-vexus.sh
```

The isolated integration runtime doesn't need Puppeteer's browser download.
The Vexus build places the checked N-API module at
`rust-vexus-lite/vexus-lite.linux-x64-gnu.node`. The source build provides the
ABI required by this host version.

Run the monorepo build and isolated smoke flow from the repository root.
The harness stages this host in a disposable directory before starting
`server.js`, provisions database and diary directories, and provides an
explicit loopback listener, a synthetic provider and a loopback HTTPS proxy.

`Plugin/NativeSync/plugin-manifest.json` is the active manifest. The
`AgentAssistant` and `VCPSleep` directories supply implementation helpers.
The mobile PWA uses the real host's `/mobile` route backed by
`Plugin/NativeSync/mobile-dist`. `NativeMobilePwaDir` can specify an absolute
build directory.

## Ordinary host administration

Build the independent administrator UI from its checked-in lock.

```sh
npm --prefix AdminPanel-Vue ci --no-audit --no-fund
npm --prefix AdminPanel-Vue run build
```

Run `node adminServer.js` from an isolated server staging directory for the
separate AdminPanel. It listens on the same loopback address as the main
service, on `PORT + 1`. The built UI is served at `/AdminPanel/`. The host's
existing admin authentication requires private operator configuration to grant
access to protected pages.

The cache, weather, final-context and Bridge Profile routes load their fixed
upstream modules. Image and weather caches, OneRing state, Bridge profiles,
and provider settings are created or supplied by the operator when needed.
Optional tools are activated through their own manifests and runtime
configuration.

The daily-note search route can use the bundled Rust source after an optional
local build on Linux. The generic filename is the existing route fallback.

```sh
cargo +1.89.0 build --locked --release --manifest-path Plugin/DailyNoteSearcher/src/Cargo.toml
install -m 0755 Plugin/DailyNoteSearcher/src/target/release/DailyNoteSearcher Plugin/DailyNoteSearcher/DailyNoteSearcher
```
