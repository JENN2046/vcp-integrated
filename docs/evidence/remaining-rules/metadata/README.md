# History 消息时间戳元数据

普通 VCPChat 单聊的 `assembleRequestMessages` 与 NativeSync 共享 worker 的 `effectiveContext` 原来分别执行相同的 `attachTimestampMetadata`。现在两条路径共同执行原生桌面 `historyWindow/requestMetadata.mjs`。桌面在沙箱内通过相对路径加载，worker 从原入口转发到已安装的 `@vcp/native-history-window/request-metadata`。worker 群聊沿用同一个转发。

| 运行 | 桌面实际执行 | worker 实际执行 | 各路径调用次数 |
| --- | --- | --- | --- |
| 基线 | `apps/desktop/modules/chat/chatContextPipeline.js` | `Plugin/NativeSync/nativeRules/modules/chat/requestMetadata.js` | 4 |
| 候选 | `apps/desktop/modules/chat/historyWindow/requestMetadata.mjs` | 同一个原生模块，源码 SHA-256 与桌面一致 | 4 |

真实 Electron 从普通发送按钮发起请求，以 renderer precise coverage 核对函数及调用次数，再从 `send-to-vcp` 入参核对每条元数据。共享 worker 从 HTTP 准入进入，以实际 CommonJS 调用点记录函数返回的元数据和已加载源码哈希。每条消息以 History ID、role 和 timestamp 对照 Handler 的 `hash_only` 绑定，再用实际发送消息文本验证绑定哈希。每轮各有两次 Handler 请求、两次回环 Provider 请求。两条路径各自的完整请求在基线和候选中一致，归一仅影响每轮生成的请求 ID、共享对象 ID、发送时钟、临时 Profile 路径及派生哈希。重放获得原完成 Work，worker 合计一次派发、一次 Provider 调用、六条 Journal 记录。[基线](before.json) · [候选](after.json)

桌面群聊的 `attachTimestampMetaToVcpMessage` 使用不同的输入判断，继续独立执行。用合成 `timestamp: Infinity` 调用源码的两个函数，原生单聊原样返回，桌面群聊附加该值，后续 `toISOString()` 抛出 `RangeError`。

使用 Node 24 离线打包原生 History 包，再在空目录离线安装。CommonJS 包子路径能够导入，`timestamp: 0` 正常附加，`null`、`undefined`、字符串、`Infinity`、`NaN` 原样返回。三组桌面现有测试共 15 项通过，包括普通单聊、Flowlock 和上下文管线。

## 复现

使用已构建的 Linux 检出、Node 24、Xvfb 和具备沙箱的 Electron。命令运行真实 Electron、VCPToolBox、CDS 及回环合成 Provider。基线为 `4f3f906` 的产品源码加本次观测夹具，候选使用当前产品源码。需要时用 `XVFB_BIN` 和 `ELECTRON_BIN` 指定工具。知识库 watcher 达到 inotify 配额时可沿用仓库的空知识库 fixture preload。

```sh
# 基线
npm run test:context -- request-metadata --baseline

# 候选
npm run test:context -- request-metadata

# 对照已生成的回执
node tests/context-chain/compare.cjs docs/evidence/remaining-rules/metadata/before.json docs/evidence/remaining-rules/metadata/after.json
```

仓库回执只包含本次合成运行的验证数据，桌面 History 副本已剔除 `admissionToken`。
