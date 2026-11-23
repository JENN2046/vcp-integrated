# 共享附件文件 URI 往返

固定源码 `0d72d8ef424999fb68525defeaac8f04e27c573b`。在 Linux x64 隔离环境启动真实 Electron A、CDS、ToolBox 与本地合成 Provider。三轮从独立空共享话题、桌面配置和 ToolBox 冷缓存开始。A 从桌面选择器附加同一份 67 字节 UTF-8 合成文件，然后点击发送。各轮运行摘要见 [receipt.json](receipt.json)。

| 场景 | Provider 行为 | 验收 |
| --- | --- | --- |
| 文件 URI | 从 A 实际消息的附件标题取出完整 URI，调用一次摘要工具 | ToolBox 无法直接打开 A 的 URI。原生 FileFetcher 从 `internal_request_file` 的 WebSocket 回包获取 67 字节，写入 `.file_cache` 后交给摘要工具。Provider 从原生回填读取到实际摘要 |
| 内联正文 | 从实际消息的附件块提取正文并计算 SHA-256 | 标题采用文件名，四层抓包均无文件 URI。合成 Provider 从正文复算同一摘要。工具调用、文件请求及缓存写入均为零 |
| 文件名参数 | 工具仍可用，Provider 取同一附件块结束标记中的显示文件名，调用同一摘要工具 | 工具在其隔离目录对原样裸名执行真实 `fs.readFile`，得到 `ENOENT`。Provider 收到错误结果，文件请求及缓存写入均为零 |

每轮检查桌面共享归属、原生 History、中央 admission 与请求终态。工具模式还检查发送到 A 的 URI 摘要、A 原生返回的数据摘要、工具实际读取的数据摘要与 Provider 回填摘要。文件名对照的工具把真实读取错误作为数据回填，已知结果因此可沿原生循环完成。

ToolBox 进程通过 `bubblewrap` 单独挂载空的 A 附件缓存目录。隔离从启动时生效，A 选择文件后其自身挂载命名空间能读到文件，实际 ToolBox 进程中的 `fs.access` 和 `fs.readFile` 对同一 URI 都得到 `ENOENT`。两个连接的目的地址是 loopback。HTTPS 代理到 ToolBox 和 A 到原生 WebSocket 的 TCP 连接绑定同一个真实本地 IPv4，ToolBox HTTP 观测到该源地址，WebSocket 使用 A 自己上报的地址。回执对具体地址和临时目录做了脱敏。

使用不含真实插件配置的干净开发检出。桌面原生插件启动和 UI 可在该检出下留下 Git 忽略的诊断报告与用量统计。需要 Node 24、`bwrap`、Xvfb、仓库现有桌面和服务构建依赖。使用宿主默认 `Xvfb`，或设置 `XVFB_BIN`。

```bash
NS_FIXTURE_POLL_WATCHERS=1 node tests/file-uri-roundtrip/run.cjs tool
NS_FIXTURE_POLL_WATCHERS=1 node tests/file-uri-roundtrip/run.cjs inline
NS_FIXTURE_POLL_WATCHERS=1 node tests/file-uri-roundtrip/run.cjs filename
```

覆盖合成文本、Linux 路径、共享单聊桌面 A 和单个固定工具。实际 LAN/WAN 路由、其他格式、多候选节点和已部署环境未纳入此次测试。

[工具调用账本与回填](tool-receipts.json)把 Work、原生模型请求、工具 invocation、工具记录 ID、A 的取件 RPC ID 和 Provider 实收的工具回填对齐。FileFetcher 识别工具参数中的 `file://`，由此次请求的真实来源 IP 找到已注册的 A，将同一 URI 传给 A；A 的原生处理器用它定位缓存文件。A 返回字节后，摘要工具读取 ToolBox 自己的缓存路径。读内联正文无需原 URI。裸文件名控制的回执中，returned 表示工具返回了明确的读取错误，文件字节数并未被当作成功结果。

复跑请使用独立开发检出和合成 Profile。启动桌面分布式节点时，宿主插件可能产生 Git 忽略的运行统计或诊断报告；本次按 Electron PID 将本轮 PTY 插件报告移至临时运行目录，保留现有统计文件。三个场景的 Electron、ToolBox 均已退出。
