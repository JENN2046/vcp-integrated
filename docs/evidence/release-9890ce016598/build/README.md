# Linux、ToolBox、PWA 重建

本轮使用全新 detached worktree，固定提交 `9890ce016598b0814d7ee09fce07766a45356352`、Git tree `49585a495379447f927269922bc84e4a44d748e4`。各应用分别从 npm lockfile 安装，CDS 与 Vexus 通过 Cargo lockfile 源码编译。Linux x86_64 使用 Node 24.22.1、npm 11.19.1、CDS Rust 1.96.1 与 Vexus Rust 1.89.0。依赖安装与构建复用本机公共下载缓存，候选 worktree 使用独立安装和输出目录。

```sh
git -C /home/jenn/AGENTS_OS_Workspace/projects/vcp-integrated worktree add --detach \
  /path/to/fresh-checkout 9890ce016598b0814d7ee09fce07766a45356352
cd /path/to/fresh-checkout
export PATH="/home/jenn/.nvm/versions/node/v24.22.1/bin:$PATH"
git status --porcelain
npm_config_offline=true npm run deps
CARGO_NET_OFFLINE=true npm run build
git status --porcelain
```

离线标志对应已有下载缓存的主机。首次在新主机安装时删除两个离线标志。使用 rustup 提供 `cargo +1.89.0`。实际依赖脚本、构建与启动的范围见仓库根 README 及 `tests/hardware/README.md`。

`hash-build.sh` 记录锁文件、生成产物与运行时组件摘要。 `verify-loaded-native.py` 从 Electron、CDS 的 `/proc/<pid>/exe` 及后端进程的 `/proc/<pid>/maps` 取实际加载内容，并逐个与构建产物比对。`verify-served.sh` 通过本轮公有测试 CA 验证 HTTPS，检查实际服务的全部 PWA 文件与构建输出 SHA256 相同。

初次启动原版硬件夹具时，隔离 ToolBox 进程退出 1。同一宿主上的 inotify 配额已用尽。复用硬件验收已有的空知识库 watcher 容错，并为夹具子进程的 Chokidar 启用轮询后，原候选成功启动。变动范围限于本轮合成 ToolBox 夹具的空知识库监听。当前显示使用仓库验收工具目录现有 Xvfb，Linux 运行真实 Electron 和独立 Profile。

```sh
evidence=/home/jenn/AGENTS_OS_Workspace/projects/vcp-integrated/docs/evidence/release-9890ce016598
candidate=/path/to/fresh-checkout
export NS_RELEASE_EMPTY_WATCHER=1 # 仅用于宿主 inotify 配额已用尽时
"$evidence/build/start-central.sh" "$candidate"
```

另开终端，在可用 X11 显示上执行 `"$evidence/linux/start-desktop.sh" "$candidate" "$run" initial`。其中 `run` 是中央 ready JSON 所在的绝对目录，目录中公开测试 CA 仅用于这次回环监听。两脚本将交互输入接到 `$candidate/.runs/{central,linux-initial}.fifo`。Linux 通过既有硬件夹具的真实发送按钮点击一次。收据补充夹具位于本轮证据目录。

Electron 主进程 require 缓存报告 3 个实际加载 JS 模块，Chromium 调试接口读到 3 个实际解析并加载的渲染脚本，摘要与固定检出一致。ToolBox 正常退出时，夹具记录 33 个已加载的 JS 模块，全部与固定检出相符。[桌面加载的 JS](./linux-loaded-js.json) · [ToolBox 加载的 JS](./backend-loaded-js.json) · [首开运行时映射的原生组件](./loaded-binaries.json) · [重开后映射](./reopened-loaded-binaries.json) · [PWA HTTPS 载荷](./served-pwa-sha256.txt)

保留干净构建树供复查。`central/cleanup.txt` 记录运行期进程及合成夹具的回收结果。
