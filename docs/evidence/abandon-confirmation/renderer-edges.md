# 桌面结清确认的渲染器边界

从仓库根目录执行：

```sh
node --test apps/desktop/tests/shared-abandon-confirmation-edges.test.mjs
```

测试加载实际 `nativeExecutionStatus.js`，由 JSDOM 提供 DOM，合成状态快照和 IPC 响应。测试会记录发往替代 IPC 接口的参数与次数。真实桌面点击和服务端结清回执由本目录的 Electron 验收覆盖。

| 场景 | 验收行为 |
| --- | --- |
| 同一 Topic、Work 与 request，保持在线和可结清 | 主动刷新保留已连接的原勾选控件与按钮，首次提交准确调用一次 |
| Work ID、request ID 或 Topic 变化 | 新对象需重新勾选，旧控件无法调用结清 |
| 只读、撤销结清权限或离线 | 控件隐藏或禁用，先前的勾选失效，恢复资格后重新勾选 |
| 结清等待 IPC 响应时收到同一 Work 的状态 | 新旧控件都无法重复提交。唯一调用带原 Topic、Work、request 与 `confirmed: true` |
| 同一单聊 Work 仍可结清，但等待响应期间状态从待核对变为排队 | 不会再次发送该请求。单聊 IPC 沿用 request ID，无群聊专用 Work ID 字段 |
| IPC 返回失败或 Promise 被拒绝 | 显示失败，恢复为未勾选；再次明确勾选可按原目标提交 |

修复后十项均通过。`ed75977` 上运行前九项均在相应保护点失败。同一 Work 刷新清除了勾选，注入已脱离 DOM 的旧控件点击仍会进入旧处理函数，等待响应时刷新后的控件可以再次启用。脱离 DOM 的点击用于检验渲染器处理函数的边界。

第十项在初版修复中观察到重复 IPC。待响应检查按 Topic、Work 与 request 绑定后，通过同样的测试。
