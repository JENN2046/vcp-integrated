# ToolBox 终稿跨进程恢复

在 Node.js 24.22.1 下运行仓内 ToolBox、NativeSync、原生文件检查点和 SQLite Journal。服务、A/B 身份、回环模型和计数工具均为隔离夹具。B 通过真实 HTTP 接口完成接管和原生请求准入。桌面进程退出和 History 投影的验证另有桌面场景。

正例中，测试专用预加载代码等待 ToolBox 自己将第 1 代 `completion` 文件原子替换并完成目录 fsync，然后给当前 ToolBox 进程发送 `SIGKILL`。重启前用只读 SQLite 查询确认 B 的 Journal 行和 `reply_seq` 还未产生。第二次重启复查同一个 Journal 序号。夹具只选定中断位置，终稿内容与身份由真实 handler 和原生归档写入。

| 场景 | 证据 |
|---|---|
| 非流终稿落盘后中断 | [final-crash.json](final-crash.json) |
| SSE 收到可信终止、终稿落盘后中断 | [stream-final-crash.json](stream-final-crash.json) |
| 落盘后改动正文，保留原摘要 | [tampered-final.json](tampered-final.json) |
| 已派发，模型尚未回包 | [dispatch-only.json](dispatch-only.json) |
| SSE 只有前缀，ToolBox 合成 `STREAM_INCOMPLETE` 尾帧 | [truncated.json](truncated.json) |
| 上游 HTTP 400，ToolBox 合成 `UPSTREAM_INCOMPLETE` 响应 | [provider-error.json](provider-error.json) |

两个正例均在 B 尚未提交前自动写入唯一一条 B Journal 记录。B 迟到提交相同终稿复用原序号，同一操作 ID 改用本地时间与 `stop` 也复用回执。不同正文和 A 冒领被拒绝。四个负例进入 `review_required`，保持 `reply_seq=null`。派发后挂起的负例还在重启前验证了 `SHARED_NATIVE_TERMINAL_REQUIRED`。

每项记录原 Work、两代 native request ID、工具 invocation ID 与 record ID、Journal 序号、调用计数、补交 HTTP 结果及加载源码哈希。每项的 3 次模型请求包含独立的多工具拒绝对照、A 的停点和 B 的接续。工具副作用标记始终只有 1 条。

## 复跑

从仓库根目录执行。需要 Node.js 24、ToolBox Vexus addon 和已构建的 `mobile-dist`。进程故障注入使用 Linux 的 `/proc/self/fd`。

```bash
evidence="$PWD/docs/evidence/native-final-publication/server"
for mode in final-crash stream-final-crash tampered-final dispatch-only truncated provider-error; do
  TMPDIR=/var/tmp VCP_PROTOCOL_EVIDENCE="$evidence/$mode.json" \
    node tests/tool-work-handoff/protocol.cjs "--$mode" || break
done
TMPDIR=/var/tmp node tests/tool-work-handoff/protocol.cjs
TMPDIR=/var/tmp node tests/tool-work-recovery/run.cjs
TMPDIR=/var/tmp node tests/tool-work-recovery/run.cjs --known-receipt
```
