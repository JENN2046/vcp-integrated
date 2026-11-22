# 共享话题中的 UTF-8 附件续问

基线 `be8ce56` 通过。Linux x64 上运行两个隔离的 Electron 44.9.3 客户端、实际 Chat Data Service 和实际 VCPToolBox/NativeSync。回环测试 Provider 根据请求中是否有合成文件标记返回固定回复。夹具代填 A 的系统文件选择器，仍通过真实桌面附件按钮、主进程附件 IPC、普通聊天输入框和发送按钮。

A 附带上传 67 字节的 `synthetic-continuity.txt`，桌面负责首轮原生模型调用。上传只发生一次，创建、写入和完成分别返回 201、200、200。附件 ID、原消息 ID、中央 CAS 字节 SHA-256、Journal 正文摘要及 B 投影一致。A 收到回复后正常退出，夹具移走合成原件和 A 的附件缓存副本。

B 使用原测试 profile 重开同一共享话题，关闭本地附件下载缓存，输入框附件列表为空。B 没有打开附件选择器、重复上传或发起桌面 Provider IPC。中央 worker 在 B 的成员身份下执行一次，原生 Handler 和回环 Provider 各收到原始 UTF-8 正文一份，正文跟在 A 的历史用户消息中。B 请求中没有本机路径，终态回复“原文件的样本编号是 73。”进入 B 的实际 History。Journal 恰好有两组用户与助手消息。

A 首轮 Handler 和回环 Provider 中观察到 A 本地附件 URI 及 History 路径。收据把隔离目录名统一替换为 `/isolated-fixture`，保留原生路径形态以便对照。该观察适用于 A 首轮桌面执行。验证覆盖合成共享成员和 UTF-8 文本。

- [执行收据](desktop-continuation.json)
- [A 选择附件](A-attached.png)
- [A 首轮回复](A-reply.png)
- [B 重开同一话题](B-reopened.png)
- [B 普通续问回复](B-reply.png)

运行 `node tests/shared-attachment-continuation/run.cjs`，需要 Linux x64、Node 24、已构建的桌面与服务依赖及 Xvfb。可指定 `XVFB_BIN`。本次使用 `NS_FIXTURE_POLL_WATCHERS=1` 运行空合成知识库。Electron、CDS、ToolBox 和 Xvfb 已退出。测试运行目录由夹具放在 `/tmp/vcp-integration-*`，其中保留一次性 profiles、合成输入和原始诊断，仓库证据仅复制收据和截图。

回归通过 `node tests/shared-single-review/upstream-delete-desktop.cjs`。

[桌面私有引用、共享附件与跨空间读取权限对照](boundaries.md)记录了同一份材料的负对照：私有实时引用只传引用元数据，已授权桌面能看见目标路径，但不会通过共享附件接口得到正文；外部共享空间设备的读取请求返回 403。
