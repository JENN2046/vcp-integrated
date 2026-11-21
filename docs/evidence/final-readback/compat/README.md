# 末代回复读回兼容复验

在 Node 24.22.1 下对候选工作树执行三次隔离集成测试。ToolBox、共享 HTTP、SQLite、Journal 和原生回复发布均实际运行，模型使用回环合成响应，工具使用本地计数夹具。新客户端对旧服务器的回退由实际桌面 `SharedSteeringClient.finishStep` 经 HTTP 完成，桌面所有者和保存回调由夹具提供。回执记录实际加载的桌面客户端 SHA-256，并从 ToolBox 退出报告核对四个服务端模块。每次旧版升级前还核对原版模块。[机器回执](receipt.json)

- 当前版在派发前返回 `pending`。发布后读回原始正文与序号 5，人工编辑后读回修改正文与当前序号 6，人工删除后读回序号 7 与空消息。原序号和原正文哈希保持一致，强停重启后仍读到同一墓碑。
- 旧 B 在编辑和删除之后补交，以及重放原操作 ID，均取回发布序号 5。Journal 只有原发布、人工编辑和删除三条相关记录。
- 错执行端、Work、代次与回复 ID 分别返回 403、404、400、404。每次读回前后均核对 Work、原生请求状态、消息投影、Journal、共享回执数和已应用操作数。
- 历史 ToolBox `5ed51ba784bf` 缺省新能力，实际新客户端通过既有 `steering` 和 `steer-turn-complete` 路径完成。升级后旧回执精确重放仍可取回原序号，改动旧操作正文返回 `IDEMPOTENCY_KEY_REUSED`。已发布的旧 Work 也可通过新入口读回。
- 同一旧版若只有模型终态和归档正文，升级后返回 `review_required`，迟到 POST 被拦截，且没有正式回复。每次测试各有三次合成模型请求和一次本地工具执行。

从集成仓根执行以下命令。当前机器的 inotify 配额已耗尽，复用了现有空知识库监听回退，并启用 JS 文件轮询。

```sh
export FINAL_REVIEW_WATCH_FALLBACK=1
export FINAL_REVIEW_EVIDENCE=/tmp/vcp-final-readback-compat.json
node tests/shared-single-review/final.cjs
node tests/shared-single-review/final.cjs --legacy-with-receipt
node tests/shared-single-review/final.cjs --legacy-without-proof
```
