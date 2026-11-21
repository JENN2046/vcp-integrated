# B 接续末代的只读收尾

审阅基线为 `aa19a63`。在显式工具单聊 `safe-tools-v1` 的 B 末代，新 ToolBox 公告 `shared-controlled-tools-history-v1` 后，新桌面经 `GET final-reply` 核对原生已发布的回复。正常 JSON 和 SSE 的完成补交 POST 从基线各 1 次降至 0。普通聊天和旧协议仍走各自原入口。[改前对照](../native-final-publication/desktop/README.md) · [宿主差异](host.patch)

ToolBox 在同一读快照里核对共享空间、执行者、Work、代次、回复 ID、原发布操作和 Journal 序号，同时返回当前版本或墓碑。B 使用已有话题投影队列追到该水位，核对本机 History 与 ACK。收到原生正文时只记录它的哈希供比对；只从服务端恢复的情形可以凭服务端发布证据核实。新模式不会为末代新建带完整正文的补交意图。读回断包会继续查原身份；没有可信终态的原 Work 保持待核对。

## 验收

- 新组合的正常 JSON、正常 SSE、丢模型终态后重开、丢首次成功读回后重读都完成了原 Work。每组末代完成补交 0 次，Journal、物理 History 和聊天各有一条原 ID 回复；A 初始、摘要、B 接续各调用一次 Provider，工具实际执行一次。[九组桌面回执](desktop/desktop-results.json) · [ToolBox 重启后 B 的画面](desktop/terminal-lost-toolbox-restarted.webp)
- 在 B 尚未收到模型终态时先编辑或删除原回复。迟到 SSE 后 B 显示编辑后的内容，迟到 JSON 后 B 保留墓碑。两组均检查终态 IPC 返回后的同一窗口，旧正文未再次成为正式气泡。[编辑截图](desktop/late-sse-edit.webp) · [删除截图](desktop/late-json-delete.webp)
- 旧 ToolBox 未公告能力时，新 B 仍发送一次原完成 POST；丢写 ACK 重开仍只有一条回复。新服务端接受旧 B 的幂等补交。编辑、删除后的读回分别返回原发布序号 5 及当前序号 6、7。错身份拒绝，只有旧模型终态标记的库升级后仍待核对。[兼容与只读性检查](compat/README.md)
- 所有桌面运行均为 Linux 上独立沙箱 Electron Profile、隔离 ToolBox、回环合成 Provider 与计数工具。原生回归 242 项通过，6 项需要原故障资产，指定资产后独立专项 13/13；协作 54/54，桌面相关组合 130/130。[桌面实测说明及复跑命令](desktop/README.md)
