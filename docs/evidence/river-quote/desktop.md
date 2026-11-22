# River Quote 桌面送达与冷重开

Linux 上以真实 Electron 44.9.3 沙箱进程和 Xvfb 完成。三份主验收重放各版本 ToolBox 使用同一组短消息执行 `semantic:3` 时的原样派发参数，包括原来的发送者、目标话题和来源话题 ID。桌面测试从原生 TopicSponsor 服务的 `processToolCall` 接入，调用宿主创建的 Agent 操作服务、投递队列和 History。ToolBox 模型与真实分布式网络接入不在本桌面脚本内，工具侧证据见 [tool-trace.md](tool-trace.md)。

| 桌面 | 当前引文 | 发送后与冷重开 | 回执 | 截图 |
| --- | --- | --- | --- | --- |
| 作者 `8a937038` | V2，青岚、用户、白露 | 三条，历史文件字节一致 | [JSON](author-desktop.json) | [送达](author-desktop-live.png) · [重开](author-desktop-reopened.png) |
| 集成基线 `e6fdf5b` | V1，两行都是助手 | 两条，短无名行未出现在 semantic 派发中，历史文件字节一致 | [JSON](baseline-desktop.json) | [送达](baseline-desktop-live.png) · [重开](baseline-desktop-reopened.png) |
| 集成候选（本批工作树） | V1 带可选署名，青岚、用户、白露 | 三条，历史文件字节一致 | [JSON](candidate-desktop.json) | [送达](candidate-desktop-live.png) · [重开](candidate-desktop-reopened.png) |

源消息依次为 `river-source-0`（青岚）、`river-source-1`（无名，正文“收到。”）、`river-source-2`（白露）。青岚和白露的正文完全相同。基线改用同一批输入真实派发的 `last:3` 后，无名行正常显示为用户，两位具名助手仍显示为“助手”。这次对照隔离了 semantic 短消息筛选和桌面署名丢失。 [基线 last:3 JSON](baseline-last-desktop.json)

每次重开都点开预先写入的旧 V1 引文并核对角色回退和正文。候选另外退出后在隔离 History 中加入作者实际送达的 V2 字节，仅给导入消息分配独立 ID。第三次启动显示两位署名以及无名用户，退出后 History 字节一致。 [候选冷开作者 V2 截图](candidate-desktop-author-v2.png)

## 复跑

准备带该版本桌面构建资产的源码目录和 Linux Electron 依赖。集成桌面需要正常构建生成的规则、preload、contracts 和现有 History authority 构建资产。实测作者源码从固定提交归档展开，共用本地锁定安装的 Electron 和 Node 依赖。作者文件监听在本机报告一次系统限额，页面仍在首次进程内显示送达并通过冷重开检查。

```sh
out=docs/evidence/river-quote
trace="$out/tool-trace.json"
node tests/river-quote/desktop-run.cjs author "$AUTHOR_DESKTOP" "$out" "$trace"
node tests/river-quote/desktop-run.cjs baseline "$BASELINE_DESKTOP" "$out" "$trace"
node tests/river-quote/desktop-run.cjs candidate apps/desktop "$out" "$trace" \
  candidateShortSemantic "$out/author-desktop.json"
node tests/river-quote/desktop-run.cjs baseline "$BASELINE_DESKTOP" "$TMP_OUTPUT" \
  "$trace" integratedShortLast
```

如工具未在 PATH 上，可指定 `XVFB_BIN` 和 `ELECTRON_BIN`。脚本为每次运行创建独立 HOME、应用数据和显示环境，所有 Electron/Xvfb 子进程结束后回收临时配置。作者及基线源码快照分别位于 `/tmp/river-quote-author-QA` 和 `/tmp/river-quote-baseline-QA`，当前保留供本批复核。需重跑时可重新从固定提交和已构建依赖组装。

## 同一次工具执行贯通到冷重开

另跑了三组真实 ToolExecutor 与 PluginManager 的 `semantic:3`，分别连接同版本隔离 Electron。测试传输把 `executeDistributedTool` 的实参经父子进程桥送入真实桌面 TopicSponsor 服务，再将其原生回执返回工具执行器。每组核对工具结果 raw 和 text 的 `message_id`、桌面送达回执、磁盘 History 以及冷重开后的 DOM `data-message-id` 完全一致。传输使用测试桥，WebSocket 本身不在本验证范围。独立工具证据和上表直接桌面重放仍可单独复跑。

- [作者单链 JSON](author-chain-desktop.json)
- [基线单链 JSON](baseline-chain-desktop.json)
- [候选单链 JSON](candidate-chain-desktop.json)

用上方同一命令，并设置对应版本的 `RIVER_TOOLBOX_ROOT` 和依赖路径。候选单链命令不带独立 V2 导入参数。

```sh
NODE_PATH="$SERVER_DEPS:$DESKTOP_DEPS" RIVER_TOOLBOX_ROOT="$CANDIDATE_TOOLBOX" \
  node tests/river-quote/desktop-run.cjs candidate apps/desktop "$out" "$trace"
```
