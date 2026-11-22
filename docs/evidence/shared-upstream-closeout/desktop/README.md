# 共享单聊上游 502 的桌面验收

使用 Linux x64、带沙盒的 Electron 44.9.3、真实 CDS、独立 ToolBox 和仅监听回环地址的合成 Provider。两个版本对照使用同一桌面源码和测试动作，旧版通过环境变量切换 ToolBox 版本。每次启动均使用新建测试 Profile 和数据库。

| 阶段 | 观察 |
| --- | --- |
| 旧版 `b5648e96d883` | Provider 一次流式请求返回 HTTP 502。原执行停在 `publishing`，准入为 `review_required`。错误正文进入待发布回复意图，也在 Electron 临时渲染为回复气泡。中央 Journal 和桌面物理 History 只保存用户消息。 |
| 候选 `526809f27e1a` | 原执行与准入均进入 `review_required`。模型请求标为 `unknown`，没有待发布回复或原生终态操作；错误正文没有进入聊天消息、桌面物理 History 或中央 Journal。 |
| 原请求结清 | A 勾选“我已核对可能的工具副作用，放弃此请求剩余工作”后点击“确认放弃并解除暂停”。原准入变为 `abandoned`，原执行变为 `cancelled` 且已结清复核。模型请求仍标为 `unknown`，Provider 计数仍为 1。 |
| 同话题下一轮 | A 点击原生发送按钮提交下一条，新 Work 各自完成一次调用和一次发布。桌面物理 History 与中央 Journal 消息 ID、顺序和正文一致，共两条用户消息和一条成功回复。 |
| 原操作重交 | 用原始请求体重交，返回 HTTP 200、同一个已结清 Work、`replayed: true`。两个 Work 的记录、History、Journal 和模型调用列表均保持一致，累计调用数为 2。 |

以 Node 24 在完成仓库构建后执行。Xvfb 位于非标准路径时设置 `XVFB_BIN`。

```sh
node tests/shared-single-review/upstream-closeout-desktop.cjs
NS_UPSTREAM_CLOSEOUT_BASELINE=$(git rev-parse b5648e96d883) node tests/shared-single-review/upstream-closeout-desktop.cjs
```

[结构化回执](receipt.json) · [旧版错误气泡](A-baseline-publishing.png) · [候选需要核对](A-original-review-required.png) · [结清状态](A-original-closed.png) · [下一轮完成](A-next-native-round-completed.png)
