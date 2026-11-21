# 单台桌面恢复共享 Work 的待审批项

基线为 `fb742edb8513`。每个隔离实例只启动一台具有 VCPLog 审批权限的 Linux Electron 桌面。桌面完全退出后，ToolBox 和本地合成 Provider 保持运行。重开使用原 Profile。负向场景另配对一个只有共享读取权限的 PWA。

| 用户操作 | 改前 | 改后 |
|---|---|---|
| 在等待审批时退出，再重开 | 原 Work 显示等待；过了通知补发窗口仍无审批卡 | 恢复原审批 ID，卡片显示原 Work ID，可以直接批准或拒绝 |
| 在恢复的卡片上批准，再次点击 | 原桌面没有可点击的审批项 | 一次发送、一次 Work 尝试、一次工具调用；原生工具记录与调用回执关联，两条 History 与中央 Journal 对齐 |
| 退出后由所有者取消 Work，然后重开，送达原审批的迟到响应 | 工具执行 0 次 | 审批卡 0 张，工具执行 0 次 |
| 退出后等原生审批自然到期，然后重开，送达原审批的迟到响应 | 工具执行 0 次 | 审批卡 0 张，工具执行 0 次；工具按超时记录失败，聊天可以继续处理这个错误 |
| 只读 PWA 在等待和终态观察同一话题 | 可以观察 | 配对权限只有 read。等待时只见状态，终态可以读到已提交的回复；两阶段均无审批按钮，界面执行写请求为 0 |

[桌面前后回执](desktop/receipt.json) · [基线重开截图](desktop/baseline-reopened.png) · [修复后重开截图](desktop/candidate-reopened.png) · [批准后的终态](desktop/candidate-completed.png) · [取消、到期和只读观察回执](stale/receipt.json)

工具次数取自插件接收端单独 fsync 的计数。正向场景的两次模型请求分别产生工具调用和最终回复。等待阶段已有一条原生工具审计记录，实际派发在批准之后发生。

PluginManager 继续保存原批准或拒绝所需的 Promise、原始请求和截止时间。获准桌面重新连接 VCPLog 时，ToolBox 检查原 Work 是否仍有执行权、请求是否仍待处理以及剩余时间，再投递审批卡。决定抵达后执行同样的有效性检查；宿主只消费一次原决定。共享会话的事件流和 PWA 仅承担观察。验证范围是桌面退出与重开，服务端重启按既有未知执行恢复规则处理。[宿主差异](host.patch)

## 复跑

在已构建的 Linux x64 检出使用 Node 24、Xvfb、带可用沙箱的 Electron 及 Chromium。通过 `XVFB_BIN`、`ELECTRON_BIN`、`CHROME_BIN` 可指定已安装的程序。

```sh
node tests/integration/run.cjs approval-restore
node tests/integration/run.cjs approval-restore-stale
NS_EXPIRE_APPROVAL=1 node tests/integration/run.cjs approval-restore-stale
```

在各命令前设置 `NS_BASELINE_SERVER_REVISION=fb742edb8513eded7bd46d78124c4800edb9fda1` 即可对照原服务端。两组加载相同的桌面渲染器，基线服务端沿用原审批帧。到期场景仅将隔离插件审批配置设为 18 秒，计时和决定均由原生宿主处理。原生回归 199/199、协作回归 53/53、桌面审批卡测试 39/39。
