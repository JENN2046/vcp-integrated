# 三成员顺序接力的双桌面实测

基线 `af17c99e784fd1afd5b127fcf8a467f06ef8423d` 的三成员顺序共享群没有接力入口。通过同一个沙箱桌面的主窗口 preload 提交旧版接力，实际 ToolBox 返回 HTTP 409 `SHARED_GROUP_HANDOFF_UNSUPPORTED`。中央未创建 Work 或 Journal 记录，回环 Provider 没有收到请求。[基线回执](baseline.json) · [基线窗口](baseline-three-member-rejected.png)

候选使用两个独立的 Electron Profile、各自的 CDS 和原生 History、真实 ToolBox、回环 HTTPS 代理和合成 SSE Provider。桌面 A 发起，完成成员 A 后停在第一个接力边界。桌面 B 接管并继续，完成成员 B 后停在第二个接力边界。原桌面 A 重开并接管，代理在 ToolBox 提交第二次「本端继续执行」后截断成功回执。强停 A 并重开同一 Profile 后，原 Work 保持继续待执行，重试提交完全相同的参数和 opId，第三位成员 C 随后派发。[第一次交接](first-boundary-A.png) · [第二次交接](second-boundary-B.png) · [丢回执后重开](second-continue-ack-lost-A-reopened.png)

最终候选的原 Work 为 `request_ce80216c2dee42858f3afc05ca636f1b`。同一个 Work 下有三个原生请求 ID，ToolBox handler 和 Provider 均按 A、B、C 顺序各收到一次调用。发给 C 的两个正式前序回复分别有独立的 Journal 消息 ID。handler 的时间戳绑定指向原消息 ID、原时间、消息序号和带署名正文的哈希。handler 和 Provider 在 assistant 消息里按甲、乙次序各收到一次原正式正文。中央 Journal 和两端 History 都有原输入、甲、乙、丙四条记录，回复 ID、成员身份、正文和时间一致。[候选回执](candidate.json) · [执行端 A](original-work-completed-A.png) · [在线观察端 B](original-work-completed-B-live.png) · [重新打开的 B](original-work-completed-B.png)

修复前，在同一话题的在线 B 上观察到任务已显示 3/3，丙也已写入本机 History，但聊天窗口超过 30 秒仍未显示丙。乙提交后的本机确认步骤访问了尚未初始化的计时字段，触发保存失败，原生 History 刷新因此继续等待。修复后，本次回归先断言在线 B 在原话题各显示甲、乙、丙一次，再关闭 B 验证重开。[修复前窗口](pre-fix-observer-stale.png)

## 复跑

使用 Node 24、Xvfb 和已构建的仓库依赖。若同一主机的 watcher 配额不足，可启用下面的预加载。它只影响沙箱 ToolBox 的空知识目录 watcher。

```sh
export PATH="$PWD/.runs/toolchain/bin:$PATH"
export XVFB_BIN="$PWD/.runs/toolchain/bin/Xvfb"
export NODE_OPTIONS="--require=$PWD/docs/evidence/three-client-candidate/build-linux/empty-watcher-preload.cjs"
npm --prefix apps/desktop run build:preloads
node tests/group-member-handoff/run.cjs plan
```

基线在 `af17c99` 的独立检出中复跑 `node tests/group-member-handoff/run.cjs plan-baseline`。将本批的 `tests/group-member-handoff/{run,fixture,plan,server-capture}.cjs` 复制到该检出，安装同一组构建依赖并在基线自行构建桌面 preload。基线断言产品目录没有已跟踪的源码改动。两种模式都在终端打印原始回执和截图所在目录。两份入库回执去掉了临时目录、回环端口和重复的请求列表，无真实凭据或用户数据。

## 人数与兼容范围

新版「开始顺序接力」使用准入时保存的发言计划。单成员正式回复写入即结算；多人在每条中间正式回复处暂停，另一台有权限的桌面接管并显式继续。执行者、接管版本、下一位的位置和上一条正式回复的 Journal 序号共同约束操作。同一对桌面可交替完成整组接力。正在进行的 Work 保留原顺序和成员身份，后改的群配置仅影响以后发起的 Work。

协议与 SQLite 层分别跑完 1、4、33 位成员，确认每位只有一个原生请求和一条正式回复。另单测 1001 个成员 ID 及逆序顺序配置的接受、重复成员和无效成员的拒绝。此项没有为 1001 人调用模型。群聊配置体积、消息体和模型上下文继续使用宿主资源预算。接力适用纯文本顺序群聊；其他群聊模式沿用原入口。[人数对照](plan-lengths.json) · [可复跑测试](https://github.com/JENN2046/vcp-integrated/blob/032ad5fc27536c323eb5bd075e43282b9badf50e/tests/native/shared-plan-handoff.test.cjs)

已有 v1 双人 Work 按旧协议恢复。首次接纳 v2 接力，或写入超过旧版 32 成员约束的共享顺序群配置，会在同一事务将库标记为 schema 4。需要保留回退选择时，在启用前留存一致备份。旧宿主直接打开 schema 4 的备份会拒绝服务；现有新进度需用支持 schema 4 的版本继续。[版本兼容回执](compatibility.json) · [测试方法](compatibility.md)

最终原生宿主套件 316 项通过、6 项需要外部历史压缩夹具而跳过；协作套件 60 项通过。已有的双成员正常接力、甲未提交、乙结果未知和人工结清场景均用隔离桌面复跑通过。
