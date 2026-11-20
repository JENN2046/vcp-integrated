# 桌面退出与异常重开验证

2026-11-20 在 Linux x64 上用 Node 24、Electron 44.9.3、重编的 CDS 与真实 ToolBox 验证。两端采用各自新建的合成 Profile，服务只监听回环，Provider 由夹具驱动。

- 正常退出先冻结原生准入，关闭本地话题准入宿主，再等待 NativeSync Drain。History authority 与 CDS 在 Drain 期间保持可用。随后收紧 History 准入、停止 CDS，再关闭 HistoryMutationQueue。
- Electron 持有现有准入内的工作时拒绝退出，窗口与准入保持可用，NativeSync 未开始关闭。空闲后正常退出，Drain 期间的新准入被拒绝，两台 Electron、各自的 CDS 与 ToolBox 均退出，测试等待 Xvfb 完全退出。
- ToolBox 接受提交后，夹具断开回执并保持一次 Provider 调用。只向 A 的 Electron 主进程发送 SIGKILL，旧 CDS 随私有控制管道断开而退出。重开前检查旧 CDS PID 和 Electron 进程组均无活动进程。A 用原 Profile 与新 CDS 重开，两端看到原 Work 的同一对消息，原 Work 派发一次。
- 独立 CDS 的行为也作了回归检查。Electron 启动的受管实例在 stdin EOF 后正常退出，直接运行的独立实例在 EOF 后继续存活，经显式关闭正常退出。

复现命令如下。使用 Linux x64、Node 24，先安装仓库依赖并构建手机端和 CDS。

```sh
node --test apps/desktop/tests/quit-lifecycle.test.cjs apps/desktop/tests/shared-startup-lifecycle.test.cjs
node tests/integration/run.cjs shutdown-only
```

退出与启动测试共 34 项通过。真实异常重开案例通过。此前版本只撤销 CDS 的父管道准入，CDS 进程组在异常退出后未能在测试窗口内结束。
