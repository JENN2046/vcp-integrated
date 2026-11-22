# 共享 502 输入删除的服务端验证

在仓库根目录使用 Node 24 运行以下命令。夹具使用仓库的隔离 ToolBox 服务、已构建的移动端资源和 Vexus addon，以及只监听 loopback 的合成上游。上游实际返回 HTTP 502。只有合成 SQLite 会被复制到升级进程。

```sh
node tests/shared-single-review/upstream-delete-authorization.cjs
node tests/run-host-suite.cjs native
```

| 场景 | 实测结果 |
|---|---|
| 526809f 基线 | 待核对时版本化删除返回 409。人工结清后，版本化删除返回 400，旧无版本请求可返回 200 并产生墓碑。 |
| 候选从 502 到人工结清 | 待核对时返回 409。结清后第二设备返回 403，原作者新发无版本请求返回 400，过期 seq 或 hash 返回 409。正确版本只追加一个墓碑，精确重放返回同一回执。 |
| b5648e96d883 产生 502 并人工结清，再用候选启动同一隔离 SQLite 的副本 | 原 Work 保留未确认的 `pending_operation`，`terminal_state` 为默认 `completed`，原生请求仍是 `unknown`。候选允许原作者删除原始用户输入。Work、Admission 和原生请求逐字段相同，重放原提交命中原 Work，升级后上游调用为 0。 |
| b5648e96d883 已接受无版本删除，再升级 | 原 authenticated principal 精确重放得到原墓碑回执。复用 opId 更改 hash 返回 409，新无版本请求返回 400，另一设备的新请求返回 403。 |

原生测试套件 309 通过、6 跳过、0 失败。套件覆盖普通共享助手消息编辑／删除和只读权限检查。真实 Electron 右键、第二端同步及重启结果见本目录桌面回执。
