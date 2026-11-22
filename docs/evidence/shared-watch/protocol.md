# 桌面共享通知协议

`GET /api/v1/sync/shared/info` 的 features 包含 `shared-watch-v1` 时，支持该能力的桌面可用现有 desktop binding、主机认证及共享能力头订阅 `GET /api/v1/sync/shared/watch?sharedSpaceId=…`。同一个桌面共享连接保持一条空间 SSE；已打开的话题和在途 Work 继续使用原来的事件观察接口。老桌面可继续使用 `shared-wait-v1`。新桌面连接未宣告 watch 的旧后端时，沿用原有兼容调度。

| 空间 SSE 数据 | 接收方行为 |
|---|---|
| `hint` 事件的 JSON 为 `{token, changed}` | 合并 matches、changes、pull 指示，串行核对对应数据。在当前核对期间到达的事件进入下一轮。 |
| `invalidate` 事件的 JSON 为 `{reason}`，随后关闭 | capabilities_changed 重新读取能力，authorization_lost 停止受保护操作、观察和旧授权结果的交付。恢复须重新证明成员资格。 |
| 注释保活帧 | 服务端默认每 15 秒复核绑定、成员及能力并检查变化。客户端只维护连接存活，正常保活不会触发业务拉取。 |

`since` 是可选的上次通知 token，格式沿用旧 wait。token 由进程 epoch 和三路临时版本组成，变化在同一 SQLite 写连接上与业务事务一起提交或回滚。首次订阅、服务端 epoch 更换或重新连上都从桌面已有目录及消息游标重新核对。客户端只在原有投影与持久提交路径推进游标。

空间连接异常时共用一次重连退避，基准 1、2、4、8、16、30 秒并带抖动。正常接口仍可用时，重连失败唤醒一次增量核对；明确撤权会中止受保护传输。共享桌面在本机提交已落盘、有附件或恢复工作到期、收到中央提示时起跑。无待办时保留按设备错峰的 15 分钟审计；审计还通过原 History 队列核对外部修改，将未知文件差异保留为待核对事实。共享运行中切入只读会禁止新增写入，恢复可写沿用重新打开运行时的路径。

[桌面调度](../../../apps/desktop/modules/services/nativeSync/sharedRuntime.js) · [连接和退避](../../../apps/desktop/modules/services/nativeSync/sharedWaitClient.js) · [服务端帧与鉴权](../../../apps/server/Plugin/NativeSync/sync/sharedHttp.js) · [事务唤醒](../../../apps/server/Plugin/NativeSync/sync/sharedWait.js)
