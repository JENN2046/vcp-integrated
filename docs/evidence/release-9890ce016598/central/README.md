# 中央 Work 和 Journal

原话题为空，Linux 发送一次。Work `request_f7b2304e20c34928ada744ca1637ab19` 在同一 ID 上从 `running` 进入 `completed`，`attempts=1`，`request_dispatched=1`，合成 Provider 调用 1 次。请求与用户消息 ID 均为 `msg_1795328083067_user_o0iyw2caho`，助手消息 ID 为 `reply_request_f7b2304e20c34928ada744ca1637ab19`，Journal 序号为 1、2。

- [提交前](./pre-send.json) · [Provider 放行前](./work-held.json) · [完成](./work-completed.json)
- [完成正文摘要](./message-hashes.json) · [Linux 重开后](./post-linux-reopen.json) · [三端重开后](./post-all-reopens.json) · [三端重开后正文摘要](./post-all-reopens-message-hashes.json)

三端读回后的中央状态与首个终态快照字节一致。中央 Journal 与 Linux 持久 History 的消息 ID、角色、正文 UTF-8 字节数（46 和 21）及各自 SHA256 一致。中央终止后，测试回环监听与合成运行目录均已回收。[清理回执](./cleanup.txt)
