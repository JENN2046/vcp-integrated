# M1-R1 隔离验收

施工起点为 `dd395e3f5713c6912092b872d1d6cbf1f82e46ce`。固定运行代码为 `c3777d083c59d041de9a452a6471da101069570d`。

## 通过的三端链路

Linux Electron GUI 在新测试 Profile 中通过原生附件按钮发出一张红色 PNG。测试转发只延迟上游连接，等桌面正常退出并读到同一 Work 仍在运行后放行。实体 Android 在临时 WebView 的 PWA 中看见尚未正式提交的流式回复，随后发出追问。Core 共提交两次 Work。桌面冷启动读回四条消息，ID、角色与正文逐项一致。旧 Journal 行数为零。

模型是独立运行的 SmolVLM-500M-Instruct Q8_0，通过 llama.cpp b12728 在本机回环推理。两次模型请求实际含有同一张图，转成模型输入后的 JPEG 数据 URI 摘要一致。首轮回复识别出红色，追问带上首轮的图片与回复。Android 使用临时应用信任的一次性证书和 USB 转发。 [模型版本](https://huggingface.co/ggml-org/SmolVLM-500M-Instruct-GGUF/tree/72e986006ef53e37cdd3f6d4241c90b0f01df376) · [推理引擎](https://github.com/ggml-org/llama.cpp/releases/tag/b12728)

[结构化回执](three-device.json) · [实体手机实时输出](android-live.png) · [桌面冷启动](desktop-cold.png)

## Resident 安装版验证

读取已安装包的代码及完整性声明，在新的根目录启动同一包的真实原生 companion。Proposal 用例通过已安装适配器准备一项隔离提案。Core TurnSink 收到一张已校验的临时确认卡。挑战文本未出现在后续 Provider 请求或正式回复中，未提交确认语句。提案用例的 Provider 返回预定工具帧，便于重复触发同一分支。安装版验证复现了宿主写入冻结工具结果以及流式续轮沿用旧 Proposal 状态两项缺陷，固定提交分别修复了这两个问题。 [提案回执](resident-proposal.json)

实际 native companion 使用其刚生成的连续性锚点重启后，返回 `AGENTS_OS_PRESENCE_CONTEXT_V1`。隔离身份的 OneRing 绑定状态是 `UNKNOWN`，Provider 尝试资格为 false。安装版适配器拒绝生成可派发载体，Core 在发起 Provider 请求前返回 `RESIDENT_PROVIDER_ATTEMPT_DENIED`。正向 Provider Seal 尚无已授权 OneRing 绑定可供验收。 [Presence 拒绝回执](resident-presence.json)

## 可信人类审批待闭合

对照已安装宿主源码和独立 VCPToolBox 源码，找到了 `HumanClientAdmission` 和 `ApprovalReceiptAuthority` 的实现。源仓 `a6f37bfd` 中，生产实现配置 `vcp_chat.c2` 明确是 `PRODUCTION_DISABLED`，可运行的 `vcp_chat.c1.fixture` 仅供测试。内核四项测试通过，包括可信客户端证明、显式意图与精确目标绑定。实际 GUI 无可用的已启用可信客户端链路。Core 高敏路径继续拒绝，普通工具审批走既有原生队列。

M1 尚未闭合。正向 Seal 需要具备有效 OneRing 绑定的隔离身份，真实高敏审批需要已启用的可信客户端接线。WebTransport 另行验证。

## 回归与清理

原生套件 338 项通过、6 项跳过。协作套件 61 项通过。验收后已卸载临时 Android 应用，并确认本轮 USB 转发已移除。隔离模型与 companion 已停止。
