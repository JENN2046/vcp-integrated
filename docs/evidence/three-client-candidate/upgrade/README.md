# 旧合成库升级与代码回退

分别从初次集成基线 `c837e2a` 和上一批前的 `aa19a63` 启动。每组先完成一条普通请求，再在另一个请求已派发时杀掉旧进程。候选 `7829b83` 使用同一合成库恢复，再换回原基线代码并重开。

两组的原输入、未确认请求和原生执行身份均保留。候选让已接纳输入追平到物理 History，并保留已有 ACK。回退后逐项核对 Journal、History、ACK、话题 Cursor、总 Cursor、待确认身份、Work 及原生请求状态，与候选恢复后的状态相同。升级与回退阶段的合成模型调用数均为 0。

这是两种旧数据形态在隔离库上的代码版本往返；尚未验证将新版独有的全部 Work 状态、终稿读回协议或手机草稿格式交给任意老版本写入。[初次集成基线](initial-fork.json) · [近期基线](previous-release.json) · [回归用例](https://github.com/JENN2046/vcp-integrated/blob/032ad5fc27536c323eb5bd075e43282b9badf50e/tests/collaboration/recovery-upgrade.test.cjs)
