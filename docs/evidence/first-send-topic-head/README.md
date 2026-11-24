# 空共享话题首次发送验证

两套独立 Electron 配置启动后恢复到既有共享 Agent 的默认话题。目标话题的物理 History 与中央 Journal 均为空。另一话题已有一笔 Journal 写入。通过正式同步接口预先保存目标话题的游标，启动前的 baseline watermark 和 topic cursor 均为 1。中央 ToolBox、Electron、Chat Data Service 和共享请求链真实运行，模型响应由本地回环服务提供。

| 场景 | 观察结果 |
| --- | --- |
| 修复前 | 同一个消息 ID 已保存到本地并进入提交 IPC。话题头为 0，同步覆盖位置为 1，随后返回 `SHARED_CONTEXT_CHANGED`。中央发送请求、Work、目标 Journal 与模型调用均为 0。原输入仍在本地账本中。 |
| 修复后 | 一次点击产生一条中央发送请求、一个 Work 和一次模型调用。两端 History 与目标 Journal 的原消息、回复 ID 一致。重启保持同一组 ID，未增加发送和模型调用。无关 Journal 行和 baseline watermark 均通过原样检查。 |
| 已知拒绝 | 回环夹具在上下文读取时返回 HTTP 409 `SHARED_CONFIG_CONFLICT`。界面显示具体原因，原消息 ID、正文和原因在重启后保留。手动点击按原编号重试前，目标 Journal、History、Work、中央发送请求和模型调用均为 0。夹具解除拒绝后，手动操作用原 ID 提交并完成一次。 |
| 旧版中央 | 新版 Desktop 搭配中央版本 `7cdd195ee5ae16bf7ace17b1fc48066af53317c9`，通过同一空话题首发与重启检查。 |

两个独立的修复后本地运行中，从 `stageLocal` 返回到回环模型接收请求分别为 **189 ms** 和 **134 ms**。这段时间包含桌面接入、中央受理和本地派发。截图采用 134 ms 的运行，在回复已显示且本地投影提示已收起后截取。这些单次观察值限定于本地夹具。

[修复前截图](before-first-click.png) · [修复后截图](after-first-click.png) · [已知拒绝截图](known-rejection.png) · [对照数据](results.json)

## 复验

使用项目现有 Linux x64 集成依赖。需要 Node 24、Xvfb、Electron、已构建的 Chat Data Service、ToolBox native addon 和移动端构建产物。驱动复用现有的 Electron 和 ToolBox 集成框架，使用回环网络。每次运行单独生成合成配置、注册关系和 Journal，输出位于 `.runs/first-send-topic-head/`。

```sh
node tests/shared-single-review/first-send/run.cjs fixed
node tests/shared-single-review/first-send/run.cjs rejection
NS_FIRST_SEND_SERVER=7cdd195ee5ae16bf7ace17b1fc48066af53317c9 \
  node tests/shared-single-review/first-send/run.cjs fixed
```

如果 Xvfb 未加入 PATH，可通过 `XVFB_BIN` 指定其可执行文件。修复前使用同一版本的 Desktop 与中央。在已有该版本构建资源的独立源码目录中，将 `NS_FIRST_SEND_DESKTOP` 指向该版本的 `apps/desktop`。当前仓库仍提供驱动、种子夹具和构建产物。

```sh
NS_FIRST_SEND_DESKTOP=/path/to/previous/apps/desktop \
NS_FIRST_SEND_SERVER=7cdd195ee5ae16bf7ace17b1fc48066af53317c9 \
  node tests/shared-single-review/first-send/run.cjs baseline
```
