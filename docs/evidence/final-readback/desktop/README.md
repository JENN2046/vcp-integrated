# 工具 Work 终稿的桌面回读

真实 VCPChat Electron 44.9.3、原生 Chat Data Service、ToolBox 和 SQLite 在隔离 Xvfb 下运行，Chromium 沙箱开启。隔离 profile 使用合成 A/B 设备和回环 Provider。A 建立原 Work，执行一次落盘计数工具，随后压缩前文。代理切断接管确认，B 用原 profile 重开，从同一个 Work 读取接管结果并执行第 1 代。

| 场景 | 实测结果 | 桌面截图 |
| --- | --- | --- |
| 新 ToolBox，正常 JSON | 原生响应完整送达 B。B 以原 Work、代和回复 ID 读取已提交回执，未发完成写请求。 | [JSON](json.webp) |
| 新 ToolBox，正常 SSE | 真实 renderer 收到 `stop`，线上包含 `[DONE]`。B 读取同一 Journal 序号，未发完成写请求。 | [SSE](sse.webp) |
| 新 ToolBox，B 退出后才产生终态 | B 退出前没有收到原生 SSE 响应头。ToolBox 后续取得完整终态，B 重开后回读；强停重启 ToolBox 后再次重开，最终回复仍恰好一条。 | [B 重开](terminal-lost.webp) · [ToolBox 重启后](terminal-lost-toolbox-restarted.webp) |
| 新 ToolBox，JSON 迟到前删除回复 | 代理暂存原始 JSON，A 通过真实共享消息接口删除已发布回复。B 收到旧正文后，History IPC 返回删除态，同一窗口和物理 History 都没有该回复。 | [JSON 删除](late-json-delete.webp) |
| 新 ToolBox，SSE 迟到前编辑回复 | 代理暂存原始 SSE，A 通过真实共享消息接口编辑已发布回复。B 收到旧正文后，History IPC 返回编辑态，同一窗口和物理 History 各保留一条编辑版本。 | [SSE 编辑](late-sse-edit.webp) |
| 新 ToolBox，回读响应断包 | 代理切断第一次已提交的 `GET final-reply` 的 HTTP 200 响应正文，B 的后续 GET 取得同一 Work 和 Journal 序号。 | [回读恢复](query-lost.webp) |
| 旧 ToolBox，正常 JSON | 新桌面与 `aa19a63` 组合，B 走原 `POST steer-turn-complete` 完成路径。 | [旧 ToolBox](legacy.webp) |
| 旧 ToolBox，完成写确认断包 | 旧路径的 HTTP 200 确认断包，B 重开后仍恢复同一条回复。 | [旧确认丢失](legacy-ack-lost.webp) |
| 新 ToolBox，B 退出且 Provider 未给终态 | 原 Work 保持待核对，继续按钮禁用，Journal、物理 History 和聊天均没有最终回复。 | [待核对](unknown.webp) |

每个完成场景都核对 B 的唯一原生回复 ID。未编辑的回复在 Journal、物理 `history.json` 和实际聊天气泡各一条。两项迟到负例核对原发布与后续人工变更的 Journal 序号，并在实际 History IPC 返回后监测旧正文是否重新成为正式气泡。三个 Provider 调用分别属于 A 初始、摘要和 B 接续，工具副作用计数为一。终态丢失的截图只计入正式气泡，实时预览独立核对。B 本地执行账本的第 1 代在新版正常收包后只保存正文的 `observedFinalHash`，没有 `replyIntent`。响应未交付的重开场景没有观察哈希和回复意图。旧 ToolBox 的兼容路径保留 `replyIntent`。[机器回执与实际加载文件 SHA256](desktop-results.json)

## 复跑

在构建好移动端资源和原生依赖的集成仓，使用 Node 24、Xvfb 和启用沙箱的 Electron。旧版对照固定为 `aa19a63` 的 ToolBox，桌面使用当前工作树。

```bash
node tests/integration/run.cjs tool-final-readback-json
node tests/integration/run.cjs tool-final-readback-stream
VCP_TEST_FINAL_STREAM=1 node tests/integration/run.cjs tool-final-readback-terminal-lost
node tests/integration/run.cjs tool-final-readback-query-lost
node tests/integration/run.cjs tool-final-readback-json-delete
node tests/integration/run.cjs tool-final-readback-stream-edit
node tests/integration/run.cjs tool-final-readback-legacy
node tests/integration/run.cjs tool-final-publication-ack
node tests/integration/run.cjs tool-final-receipt-unknown
```

本次宿主的 jenn UID 的 inotify 配额耗尽。隔离运行使用独立测试 UID 和私有临时挂载，并为 Electron 提供临时 SUID helper。宿主配额未改动。临时挂载随进程退出解挂。
