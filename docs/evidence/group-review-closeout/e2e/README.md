# 原接力结清与下一轮 Electron 验证

基线 `774b70e` 中，B 重开后看到原 A 正式回复和原 Work 待核对，确认放弃后中央将同一 Work 结清为 `abandoned`。代理在中央提交后截断 HTTP 200 回执，桌面收到网络错误。B 再次重开仍显示待核对。整段没有调用模型。见 [基线记录](baseline.json)、[结清前窗口](baseline-before-closeout.png)与[丢回执后的窗口](baseline-after-lost-ack.png)。

修复后，B 两次冷开均只显示一次原 A 正式回复。结清前显示原 Work 待核对及第二位成员 B 的回复已派发、结果未知。中央写入一条归属 B、以原 Work ID 标识的幂等结清回执。代理截断回执并关闭 B 进程后，冷开读取到「接力已结束」，原 B 的未知提示保留，待核对入口消失。见 [真实运行记录](passed.json)、[结清前窗口](B-reopened-original-needs-review.png)和[丢回执后的窗口](B-reopened-after-lost-closeout-ack.png)。

B 通过同话题的普通输入框发送下一轮。合成 Provider 收到的两次调用都属于新 Work，A、B 的新回复按顺序进入中央 Journal 和 B 的原生 History。原 Work 仍只有原用户输入与 A 正式回复，B 的原生请求仍为 `unknown`，原结清回执保持一条。见[下一轮完成窗口](B-native-next-round-completed.png)。

从仓库根目录运行。需 Node 24、Electron 及仓库已有的原生构建依赖，默认使用原 `candidate-handoff-unknown` 的合成测试资产。可以设置 `NS_GROUP_REVIEW_SOURCE` 指定同一份已验证的原资产目录。这里复用已记录的空目录 watcher 预加载，避免宿主的 watcher 配额影响测试。

```sh
PATH=/home/jenn/.nvm/versions/node/v24.22.1/bin:$PATH \
XVFB_BIN="$PWD/.runs/toolchain/bin/Xvfb" \
NODE_OPTIONS="--require=$PWD/docs/evidence/three-client-candidate/build-linux/empty-watcher-preload.cjs" \
node tests/group-member-handoff/run.cjs review-closeout
```

原快照由[来源说明](../source.md)追踪。通过运行的临时目录为 `/tmp/vcp-integration-LgJQdD/ready`，Electron 与 ToolBox 已退出，原 SQLite 摘要复核通过。
