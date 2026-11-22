# 群聊模型裁决复审

原生群聊和共享 worker 的模型选择逻辑一致，且两端都实际用于派发。启用统一模型时选统一模型，关闭时选本轮成员模型。模型 ID 都经首尾空白规整。成员的采样温度、输出上限和流式开关继续随该成员的请求传递。两端现在调用 `@vcp/core-rules/group/modelSelection`，旧 NativeSync 导入路径转发到同一函数。

基线复现了一个通路差异。共享发布合约接受 `" synthetic-unified "`，worker 发送 `"synthetic-unified"`，但 ToolBox 的共享冻结配置校验此前要求带空格的值。A 的请求收到 `MODEL_HTTP_409`，请求只到 `native_prepared`，B 仍在排队。修复后，冻结群聊配置也按原生规则计算期望模型，入口对请求体继续做精确匹配。[改前回执](before.json)

| 输入 | 原生桌面 | 共享 worker |
|---|---|---|
| 关闭统一模型，配置两个不同成员模型 | A、B 使用各自模型 | A、B 使用各自模型 |
| 启用统一模型 | A、B 使用同一个模型 | A、B 使用同一个模型 |
| 启用统一模型且 ID 两侧带空格 | A、B 使用规整后的统一模型 | A、B 使用规整后的统一模型，Work 完成 |
| 统一模型为空白，成员模型有效 | 两位成员各记录原生配置错误，零补全请求 | 发布校验拒绝，构包时用同一裁决拒绝 |
| 关闭统一模型，成员模型为空白 | 两位成员各记录原生配置错误，零补全请求 | 发布校验拒绝，构包时用同一裁决拒绝 |

前三组经独立 Chromium PWA、原生 Electron 群聊 IPC、真实 ToolBox 和回环合成 Provider 运行。每组两端各发两次，匹配 handler 与 Provider 的模型、温度、输出上限和流式参数。原生和 worker 记录到同一文件的 SHA-256。共享重交复用相同 Work，每步一次尝试，账本及报文一致。无模型用例在原生 IPC 实跑，另调用真实共享发布校验与 worker 构包函数。[改后回执](after.json)

另以启用附件功能的本机夹具实测 PNG 接纳。文件经共享附件 HTTP 上传、校验并进入 `ready`，再从原生共享准入路由提交。来源的图片模型授权固定为 `synthetic`。基线中，统一模式和成员模式的同名带空格配置都误报 `MODEL_IMAGE_UNSUPPORTED`。修复后两组都通过，按保存的两位成员顺序持久化计划，并可读回同一 PNG。名单外模型在两组仍返回 409，未留下接纳记录，History head 未推进。图片校验仍需匹配授权清单，并检查已授权的上传与 blob。此用例止于准入，补全请求为零。[图片准入对照](image-admission.json)

普通和邀请的原生调用点共用模型函数。本回执的报文矩阵覆盖普通顺序群聊。

## 复跑

在已构建的 Linux 集成仓库根目录，使用 Node 24、Xvfb、Chromium 和可运行的 Electron。运行 `node tests/group-model/run.cjs`，按需用 `ELECTRON_BIN`、`XVFB_BIN`、`CHROME_BIN` 选择本机二进制。若宿主 inotify 已达上限，可在外层设置 `NODE_OPTIONS="--require=$PWD/docs/evidence/three-client-candidate/build-linux/empty-watcher-preload.cjs"`。该测试预加载的降级范围为新建合成 ToolBox 的空文档树和 RAG 参数 watcher，使用原生群聊、共享 admission、ToolBox、真实 IPC/HTTP 和本机合成 Provider。


图片准入回归使用 `node --test tests/native/group-image-model-admission.test.cjs`。与 `tests/native/shared-single.test.cjs` 和 `tests/native/attachment-commit-work.test.cjs` 一并运行，35 项通过。
