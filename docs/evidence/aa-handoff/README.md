# 原生 AgentAssistant 跨设备接续验收

Linux x64、带 Chromium 沙箱的 Electron 44.9.3、两份隔离合成 Profile、各自的 CDS、真实 VCPToolBox 和 SQLite。AgentAssistant 由 ToolBox 原生插件派发，模型使用回环合成 Provider。截图和回执只保留合成记录及验收所需字段。

最终 JSON 父先、JSON 子先、SSE 和强停四组均核对了 26 个改动的应用源码。回执中的 `sources` 包括 Node 主进程实际读取的 ESM 字节、已加载的 CommonJS 文件与已解析的 renderer 脚本。将改动源码按路径排序，以 `path<TAB>sha256<LF>` 拼接后，四组的 SHA-256 均为 `e59165d922cc0c0dac8ade21461a6be3056dec71cfbf33dea4ece16671364e41`。

## 固定基线

- [父回复先](baseline-parent-first.json)。B 先渲染父回复，原生父为 `model_terminal`，子仍运行。A 正常退出后，B 的 Work 查询仍返回原子 ID。桌面活跃列表没有该子任务行，B 重开后可在任务面板核对[原报告](baseline-B-verified-report.png)。
- [子任务先](baseline-child-first.json)。B 读到原子请求 `model_terminal` 和同一报告时，原生父仍为 `dispatched`。两组运行中和核对报告后真实接管／继续均收到 HTTP 409 `SHARED_STEERING_TARGET_UNSUPPORTED`，没有受控 generation。

## 候选

- [JSON 父结算先](candidate-parent-first.json)。父报告等待由真实 HTTP 409 暂停响应确认。A 正常退出后，[B 的桌面](B-original-aa-running-after-A-exit.png)显示原子仍运行。B 界面、物理 History、Journal 的父回复行均为零。接管和压缩被拒绝，直到原生子完成且报告核对。
- [JSON 子任务先](candidate-child-first.json)。夹具暂扣真实父工具结算回调，子请求与[原报告](B-child-first-verified-report.png)照常生成。B 已能读取报告时父仍为 `dispatched`，接管为 HTTP 409 `WORK_SAFE_BOUNDARY_PENDING`。父完成结算后，A 正常退出，B 打开的是同一份报告。
- [SSE 父结算先](sse.json)。真实父请求使用 SSE，HTTP 200 的 `nativesync_work_paused` 携带 `awaiting_native_task`。连续三次收到 `interrupted` 等待事件后，A 均移除临时预览并退出停止状态。界面、History 和 Journal 均未留下虚假终稿。A 正常退出后，[B 仍能看见原子运行](B-observes-aa-after-SSE-parent-exit.png)，随后走同一接管流程。
- 三组均在服务端接受 B 的接管后丢弃回执。B 用原 Profile 重启动，[读回同一 Work 的归属](B-recovered-original-handoff.png)，执行压缩并继续。A 原执行者的继续请求被拒绝。压缩输入只包含一次已核对报告及其类型化回执，后继消费一次已提交的压缩检查点。每组只有一个子调用、一次压缩和一个后继，B 重开后物理 History 和 Journal 各保留一份[原 Work 的终稿](B-reopened-final-history.png)。
- [强停 ToolBox](toolbox-crash.json)。A 正常退出，父已结算，子 Provider 请求已派发并被暂扣。真实 ToolBox 收到 SIGKILL，以同一份库重启。原子 ID 保留，子请求与子任务均为 `unknown`，任务标记待核对，Work 继续被阻止。报告读取和接管均返回 409，Provider 没有第二次子派发，B [显示原 Work 待核对](B-original-aa-needs-review.png)。
- [原生报告哈希冲突](archive-hash-conflict.json)。只更动真实 AA 写入的隔离合成报告。B 的接管及报告读取均返回 HTTP 409 `NATIVE_RESULT_HASH_MISMATCH`。同库重启后 Work 为 `review_required`，原 A 归属与第 0 代保留，子派发一次。此故障用例通过真实 HTTP 建立原 Work。
- [既有双原生工具](ordinary-two-tools.json)与[完成后界面](ordinary-B-final-history.png)。现有 `tool-duo-returned` 回归通过。

## 复跑

按根 README 构建集成仓。使用 Linux x64、Node 24、Xvfb 和能启用沙箱的 Electron。可用 `XVFB_BIN`、`ELECTRON_BIN`、`TMPDIR` 选择工具及临时输出目录。若宿主 inotify 已耗尽，可在运行命令时设置 `NODE_OPTIONS=--require=<本仓绝对路径>/docs/evidence/three-client-candidate/build-linux/empty-watcher-preload.cjs`，只为隔离空知识库启用既有测试 fallback。

```sh
node tests/aa-handoff/run.cjs candidate parent
node tests/aa-handoff/run.cjs candidate child
node tests/aa-handoff/run.cjs sse
node tests/aa-handoff/run.cjs crash
node tests/aa-handoff/run.cjs archive-mismatch
node tests/integration/run.cjs tool-duo-returned
```

另建固定提交 `c9008bde429d` 的隔离 Git 工作树并按相同方法构建。从当前仓运行夹具，传入该隔离 checkout 的绝对路径。夹具用固定基线的测试模块和产品源码，只在内存中扩展测试行为。

```sh
AA_ACCEPTANCE_CHECKOUT=/path/to/built-baseline node tests/aa-handoff/run.cjs baseline parent
AA_ACCEPTANCE_CHECKOUT=/path/to/built-baseline node tests/aa-handoff/run.cjs baseline child
```

## 使用边界

服务端注册原生 AgentAssistant 并通过 `NativeSyncSharedAgentAssistantAgents` 明确列出允许的 Agent 名称后，桌面共享单聊提供「新建 AA 委托」。配置缺省为空。A 输入名单中的 Agent 名称和委托正文，启动第 0 代。目标和正文绑定到原 Work；子任务可以使用原生文本 Flowlock，在这个模式中禁止再开工具或递归委托。普通单聊、原有委托和双直连工具保持各自的入口。

父工具启动回执和已完成子任务的原生归档分别核验。检查点同时绑定父请求、子任务、工具调用、原生子轮次、报告哈希及归档哈希。B 在允许接管之前即可观察原任务；接管后在 B 端压缩，再显式继续。子请求已派发但结果未知、任务取消或报告不匹配时保持核对状态。存储暂时不可读时保留原事实，允许恢复后重新验证。没有待办委托时，AA 恢复路径不重复扫描 SQLite。

最终 Node 24 原生套件通过 290 项，6 项因旧压缩夹具缺失而跳过；协作套件通过 60 项，桌面流消费、路由和桥接定向测试通过 20 项。SSE 等待态曾出现已结束的预览仍占用发送按钮；修正原发送视图的流清理入口后，连续三次实测通过。日用端未部署。
