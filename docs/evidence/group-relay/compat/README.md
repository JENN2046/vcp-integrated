# 群聊取消兼容性验证

- [原生桌面群聊](native-local-queue.json)使用沙箱开启的 Electron 44.9.3、真实 CDS、单独的本地 Profile 与回环 Provider。通过原生 preload 和 IPC 发送顺序群聊并取消队列。A 已完成，B 保持连接并以同一消息 ID 写入 History，C 的 Provider 调用为零。
- [普通本地单聊](ordinary-local.json)通过原生 Electron 发送入口，合成工具执行一次，Provider 收到一次工具请求及一次含结果的续写。原生 History 保留用户与助手消息，共享 Work 和 Journal 为空。

- [共享审批与旧版全停](shared-approval-and-legacy.json)使用 Chromium PWA、真实服务器审批和回环 Provider。取消剩余接力后，B 的原审批 ID、工具记录、Work ID 与调用次数保持一致。允许一次后，同一工具记录成功，工具只执行一次。B 续写并发布，C 保持取消且尝试次数为零。[审批后截图](approved-after-cancel-remaining.png)
- 同一环境的旧版 `/cancel` 关闭了正在生成 B 的 Provider 连接并取消 C。B 保留中断发布意图，Work 为 `recovering`。

在已构建的 Linux x64 环境运行 Node 24 和 Xvfb。可以使用 `ELECTRON_BIN` 指定同版本、已配置系统沙箱的 Electron。测试新建临时目录并关闭进程，完整日志和合成 Profile 保留在各次输出路径下供复核。仓库回执只保留验证数据。

```sh
node tests/integration/run.cjs native-local-queue
node tests/integration/run.cjs ordinary-local
node tests/group-extra/shared.cjs
```
