# TopicSponsor 的 River 引用

固定作者 VCPToolBox `d9233bc`、VCPChat `8a937038` 和集成基线 `e6fdf5b`。用同一组按顺序排列的源消息执行 `ReplyToTopic`。来源 ID 留在测试输入中，工具派发后按原始位置、角色、已有署名和逐字正文核对；目标 History 用投递回执的消息 ID 核对。作者的引用格式没有为每一行持久化源消息 ID，本批沿用这个边界。

| 原消息 ID | 来源 | 正文 | 作者与候选桌面冷开 |
| --- | --- | --- | --- |
| `river-source-0` | 青岚，助手 | 蓝色样本按原计划保留，等下一轮确认。 | 第 1 行，青岚（助手），正文一致 |
| `river-source-1` | 无显示名，用户 | 收到。 | 第 2 行，用户，正文一致 |
| `river-source-2` | 白露，助手 | 蓝色样本按原计划保留，等下一轮确认。 | 第 3 行，白露（助手），正文一致 |

基线走通用语义筛选，在工具派发前丢失短消息「收到。」。把同一组输入改为 `last:3` 可找回这条消息，但两个具名行到达桌面后都显示为“助手”。作者与候选的 TopicSponsor 从最近的消息窗口取引用，显式 `last:N` 使用指定窗口，其余已启用的 River 模式使用最近五条；仅转发对话角色、可见文本和已有署名。普通工具保留原有语义检索。直接传入的 `river_context` 由执行器清除。[工具派发、返回和源码哈希](tool-trace.md)

集成桌面和共享 Journal 继续写 V1，在具名行保存可选的 `name`。桌面读取旧 V1 时沿用角色标签，也能读取作者实际生成的 V2。转发带既有 V1 或 V2 引用的消息时，保留本条留言，去除已经附带的引用。共享用例另验了目标 Journal 提交后丢失传输响应，重开后按原收据重放仅有一条消息。[共享收据与重放](shared-topic-sponsor.md)

在隔离 Linux Electron 中核对首次送达和进程冷重开，两次读到的 History 文件字节一致。旧 V1 行在同一话题中正常显示。各运行使用合成消息及本地工具传输。[桌面运行方法与全部截图](desktop.md) · [改前重开](baseline-desktop-reopened.png) · [修复后重开](candidate-desktop-reopened.png) · [候选读取作者 V2](candidate-desktop-author-v2.png)

另跑三次从真实 ToolExecutor 直接进入隔离桌面的单链验证。候选的工具返回、原生投递回执、磁盘 History 和冷开 DOM 使用同一条留言 ID `msg_e6006f63-c844-486f-8f7e-7a8993c7e132`。传输使用本机跨进程测试桥。完整原生套件通过 308 项、默认跳过 6 项旧压缩夹具；协作套件通过 60 项。[作者单链](author-chain-desktop.json) · [改前单链](baseline-chain-desktop.json) · [候选单链](candidate-chain-desktop.json)
