# 原生 Agent 配置保存的前后对照

使用两个隔离的 Linux VCPChat Electron 客户端、各自的 CDS 和一个 ToolBox / SQLite。本机组的 A 使用未加入共享空间的 Agent 资料。共享组使用现有 `config-only` 夹具，A、B 使用不同资料和设备身份。两组都从原生界面操作。基线固定在 `1eb2a27`，候选在相同归档上只替换 `nativeConfigSave.js`。所有操作使用合成资料。每组的 Provider 调用为 0。

测量在 Electron 主进程的原生保存调用范围内运行。调用仍由应用原有代码处理。探针以 `WeakMap` 为响应对象分配进程内引用编号，并记录每次 `validateConfig` 的调用点、引用编号、对象 ID、版本和配置 hash。它另行记录原生文件写入的调用者，从磁盘读取 `config.json` 和旁文件的 hash，从中央 SQLite 读取版本及带设备身份的回执。

| 实际操作 | 写入结果 | 保存前 GET 校验次数，基线 → 候选 |
| --- | --- | --- |
| A 本机 Agent 完整表单改名 | `saveLocal` 经 `AgentConfigManager` 更新 `config.json` 并保留备份。中央版本和回执计数均不变 | 0 → 0 |
| A 共享 Agent 完整表单改名并裁剪头像 | ToolBox 接受 A 的一次提交并增加一个版本。A、B 的原生投影名称和头像一致。A 的表单附加字段经原生配置管理器写入 | 2 → 1 |
| B 先改名，A 提交旧版本 | ToolBox 只为 B 增加一个版本。A 收到 409，启动器保留输入，草稿保持 conflict。已确认的 B 配置仍可投影到磁盘 | B 2 → 1，A 2 → 1 |
| A 保存被接受，响应丢失，再按原名称提交 | 第一次提交只增加一个版本并保留原 `opId` 的待确认草稿。重放使用同一请求体和 `opId` 返回原回执，两端投影收敛 | 首次 2 → 1，重放 0 → 0 |

基线四次首提交中，`SharedRuntime.observeConfigs` 与随后由 `saveShared` 调用的 `SharedConfigReplica.validate` 都校验了同一对象引用，ID、版本及 hash 逐项相同。候选每次保留前一处校验。成功提交的回执校验、接收和投影恢复校验仍各自运行。具体调用栈、文件 hash、中央版本及回执主体见 [对照回执](./receipt.json)。

使用仓库集成环境的 Node 24、Xvfb 与 Chromium 沙箱。从候选目录提供同一份探针和 Electron 包装器。基线运行时把探针的绝对路径指向候选目录，保持基线归档源码原样。分别以 `config-only` 和 `local-only` 运行，基线使用 `NS_CONFIG_BASELINE=1`，候选使用 `NS_CONFIG_BASELINE=0`。

```bash
NS_CONFIG_BASELINE=0 node \
  --require ./docs/evidence/native-config-write-path/config-probe.cjs \
  tests/integration/run.cjs config-only
NS_CONFIG_BASELINE=0 node \
  --require ./docs/evidence/native-config-write-path/config-probe.cjs \
  tests/integration/run.cjs local-only
```

候选截图依次展示 [本机表单保存](./local-native-config-saved.png)、[共享表单合并保存名称和头像](./native-name-avatar-one-save.png)、[版本冲突保留草稿](./quick-name-conflict.png)和[重放后恢复](./quick-name-recovered.png)。丢回执期间，B 后台投影与 A 待确认状态独立推进。两次运行的中间采样点可能分别落在 B 的原生文件写入和投影账本更新之间。重放后，两端磁盘和账本均确认到中央版本 2。

另用真实回环配置接口返回正文与 hash 不匹配的合成 GET。原生 Agent 表单返回 `SHARED_CONFIG_RESPONSE_INVALID`，没有发起配置 POST，没有进入本机保存分支，Agent 文件和中央对象保持原值。[原生入口回归](../../../tests/native/native-config-save-receipts.test.cjs)
