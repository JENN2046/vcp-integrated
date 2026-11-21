# 未取消共享群聊的运行验收

在隔离 SQLite、真实 VCPToolBox/AgentAssistant、Chrome 手机视口以及回环合成 Provider 上执行了两次。候选工作树基于 `d8c04e57de2f`，JSON 记录实际加载的插件与 PWA 构建指纹。用例通过 Provider 控制 C 的成员正文和 AA 的报告分别何时返回。

| 顺序 | 阶段复审 | 候选实测 |
| --- | --- | --- |
| AA 先，C 后 | 共享准入 `completed`，移动 Work `review_required / GROUP_PLAN_REVIEW_REQUIRED`。[复审回执](../../stage-review/uncut-early.json) | C 仍运行时，PWA 已显示同一 AA 完成，Journal 保持用户、A、B 三行。C 写入第 4 行后，准入与移动 Work 都自动完成。[验收回执](early.json) |
| C 先，AA 后 | AA 完成后，共享准入仍为 `review_required`，移动 Work 仍为 `blocked_config`，同话题的新发送返回 409。[复审回执](../../stage-review/uncut.json) | 三位成员回复均已保存，PWA 显示「成员回复已保存，等待原生任务结束」，同一 AA 仍运行。新提交返回 `409 SHARED_TOPIC_BUSY`，直接探测人工解除接口返回 `409 INVALID_REVIEW_RESOLUTION`，页面没有人工核对控件。同一 AA 的报告返回后，准入与移动 Work 都自动完成，原四条 Journal 不变。[验收回执](late.json) |

两种顺序下，PWA 均展示 C 所属的单个 AA，并成功打开已核对的报告。首轮只有 A、B 各一次、C 两次父模型调用、AA 一次子模型调用及一条已返回工具回执。重交原提交获得同一 Work。随后用 PWA 输入框在同一话题发送新消息，A/B/C 各执行一次并自然完成，新旧两轮共八条不同 ID 的 History 与 Journal 顺序相同。

在构建好的检出中用 Node 24 和 Chrome 复跑：

```sh
node scripts/build.mjs --mobile
node tests/stage-review/uncut.cjs settled-early docs/evidence/group-settlement/live/early.json
node tests/stage-review/uncut.cjs settled-late docs/evidence/group-settlement/live/late.json
```
