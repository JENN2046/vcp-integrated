# History 路径与附件 URI 的消费者

在仓库根目录执行，使用 Linux 和仓库已安装的 Node 依赖。

```sh
NODE_PATH="$PWD/apps/server/node_modules:$PWD/apps/desktop/node_modules:$PWD/node_modules" \
  node tests/shared-attachment-continuation/path-consumers.cjs
```

脚本把 FileOperator 和 FileFetcherServer 的必要源码复制到临时目录，只处理合成文件。FileFetcherServer 的远端响应由进程内适配器模拟。临时目录在结束时清除。结构化输出见 [consumers.json](./consumers.json)。

| 场景 | 实测 |
| --- | --- |
| FileOperator 读取合成附件 | 本地绝对路径成功，原样 `file://` URI 返回 `ENOENT` |
| FileOperator 读取和更新合成 History | 标准 POSIX 路径成功，只修改第一条命中的 assistant 文本 |
| Linux 上将首发 prefix 的 History 路径交给 FileOperator | 原样路径含反斜线，读取和更新均返回 `ENOENT` |
| Windows 路径 | 同一 prefix 生成的路径符合 `path.win32` 拼接语义。实际 Windows 工具行为尚未验证 |
| FileFetcherServer 解析合成附件 URI | 本地文件返回原始 URI。模拟远端收到完整 URI，首次返回缓存 URI，重复解析命中缓存。验证了缓存文件字节 |

## 路径归属

- **本机上下文。** 单聊首发、重新回复、继续发言和 Flowlock 复用 [chatContextPipeline.js](../../../apps/desktop/modules/chat/chatContextPipeline.js)。默认 prefix 在有系统提示、agentDataPath 和 topicId 时提供物理 History 路径。调用可覆盖 prefix。附件 URI 给 Agent 工具定位文件，本地上下文还单独按需读取实时文本与媒体帧。
- **History 文件工具。** 作者的 [FileToolBox.txt](../../../apps/server/TVStxt/FileToolBox.txt) 公开 `FileOperator.UpdateHistory(filePath,target,replace)`。[FileOperator.js](../../../apps/desktop/VCPDistributedServer/Plugin/FileOperator/FileOperator.js) 按允许目录检查更新操作，直接读取并回写实际 JSON。HistoryMutationQueue 独立管理原生 History 变更。FileOperator 的 ReadFile 和 FileInfo 还有绝对路径只读放行规则。
- **附件传输。** [Plugin.js](../../../apps/server/Plugin.js) 在非分布式工具参数中解析 `file://`，由 [FileFetcherServer.js](../../../apps/server/FileFetcherServer.js) 保留本地 URI 或返回缓存 URI。分布式插件接收原参数，是否识别 URI 由对应消费者决定。[VCPDistributedServer.js](../../../apps/desktop/VCPDistributedServer/VCPDistributedServer.js) 的内部文件请求支持 URI 到路径转换。
- **共享上下文。** [sharedSessionClient.js](../../../apps/desktop/modules/services/nativeSync/sharedSessionClient.js) 的服务端单聊仅接纳符合条件的纯文本发送。附件和需要桌面上下文的请求可走 [sharedRuntime.js](../../../apps/desktop/modules/services/nativeSync/sharedRuntime.js) 中的桌面执行分支，复用本机上下文组装。[effectiveContext.js](../../../apps/server/Plugin/NativeSync/mobile/effectiveContext.js) 从 Journal 和配置组装服务端单聊，[attachments.js](../../../apps/server/Plugin/NativeSync/mobile/attachments.js) 从 CAS 组装附件输入。共享群聊的服务端 watcher 使用 Journal 标识和 `filePath:null`。调用者自行写入 prompt 的路径仍取决于输入与上下文规则。
- **工具调度。** [vcpClient.js](../../../apps/desktop/modules/vcpClient.js) 的 `enableVcpToolInjection` 控制 URL 切换，[server.js](../../../apps/server/server.js) 的两个 completion 入口进入同一工具处理器。普通桌面共享发送可进入工具调度，实际可用性受节点、插件和审批影响。显式禁止工具的标记由 [chatCompletionHandler.js](../../../apps/server/modules/chatCompletionHandler.js) 消费。受控模式对分布式工具另有准入限制。

验证范围限于仓库源码、Linux 文件读写与模拟适配器。在线节点、部署审批配置和 Windows 运行未纳入验证。
