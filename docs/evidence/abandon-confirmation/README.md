# 桌面放弃确认刷新回归

四轮分别新建隔离 Profile 和共享话题。实际 Electron 44.9.3 启用沙箱，加载原生 CDS 和本地隔离 VCPToolBox。回环合成 Provider 对第一轮输入返回 HTTP 502。每轮都在原生状态面板里操作该轮原 Work，鼠标按下和勾选事件由 Chromium 派发并记录 `isTrusted`。

| 场景 | 原 Work 的确认框 / 按钮 | 原 Work 的放弃回执 | Provider 调用 |
| --- | --- | --- | --- |
| [基线立即点击](baseline-immediate/desktop-closeout.json) | 勾选、启用 | 1 次 IPC 成功，1 次 HTTP 200，admission 为 `abandoned`，Work 为 `cancelled` | 关闭时仍为原 502 一次，随后新轮另一次 |
| [基线经原生刷新后点击](baseline-after-refresh/desktop-closeout.json) | 同 Work 的行与控件被重建，取消勾选、禁用 | 可信鼠标按下命中按钮，0 次放弃 IPC，0 次放弃 HTTP，仍为 `review_required` | 仍为原 502 一次 |
| [候选立即点击](candidate-immediate/desktop-closeout.json) | 勾选、启用 | 1 次 IPC 成功，1 次 HTTP 200，admission 为 `abandoned`，Work 为 `cancelled` | 关闭时仍为原 502 一次，随后新轮另一次 |
| [候选经原生刷新后点击](candidate-after-refresh/desktop-closeout.json) | 同 Work 的行内容更新，原行和控件保持，勾选、启用 | 1 次 IPC 成功，1 次 HTTP 200，admission 为 `abandoned`，Work 为 `cancelled` | 关闭时仍为原 502 一次，随后新轮另一次 |

刷新由鼠标点击面板的「核对云端状态」触发。探针只读等候原生 `native-sync:executions` IPC 回执及同一 Work 所在列表的 DOM mutation。在候选 [刷新后截图](candidate-after-refresh/A-confirmation-after-status-refresh.png) 仍可见勾选，随后 [人工关闭截图](candidate-after-refresh/A-original-closed.png) 可对照 [基线刷新后截图](baseline-after-refresh/A-confirmation-after-status-refresh.png)。

关闭前后的原工作原生请求仍为 `unknown`。原尝试次数、用户消息、Journal 与 History 在关闭时保持不变。成功关闭的三轮均在同话题提交一个新 Work、保存一次新回复。重放原提交取得原 `abandoned` receipt，未产生额外 Provider 调用或持久变化。基线刷新失败的快照保留原 `review_required` 工作，随后关闭整套合成运行环境。

## 复跑

需要 Linux x64、Node 24、Xvfb、可启用沙箱的 Electron、锁定依赖和项目构建资产。可用 `XVFB_BIN`、`ELECTRON_BIN` 选择本机工具。四轮使用仓库的空文档 watcher 测试预加载。

```sh
NS_ABANDON_CONFIRMATION=immediate node tests/shared-single-review/upstream-closeout-desktop.cjs
NS_ABANDON_CONFIRMATION=refresh-before node tests/shared-single-review/upstream-closeout-desktop.cjs
NS_ABANDON_CONFIRMATION=refresh-after node tests/shared-single-review/upstream-closeout-desktop.cjs
```

前两条在固定 `ed75977a28c1da626bc9aff6fcef5ce56f43955e` 的独立检出执行，只带入本次 `abandon-confirmation-desktop.cjs` 及其场景接入。候选执行第一和第三条。每轮通过 Chromium Debugger 读取实际加载的 renderer 脚本，并核对源码哈希。目标文件为 `apps/desktop/modules/renderer/nativeExecutionStatus.js`，基线 SHA-256 为 `026d01c78d9a883a84f06805750fe26211028b16eb60ff13fec25fe8ecffaf24`，候选 SHA-256 为 `1daab2ea5cb877a7cea4416b8cd545c381e88224da902eb80cd06de00e6f2831`。

完整合成输出按上表顺序位于 `/tmp/vcp-integration-T90omT`、`/tmp/vcp-integration-tWokRd`、`/tmp/vcp-integration-eIBlqZ`、`/tmp/vcp-integration-rb4F5u`。各轮 Electron、ToolBox 和 Xvfb 已退出。隔离基线检出保留在 `.runs/abandon-confirmation-base`，用于本批复跑。其生成的桌面规则、portable owner 与预加载可按项目构建脚本重建，依赖和原生构建产物复用了本地构建。
