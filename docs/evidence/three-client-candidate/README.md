# 三端隔离交付候选

固定版本 `7829b83ccb634c397caa6a168d9fe0d8663cb12e`。Linux 普通本机单聊与三端观察同一共享 Work 已通过，旧合成库升级与代码回退通过。Android 首次配对后立即强停的专项实测到了重新配对现象。Android 系统选择器真实选中附件与后续改发、丢回执，须以本目录 Android 专项回执为准；目前只确认已进入系统提供的文件列表。

Linux A 发起一次普通共享请求，实体 Android 先观察运行中再看到完成；原 Windows 11 虚拟机上的 Windows B 在完成后加入并正常退出，用同一 Profile 启动新进程重开话题。三端观察到同一输入和回复 ID、正文一致。Work 为 `request_36f6c924891e4df7a383a27762534321`，Journal 序号 1、2，Windows 重开后中央仍只记录一次 Provider 调用。Linux 另一次本机发送只进入本机 History。

- [干净检出、构建边界、资产哈希和启动命令](build-linux/README.md)
- [Windows 首开、重开及三端比对](windows/README.md)
- [实体 Android 的公共 Work 和快速强停取样](android/README.md)
- [两套旧合成库的升级与回退证据](upgrade/README.md)
