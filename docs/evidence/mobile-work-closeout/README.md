# 手机只读冷开核对共享单聊 Work

Android 16 原手机，隔离用户 12，已安装的 Firefox PWA。以测试库副本复用原配对，只授予共享空间读取权限。隔离桌面运行基线 32fe47a6dc86，测试 ToolBox 与旧 PWA 来自 a2a13b53555c，两版的服务端和手机源码一致。

桌面实发一条共享单聊，本地合成 Provider 返回一次 502。选定话题后，每次都强停用户 12 的 Firefox，从已安装入口冷开。三次读取使用同一 sessionMarker、话题、Work 和用户消息，Firefox PID 各不相同。三次手机执行卡都没有处置控件。

| 冷开时点 | 中央与手机 |
| --- | --- |
| [待核对](original-pending.json) · [截图](original-pending.png) | Work 为 review_required，卡片提示核对可能的工具副作用，历史只有用户原文。 |
| [桌面结清后，原版](original-closed.json) · [截图](original-closed.png) | 准入为 abandoned，Work 为 cancelled、review_resolved 为 1。旧错误码覆盖了标题，仍然提示需要确认。 |
| [同一 Work，修复版](fixed-closed.json) · [截图](fixed-closed.png) | 同一中央数据，重新构建 PWA 并在隔离服务更新静态资产。卡片标题为「已人工结清，剩余工作已放弃」，下方保留工具副作用说明。 |

[中央与桌面结清回执](central.json) · [逐次比对](comparison.json)。桌面一次结清得到 HTTP 200；原生请求始终为 unknown，正式回复为空。测试结束后已停止隔离服务、移除本轮 USB 转发并切回机主，保留用户 12 的 Firefox PWA。
