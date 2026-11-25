# VCP Core M1 隔离开发

本切片将共享工作空间的普通单聊交给同进程 Core。ToolBox 继续执行原生预处理、模型请求和同步工具循环。Core 持有 Work 的取消信号、请求身份、SQLite 正式消息、工具执行状态和恢复决策。桌面与 PWA 使用同一套命令、查询和 SSE。桌面正式历史视图读取 Core 投影，观察流与 Resident 展示留在瞬态界面。

## 启用

使用 Node 24、已有的 NativeSync 隔离开发配置、已批准的空共享工作空间、两个测试客户端 Profile。通过当前宿主的正常私有启动方式设置以下两个变量。

- `VCP_CORE_WORKSPACE` 填现有开发共享空间的 ID。
- `VCP_CORE_DATA_DIR` 填独立的绝对目录，与旧 NativeSync 数据目录分离。

宿主会检查开发空间的旧单聊历史与执行是否为空。首次启用会记录该工作空间的 Core 归属。此后即使 Core 没启动，该空间的普通单聊也会提示不可用，旧执行入口仍处于封闭状态。评估旧版请使用连到另一独立数据库的原分支。群聊及其现有执行入口继续按原工作空间授权运行。

桌面通过绑定的 source 和设备认证，PWA 通过现有配对会话及权限认证。已认证的桌面和 PWA 均可观察正式消息与执行。取消和释放待核对 Work 需要原提交主体，追加补充输入需要该空间 execute 权限。追加输入会在当前原生轮确定完成后进入下一轮，Work ID 不变。图片通过现有受控上传和哈希读取接口处理。

## 验证入口

```sh
npm run build:mobile
node tests/run-host-suite.cjs native --test-name-pattern='^Core '
npm run test:collaboration -- --test-name-pattern='Core single chat PWA'
```

测试使用隔离数据和本地合成上游。WebTransport 独立结果见 [M0 探针](../probes/webtransport/README.md)。

## 当前边界

- 基线缺少生产 `HumanClientAdmission` 和 `ApprovalReceiptAuthority` 接线。普通审批沿用 ToolBox；要求可信人类凭据的 Core 工具调用返回 `CORE_TRUSTED_APPROVAL_UNAVAILABLE`。
- AGENTS OS Resident 保持可选。Presence 校验与 Provider Seal 放在 Resident 扩展模块。Core 接收由扩展验证的瞬态展示。目标基线没有已安装 Resident 插件的运行验证资产。
- 群聊、AA、异步工具、压缩、桌面专用上下文和真实历史导入未迁移。Core 单聊不走这些能力的旧执行入口。
- Windows 打包、实体手机、真实多模态模型和生产可信审批仍需独立验收。
