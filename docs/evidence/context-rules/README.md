# 酒馆深度注入的原生归属与请求验收

**共享单聊按 VCPChat 原生的会话消息位置计算酒馆 depth。** 原生的系统提示和历史 `system` 消息先集中到前面，depth 从剩余对话消息尾部计数。归一每次运行生成的标识、时间和路径后，原生单聊的完整请求前后一致，共享单聊仅改变消息顺序及对应的时间戳绑定位置。[产品差异](host.patch)

| Provider 实收顺序 | 原生单聊 | 共享单聊 |
| --- | --- | --- |
| 基线 | 系统提示 → 历史 system → 注入 → 检查点 → 带附件旧输入 → 旧回复 → 本次输入 | 系统提示 → 检查点 → 注入 → 带附件旧输入 → 历史 system → 旧回复 → 本次输入 |
| 候选 | 系统提示 → 历史 system → 注入 → 检查点 → 带附件旧输入 → 旧回复 → 本次输入 | 系统提示 → 历史 system → 注入 → 检查点 → 带附件旧输入 → 旧回复 → 本次输入 |

两侧从新建的合成数据运行。保留原始对照的检查点、检查点之后的 22 字节文本附件、系统后缀和用户后缀，新增一条有时间戳的历史 `system`，将注入设为 depth=4。应用实际运行 Linux x64 上带沙箱的 Electron 44.9.3 和 Node 24.22.3 上的 VCPToolBox，Provider 是同机回环合成服务。桌面用原生发送按钮，共享走真实 HTTP 准入与 worker。基线取自过滤后的 `f5928bd426b1` Git archive，桌面 renderer 规则与预加载文件由该快照的构建脚本重新生成。两侧复用相同的锁定运行时依赖和已构建的 CDS、Vexus 与 PWA；基线的 `@vcp` 本地包指向 archive 内的源码。观察夹具一致。[固定输入](https://github.com/JENN2046/vcp-integrated/blob/032ad5fc27536c323eb5bd075e43282b9badf50e/tests/context-chain/input.json) · [depth 用例](https://github.com/JENN2046/vcp-integrated/blob/032ad5fc27536c323eb5bd075e43282b9badf50e/tests/context-chain/tavern-depth.cjs)

- Chromium precise coverage 显示基线 renderer 调用 `chatContextPipeline.js` 内的 `applyContextRules`，worker 在插件规则镜像直接调用 `applyContextInject` 并将历史 `system` 算入 depth。候选 renderer 与 worker 都命中 `historyWindow/tavernContext.mjs` 的 `applyContextRules`，实际源码 SHA-256 一致。
- 每侧各有一份原生、一份共享的 handler 入参以及对应 Provider 实收 body。逐条校验 5 个时间戳绑定的持久消息 ID、时间、发送索引和实际发送文本哈希。两侧的检查点之前消息仍在物理 History 或中央 Journal 中，模型请求从检查点处取会话历史。附件哈希在本机 FileManager 与共享 CAS 中一致，Provider 收到相同附件正文。[基线完整合成请求和回执](before.json) · [候选完整合成请求和回执](after.json)
- 两侧都完成同一请求重放，回到已完成的原共享 Work，仍是一个 Work、一次派发、一次 Provider 调用和七条 Journal 记录（五条种子、一条输入、一条回复）。独立故障用例另覆盖准入前拒绝、接纳后丢回执和非空正文后断流，最后一种仍待核对。[故障回执](recovery.json)
- 截图显示本机物理 History、检查点、附件、历史系统消息和最终回复。注入顺序以 handler 和 Provider 回执为准。[基线桌面](before-desktop.png) · [候选桌面](after-desktop.png)

使用 Node 24、Xvfb 和已构建的 Linux 沙箱 Electron，从仓库根目录运行：

```sh
npm run test:context
npm run test:context -- tavern-depth
node tests/context-chain/compare.cjs docs/evidence/context-rules/before.json docs/evidence/context-rules/after.json
```

在独立基线构建中覆盖同一版 `tests/context-chain` 观察夹具，运行 `npm run test:context -- tavern-depth --baseline` 验证基线顺序。比较脚本归一新建请求与共享对象 ID、桌面实际点击时间及本次生成的合成 Profile 路径。它先核对每条原始绑定的文本哈希，再比较完整消息与请求 body，只接受上表对应的共享路径重排。

本批原生宿主测试 202/202、协作测试 53/53、桌面上下文定向测试 17/17 通过。用 npm 打包原生历史窗口后，独立目录离线安装验证了原入口和新增酒馆入口均可加载。
