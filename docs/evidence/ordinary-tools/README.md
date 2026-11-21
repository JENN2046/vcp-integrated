# 共享单聊的普通工具审批与恢复

基线为 `89dd204c659f`。Linux 隔离的 VCPChat 和 VCPToolBox 共用回环合成 Provider。夹具按正常插件发现流程加载一个本机直连插件。每收到一次调用，它就在独立文件追加一行并执行 fsync。这个计数独立于模型轮数、HTTP 状态和服务端账本。改前改后使用相同的合成输入、初始话题配置和故障位置。此批输入为纯文本。

## 实测差异

| 操作 | 改前 | 改后 |
|---|---|---|
| 进入人工审批 | 原生审批卡可见，共享工作显示执行中 | 同一 Work 显示等待审批，接收端计数为 0 |
| 原生批准 | 工具执行 1 次，共享调用记录 0 条 | 工具执行 1 次，原生工具记录 ID、调用 ID 和 Work 可关联；调用状态为 `returned` |
| 原生拒绝 | 接收端计数为 0 | 接收端计数为 0，共享调用记录为 0；聊天可按原生拒绝策略结束 |
| 等待中停止，随后送达原批准 | 接收端计数由 0 变成 1，合成 Provider 收到工具结果 | 接收端保持 0，后续模型请求为 0。模型首轮已经派发，Work 保留 `review_required` |
| 接收端落盘后，工具超时或抛错 | Work 显示完成，Journal 已写入助手消息，共享工具账本无记录 | 原调用保持 `started`，Work 等待核查，Journal 只含输入；模型未再接到下一轮请求 |
| 接收端落盘后、返回前强停 ToolBox | 原 Work 能找回，缺少该工具的调用记录 | 重启并按原 ID 重交后，同一调用仍为 `started`，Work 尝试次数及接收计数均为 1，Journal 只含输入 |

六个服务端场景在基线合计发出 11 次模型请求，改后合计 8 次。按接收时间和原生请求 ID 逐笔核对到后端关闭，未归属请求为 0。减少的三次分别是停止后的迟到批准、工具超时和工具抛错引出的模型续轮。原生拒绝仍可把拒绝结果交给模型。成功场景有两次模型请求。第一轮要求调用工具，第二轮使用工具回执作答。工具接收端只有一次调用。[改前回执](before.json) · [改后回执](after.json)

## 桌面与只读观察端

桌面点发送后，代理在服务端接纳成功时丢弃 HTTP 200 回执。重开的发起端凭原输入 ID 查回同一 Work，另一台保持在线、已收到原生审批卡的测试桌面执行批准。全程只提交一次发送，工具计数为 1，两端物理 History 的消息 ID 与中央 Journal 一致。发起端重开后能看到等待状态，本次宿主没有向它再次投递已送达的审批卡。[桌面前后回执](desktop/receipt.json) · [审批卡](desktop/candidate-shared-approval.png) · [丢回执后重开](desktop/candidate-shared-tool-lost-ack-reopened.png)

准入前拒绝时，输入框保有原文。切断已返回首段的 Provider 连接后，重开仍能看到部分正文，History 和 Journal 只有用户消息。本机普通发送与本机工具调用均能得到回复，共享 Work 为 0。另在隔离 Chromium 中以只读权限配对 PWA，观察到共享回复完成，输入框禁用，界面无审批操作，执行写请求为 0。[断流后重开](desktop/interrupted-partial-reopened.png) · [普通本机工具回复](desktop/candidate-local-tool-complete.png)

## 归属与改动

桌面保留输入及发送意图。服务端沿用原有准入和幂等逻辑分配 Work。ToolExecutor 分配原生工具记录，PluginManager 继续裁决规则、人工批准和工具结果。共享工作订阅原生等待事件。原生直连传输在实际调用前向既有账本写派发意图，并复查取消和执行归属；插件结果经过宿主处理后才结算。持久回执缺失时，原请求暂停后续模型和工具派发，保留已开始的调用供核对。[三个宿主文件的完整差异](host.patch)

此次覆盖普通 `hybridservice/direct` 及其在共享单聊里的实际入口。TopicSponsor 沿用专用投递回执。普通 stdio、分布式工具及 AgentAssistant 长任务需要分别核对各自的接收凭据。跨进程的未知副作用仍需经原有核查流程处理。

## 复跑

在本仓 Linux x64、Node 24 的已构建环境执行。浏览器使用独立测试 Profile，桌面使用 Xvfb 和可用的 Electron 沙箱。仓库根 README 说明依赖安装与构建。

```sh
npm run test:ordinary-tools -- 89dd204c659f1e7e71efc95cdea8ad76a2d6d8eb --pwa
npm run test:ordinary-tools -- --pwa
node tests/integration/run.cjs ordinary-shared
NS_DROP_APPROVAL_RECEIPT=1 node tests/integration/run.cjs ordinary-shared
node tests/integration/run.cjs ordinary-local
npm run test:native
npm run test:collaboration
```

原生回归 199/199，协作回归 52/52。协作回归包含两个并行审批的等待状态、持久意图写入后取消、结算回执缺失，以及 TopicSponsor 原路径。此次设备证据来自 Linux Electron 与隔离浏览器；Windows 和实体 Android 的历史回执见上级集成交付记录。
