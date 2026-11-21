# 普通共享单聊可携带上下文

原复审在 `69573c475e3a` 保存了四组基线。便携对照组能通过中央入口，合成 provider 只收到 prompt、摘要和当前输入。归档 Canvas 在桌面侧拒绝走后端，PWA 完成。归档文件引用和有效文件引用同样在桌面侧拒绝走后端，PWA 则在 HTTP 202 后进入 review，provider 调用均为 0。[原复审记录](../shared-single-review/context.json)

2026-11-21 在候选源码中运行了 10 个用例，10 个通过。桌面通过普通发消息使用的 `runtime.prepareSharedSend({serverSession:true})`，PWA 通过配对后的 `POST /mobile/api/conversations/:key/messages`。两端各用独立的合成 History 和本机 provider。通过既有压缩 prepare／commit 接口写入固定摘要。

| 场景 | 桌面结果 | PWA 结果 |
| --- | --- | --- |
| 已归档 Canvas | 后端执行一次 | HTTP 202，后端执行一次 |
| 已归档文件引用 | 后端执行一次 | HTTP 202，后端执行一次 |
| 有效 Canvas | 既有桌面执行持有准入、发起原生请求并完成 | HTTP 409 `DESKTOP_CONTEXT_REQUIRED`，持久记录与 provider 计数不增加 |
| 有效文件引用 | 既有桌面执行持有准入、发起原生请求并完成 | HTTP 409 `DESKTOP_CONTEXT_REQUIRED`，持久记录与 provider 计数不增加 |
| 系统 prompt 或当前输入含 Canvas | 既有桌面执行持有准入 | HTTP 409 `DESKTOP_CONTEXT_REQUIRED`，持久记录与 provider 计数不增加 |

归档用例在写入 checkpoint 后编辑归档行并调高其时间戳。四个归档用例均断言 provider 文本严格依次为已冻结的系统提示词、一次摘要、较新的有效历史、当前输入，且原归档行保持完整。PWA 拒绝用例核对 Journal、admission、Work、原生请求注册和 provider。桌面回退用合成请求体验证原生 dispatch 与完成归属。测试覆盖桌面 runtime 和 PWA HTTP API，模型响应由 loopback 合成。

从已构建的集成仓根目录用 Node 24 重跑。合成用户目录和 SQLite 会在测试结束后回收。

```bash
node --require ./tests/collaboration/fixtures/loopback.cjs --test --test-reporter=tap tests/shared-single-review/context.cjs
```

PWA 收到明确的桌面上下文拒绝后，会用同一会话和请求 ID 查询接受记录。确认不存在 Work 才解除该笔本地待确认提交，草稿及已选附件可继续编辑。其他 409、网络丢回执或会话身份变化沿用原有恢复路径。[宿主差异](host.patch)
