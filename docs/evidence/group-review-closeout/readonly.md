# 只读端观察与拒绝代办

在 `review-closeout` 的隔离 ToolBox 中，使用原 B 未知 Work 的合成中央库副本。主流程开始放弃前，通过真实配对接口领取只读范围并建立 Mobile 会话。`/mobile/api/session` 回报唯一授权 `shared:sharedAB:read`。

| 路径 | 实测结果 |
| --- | --- |
| `GET /mobile/api/shared/session-events` | HTTP 200。拒绝前后都观察到原 Work `request_9c83476f43f546a1a8f96d54254467fe` 的 `review_required`。执行者 `desktop:deviceB`、归属代次 1、A 回复 Journal 序号 2、事件 epoch 与 seq 0 完全一致。 |
| `POST /mobile/api/shared/abandon` | HTTP 403 `SHARED_PERMISSION_REQUIRED`。 |
| `POST /mobile/api/shared/group-continue` | HTTP 403 `SHARED_PERMISSION_REQUIRED`。 |
| `POST /mobile/api/shared/group-handoff` | HTTP 403 `SHARED_PERMISSION_REQUIRED`。 |

逐次比对原 admission、群接力控制记录、两个 native 请求、Journal 与 Provider 调用，前后相同。B 的 native 请求仍为 `unknown`，只读端的三次请求共新增 0 份操作回执。探针使用真实 HTTP 和配对作用域，原 Work 源库保留原状。

首次独立通过记录位于 `/tmp/vcp-integration-1NmGtR/ready/evidence.json` 的 `groupReviewCloseout.readOnly` 字段。该次运行后续在 B 丢回执重开检查超时。只读检查在授权端执行放弃前已完成。另用 Node 24.22.1 跑 `tests/native/shared-group-handoff.test.cjs` 与 `tests/native/shared-group-handoff-desktop.test.cjs`，14/14 通过。
