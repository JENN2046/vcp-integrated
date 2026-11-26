# VCP Core 文档导航

> 现行工程基线：Pilot 01-R，`0a1f35899294bceec3131e39bd92e71b45b984d7`。本文档按当前主线组织，不代表所有平台与功能已经通过正式发行验收。

本项目已从 NativeSync 跨端同步体系演进为由 ToolBox 直接管理的 VCP Core。新开发、部署与故障排查请优先从现行文档进入，避免沿用早期施工方案。

## 现行文档

| 文档 | 适用场景 |
| --- | --- |
| [项目首页](../README.md) | 产品定位、功能范围、构建入口和版本 |
| [ARCHITECTURE](ARCHITECTURE.md) | 运行架构、数据权威、Work 生命周期、身份与原生能力边界 |
| [Pilot 01-R 部署与配对](core-pilot-01-r.md) | Linux 服务端、远程 HTTPS、桌面/PWA 配对、数据库身份、备份恢复 |
| [独立本机 Core 启动记录](evidence/core-closeout/README.md#pilot-启动与产物) | 本机模式的构建与启动；数据库身份规则以 Pilot 01-R 部署文档为准 |
| [构建与测试](../README.md#快速开始) | Node 24、锁定依赖、原生组件及回归入口 |
| [开发方向](../README.md#开发方向) | 日用迭代、上游继承及独立兼容工作流 |

## 按任务查阅

| 我要做什么 | 从这里开始 |
| --- | --- |
| 理解 Core 的代码组织与权威边界 | [架构说明](ARCHITECTURE.md) |
| 新建本机或远程个人工作空间 | [运行模式](ARCHITECTURE.md#运行形态与接入) · [部署说明](core-pilot-01-r.md) |
| 接入已有 Agent、迁移历史与附件 | [数据归属与迁移](ARCHITECTURE.md#存储检索与历史迁移) |
| 排查数据库身份变化或进行冷备 | [数据库身份、备份与恢复](core-pilot-01-r.md#数据库身份备份与恢复) |
| 核对日用候选的实际验证范围 | [远程联验](evidence/core-pilot-01-r/remote.json) · [日用风险回执](evidence/core-pilot-01-r/pilot-risk.json) |
| 追溯早期实现、决策或工程证据 | [历史档案索引](archive/README.md) |

## 阅读规则

- 现行说明描述当前实现；固定版本及其源码决定该版本实际行为。
- 历史方案、阶段报告和验收证据是当时的记录，不自动成为现行设计或最新测试结论。
- 原始证据留在 [evidence/](evidence/)。历史分类索引不移动这些文件，不修改其结论。
- 公开仓库的文档不记录私人部署地址、凭据、原始日用历史或真实设备会话。
- 上游来源与许可证见 [NOTICE](../NOTICE.md)、[provenance](../provenance) 与 [LICENSES](../LICENSES)。
