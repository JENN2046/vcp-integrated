# 历史档案与证据索引

> 本目录是分类导航，不是物理迁移。原始报告、截图、测试回执及其路径完整保留在原位置；原始 Git 历史与固定标签不变。历史结论只适用于对应版本、范围和验收条件。

阅读当前实现请返回 [文档导航](../README.md) 或 [现行架构](../ARCHITECTURE.md)。

## 阶段演进

| 阶段 | 代表性检查点 | 历史意义与原始材料 |
| --- | --- | --- |
| NativeSync 整合 | `223270b`（原整合主线） | 跨端同步、中央 Journal、执行接续与原生规则集成。[整合成果](../integration-result.md) · [当时后续安排](../integration-next.md) · [历史分支](https://github.com/JENN2046/vcp-integrated/tree/codex/integration-main) |
| M0 | `e7f9c93` | WebTransport 本机探针；远程、Windows 和证书验收证据不足，Core 继续 HTTP + SSE。[探针](../../probes/webtransport/README.md) |
| M1 / M1-R1 | `dd395e3` / `579be87` | 普通单聊正式会话及 Work 权威切换，真实桌面与手机隔离联验。[开发说明](../core-v1-development.md) · [验收](../evidence/core-m1-r1/README.md) |
| M2 / M2-R2 | `e21fa4f` | 原生上下文、文档附件、AA、TopicSponsor、Flowlock 与压缩。[施工记录](../core-v1-m2.md) · [验收](../evidence/core-m2-r2/README.md) |
| M3 | `af5b8f9` | 常规群聊、历史导入、CDS/Tantivy 选型。[验收](../evidence/core-m3/README.md) |
| M4 | `03039ad` | CDS、DeepMemo、TopicMemo、JEV、斗地主及群聊原生能力接线。[验收](../evidence/core-m4/README.md) |
| RC-01 | `ead84e2`（产物）/ `bcb03a8`（补充验收） | Linux 整套运行、Windows 客户端安装启动、外部 JEV、脱敏历史样本。[验收](../evidence/core-rc01/README.md) |
| Pilot 01 | `1b20a0d` | 本机 Core 脱离 NativeSync 运行时。[验收](../evidence/core-closeout/README.md) · [固定标签](https://github.com/JENN2046/vcp-integrated/tree/vcp-core-v1-pilot-01) |
| Pilot 01-R | `c08fa7f` | 独立远程接入、实体 Android、桌面冷读回。[回执](../evidence/core-pilot-01-r/remote.json) |
| Pilot 01-R 日用候选 | `0a1f358` | 删除、提示词绑定、数据库身份和备份恢复收口。[回执](../evidence/core-pilot-01-r/pilot-risk.json) · [固定标签](https://github.com/JENN2046/vcp-integrated/tree/vcp-core-v1-pilot-01-r) |

表中的检查点指对应阶段的代表性提交，不代表整阶段的所有变更仅来自该提交。

## 历史施工文档

以下文件保留原正文和链接，只添加历史提示。它们不再是新 Core 默认部署或待办清单。

| 文件 | 归类 |
| --- | --- |
| [integration-next.md](../integration-next.md) | NativeSync 旧路线的计划，已被 Core 主线取代 |
| [integration-result.md](../integration-result.md) | 早期三端整合成果 |
| [core-v1-development.md](../core-v1-development.md) | M1 隔离开发 |
| [core-v1-m2.md](../core-v1-m2.md) | M2 阶段施工 |
| [WebTransport 探针](../../probes/webtransport/README.md) | 独立技术验证，保留当时 No-Go 结论 |

## 原始验收证据分类

以下按目录名称和历史阶段组织，提供查阅入口；并非重新审计每份回执。所有目录仍处于 `docs/evidence/` 下，不移动文件或修改测试夹具。

### Core 阶段原始证据

- [core-closeout](../evidence/core-closeout/)
- [core-m1-r1](../evidence/core-m1-r1/)
- [core-m2-r2](../evidence/core-m2-r2/)
- [core-m3](../evidence/core-m3/)
- [core-m4](../evidence/core-m4/)
- [core-pilot-01-r](../evidence/core-pilot-01-r/)
- [core-rc01](../evidence/core-rc01/)

### 旧版整合候选、交付与升级

- [final-readback](../evidence/final-readback/)
- [group-review-closeout](../evidence/group-review-closeout/)
- [release-75ef3d4c5cb8](../evidence/release-75ef3d4c5cb8/)
- [release-9890ce016598](../evidence/release-9890ce016598/)
- [release-a2a13b53555c](../evidence/release-a2a13b53555c/)
- [release-c1b8ffc6272f](../evidence/release-c1b8ffc6272f/)
- [shared-upstream-closeout](../evidence/shared-upstream-closeout/)
- [stage-review](../evidence/stage-review/)
- [three-client-candidate](../evidence/three-client-candidate/)
- [three-device-work-trial](../evidence/three-device-work-trial/)

### 旧版执行、审批与工具连续性

- [aa-delegation](../evidence/aa-delegation/)
- [aa-handoff](../evidence/aa-handoff/)
- [abandon-confirmation](../evidence/abandon-confirmation/)
- [approval-restore](../evidence/approval-restore/)
- [desktop-stream-close](../evidence/desktop-stream-close/)
- [final-work-receipt](../evidence/final-work-receipt/)
- [idle-review](../evidence/idle-review/)
- [local-stream-interrupt](../evidence/local-stream-interrupt/)
- [long-stream](../evidence/long-stream/)
- [mobile-undispatched](../evidence/mobile-undispatched/)
- [mobile-work-closeout](../evidence/mobile-work-closeout/)
- [native-final-publication](../evidence/native-final-publication/)
- [ordinary-final-recovery](../evidence/ordinary-final-recovery/)
- [ordinary-tools](../evidence/ordinary-tools/)
- [tool-payload](../evidence/tool-payload/)
- [tool-work-handoff](../evidence/tool-work-handoff/)

### 旧版群聊与上下文

- [compaction-failures](../evidence/compaction-failures/)
- [compaction-fallback](../evidence/compaction-fallback/)
- [compaction-input](../evidence/compaction-input/)
- [context-chain](../evidence/context-chain/)
- [context-rules](../evidence/context-rules/)
- [cross-device-compaction](../evidence/cross-device-compaction/)
- [group-context](../evidence/group-context/)
- [group-member-handoff](../evidence/group-member-handoff/)
- [group-plan-handoff](../evidence/group-plan-handoff/)
- [group-relay](../evidence/group-relay/)
- [group-settlement](../evidence/group-settlement/)
- [human-desktop-group-relay](../evidence/human-desktop-group-relay/)
- [mobile-group-invite](../evidence/mobile-group-invite/)
- [portable-context](../evidence/portable-context/)
- [remaining-rules](../evidence/remaining-rules/)
- [request-envelope](../evidence/request-envelope/)
- [river-quote](../evidence/river-quote/)
- [speaker-semantics](../evidence/speaker-semantics/)

### 旧版历史、附件与配置

- [attachment-path-ownership](../evidence/attachment-path-ownership/)
- [desktop-topic-recovery](../evidence/desktop-topic-recovery/)
- [file-uri-roundtrip](../evidence/file-uri-roundtrip/)
- [first-send-topic-head](../evidence/first-send-topic-head/)
- [history-identity](../evidence/history-identity/)
- [mobile-config-freeze](../evidence/mobile-config-freeze/)
- [native-config-write-path](../evidence/native-config-write-path/)
- [shared-attachment-continuation](../evidence/shared-attachment-continuation/)
- [shared-desktop-gif](../evidence/shared-desktop-gif/)
- [shared-desktop-regenerate](../evidence/shared-desktop-regenerate/)
- [shared-message-menu](../evidence/shared-message-menu/)
- [shared-single-image-models](../evidence/shared-single-image-models/)
- [shared-single-review](../evidence/shared-single-review/)

### 旧版设备、移动端与观察体验

- [android-device](../evidence/android-device/)
- [android-installed-pwa-pair](../evidence/android-installed-pwa-pair/)
- [android-pair-force-stop](../evidence/android-pair-force-stop/)
- [android-send](../evidence/android-send/)
- [chrome-webapk-deferred](../evidence/chrome-webapk-deferred/)
- [mobile-chat-layout](../evidence/mobile-chat-layout/)
- [mobile-desktop-relay](../evidence/mobile-desktop-relay/)
- [screenshots](../evidence/screenshots/)
- [shared-watch](../evidence/shared-watch/)
- [windows-device](../evidence/windows-device/)

### 独立证据文件

- [desktop-shutdown.md](../evidence/desktop-shutdown.md)
- [idle.json](../evidence/idle.json)
- [linux-acceptance.json](../evidence/linux-acceptance.json)
- [linux-selection-observations.md](../evidence/linux-selection-observations.md)

## 保留规则

- 现行说明不复制历史大段日志；引用固定版本、原始回执与测试入口。
- 原始测试证据保持路径和内容，不因阶段结束而删改。
- 发现旧证据被现行代码或测试引用时，先核对依赖，再决定将来的物理归档方式。
- 上游来源、署名与许可证属于持续有效的来源资料，不作为过时施工文档处理：[provenance](../../provenance) · [NOTICE](../../NOTICE.md) · [LICENSES](../../LICENSES)。
