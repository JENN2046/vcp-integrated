# 桌面 AA 委派与只读 PWA 验证

隔离 Linux Xvfb 中运行带沙箱的 Electron 44.9.3，走 VCPChat 主聊天的共享话题发送入口。VCPToolBox 执行真实的 AgentAssistant 插件，模型响应由本地回环夹具提供。PWA 使用独立 Chrome 的 390 × 844 移动视口和只读配对。

- 桌面发送普通共享消息后，AgentAssistant 启动一个子任务。关闭 Electron，使用同一个隔离 Profile 重开并选择同一话题，工作与子任务标识一致。发送和子任务启动各一次。[关闭前](desktop-aa-before-close.png) · [重开后](desktop-aa-reopened.png)
- 发起端在任务面板点击「请求停止 AA」，原子任务先显示「正在取消」，随后显示「已取消」。PWA 在两个阶段分别看到原任务运行和取消，配对完成后执行写入数为零。[桌面已取消](desktop-aa-stopped.png) · [PWA 运行中](pwa-aa-running.png) · [PWA 已取消](pwa-aa-stopped.png)
- 第二条共享消息使用正常 AA 完成路径。桌面和 PWA 都从同一个绑定的子任务打开归档报告。[桌面报告](desktop-aa-report.png) · [PWA 报告](pwa-aa-report.png)

[验证记录](receipt.json) 包含前后实际工作和任务标识、发起端按钮状态、两次桌面运行的相同 Profile 摘要、退出结果，以及加载源码的 SHA-256。测试过程中使用真实的桌面和浏览器软件，模型输出和账户均为隔离夹具。本轮实机范围是 Linux 桌面和移动视口浏览器。

在仓库按根 README 完成依赖与宿主构建后，使用 Node 24 和可用的 Xvfb 运行：

```sh
node scripts/build.mjs --mobile
node apps/desktop/scripts/build-sandbox-preloads.cjs apps/desktop
node tests/integration/run.cjs aa-desktop
```

可用 `ELECTRON_BIN` 和 `XVFB_BIN` 指定隔离运行的二进制路径。脚本会输出测试临时目录及完整证据路径。
