# VCP Integrated

VCP Integrated 将 VCPChat 桌面客户端、VCPToolBox 服务端和移动端渐进式 Web 应用（PWA）集成在同一个仓库。三端可以加入同一个共享话题，查看已经确认的消息与附件，并在换设备后继续交谈。普通本机话题沿用 VCPChat 的原生发送流程。

## 已验证的跨端流程

在 `f7b718c97683` 的实机验收中，Linux 桌面发送了一张静态图片。Android 手机上已安装的 Firefox PWA 随后用纯文字追问图片细节。Windows 桌面重新打开同一话题，读到前两轮对话并继续提问。

本次验收使用本地合成 Provider 检查实际模型请求。三个请求各携带一份字节相同的 JPEG，后两轮从首条历史消息取得图片。三个工作项（Work）各执行一次。三端冷启动后，六条消息的 ID、角色和正文逐条一致。[三端验收标签](https://github.com/JENN2046/vcp-integrated/tree/acceptance-f7b718c) · [静态图与 GIF 的请求对照](docs/evidence/shared-single-image-models/receipt.json)

## 架构与职责

| 组件 | 在共享会话中的职责 |
| --- | --- |
| [VCPChat 桌面端](apps/desktop) | 提供原生聊天界面、附件读取和消息操作。已确认的共享消息通过桌面的 History 写入队列保存到本机。 |
| [VCPToolBox 服务端](apps/server) | 提供原生模型请求和工具执行管线。服务端 worker 可为后续请求读取已获授权的历史附件。 |
| [移动端 PWA](apps/mobile) | 提供配对、话题浏览、参与对话和工作状态查看。构建产物由服务端从 `/mobile/` 提供。 |
| [NativeSync 协调层](apps/server/Plugin/NativeSync) | 管理共享身份、权限、请求准入和执行归属。中央 Journal 记录已确认的消息变更，客户端凭原请求 ID 核对回执、恢复工作。 |
| [共用模块](packages) | 存放聊天规则、执行决策和同步契约。桌面与共享单聊 worker 复用同一套图片缩放、JPEG 编码和 GIF 采样逻辑。 |

共享单聊按所选模型提交图片，无需另行登记图片模型名单。对已接纳的请求，使用相同身份重试会找回原 Work。工具副作用仍未确认时，工作保留为待核对状态。仓库中另有审批恢复、AgentAssistant 父子任务接续和手机参与邀请制群聊的验证记录。[审批恢复](docs/evidence/approval-restore/README.md) · [AgentAssistant 接续](docs/evidence/aa-handoff/README.md) · [手机群聊邀请](docs/evidence/mobile-group-invite/README.md)

## 从源码运行隔离环境

以下命令适用于 **Linux x64 GNU**。准备 Git、Node.js 24、npm、C/C++ 构建工具、Rust、OpenSSL、Xvfb 及 Electron 所需的系统库。桌面 Chat Data Service（CDS）使用 Rust release 构建，服务端 Vexus 使用 Rust 1.89.0 和仓库中的 Cargo.lock。Windows 桌面端单独构建。[Linux 构建记录](docs/evidence/release-c1b8ffc6272f/build/README.md) · [Windows 构建记录](docs/evidence/release-c1b8ffc6272f/windows/README.md)

```sh
git clone https://github.com/JENN2046/vcp-integrated.git
cd vcp-integrated
npm run deps
npm run build
npm run dev:isolated
```

首次安装会按三个应用各自的锁文件下载依赖和 Electron。构建脚本生成同步契约、桌面 preload、原生组件及 PWA 资源。`dev:isolated` 使用两个独立的测试 Profile 和本地合成 Provider，终端会打印回环 HTTPS 地址和运行目录。默认在 Xvfb 中启动桌面窗口。若要在本机 X11 桌面查看这两个窗口，可使用 `VCP_DEV_DISPLAY="$DISPLAY" npm run dev:isolated`。按 Ctrl+C 结束会话。

## 运行测试

完成依赖安装和构建后，在仓库根目录运行所需套件。

| 命令 | 范围 |
| --- | --- |
| `npm run test:native` | 原生宿主集成，包括共享准入、历史投影和执行恢复 |
| `npm run test:integration` | 隔离桌面端到端流程，包括发送、回执丢失、流中断、配置保存和重开 |
| `npm run test:collaboration` | 多端协作与浏览器测试，需要 Chrome 或 Chromium |
| `npm run test:wire` | 移动端与服务端的协议验证 |

可通过 `XVFB_BIN` 和 `CHROME_BIN` 指定可执行文件路径。针对单一故障复验，例如 `node tests/integration/run.cjs lost-only`，可缩短反馈时间。[验证记录索引](docs/evidence)

## 上游与许可

桌面端基于 [VCPChat](https://github.com/lioensky/VCPChat)，服务端基于 [VCPToolBox](https://github.com/lioensky/VCPToolBox)。本仓保留上游署名、宿主许可及导入版本记录。使用和分发时请查阅对应组件的许可。[来源与署名](NOTICE.md) · [宿主来源记录](provenance) · [根许可证](LICENSE) · [组件许可证](LICENSES)
