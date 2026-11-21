# Linux 干净重建及实体客户端验证

2026-11-22（Asia/Taipei），在 Linux x86_64 / glibc 2.43 上，以 `vcp-integrated` 提交 `7829b83ccb634c397caa6a168d9fe0d8663cb12e`（tree `a9e95aad980a8bb73c848b94dd0f3c399b9fbccd`）建立全新 detached worktree。依赖与构建前后 `git status --porcelain` 均为空。Node 24.22.1、Electron 44.9.3。桌面 Linux CDS 使用 Rust 1.96.1，服务端 Vexus 使用要求的 1.89.0。Windows CDS 和桌面 Electron 需要对应平台构建或安装，Linux 二进制仅用于 Linux。PWA 是构建后经 HTTPS 实际提供的同源浏览器载荷。

本轮在新检出以锁文件重新安装三套依赖，并从源码生成桌面 preload、共享规则与 Agent 保存模块、Linux CDS、服务端 Vexus 和 PWA。公共 npm、Electron 和 Cargo 缓存以及本机公共工具链可复用，已有项目的 `node_modules`、构建产物和用户数据均未用于此检出。Xvfb 复用现有公共工具二进制，Electron 使用真实 Chromium 渲染器及独立测试 Profile。回环合成 Provider、隔离 ToolBox、临时 SQLite 和一次性只读手机会话构成本轮环境。

## 实际结果

- **Linux 普通本机单聊通过。** 在 Electron 中通过发送按钮提交一次，在同一话题渲染合成回复。本地 History 各保存一条用户消息与助手回复。Provider 1 次、本机请求 1 次、共享提交 0 次、中央 Work 0 条、Journal 0 条。独立进程全部正常退出。[进程与消息回执](./linux-local.json)
- **Linux 普通共享单聊通过。** Linux Electron 提交一次。持久 Work 在同一 ID 上从 running 变为 completed，attempts=1，合成 Provider 请求总计 1 次。中央 Journal seq 1/2 对应 Linux 本地 History 中同两条 ID，终态截图显示两条消息，手工夹具设置的独立草稿和选区保留。[原 Work 在途](./work-held.json) · [原 Work 完成](./work-completed.json) · [Linux 所见及 History](./linux-completed.json)
- **Android 观察已由设备负责人确认。** 手机只读配对同一话题并分别看到 running、completed 和原消息／回复 ID。Windows 观察负责人确认同一 Work 初开及重开均可回读。Windows 重开后，中央仍仅一份 Work（attempts=1）和一次 Provider 请求。[重开后中央快照](./work-post-windows-reopen.json)
- 共享 Linux 窗口的主进程模块由 Electron require 缓存报告，渲染模块由 Chromium 调试接口读取已载入源码。实际 Electron 与 Linux CDS 从 `/proc/<pid>/exe` 核对。运行中 ToolBox 的 Vexus 和 better-sqlite3 从 `/proc/<pid>/maps` 找到实际映射文件并核对摘要。本机发送回执包含后端退出时实际加载的 JS 文件摘要。共享 ToolBox 停止时导出的 31 个实际加载 JS 模块也都与干净检出一致。Linux A 本地 History 与中央 Journal 的两条消息以 UTF-8 正文逐字节计算 SHA256，结果和消息 ID、角色一致。HTTPS 验证返回 200，实际提供的 HTML、JS、CSS 和 service worker 与构建产物逐字节相同。[Linux 共享加载文件](./linux-shared-loaded.json) · [Linux 共享进程](./linux-shared-process-hashes.txt) · [共享后端原生组件](./shared-backend-native-hashes.txt) · [构建摘要](./build-sha256.txt) · [HTTPS 实际载荷](./shared-served-assets.txt) · [共享后端已加载 JS](./shared-backend-loaded.json) · [两份持久正文摘要](./shared-message-content-hashes.json)

## 复跑

从已安装 Node 24、Rust 1.89.0 与默认 Linux Rust 工具链的软件环境执行。若 cargo 入口已通过 rustup 解析 `+1.89.0`，可直接运行 `npm run build`。此次使用附带的 [Cargo 入口](./cargo-pin.sh) 把 `+1.89.0` 转给本机已缓存的固定工具链，标准 cargo 仍负责 Linux CDS。将该脚本以 `cargo` 为名复制至本轮专用工具目录并把该目录放在 PATH 首位，可复现本机工具链选择。

```bash
git -C /home/jenn/AGENTS_OS_Workspace/projects/vcp-integrated worktree add --detach \
  /tmp/nativesync-three-client-7829b83 7829b83ccb63
cd /tmp/nativesync-three-client-7829b83
export PATH="$HOME/.nvm/versions/node/v24.22.1/bin:$PATH"
npm_config_offline=true npm run deps
CARGO_NET_OFFLINE=true npm run build

evidence=/home/jenn/AGENTS_OS_Workspace/projects/vcp-integrated/docs/evidence/three-client-candidate/build-linux
export XVFB_BIN=/home/jenn/AGENTS_OS_Workspace/projects/vcp-integrated/.runs/toolchain/bin/Xvfb
node --require "$evidence/empty-watcher-preload.cjs" tests/integration/run.cjs local-only
node --require "$evidence/empty-watcher-preload.cjs" tests/hardware/coordinator.cjs
```

宿主 inotify 达到上限时，原版 fixture 在启动空知识库原生 watcher 后退出。附带的 `empty-watcher-preload.cjs` 只为合成 ToolBox 子进程引入仓库已有的空 fixture watcher 容错和 Chokidar 轮询，无需改变系统限制或产品源码。正常条件下可移除 `--require`，进程会使用原生 watcher。

协调器启动后读取其 `ready.json`。用 `"$XVFB_BIN" -displayfd 1 -screen 0 1600x1100x24 -nolisten tcp` 启动独立显示，并将下方的 `:2` 替换成实际显示号，Android 用已授权 ADB reverse 转发回环端口，Windows 用其隔离来宾的回环转发。仅把公有测试 CA、叶证书和本轮合成 Windows seed 交给观察端。

```bash
run='.runs/hardware/run-<id>' # 替换为 ready.json 所在的本轮目录
DISPLAY=:2 node "$evidence/linux-source-receipt.cjs" "$run"
```

Linux 输入 `sources` 捕获已加载模块。协调器输入 `arm-pair` 后手机完成只读配对。Linux 输入 `send` 一次，观测 running 后输入 `mark`。协调器输入 `release`，完成后 Linux 输入 `record` 和 `capture`。复制需要的合成证据，先结束 Linux，再在观察端终结后停止协调器。完整交互及信任配置见 `tests/hardware/README.md`。

验证 worktree 保留于 `/tmp/nativesync-three-client-7829b83` 供本批复查源码与构建版本。两台观察设备完成后已正常关闭 Linux Electron、CDS 和 ToolBox，停止协调器和回环监听，回收本次合成数据库、证书与测试 Profile。测试控制 FIFO 使其 Node 驱动在所控应用退出后仍保持空闲，已结束驱动进程。独立 Linux 本机发送运行目录为 `/tmp/vcp-integration-G6eVlL`，有效摘要和合成终态截图已摘录至本目录。
