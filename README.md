# VCP Integrated

VCPChat、VCPToolBox 与手机 PWA 的本地集成分叉。共享单聊由服务端接纳并执行；桌面按原请求 ID 恢复工作，将已确认的消息投影进本机 History。普通未绑定话题沿用本机聊天入口。

## 从干净检出运行

已验证的组合为 Linux x64 GNU、Node 24、npm、Rust（CDS 使用 release 构建，Vexus 使用 1.89.0 和 Cargo.lock）、C/C++ 构建工具、OpenSSL、Git、Xvfb 及 Electron 所需系统库。首次安装会下载锁定依赖和 Electron。三个应用分开安装，以保留各自的原生依赖。Xvfb 在非标准位置时可以设置 XVFB_BIN。

```sh
npm run deps
npm run build
npm run test:native
npm run test:integration
npm run test:collaboration
npm run test:wire
npm run dev:isolated
```

`dev:isolated` 创建两个独立的合成 Profile、临时回环 HTTPS 入口和本地合成 Provider，将手机入口及运行目录打印到终端。默认使用独立 Xvfb。要在当前本机桌面看见两个窗口，可运行 `VCP_DEV_DISPLAY="$DISPLAY" npm run dev:isolated`。Ctrl+C 结束开发会话。单项故障可通过 `node tests/integration/run.cjs lost-only` 等模式运行。临时会话包含测试配对和连接资料，复查时使用筛选过的回执。

桌面从 apps/desktop 加载，服务端从 apps/server 加载，手机源文件位于 apps/mobile。构建器先生成桌面、服务端和手机所需的四份契约产物，再把 Vite 产物放到服务端已有的 /mobile 挂载位置。源码及原生工件的来源在 provenance；署名与许可见 NOTICE.md 和 LICENSES。

协作浏览器套件需要 Chrome 或 Chromium，可用 `CHROME_BIN` 指定。集成套件默认依次验证丢回执、首段后断流、准入前拒绝、普通本机发送、配置保存、桌面异常重开。两端各自安装的 @vcp/core-rules 通过 npm 本地文件依赖指向本检出的 packages/core-rules；运行 build 会更新浏览器直接加载的原生规则脚本。
