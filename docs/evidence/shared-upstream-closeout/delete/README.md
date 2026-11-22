# 共享单聊 502 原消息删除的双端桌面验收

两轮均用 Linux 上的真实 Electron 44.9.3 沙盒和真实 CDS。A、B 使用独立的合成 Profile，通过回环连接真实 ToolBox。合成流式 Provider 对首条消息返回 502，对同话题下一条消息返回正常 SSE。

| 阶段 | 基线 `526809f27e1a` | 候选 |
| --- | --- | --- |
| 原作者右键并确认删除，Work 待核对 | A 报 `EXPLICIT_DELETE_REQUIRED`，气泡从 A 的界面消失。B 界面和双方物理 History 保留该行，A 重开后恢复。 | ToolBox 返回 `SHARED_TOPIC_BUSY`，A 提示“话题仍有未结清的请求，处理后再删除”。A、B 仍显示原行，中央 Journal、两份 History 和原 Work 记录均一致。 |
| 原作者人工结清后再次右键并确认 | 仍报 `EXPLICIT_DELETE_REQUIRED`，A 界面再次乐观移除，A 重开后原行恢复。 | ToolBox 返回 HTTP 200，Journal 追加原消息 ID 的墓碑。A、B 界面及物理 History 移除该行。A 关闭后用同一 Profile 重开，原行仍保持删除。 |
| 结清后的执行和续发 | 基线对照止于第二次拒绝和重开。 | 删除前后旧 Work 均为 `cancelled`，准入为 `abandoned`，原生请求仍是 `unknown`。同话题下一笔 Work 完成一次调用和一次发布。原请求重投返回同一个旧 Work 和 `replayed: true`，Provider 合计两次请求，工具调用记录为零。 |

候选通过 `node tests/shared-single-review/upstream-delete-desktop.cjs` 运行，使用 Node 24、已构建的运行资产及 `NS_FIXTURE_POLL_WATCHERS=1`。基线用 `git archive 526809f apps/desktop` 组装独立桌面目录，只复用构建依赖和必要生成文件。运行时另外设置 `NS_UPSTREAM_DELETE_BASELINE=1`、`NS_UPSTREAM_DELETE_DESKTOP` 指向该桌面目录，以及 `NS_UPSTREAM_DELETE_SERVER=$(git rev-parse 526809f)`。回执记录实际加载的服务端以及 Electron 主进程、渲染进程代码哈希。

[结构化回执](desktop-receipt.json) · [基线待核对删除后](baseline-pending-after-delete.png) · [候选待核对拒绝](candidate-pending-after-delete.png) · [结清后确认删除](candidate-settled-confirmation.png) · [B 同步删除](candidate-mirror-deleted.png) · [A 重开](candidate-reopened.png)

第 8 批原库使用 immutable 只读连接验证，原输入仍存在，原作者与 Journal 原序号符合候选规则。旧版尚有未发布错误意图的记录也通过独立升级实测。正常共享助手回复、本机单聊助手回复的已有菜单验收均复跑通过。[原消息资格回执](original-eligibility.json) · [权限、版本和旧库回执重放](server-authorization.md)
