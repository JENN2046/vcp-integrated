# M0 WebTransport 探针

**当前判定为 No-Go。** 两个候选都完成 Linux 本机双向 WebTransport 实测。真实网络、Windows 打包和远程证书仍无验收证据。M1 沿用 HTTP + SSE。

| 红线 | @fails-components/webtransport 1.6.12 | @http3-server/server 0.3.2 |
| --- | --- | --- |
| 真实网络 | Linux 本机 HTTP/3 双向回显通过。Android Firefox、蜂窝网、家庭 NAT 和日用代理未测。上游将 HTTP/2 WebTransport 标为实验性。 | Linux 本机 HTTP/3 双向回显通过。Android Firefox、蜂窝网、家庭 NAT 和日用代理未测。候选的 WebTransport 处理器仅在 HTTP/3 运行。 |
| 跨平台同构 | Linux x64 在 Node 24.22.1 内加载 QUIC 原生组件并监听 UDP。Windows x64 启动与安装包未测。 | Linux x64 在 Node 24.22.1 内加载平台原生组件并监听 UDP。Windows x64 启动与安装包未测。 |
| 证书与恢复 | Electron 44.9.3 使用 13 天 P-256 证书哈希连接 `127.0.0.1`，关闭会话后重连，回显游标 0、1。服务端记录两条对端正常关闭消息。 | 同一 Electron、证书策略及用例通过。两者的远程域名 TLS、生产轮换、切网、休眠和 Work 进程重启恢复仍待实测。 |

Linux 的 SQLite 单独在 Node 24.22.1 验证，`DatabaseSync` 返回 `journal_mode=wal` 和 `busy_timeout=5000`。探针依赖位于临时目录，未加入宿主安装清单。

## 本机复现

将本目录两个脚本复制到临时目录，从该目录运行。TLS 私钥只用于本机一次性探针。

```sh
npm install --no-audit --no-fund @fails-components/webtransport@1.6.12 \
  @fails-components/webtransport-transport-http3-quiche@1.6.12 @http3-server/server@0.3.2
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -days 13 -subj /CN=127.0.0.1 -addext subjectAltName=IP:127.0.0.1 \
  -out probe.crt -keyout probe.key
node echo.mjs quiche probe.crt probe.key
```

在另一个终端用 Electron 44 运行 `electron --user-data-dir=/tmp/vcp-wt-profile electron.cjs PORT probe.crt`，其中 `PORT` 是服务端打印的端口。随后用 `http3` 替换 `quiche` 重复测试。

候选协议与平台说明见各项目文档。[fails-components](https://github.com/fails-components/webtransport/tree/master/main) · [http3-server](https://github.com/http3-server/http3-server)
