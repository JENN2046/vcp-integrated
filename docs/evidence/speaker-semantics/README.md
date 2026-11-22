# 群聊说话人语义实测

基线使用固定提交 `4d8b67c`。两条路径使用同一组合成数据。历史已保存成员乙的发言，随后成员甲生成同文。观察成员乙的真实请求，核对当前执行者、两条历史发言和各自来源。普通路径在真实 Electron 的群聊发送 IPC 发起，共享路径在真实 Chromium 内配对 PWA 后提交，由共享 Work 执行。

| 观察位置 | 基线 | 候选 |
| --- | --- | --- |
| 普通 History、共享 Journal | 乙与甲的正文均为 `GC_SAME_ASSISTANT_BODY`，分别保存各自姓名、成员 ID 和消息 ID | 两条发言的身份和正文均可核对 |
| 乙的 ToolBox handler 入口 | 两条 assistant 消息分别带一个 `[成员乙的发言]:` 与 `[成员甲的发言]:` 正文标签。历史消息对象只有角色和正文，时间戳绑定仍可关联各自消息 ID | 同一署名与关联方式 |
| ToolBox detectors 完成后 | 两条标签及顺序保持，邀请消息仍带 `name: 用户` | 同样保留 |
| ToolBox final context 与 Provider 收包 | 两条标签及顺序保持，邀请消息的 `name` 已清理 | 同样清理 |
| ToolBox 收到首个 Provider 响应后，流式处理器入口 | 邀请消息的 `name` 已丢失 | 内部邀请仍带 `name: 用户` |
| 共享成员乙本轮执行身份 | handler 的共享 `requestContext` 另带成员乙的 ID 与姓名 | 同样保留 |

普通和共享群聊都在生成请求消息时将历史说话人的姓名编码到正文。桌面 `Groupmodules/groupchat.js` 和服务端 `mobile/groupRequest.js` 都只用角色与正文构造历史请求消息，再附加消息时间戳绑定。结构化的历史说话人 ID 与展示姓名在这个步骤未进入 handler。候选 ToolBox 保留已有的内部 `name`，只在形成上游请求的副本时清理对话消息的 `name`。正文署名保留。

额外向同一个真实 ToolBox handler 送出标准 completion 请求，其中 assistant 和 user 消息均有中文 `name`，正文没有群聊署名。两条名字在 handler 和 detectors 完成后都可见，基线进入流式处理器时两条都已丢失，候选进入流式处理器时仍保留两条。真实回环 Provider 在两版中收到逐字相同的正文，均无 `name`。回环 Provider 记录实际 HTTP payload，并以固定串流回复夹具。本次流式实测覆盖第一次上游派发和真实流式处理器接收的内部消息。

共享提交的重放使用同一请求 ID，确认仍指向同一已完成 Work，账本、handler 和 Provider 收包保持一致。每条路径观察到两次真实模型请求，第二次派发前已读到甲保存的回复。

[基线收包摘要](before.json) · [候选收包摘要](after.json) · [合成输入](../../../tests/speaker-semantics/input.json)

## 复跑

使用仓库已构建的 Linux x64 依赖和 Node 24。按本机位置设置 `ELECTRON_BIN`、`XVFB_BIN` 和 `CHROME_BIN`。脚本沿用现有验证夹具处理主机 inotify 配额耗尽的空日记或 RAG 参数监听器，报告的 `fixtureLimits` 记录实际触发的回退。

```sh
bash tests/speaker-semantics/run.sh baseline
bash tests/speaker-semantics/run.sh candidate
node tests/speaker-semantics/report.cjs "$baseline_evidence" docs/evidence/speaker-semantics/before.json
node tests/speaker-semantics/report.cjs "$candidate_evidence" docs/evidence/speaker-semantics/after.json
```

两次运行各打印一个完整的 `evidence.json` 路径，包含实际加载文件、IPC、账本和 Provider 包。把对应路径用于报告命令。候选的 Git revision 标记检出起点，实际运行的文件由回执中的 SHA-256 核对。

## 作者边界与实测补充

固定作者 VCPChat 的群聊实现以当前记录的说话人构造正文署名。历史已含该说话人的准确前缀时沿用原文；单独的邀请是合成用户消息。ToolBox 在内部保留收到的消息姓名，仅在 Provider 出站副本上清理 system、developer、user、assistant 的顶层 name；tool/function 的 name 继续用于协议匹配。这里的历史姓名、成员 ID、当前执行者和 Provider 消息正文分别取证。[作者桌面源码](https://github.com/lioensky/VCPChat/blob/8a937038e789d303423c174b0b196492e7b18fa1/Groupmodules/groupchat.js) · [作者 ToolBox 提交](https://github.com/lioensky/VCPToolBox/commit/74ed451364c70808d93c6bf5f1215d68a2ce2316)

- **已有署名。** 改前，历史正文 `[成员甲的发言]: GC_PRE_SIGNED_BODY` 在桌面乙的请求中保留一个署名，在共享乙的请求中重复为两个。现在桌面普通发言、邀请发言和共享 worker 复用同一个原生规则。正文以其他成员的名字开头时保留其引用并添加真实作者的署名；不会用正文推断身份。[共同实现](../../../packages/core-rules/group/speaker.js)
- **普通单聊。** 通过真实 Linux Electron 发送，持久消息 `ctx-retained-user` 自带名字「留名访客」。同一条无群聊标签的文本在 IPC、ToolBox handler、非流式处理器中均携带原名，实际 Provider 消息仅包含原角色与原正文。[单聊回执](native-single.json)
- **River。** 使用本机定值向量运行已有 semantic:3 检索；三条记录文本相同。改前输出姓名均缺失，改后从原消息保留已提供的「成员甲」（去首尾空白），其余两条保持无名，分数与顺序一致。此项验证到工具准备入口。TopicSponsor 的引用展示仍使用本地 V1 格式，未迁移 V2 或改动工具结果回填格式。[River 与投影测试](../../../tests/native/speaker-projection.test.cjs)
- **双桌面接力。** 再次运行两成员、丢接管和继续回执的真实场景。乙的 handler 按原 ID、时间戳、索引和哈希绑定甲，Provider 实收一次甲的署名正文；原 Work 完成，两成员各派发一次。[接力回执](handoff.json) · [完成截图](handoff-completed.png)

普通单聊可用 `node --require ./docs/evidence/three-client-candidate/build-linux/empty-watcher-preload.cjs tests/speaker-semantics/native-named.cjs /tmp/native-single-report.json` 复跑，语义投影用 `node --test tests/native/speaker-projection.test.cjs` 复跑。普通单聊探针初次因同步等待 Electron 子进程而阻塞同进程的合成 HTTP 服务，改用异步等待后通过。
