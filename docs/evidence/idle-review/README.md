# 两个已追平桌面的空闲复测

复用 `node tests/integration/run.cjs idle`。Linux x64 上运行两个合成 Profile 的 VCPChat Electron 44.9.3、两个 CDS 与一个 ToolBox/SQLite。Electron 使用 Chromium 沙箱和独立 Xvfb。服务端和合成 Provider 在回环地址监听。两组均核对了中央与两端的目录版本（7）及消息游标（0）。两端各有 3 个共享话题，inbox、outbox 和待处理状态均为空。

15 秒预热后采集三个连续 60 秒窗口。CPU 取两个 Electron 主进程和 ToolBox Node 进程的 CPU tick 增量。文件字节是夹具拦截并归因的逻辑数据量，进程 I/O 单独记录。HTTP 在 ToolBox 入口按路径计数，字节为响应体。Renderer、CDS、回环代理、合成 Provider 和 Xvfb 均在进程统计范围外。

本机日用 UID 的 inotify 配额用尽。两组均使用另一个测试 UID、私有 mount namespace 和临时写时 overlay，以便桌面创建 `.vcp_ready`，并保留 ToolBox 的真实 Rust 知识库 watcher。两组使用相同的 Node 24、Xvfb 和 Electron 二进制。

两组均正常退出，无模型调用。两端的配置读取在各自三个窗口内稳定一致。

| 每个桌面每 60 秒 | 基线次数 / 字节 | 候选次数 / 字节 |
|---|---:|---:|
| `SharedRuntime.discover` 读取 `config.json` | 36 / 16,896 | 36 / 16,896 |
| `SharedRuntime.readLocal` 读取 `config.json` | 72 / 33,792 | 36 / 16,896 |
| 两桌面合计 | 216 / 101,376 | 144 / 67,584 |

两端总配置读取次数和逻辑字节均下降 33.3%。
每窗 HTTP 合计 34 次、11,616 B（`shared/info` 24、`shared/wait` 4、`shared/matches` 2、`shared/changes` 2、`shared/pull` 2），三组进程的回填状态写入均为 0。
CPU 按实际窗口列出，单位为毫秒。

| 进程 | 基线三窗 | 候选三窗 |
|---|---|---|
| 桌面 A | 590 / 430 / 390 | 580 / 460 / 430 |
| 桌面 B | 630 / 460 / 410 | 590 / 480 / 400 |
| ToolBox | 720 / 730 / 650 | 700 / 690 / 650 |

基线使用 `32e4074b8dee` 的产品源码。候选基于 `973bcff9c614`，两处加载文件的 SHA-256 见回执。
[基线三窗](before.json) · [候选三窗](after.json)

## 配置变化和离线恢复

桌面只复用本轮目录扫描读到的原生话题配置。观察值与已物化版本一致时跳过第二次读取；不同或本轮没有观察值时，继续使用原读盘与草稿流程。回归用例在目录扫描和草稿检查之间再次修改名称及归档状态，核对草稿采用最后一次写入。原生配置与操作相关测试共 29 项通过。

在独立 Electron 用例中，B 关闭前持久游标为 2。A 发出第二轮并完成时 B 的磁盘仍为 2；B 用原 Profile 冷开，在操作界面前追平到 4，在线收到第三轮后到 6。六条 History ID 与 Journal 顺序一致，三个 Work 各一次尝试，三次提交、三次合成 Provider 调用。回执中 pending 字段是对 pending === null 的布尔检查。[离线冷开与在线投递回执](offline-reopen.json)
