# 共享附件续谈的权限与桌面引用边界

以 `vcp-integrated` 的 `be8ce56` 产品源码运行。正负例使用相同的合成文件 `synthetic-continuity.txt`，SHA-256 为 `f346e907ed0c3a44347eba4a411e0e891c16d3d43905f1036a63c3156f55fc0e`。负对照使用 loopback HTTP、生产 NativeSync 路由和桌面运行时、临时 SQLite 和合成 Provider。此处的移动结果来自 PWA API，桌面结果来自运行时和服务 API。实际 ToolBox 进程、Electron 界面和实体设备的覆盖以各自的正例记录为准。

## A 私有文件以桌面引用留在活动上下文

| 入口 | 实测 |
| --- | --- |
| A 桌面以原生 `isLiveReference` 提交 | 归属 `desktop:deviceA`。产生一个用户 Journal 记录与一个桌面 admission。无服务端 Work、原生请求、Provider 调用或附件上传、blob、关联。夹具随后结束该未派发 admission，以便测试续谈。 |
| B 同一共享话题 History | 有 `desktopReferences`，标记 `desktop-only`。名称、目标路径等引用元数据对获准读话题的 B 可见。正文标记未出现在投影中，普通 `attachments` 为空。 |
| A、B 强制走桌面 `session-send`，以及有权限的 PWA 发送 | 均为 `409 DESKTOP_CONTEXT_REQUIRED`。拒绝期间 Journal、admission、Work、原生请求、Provider 与附件表计数保持一致。 |
| B 按引用 ID 读取共享附件 | `403 ATTACHMENT_NOT_ALLOWED`。没有附件正文、文件名或 hash 响应，A 原始文件字节保持一致。 |

`packages/sync-contracts/src/contracts.mjs` 将带 `isLiveReference` 且无有效 hash 的原生附件投影为桌面引用。VCPChat 的 `apps/desktop/modules/chat/chatContextPipeline.js` 负责原生实时引用取文。夹具从 A 提供本地真实合成文件，未调用对 B 的桌面引用取文，也未从 A 的私有文件发出模型请求。

服务端桌面和 PWA 共享单聊分别在 `sync/sharedSession.js`、`mobile/sharedSingle.js` 使用 `mobile/effectiveContext.js` 的活动窗口检查；桌面运行时另有 `sharedSessionClient.js` 的规避分流。已有窗口夹具确认，压缩归档后的桌面引用仍留在 History，界外引用可从后续可移植上下文排除。在原生路径上继续依赖该引用的工作仍需要能访问该文件的桌面。

## 共享附件存在，C 没有目标话题读取权

使用相同文件从 A 建立真正的共享附件关联。已授权 PWA 返回完整匹配字节，状态返回对应附件 ID、`available` 与 `text/plain`。C 桌面使用已注册的外部 source，C 手机持有外部共享空间的合法只读配对。

| 入口 | 实测 |
| --- | --- |
| C 桌面的附件字节、附件状态和共享话题历史 | `403 SHARED_SPACE_NOT_APPROVED`。附件主路由和 source 路由都覆盖。 |
| C 手机的附件字节、附件状态和话题历史 | `403 SHARED_PERMISSION_REQUIRED`。 |
| 拒绝响应及持久状态 | 未返回文件名、hash、正文标记或下载文件头。Journal、admission、Work、原生请求、Provider 与附件表计数保持一致。 |

桌面端由 `sync/sharedAttachments.js` 在查找、返回附件内容前校验话题权限。移动端 `mobile/portal.js` 先校验配对会话的共享读权限，再进入同一个 `mobile/attachmentRoutes.js`。实际模型入口由 ToolBox 执行。共享单聊服务端组装历史附件上下文时，`mobile/execution.js` 调用 `effectiveContext.js` 和 `AttachmentStore.content` 检查关联及 blob，文本附件使用 History 中提交的 `extractedText`。因此字节下载测试与模型输入测试各有独立断言。

## 复跑

```bash
node --test tests/shared-attachment-continuation/boundaries.cjs tests/shared-single-review/context.cjs
node --test --test-name-pattern='shared attachments reuse' tests/native/shared-single.test.cjs
```

第一条共 12 项通过，第二条 1 项通过。记录区分读取权限和当前执行所需的桌面上下文。引用元数据可见的结论限于已授权话题成员。
