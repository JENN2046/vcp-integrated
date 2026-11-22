# 已追平双桌面空闲基准

使用本仓库已有的 `tests/integration/run.cjs idle` 入口。运行需要 Linux x64、Node 24、Electron、Xvfb 和已构建的集成依赖，与普通 integration 夹具相同。应用、数据库、证书和身份都由夹具在临时目录创建。真实 VCPChat、ToolBox、SQLite 和 CDS 通过回环地址运行，Provider 使用合成端点。

## 命令

```bash
# 小夹具，3 份空 History 和 0 条 Journal
NS_IDLE_N=10 node tests/integration/run.cjs idle
NS_IDLE_N=31 node tests/integration/run.cjs idle

# 123 份 History，1,564 条 Journal，同一消息在每个话题连续编辑
NS_IDLE_N=31 NS_IDLE_SCALE=large node tests/integration/run.cjs idle

# 同规模，最后一个消息版本引用 CAS 中尚不存在的文件
NS_IDLE_N=31 NS_IDLE_SCALE=large NS_IDLE_MISSING=yes node tests/integration/run.cjs idle

# 同规模，测 /proc CPU 与 I/O，无 JS 归因插桩
NS_IDLE_N=31 NS_IDLE_SCALE=large NS_IDLE_METER=off node tests/integration/run.cjs idle

# 同规模底噪，先追平并正常退出，再关闭连接文件的 enabled 后重启
NS_IDLE_N=31 NS_IDLE_SCALE=large NS_IDLE_METER=off NS_IDLE_BACKGROUND=off node tests/integration/run.cjs idle

# B 打开已追平话题并保持观察，分开计量空间流与话题流
NS_IDLE_N=2 NS_IDLE_OBSERVE_TOPIC=yes node tests/integration/run.cjs idle

# 附件恢复功能场景，真实 404、上传、重试和 History 本地化
NS_IDLE_SCENARIOS=attachment NS_IDLE_METER=off node tests/integration/run.cjs idle
```

省略 `NS_IDLE_N` 时测三个一分钟窗口。测量更换源码前后使用同一构建产物与同规格合成数据。两个客户端均保持 CDS 运行，关闭组只关闭合成 profile 的 NativeSync 连接。准备时等待双方 runtime ready 和中央 Journal、目录版本追平。进程预热 15 秒后每 60 秒采样。采样前后校验同一组 History 文件数量、内容摘要、游标、目录版本和待处理队列。大夹具固定每个话题一个活跃消息，正文体量以实际合成数据为准。

`evidence.json` 按分钟记录两个 Electron 主进程与 ToolBox 的 `/proc` CPU tick 和 I/O。Renderer、CDS、Xvfb、TLS 夹具代理与合成 Provider 单独运行，不进入这三个 PID 的 CPU 数字。底噪比较使用关闭 JS 插桩的运行组，报告有符号差值。CPU 百分比按一颗逻辑核换算。

归因计量在独立运行中进行。异步标签每次只记录当前最内层归因，SQLite 同步查询所在的服务端线程与 SSE 保活回调均计入对应 HTTP 路由。由标签捕获的线程 CPU 不包含其他线程或未贴标工作。History、同步状态及其他文件统计是被归因的逻辑 I/O。`/proc` I/O 是进程总量。HTTP 统计请求、状态和逻辑响应体字节。SSE 长连接可以在预热阶段打开，采样时照常记录存续连接发送的数据帧和心跳注释。秒级握手及 HTTP/TLS 帧开销不属于 SSE 逻辑字节。

所有窗口按真实墙钟运行。31 分钟组同时提供完整区间和前 10 分钟切片，可用每分钟的 `SharedRuntime.tickCore`、HTTP 路由和文件计数定位两次低频审计。空闲判定排除启动预热。审计或附件重试所在窗口保留在完整区间的数据中。文件计数单列 History 内容读取与 `readSnapshot` 调用。漂移审计可通过 mapped queue 读取内容，这类 I/O 会进入 History 文件读计数。实际加载的核心 CJS 模块 SHA-256 与候选目录中的源码逐项核对。

同一 Linux 用户的 inotify 实例配额耗尽时，测量使用独立测试 UID、私有 mount namespace 和写时复制上层，保留 ToolBox 的真实 Rust watcher。输入只取版本化源码以及必要的共享只读二进制和依赖，Cookie、认证配置及真实用户资料不进入夹具。

## 本轮结果

12 组各完成 31 个一分钟窗口。每组采样前后 History、游标、目录版本及待处理队列一致，两个桌面和 ToolBox 正常退出，Provider 调用为 0。健康小、大夹具的前 10 分钟没有新的同步 HTTP 请求和归因的 History 读取，分别收到 1,040 B SSE 心跳。完整 31 分钟内两组均在第 15、30 分钟运行审计，每次各有 8 个请求。小夹具每端每次读 3 个空 History（6 B），大健康夹具每端每次读 123 个 History（92,755 B）。

| 31 分钟组 | 普通同步请求，基线 → 候选 | 响应体字节，基线 → 候选 | 候选归因 CPU，A / B / ToolBox |
| --- | --- | --- | --- |
| 小健康 | 1,046 → 16 | 356,400 → 5,664 | 0.00469% / 0.00467% / 0.01086% |
| 大健康 | 1,044 → 16 | 355,972 → 5,683 | 0.02785% / 0.02257% / 0.01099% |
| 大缺件 | 1,059 → 30 | 357,050 → 6,312 | 0.03006% / 0.03030% / 0.01366% |

大缺件候选的 30 个请求含 14 次真实 404，与基线缺件重试次数相同。健康小组无插桩 `/proc` CPU 减相同规模的关闭组为 +0.0511 / +0.0522 / +0.0247 个百分点。大组为 +0.1087 / +0.1215 / +0.1189 个百分点。三者以各自进程的单核占用计算，保留并发测试与宿主调度的底噪。归因 CPU 和独立进程差值是两种口径。

单独打开一个已追平的空闲话题后，B 的话题 SSE 在两个整分钟发送 8 个心跳（104 B），对应 ToolBox 线程归因 7.191 ms，包含发送路径的实时授权检查。同期两条空间 SSE 共 16 个心跳（208 B）。打开话题建立连接后，采样窗口里的普通同步新请求、业务 SSE 数据帧和 History 实读均为 0。正向缺件场景中，两端各在一次 404 后成功重试，校验同一份 47 B 附件并写入各自本地 History。上传完成至两端恢复约 52 秒，中央 Journal 仍为一条。

可写副本基准冻结在部署候选的可写热路径。冻结后另行修改的只读 registry 写入和共享配置 IPC 交付授权有专项测试。五个候选长窗中的两个桌面均未发出共享配置请求 IPC。机器回执记录实际加载 SHA、冻结后源码差异、逐组状态和 372 个完整分钟。[结果汇总](idle-receipt.json) · [逐分钟记录](idle-windows.jsonl)
