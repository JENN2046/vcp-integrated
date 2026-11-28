# 移动 PWA 修改提示词时的共享单聊配置冻结

**修后 PASS。** 基线 `f67c546c8a425ef2b31c198b329a3461c5111e7a` 通过冻结、原生执行、回执重试和只读权限检查，但编辑器渲染会把缺省的 `ruleOverrides` 写成空对象 `{}`，违反“只改提示词”的要求。修复共享编辑器后，用相同夹具和断言复跑，服务端共享对象只有 `systemPrompt` 变化。

[基线回执](baseline.json) · [修后回执](candidate.json)

| 检查 | 实际观察 |
| --- | --- |
| A 接纳与冻结 | Electron A 从真实聊天界面发送，`session-send` 返回 200。admission 已接纳，Work 为 `queued`，尝试次数和 admission 派发位均为 0。Work 的原始 `request_dispatched` 为 SQLite `NULL`，回执保留原值及用于计数的 0。原生请求表行数、ToolBox Handler 输入和 Provider 调用均为 0。A/B 的 History 随后各投影 1 条用户消息。 |
| 移动 PWA 保存与重试 | 有配置权限的独立 Chromium 会话只修改提示词输入框。中央提交并返回 HTTP 200，Chrome CDP 在响应阶段丢弃第一次回执。UI 显示“重试原保存并核对”。重试请求体、操作 ID 和摘要相同，第二次 200 标记 `replayed:true`。中央新增 1 个配置版本、1 行变更和 1 份操作回执。 |
| 只读 PWA | 第二个浏览器会话持有纯共享读取权限。展开共享区后配置编辑控件为 0，同源 POST 得到 403 `SHARED_PERMISSION_REQUIRED`，中央版本、配置和回执均无变化。 |
| A 实际执行 | 移动端保存、重试及只读检查期间，A 的 Work 和 admission 冻结配置的原始字节保持相同。原生 10 秒延迟自然到期后，ToolBox Handler 和回环 Provider 各收到一次旧标记，新标记计数为 0。 |
| B 后续实际执行 | A 回复投影到 B 且新派生配置可用后，B 在同一共享话题发送。新 Work 和 admission 冻结新版本。Handler 和 Provider 各收到一次新标记，旧标记计数为 0。两次 Work 和原生请求均到终态，A/B 最终有相同的 4 条原生 History 消息。 |
| 配置保真 | 修后严格比较完整共享配置，仅 `systemPrompt` 变化。两版派生执行配置的模型、温度、上下文长度、输出上限、流式开关和执行规则相同。 |

两轮均使用独立合成 Profile、真实 Electron/CDS、真实 ToolBox、回环 HTTPS 和合成 Provider。Chrome 使用 390 × 844 触屏视口。所有 PWA 检查均在产品原生 `NativeMobileStartDelayMs=10000` 到期前完成。SQLite 只读观察。Handler 与 Provider 输入通过原生请求 ID 对账，两个隔离 Chrome 会话均记录实际执行的 JavaScript 响应 SHA-256，并核对 ToolBox 实际暂存的构建。此次覆盖范围为合成数据、桌面发起的共享单聊和浏览器移动视口。

[首次回执丢失后的 PWA](mobile-config-retry.png) · [重试确认后](mobile-config-saved.png) · [只读 PWA](mobile-config-read-only.png)

### 复跑

在开发检出按仓库说明完成依赖与构建，使用 Node 24、Xvfb 和 Chrome。使用 `XVFB_BIN`、`CHROME_BIN` 指定自定义二进制路径。使用普通模式时，确保检出基线源码并以该源码重建 PWA。

```bash
npm run build:mobile
NS_FIXTURE_POLL_WATCHERS=1 node tests/config-freeze/run.cjs
```

基线在两次运行态执行验证完成后，以严格的共享对象非提示词字段断言退出 1。修后模式接受同一基线加上共享编辑器修复的工作树或相应的提交。重建后执行同一套断言。

```bash
npm run build:mobile
NS_FIXTURE_POLL_WATCHERS=1 node tests/config-freeze/run.cjs --candidate
```

终端会打印每轮隔离输出目录，完整证据位于其 `mobile-config-freeze/evidence.json`。

补充用隔离 Chromium 打开缺少可选规则字段的合法 Agent 配置。改前只编辑提示词，保存时还会创建空的正则列表、酒馆规则列表和覆盖对象；改后只保存提示词。实际新增、再编辑三类规则也通过，已有规则 ID 保留。[可选字段前后对照](editor-regression.json) · [复跑脚本](https://github.com/JENN2046/vcp-integrated/blob/032ad5fc27536c323eb5bd075e43282b9badf50e/tests/config-freeze/editor-regression.cjs)

回归结果为原生宿主 309 项通过、6 项需要外部历史压缩夹具而跳过，协作套件 60 项通过。复跑改前端到端用例时，把本批 `tests/config-freeze` 复制到已构建的固定基线检出再运行。
