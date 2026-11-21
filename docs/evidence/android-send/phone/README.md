# Android 16 实体设备 PWA 发送与冷开

验收使用 USB 连接的 Android 16 实体设备与系统 WebView 157.0.8103.50。临时 WebView 只访问回环 HTTPS ToolBox，使用本轮 CA 及一次性配对。数据均为隔离夹具。发送、配对、核对和附件预览均经过 PWA 界面控件。脚本将合成 Web File 交给网页文件输入，因此覆盖网页选入后的上传、草稿和提交路径。Android 系统文件选择器另未验证。

## 基线

`b02867a` 的 PWA 上传了 `fixture-note.txt` 并提交一条含桌面专用模板内容的消息。真实服务原生返回 `409 DESKTOP_CONTEXT_REQUIRED`，按请求 ID 查询返回空，中央 Work、Journal、附件关联、Provider 和工具调用均为空。手机在拒绝后显示可编辑原文和已上传附件。同一应用强制停止再打开后，原配对与话题仍可用，原文为空、附件为空，发送按钮不可用。

[拒绝时的设备状态](baseline-rejected.json) · [冷开后的设备状态](baseline-reopened.json) · [服务端事实](baseline-server.json)

## 修复版

实机加载 `index-CEYqWIUX.js`。一次性配对后等待其落盘，先强停重开一次并确认原会话可用，再开始用例。在换版的早期探跑中，首次配对后数秒就强停曾返回未配对状态。正式用例从新客户端 Profile 开始，并在同一配对下完成各次强停重开。

- 同样的 409 再次返回空 Work。强停后打开原话题仍显示原文、一个已上传附件槽及可用的发送按钮。冷开时附件槽使用通用标签。仅编辑文本，然后发送一次。服务端使用相同上传 ID，无第二次上传。历史显示一个用户输入、一条助手回复，附件预览显示原文件名和真实合成正文，附件 SHA-256 与中央关联相同。
- 第二条消息只提交一次，隔离代理丢弃真实 202 回执，同时暂缓对应请求的精确查询。强停再开仍显示同一待核对请求，发送禁用。放开查询后，PWA 自动按原请求 ID 确认同一已完成 Work。恢复前后 Work、Journal、Provider 和工具调用列表完全一致。两条已接受消息各有一个 Work、一次执行尝试、一个真实普通工具调用。每个 Work 的两次模型调用分别对应工具请求和读取工具结果。
- 实体 PWA 四条可见消息的 ID 与中央 Journal 顺序一致。

[拒绝时的手机截图](candidate-rejected.png) · [草稿冷开](candidate-draft-reopened.png) · [附件预览](candidate-attachment-preview.png) · [丢回执冷开](candidate-lost-ack-reopened.png) · [原请求完成核对](candidate-lost-ack-confirmed.png) · [最终服务端记录](candidate-final-server.json)

临时 APK 已卸载。本轮 ADB reverse 和 CDP forward 均已移除，ADB 转发列表为空。[清理回执](cleanup.json)
