# VCPToolBox 开放 PR 的吸收记录

2026-11-28 核对 GitHub 的开放 PR 及文件树。本轮 ToolBox 主线固定为 `699ed4b3a0c0b08124cb8f8cf14f7e154f00af24`，以下八项均仍开放。新引入的插件随附源码，发现清单保持 `.block`。原有业务配置和真实凭据均不在导入范围内。

| PR 与 head | 候选处理 | 源码与验证边界 |
| --- | --- | --- |
| [#667](https://github.com/lioensky/VCPToolBox/pull/667) · `385d5920` | 吸收 | 标签一致性服务、管理界面及测试的五个文件与 PR head blob 一致。实跑覆盖部分向量失败后仅补缺项、计划过期后的向量复用、差分变化后重新确认、连续写入时停止提交；这些分支的标签服务测试使用受控嵌入结果和计划。 |
| [#664](https://github.com/lioensky/VCPToolBox/pull/664) · `06646fab` | 吸收 | 根地址和末尾已有 `/v1` 的地址均产生一个版本前缀。用真实 GPTImageGen 子进程、临时文件和回环 HTTP 服务核对生成、编辑、聊天路径。 |
| [#660](https://github.com/lioensky/VCPToolBox/pull/660) · `68523d75` | 吸收 | 原生 PluginManager 对错误实体执行隐私过滤后抛出。ToolExecutor 从结构化 `result` 生成模型视图，保留审核留言和失败结算。本地回归另测深层嵌套的合成凭据被原生隐私守卫截断。 |
| [#662](https://github.com/lioensky/VCPToolBox/pull/662) · `d333a636` | 吸收 | 16 项插件的资源输出遵循显式 `USE_PUBLIC_URL` 选择；关闭时沿用原本机地址与端口，开启时优先使用配置的公网地址。仅导入公开源码和适用的模板。针对 URL 选择、尾斜杠和回退运行插件回归；没有把生成资源发布到公网。 |
| [#661](https://github.com/lioensky/VCPToolBox/pull/661) · `9249abbf` | 保留当前主线 | 该改动从普通路径缓存键去掉请求来源，并扩大 FileOperator 的 MoveFile 源目录例外。不同节点可能有相同路径、不同内容，节点资源身份不能从同名条目或代理的一跳连接推导。保留既有缓存区分和路径检查。 |
| [#663](https://github.com/lioensky/VCPToolBox/pull/663) · `343c559b` | 合并进 BilibiliFetch | 短链解析归一化视频地址并保留有效分 P 参数；重定向测试使用受控响应。 |
| [#665](https://github.com/lioensky/VCPToolBox/pull/665) · `eae1d466` | 合并进 BilibiliFetch | 获取视频信息、CID 及分 P 回退；与短链和公网资源配置合并。 |
| [#666](https://github.com/lioensky/VCPToolBox/pull/666) · `b5c4e2c5` | 合并进 BilibiliFetch | 分段弹幕获取和按视频时间采样。与视频信息、内容选项的 Python 用例合跑，网络响应使用夹具。 |

验证使用 Linux x64、Node 24 与 Python。七个 Node 测试文件合计 31 项通过，Bilibili 的 Python 用例合计 18 项通过。

```sh
cd apps/server
node --test tests/kbmAuditRegression.test.js tests/kbmVectorRepairBackoff.test.js tests/adminRagMaintenanceRoutes.test.js tests/toolExecutorErrorResult.test.js tests/gptImageGenBaseUrl.test.js tests/pluginPublicUrl.test.js tests/bilibiliShortUrl.test.js
python -m unittest discover -s tests -p 'test_bilibili*.py'
```
