# Linux 桌面、ToolBox 和 PWA 构建

在全新 detached worktree 从提交 `75ef3d4c5cb8a880772342209841a40104127ba3` 和 Git tree `fc9ca39fb3dc087d8a2a3758286a50c8373cb2a6` 构建。三个应用各自按 npm lockfile 安装。CDS 和 Vexus 分别用 Rust 1.96.1 和 1.89.0 从各自的 Cargo lockfile 编译。复用了本机公共下载缓存，依赖安装和构建输出均位于候选检出。

```sh
git worktree add --detach /path/to/fresh-checkout 75ef3d4c5cb8a880772342209841a40104127ba3
cd /path/to/fresh-checkout
export PATH="/home/jenn/.nvm/versions/node/v24.22.1/bin:$PATH"
git status --porcelain
npm_config_offline=true npm run deps
CARGO_NET_OFFLINE=true npm run build
git status --porcelain
```

首次在新主机构建时需下载锁定依赖。通过 rustup 提供 CDS 使用的默认 Rust 工具链及 Vexus 使用的 `cargo +1.89.0`。

[构建输入与工具链](./source.txt)列出检出路径和版本。[构建摘要](./build-sha256.txt)覆盖三份 npm 锁、两份 Cargo 锁、Electron、CDS 及其 authority 文件、better-sqlite3、Vexus、生成契约、桌面 renderer 和 preload 构建产物，以及 ToolBox 提供的完整 PWA 文件。通过 [hash-build.sh](./hash-build.sh) 重新生成摘要，或在候选根目录用 `sha256sum --check` 核对证据文件。

安装与全量构建均退出 0。构建入口检查了 Vexus 原生 ABI 和 SQLite 内存查询，候选检出构建前后均干净。32 个锁文件和产物的 SHA256 核对通过。Vexus 使用仓库构建入口默认的 debug profile。[构建输出摘录](./build-output.txt)

构建输出供同批三端验收和复查使用。当前工作树由本轮构建任务创建，在本次验收收尾后复核保留范围。
