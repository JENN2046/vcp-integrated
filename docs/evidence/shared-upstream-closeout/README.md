# 第 8 批 502 修复的集成主线验收

集成主线从 `b5648e96d883` 快进到其直接子提交 `526809f27e1a`。故障来自第 8 批真人验收：本机模型服务退出，转发连接被拒，ToolBox 把上游 502 包装成带 `X-VCP-Upstream-Status: 502` 的 HTTP 200 SSE，并以 `stop` 结束错误说明。现场原请求只有用户消息落入 Journal。[现场原 Work 与人工结清回执](../three-device-work-trial/live-502-closeout.json)

同一个服务端夹具在两版各运行一次，都向真实 ToolBox 提供一个 502。每版均记录了真实 SSE、第一次发送后的两本账、按原请求重投后的状态，并逐项对照了 33 个已加载服务端源码文件的 SHA-256。[服务端对照回执](server-comparison.json)

| 观察位置 | 修复前 `b5648e96d883` | 修复后 `526809f27e1a` |
| --- | --- | --- |
| 中央 Work / 准入状态 | publishing / review_required | review_required / review_required |
| 准备发布的操作 | 含 502 错误正文的助手消息 | 空 |
| 正式消息及执行事实 | 仅原用户消息；原生请求 unknown | 仅原用户消息；原生请求 unknown |
| 同 ID 重投 | 返回原 Work，Provider 累计 1 次 | 返回原 Work，Provider 累计 1 次 |

原生宿主回归 309 项通过，6 项依赖外部历史压缩夹具的用例默认跳过；协作套件 60 项通过。

真实 Electron 端通过原生确认按钮结清了同一笔待核对 Work。旧准入变为 abandoned，执行变为 cancelled，原生 unknown 保留，期间 Provider 次数不变。随后同话题由原生发送按钮提交新 Work 并完成一次有效 SSE，桌面物理 History 与中央 Journal 都只含原输入、新输入及新回复。再以原请求体、原请求 ID 提交时，服务器返回原结清 Work 和 replayed=true，未产生第三次 Provider 请求。[桌面回执与截图](desktop/README.md)
