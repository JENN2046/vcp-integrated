# 历史故障库升级验证

以阶段复审留下的两份合成数据为输入。两条 Work 都由 `f00aa6d256a2bb7ef7fbc65fb2002728be7fea5c` 版本产生，提交文本均为 `AA_DELEGATION_COMPLETE`。脚本核对原始运行回执、Git 中的阶段复审回执、Work、成员账本和 Journal。SQLite 通过只读连接和 Online Backup API 复制 `data/central.sqlite` 与 `runtime-box/config/tool-call-records.sqlite3` 的一致快照，包含 WAL 内已提交的数据。每个副本在独立 ToolBox 运行目录中启动，并带入对应 Work 的合成 AgentAssistant 归档、原生回执和异步结果。配对由测试重新完成。

- late 复用 `.runs/vcp-stage-uncut-gpewAV`，Work `request_f90bcb286bfb4c8e92c6f32311e98f15`。原版本的恢复仍在 `groupTurn.recover` 报 `SHARED_NATIVE_TERMINAL_REQUIRED`，NativeSync 初始化失败。
- early 复用 `.runs/vcp-stage-uncut-aVJ07b`，Work `request_b308c3ae3aa44eb6838a40561fc9e263`。原版本可启动，移动 Work 仍是 `review_required / GROUP_PLAN_REVIEW_REQUIRED`。

停止原版本后，在同一个隔离目录中换入修复后的已跟踪 NativeSync 源码。换代码前后的数据库主文件、WAL 摘要和 inode 一致，修复后的真实 ToolBox 打开同一个副本。回执记录五个变更模块在运行时的实际加载摘要。两条 Work 都结算为 `completed`，Work、请求、消息、原生任务、工具调用及成员账本的身份和内容保持一致。Chrome PWA 可读取已结算 Work、原四条消息以及与历史结果摘要一致的 AA 报告。显式提交新一轮前，观察 4.4 秒，Provider 接收端和 ToolBox 工具记录均无新增，PWA 无执行写入。使用新标记 `AA_DELEGATION_DESKTOP` 提交后，同话题新一轮准入并完成，追加四条消息，Provider 收到五次模型调用，ToolBox 新增一条与该轮关联的 AA 工具记录。[late 回执](late.json) · [early 回执](early.json)

复跑需要 Node 24、Chrome、OpenSSL、服务端依赖、原生 Vexus addon、已构建的移动端，以及上述原始合成运行目录。

```sh
node tests/group-settlement/upgrade.cjs late .runs/vcp-stage-uncut-gpewAV docs/evidence/group-settlement/upgrade/late.json
node tests/group-settlement/upgrade.cjs early .runs/vcp-stage-uncut-aVJ07b docs/evidence/group-settlement/upgrade/early.json
```
