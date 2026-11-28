# 群聊流片正文提取

原生桌面普通与邀请群聊曾各维护一段正文提取。共享 worker 在 `mobile/nativeResponse` 消费 ToolBox 的客户端流时也应用相同顺序：`choices[0].delta.content`、`delta.content`、`content`、`message.content`。四个候选字段中采用第一个非空字符串，空帧只参与流和终态观察。现在三条路径加载 `@vcp/core-rules/group/streamDelta`；历史插件路径保留转发。

ToolBox 在 `streamHandler` 内从标准 delta 收集工具循环输入并裁决原生完成。客户端流可以携带额外的正文格式。普通共享会话通过现有 `readStreamDelta` 回调，为 ToolBox 持久终稿取得与 worker 对同一帧一致的可见文本。两层仍分别管理自身的工具执行、SSE 边界、错误和终态校验。

[合成输入](input.json)从回环 Provider 依次发出四种字段，其中较低优先级的冲突值以 `discard-` 开头，另有纯角色帧和 ToolBox 转发的终态帧。真实 ToolBox 经过配对 PWA 的群聊发送调用 worker，再由真实 Electron 发起同一顺序的群聊及邀请。两条共享成员步骤各派发一次，重放只返回原 Work。桌面先提交 A 的 History，再派发 B。普通群聊两端得到 `GC_REPLY_A_UNIQUE` 和 `GC_REPLY_B_UNIQUE`，桌面邀请另提交一次 A 的相同正文。后测 Electron 普通＋邀请分别命中 14、7 次，worker 命中 14 次；两端加载源码 SHA-256 一致。[实测记录](comparison.json)

立即变更前的检出已跑通普通群聊和 worker。带逐帧探针及邀请的前测复用群聊夹具固定基线 `6f34d0c0a260`。该提交与本轮起点的 NativeSync 提取模块及 `nativeResponse` 文件 Git blob 一致，桌面两段流片提取实现也一致。后测使用本轮工作树。

另重跑普通共享单聊终稿恢复的 16 个 ToolBox 强停案例。JSON/SSE 在可信终稿封存后均可恢复原回复，封存前和损坏终稿进入待核对。所有案例二次重启并重放，工具调用次数、原 Work 和回复身份按原断言验证。[恢复回归摘要](comparison.json)

在已构建的集成仓根目录使用 Node 24，按[群聊夹具说明](https://github.com/JENN2046/vcp-integrated/blob/032ad5fc27536c323eb5bd075e43282b9badf50e/tests/group-context/README.md)准备基线桌面，再用同一输入运行：

```sh
export NS_GROUP_FIXTURE="$PWD/docs/evidence/remaining-rules/stream/input.json"
node tests/group-context/run.cjs baseline <baseline_dir>
node tests/group-context/run.cjs candidate
```

验收机达到 inotify 上限时，两轮端到端群聊运行使用既有 `docs/evidence/three-client-candidate/build-linux/empty-watcher-preload.cjs`。普通终稿恢复回归同样复用 `tests/mobile-physical/knowledge-watcher.cjs`，保留恢复夹具自己的进程强停钩子。未接入真实 Provider、日用数据或实体移动设备。
