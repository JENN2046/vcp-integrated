# 单聊请求封装共用规则实测

普通桌面单聊的 `send-to-vcp` 与共享 worker 的 `mobile/nativePacket` 共同使用 `@vcp/core-rules/request-envelope`。合并前，两端各执行一份时间戳绑定和内部字段清理；合并后，两端各调用同一模块中的两个函数一次。实测使用 Electron 主进程 precise coverage，以及从 worker 调用点追踪到实际执行的 CommonJS 导出。

| 阶段 | 实际执行的源码 | SHA-256 |
| --- | --- | --- |
| 合并前，桌面 | `apps/desktop/modules/ipc/chatHandlers.js` | `6eb541cf4d16f62b108784f496a4dc2163dbbbae00b16771b51f26268cf464cb` |
| 合并前，worker | `apps/server/Plugin/NativeSync/nativeRules/modules/chat/requestEnvelope.js` | `f311d0ce8e7becd4f97b4f1180a51e4051f3f66d7a7c1f1fd2df7403bc25ef96` |
| 合并后，桌面与 worker | `packages/core-rules/requestEnvelope.cjs` | `c6ce91b16a59910f5dac0392b2e3b7e9816cfcc234d19f87a316a9dd8165c896` |

[产品差异](host.patch)把请求上下文、`hash_only` 时间戳绑定和两个消息内部字段的清理提取到现有包的一个子路径。桌面直接导入共享函数，worker 从原入口转发。桌面准备共享原生执行时也通过同一个 `buildRequestContext` 生成上下文。请求字段、绑定顺序和计算输入沿用原逻辑。桌面群聊的独立组包只发时间戳绑定，`vcpClient` 的独立组包只剥离时间戳元数据。两处均保留各自的源码。worker 群聊继续走 `nativePacket` 并发送原来的群聊请求上下文。离线安装打包产物验证了子路径导出及群聊字段。

## 实测结果

- 两轮使用同一份[合成输入](https://github.com/JENN2046/vcp-integrated/blob/032ad5fc27536c323eb5bd075e43282b9badf50e/tests/context-chain/input.json)，包括四条 History 种子、一个检查点、一份 22 字节附件和三条酒馆规则。实际运行 Linux 沙箱 Electron、VCPToolBox、CDS 和仅监听回环地址的合成 Provider。桌面通过发送按钮，worker 通过共享 HTTP 准入运行。
- 每轮各捕获一份桌面和一份共享的完整 Handler 请求，以及对应 Provider 实收 body。逐条验证四个时间戳绑定识别持久消息、索引和实际发送文本的哈希。对比脚本只归一每轮生成的请求和共享对象 ID、桌面发送时间、合成 Profile 路径及其派生哈希。两条路径各自的 Handler 与 Provider 请求前后完全一致。[基线回执](before.json) · [候选回执](after.json)
- 两轮各重放一次原共享请求。重放返回原来的完成 Work，Work、Journal、Handler 和 Provider 快照保持一致，累计一次派发、一次 Provider 调用和六条 Journal 记录。
- 批次中原生套件通过 255 项、跳过 6 项。独立目录离线安装 `npm pack` 产物通过。

回执保留未经归一的完整合成请求和正文。发布前从桌面物理 History 副本剔除了 `admissionToken`。测试连接材料、TLS 私钥及配置没有进入回执。

## 检查点夹具的版本差异

原版默认夹具在当前宿主上实际失败，旧断言预期选择器调用一次，观察到两次。历史的普通单聊和酒馆对照在旧宿主只从 worker 选择一次检查点，选择器输入还带本次发送。宿主提交 `a35e7a2` 将同一个窗口用于共享准入的可移植性核对及 worker 组包。准入读取已提交历史，worker 从选择输入中排除本次发送并在窗口确定后加入它。因此，当前默认、酒馆候选和本次组包场景严格要求两次调用，两次均校验完整的有序 History ID 和裁剪结果。历史 `tavern-depth --baseline` 仍严格要求一次调用及包含本次发送的选择输入。[历史窗口回执](../context-rules/README.md)

## NativeSync 规则入口

| 入口 | 类型及实际使用 |
| --- | --- |
| `Groupmodules/groupChatUrl`、`groupContextWindow`、`streamWatchdog`、`modes/{baseChatMode,inviteOnlyMode,natureRandomMode,sequentialMode}`、`modules/{modelTrajectory,tavernRulesEngine}`、`modules/chat/requestEnvelope` | 10 个 CommonJS 转发。群聊、共享轮次和移动执行引用相关入口。群聊模式在包内直接引用包的 `baseChatMode`，未找到插件中同名转发的直接生产调用。 |
| `modules/contextSanitizer` | 共享规则工厂，通过宿主的 `require` 取得宿主锁定依赖。 |
| `modules/renderer/{toolResultRegions,markdownCodeDomainScanner}` | 两个 ESM 转发。worker 入口引用 `toolResultRegions`，扫描器在包内由规则间接加载。 |
| `modules/chat/requestMetadata`、`Groupmodules/{modelSelection,streamDelta}` | 三处仍在插件内实现的规则。分别用于历史时间元数据附加、群聊模型选择及流增量提取。 |

`nativeRules` 下的 16 个入口中没有构建生成物。浏览器直接加载的规则副本与协议生成文件位于该目录之外。

## 复现

使用 README 所述的已构建 Linux 检出、Node 24、Xvfb 及能启用沙箱的 Electron。保留同一版 `tests/context-chain` 夹具。在基线的隔离副本可用 `git apply --unidiff-zero --reverse --check docs/evidence/request-envelope/host.patch` 核对反向差异，再用 `git apply --unidiff-zero --reverse docs/evidence/request-envelope/host.patch` 单独还原本次产品改动。候选使用当前产品源码。

```sh
# 基线宿主
npm run test:context -- request-envelope --baseline

# 候选宿主
npm run test:context -- request-envelope
npm run test:context
npm run test:context -- tavern-depth

# 可比较新生成的回执，也可复核仓库回执
node tests/context-chain/compare.cjs docs/evidence/request-envelope/before.json docs/evidence/request-envelope/after.json
```

本机 inotify 配额耗尽时，两轮都用仓库现有的[空知识库 watcher 夹具](../three-client-candidate/build-linux/empty-watcher-preload.cjs)。同样的场景参数可传给以下入口，必要时用 `XVFB_BIN`、`ELECTRON_BIN` 指定工具位置。

```sh
node --require ./docs/evidence/three-client-candidate/build-linux/empty-watcher-preload.cjs tests/context-chain/run.cjs request-envelope
```
