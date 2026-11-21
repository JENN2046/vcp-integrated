# 共享压缩输入 API 对照

两次运行均通过现有的隔离 ToolBox 夹具启动实际后端，使用回环合成 Provider。固定三个用户输入、时间戳、Provider 回复、编辑正文、操作顺序和桌面主体。每次启动都重建隔离数据，ToolBox 分配的 Work 和原生请求 ID 随运行变化。JSON 回执记录正式消息 ID、正文 SHA-256、压缩请求的 sourceHash、运行目录中的相关源码 SHA-256 及探针 SHA-256。候选回执中的 revision 是运行时检出的 HEAD，加载文件哈希对应本次候选工作区中的实际内容。

| 读取时点 | 基线 `96b1114d47e2` | 修复候选 |
| --- | --- | --- |
| 编辑前 | 一个原文正式助手行 | 一个原文正式助手行 |
| 编辑后 | 正式助手行是新文，同一 Work 的原文经原生证据返场 | 仅正式助手行的新文 |
| 删除后 | Journal 已写同 ID 的 delete，原文仍出现在压缩输入 | Journal 已写同 ID 的 delete，压缩输入无该助手内容 |
| 两个后续独立 Work 发布同文 | 两个正式助手行均存在，ID 各异 | 两个正式助手行均存在，ID 各异 |
| 编辑其中一个同文回复 | 被编辑 ID 更新，另一 ID 保留原文 | 被编辑 ID 更新，另一 ID 保留原文 |
| 删除被编辑的同文回复 | 仅保留另一个独立 ID 的原文 | 仅保留另一个独立 ID 的原文 |

[基线运行回执](baseline.json) · [候选运行回执](candidate.json)

探针在读取后取消每个压缩意图。每次运行恰有三次用于生成这三条助手回复的 Provider 请求，原生归档证明在编辑、删除和各次读取后保持原哈希。当前发行策略中的受控单聊只开放纯文本。这个 API 对照覆盖三个真实的、各自有正式消息 ID 的原生助手事件。工具结果或无正式消息映射的原生事件需要其他夹具覆盖。

使用项目要求的 Node 24 以及现有 Linux 原生插件和移动端构建：

```sh
node tests/stage-review/compaction.cjs baseline > docs/evidence/compaction-input/pair/baseline.json
node tests/stage-review/compaction.cjs candidate > docs/evidence/compaction-input/pair/candidate.json
```

本次 `/tmp` 的用户配额不足以复制原生插件，运行时使用了 `TMPDIR=/dev/shm`。探针退出时关闭 ToolBox、回环 Provider 和数据库读取连接并回收自建数据目录。
