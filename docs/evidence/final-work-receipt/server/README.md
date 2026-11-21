# ToolBox 末代回执基线核验

基线 `2a36b5075432`，Node.js 24.22.1。运行真实 ToolBox 仓内程序、NativeSync、SQLite、Journal 和文件型原生检查点。输入、模型和工具为隔离测试夹具。B 由 HTTP 测试客户端代表，客户端读取终稿后不发送 `steer-turn-complete`。Electron 退出进程的验收由桌面场景覆盖。

| 观察点 | 已核实结果 |
|---|---|
| A 的工具停点 | A 的工具调用登记为 `returned`，工具标记仅一次。压缩并接管后，原 Work 只有第 0 代 A 和第 1 代 B。 |
| B 的 HTTP 完整返回后 | 原生请求为 `model_terminal`，准入行的 `native_terminal=1`。Work 为 `dispatched`，第 1 代仍为 `running`，`reply_seq=null`。原生归档内没有 `completion`，Journal 没有 B 的终稿行。 |
| ToolBox SIGKILL 后重启 | 原 Work 转 `review_required`，原生请求仍为 `model_terminal`。相同身份、相同请求体与代号的重放收到 409 `SHARED_REQUEST_ALREADY_DISPATCHED`。本轮服务脚本连同独立多工具拒绝检查合计 3 次模型请求，工具调用标记 1 次。两项计数、Journal 和工具回执均未因重启或重放改变。 |

`final-model-without-desktop-settlement.json` 记录实际 Work、代、请求、Journal、调用数和加载模块哈希。既有 `tests/tool-work-recovery/run.cjs` 的首代工具结果未知和 `--known-receipt` 两个对照均通过。对应 JSON 记录未知结果继续待核对及已证实工具回执跨重启可压缩的行为。

## 生产路径核对

- ToolBox 的 `requestExecutionContext.js` 导出 `checkpointCompletion`，当前没有调用方。`nativeContinuationStore.cjs` 有持久化方法 `completion`，当前没有生产路径写入或核验其中的终稿。
- `requestExecutionContext.js` 的 HTTP 回包完成和原生 handler outcome 共同决定是否调用 `finish(true)`。客户端连接提前关闭时走 transport failure，已派发且缺少证据的请求归入待核对。
- `sharedNative.js` 的 `finish(true)` 和 `checkTerminal` 只写原生执行终态标记。`sharedSteering.js` 的 `completeTurn` 才用原请求身份写 `work-reply:<workId>:<generation>`、绑定 Journal seq 和完成准入。
- `sharedSpace.js` 启动只保留已确认的首代暂停或尚未派发的接续，以及独立的移动发布恢复。已经派发的 B 代没有可重放的终稿意图。

## 最小修复落点

让 ToolBox 非流和 SSE handler 在原生输出定稿处持久化经验证的 final receipt，绑定 Work、代、请求、执行者、正文和终止原因。服务端在正常流程和启动恢复时读取并验证该记录，复用既有同一 reply ID 和 `work-reply` Journal 操作，保证与 B 的补交兼容。原生 handler 没有到达定稿点、证据缺失或不一致时沿用待核对。保留现有派发围栏和工具账本。

## 复现

在仓库根目录，Node.js 使用 24.x，已有服务端 Vexus addon 和 mobile-dist。

```bash
evidence="$PWD/docs/evidence/final-work-receipt/server"
patch -d tests/tool-work-handoff -o .final-server-observe.cjs protocol.cjs < "$evidence/reproduce-final-model.patch"
TMPDIR=/var/tmp VCP_PROTOCOL_EVIDENCE="$evidence/final-model-without-desktop-settlement.json" node tests/tool-work-handoff/.final-server-observe.cjs
rm tests/tool-work-handoff/.final-server-observe.cjs
TMPDIR=/var/tmp node tests/tool-work-recovery/run.cjs
TMPDIR=/var/tmp node tests/tool-work-recovery/run.cjs --known-receipt
```
