# RC-01 · 本机发行候选

施工基线为 `03039ad`，产物源码提交为 `ead84e2`。补充验收仅更新证据和测试脚本，沿用原安装包。本批升级修复、隔离构建、样本迁移和实机入口核对均使用独立目录。此候选保留 [M4 原生能力及旧职责核对](../core-m4/README.md)。

## 运行与安装

- Linux 使用完整 ToolBox 后台、真实 Electron、独立 CDS 与原生 PWA 配对页。桌面发出 Core 消息并收到受理回执，两个桌面正常退出后 Core 继续完成。完整后台重新启动后，另一个桌面冷启动读回同一组消息 ID 和正文。合成 Provider 共调用一次，旧 Journal、admission 和移动执行台账为零写入。 [机器回执](linux-core.json) · [冷启动画面](linux-core-cold-readback.png)
- Linux x64 AppImage 从干净源码副本和全新安装的锁定依赖打包。校验 140 项运行文件后，从发行文件实际启动 Electron，达到渲染器 ready，并以退出码 0 退出。启动采用 AppImage 的提取运行模式。 [回执](linux-appimage.json)
- Windows x64 从锁定依赖和已核对的 Electron 44.9.3 发行二进制构建。CDS 采用 Rust release 交叉构建并带匹配的 authority sidecar。未签名 NSIS 完成干净 Windows 11 x64（22631）断网虚拟机的普通用户安装，退出码 0。已安装客户端渲染器达到 ready，从安装目录运行的 CDS 哈希与交付二进制一致，安装器 SHA-256 与交付文件一致。 [机器回执](windows-install.json) · [已安装桌面](windows-installed-desktop.png) · [验收脚本](../../../tests/hardware/verify-core-rc01-install.ps1)
- 原生回归 355 通过、6 跳过，协作回归 61 通过。当前无 macOS 原生验收环境。

## 修复与旧职责退出

- Rust 原生知识目录监听在 Linux inotify 耗尽时改用 notify 自带轮询，复用同一事件与对账管线。实际 GUI 联验在原宿主限额下通过，也验证了未设置测试轮询覆盖的启动。
- 已接管话题从旧桌面副本的活跃订阅退出，保存原有确认回执和游标。发现挂起的收发、投影或本地提交时，保留原状态并拒绝退役。现有旧执行代码仍服务未迁移会话。
- 本机 Core 可将 ToolBox 和 VCPChat 置于同一台设备，通过回环和现有 workspace 认证协作。独立配置使用 `VCP_LOCAL_LISTEN_HOST=127.0.0.1`、`VCP_CORE_DATA_DIR`、`VCP_CORE_WORKSPACE` 及现有 Source 与 workspace 的授权。Core 目录须与旧中央数据目录分开。普通未接入 workspace 的桌面配置仍使用原生本地入口。隔离复现入口为 `node tests/integration/run.cjs core-rc`，须先构建原生组件与 PWA。
- 常规群聊、JEV 动态编排、斗地主、历史查询、DeepMemo、TopicMemo、实时资源及既有单聊 AA、Flowlock 和压缩沿用 M4 基线。群聊 Flowlock、群聊压缩与群聊 steering 仍有限制。VTrade 及其他独立游戏大厅保留原所有者。Resident、生产可信客户端及 WebTransport 独立跟踪。

## 迁移和外部 JEV

- 在明确授权后，用只读方式在日用桌面抽取一个话题中五条消息的顺序和原始格式，确认附件关联可在本机解析。用中性 PNG 替换原件正文与文件名，从真实本地 CDS 选取一条删除事实并保留其独立话题归属。中央编辑使用合成重叠行验证。首次导入、重复导入、重开和替换附件的字节哈希核对均通过。真实中央数据库和真实附件字节保留在源端。旧格式兼容另外由合成回归覆盖。 [脱敏回执](redacted-history.json)
- 首轮 Typesafe 外部请求返回 HTTP 401。更新隔离配置后的首次 Core 复验收到有效仲裁，JEV 按继续阈值收敛。用明确点名并要求回答的合成输入复跑后，Typesafe 仲裁选中指定成员。Core 向隔离模型端点派发一次，成员 Work 完成，配对客户端从正式历史读回同一条回复。继续概率为 0.48，高于原生默认阈值 0.45。本轮测试限定一次外部仲裁。 [首轮回执](external-jev.json) · [成功回执](external-jev-recheck.json)

## 复建

1. 用仓库锁文件和 Node 24，在一份干净源码树中执行 `npm run deps` 和 `npm run build`。ToolBox 原生构建目标为 Linux x64。桌面打包的源码应与同一提交一致。
2. Linux 桌面使用 electron-builder 的 AppImage 目标。Windows x64 使用对应平台锁依赖、同版本 Electron 和 `cargo build --release --locked --target x86_64-pc-windows-gnu` 构建的 CDS，生成与二进制匹配的 authority sidecar。Windows NSIS 在 Linux 可使用锁定的 electron-builder 自带 uninstaller reader，随构建命令通过 `node --require /绝对路径/scripts/rc-nsis-reader.cjs` 加载。该路径验证的是 unsigned 本地候选。
3. 检索与 JEV 的隔离启动选项见 [M4 配置](../core-m4/README.md)。日用数据迁移之前需从授权副本检查可表示性。跨话题重复 ID、无法定位的附件、非文本内联部件仍会明确拒绝。

机器回执和 SHA-256 清单随本地候选产物交付。测试配置、日用历史源数据、隔离后的私有执行目录和虚拟机基盘不进入发行档案。
