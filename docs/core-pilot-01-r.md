# Pilot 01-R 本机与远程接入

ToolBox 的 `VCP_CORE_MODE=local` 与 `VCP_CORE_MODE=remote` 使用同一 Core 数据格式、话题目录、Work 调度、原生执行和附件存储。远程模式启用设备会话。旧共享版仍使用显式的 `shared` 模式。新试用时请选空的独立服务目录与桌面 profile。

## 在隔离 ToolBox 主机启动

使用 Node 24，从仓库根目录运行 `npm run deps` 和 `npm run build`。按正常 ToolBox 安装方式准备试用 Provider 和宿主设置。已有 ToolBox `Key` 继续用于宿主自身接口。为新 Core 配置下列环境变量，使用试用域名与可写的数据目录。

```sh
export VCP_CORE_MODE=remote
export VCP_CORE_WORKSPACE=personal
export VCP_CORE_DATA_DIR=/absolute/path/to/pilot-core-data
export VCP_CORE_REMOTE_ORIGIN=https://core.example.net
export VCP_LOCAL_LISTEN_HOST=127.0.0.1
export PORT=18081
npm --prefix apps/server start
```

HTTPS 入口使用受客户端信任的证书。反向代理和 ToolBox 运行在同一台主机上。专用域名仅代理 `/core/api/` 与 `/mobile/`，并覆盖 `Host` 及 `X-Forwarded-Proto`。关闭 SSE 响应缓存和缓冲。以下是放在现有 HTTPS virtual host 中的 Nginx location 配置。

启用本机语音识别时，`/mobile/api/voice` 需要转发 WebSocket 升级头。使用精确匹配将升级限定在该路径，普通 HTTP 和 SSE 继续使用下面的通用规则。

```nginx
location = /mobile/api/voice {
    proxy_pass http://127.0.0.1:18081;
    proxy_http_version 1.1;
    proxy_set_header Host core.example.net;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
    proxy_read_timeout 65s;
}
location ~ ^/(core/api|mobile)(/|$) {
    proxy_pass http://127.0.0.1:18081;
    proxy_http_version 1.1;
    proxy_set_header Host core.example.net;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 75s;
    client_max_body_size 16m;
}
location / { return 404; }
```

图片模型沿用 `VCP_CORE_IMAGE_MODELS` 的 JSON 模型名列表。设备 Cookie 默认有效 8 小时，可用 `VCP_CORE_REMOTE_SESSION_HOURS` 设置为 1 至 720 小时。远程 Core 的手机浏览器登记设备恢复凭据后，可以在 Cookie 到期时恢复原身份。断开设备或管理员撤销会结束该配对；清除浏览器数据后需要重新配对。

## 配对设备

用运行 ToolBox 的系统账户执行。配对码有效 3 分钟，每台设备使用单独的码。

```sh
node apps/server/core/pairDevice.js pair desktop
node apps/server/core/pairDevice.js pair desktop-reader
node apps/server/core/pairDevice.js pair mobile
node apps/server/core/pairDevice.js pair mobile-reader
node apps/server/core/pairDevice.js list
node apps/server/core/pairDevice.js revoke DEVICE_ID
```

`desktop` 可读写会话及正式配置。`desktop-reader` 可读写会话和读取附件，配置只读。`mobile` 可观察和追问，`mobile-reader` 仅可读取及观察。设备可见范围为这个已配对的个人工作空间。

- 手机打开 `https://core.example.net/mobile/`，用「一次性配对码」配对。Cookie 与原生配对恢复机制沿用现有 PWA 行为。
- 桌面使用一个新的 `VCPCHAT_APP_DATA_DIR`。首次启动设置 `VCPCHAT_CORE_REMOTE_ORIGIN`、`VCPCHAT_LOCAL_CORE_WORKSPACE` 和 `VCPCHAT_CORE_PAIR_CODE`。桌面将会话凭据保存于 Electron 系统密钥库保护下的 profile 文件。Linux 无系统密钥库时，可由会话管理器以 `VCPCHAT_CORE_DEVICE_TOKEN` 传入专用设备凭据，凭据由 `POST /core/api/pair` 的 JSON `{"code":"…"}` 一次性交换获得。
- 通过已配对的管理桌面配置 Agent、打开或创建正式话题。其他桌面冷启动从 Core 读取目录，并通过已配对的设备身份读取历史和附件。普通单聊、群聊模式与节点资源继续按本机 Core 的能力和授权执行。需要桌面节点的 Canvas、Workspace 和 Game 拥有各自的原生资源归属。远程代理不会替客户端转发旧 ToolBox 接口。

Agent 配置可由有配置权限的桌面修改。话题或 Agent 删除在 Core 记录墓碑，阻止继续查询、读取附件或使用原 ID 覆盖。仍有执行或待核对 Work 时，删除会返回忙碌。SQLite 中保留执行与删除事实。桌面已有的话题、配置和附件只用作原生界面投影，正式消息及 Work 只提交到 Core。

## 数据库身份、备份与恢复

客户端绑定 Core SQLite 已有的 `storageId`。同一地址若换库，已绑定的桌面和 PWA 会暂停连接并报告身份不一致。恢复时应保留原库内的身份。旧版桌面 profile 首次升级时，需要用 `VCPCHAT_CORE_EXPECTED_STORAGE_ID` 显式提供已核对的旧库身份；它只用于首次绑定，后续启动可省略。请从确认属于该 profile 的原库读出身份，可用以下只读命令。

```sh
node --input-type=commonjs -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1], { readOnly: true }); console.log(db.prepare(\"SELECT value FROM core_metadata WHERE key='storage_id'\").get().value); db.close();" "$VCP_CORE_DATA_DIR/core.sqlite"
```

先正常停止 ToolBox，等 Core 结束排空。用文件系统复制完整的 `VCP_CORE_DATA_DIR` 到新备份目录，保留目录权限及 SQLite 和附件对象。不要仅复制 `core.sqlite`。设备会话也在备份内，按原数据库级别保护副本。恢复时同样先停 ToolBox，把当前目录完整移开，再将备份复制到原路径。用相同 workspace、Core 模式和远程 origin 启动。用已绑定客户端冷启动核对消息、附件、Work 和删除状态，再清理预留副本。

本轮用隔离数据复验了桌面删除、TopicMemo 和附件拒绝，以及浏览器／桌面的同址换库与恢复。使用合成 Provider，保留 8 条消息记录、4 项 Work 和 2 条删除墓碑，附件哈希与备份前相同。 [验收回执](evidence/core-pilot-01-r/pilot-risk.json) · [恢复后桌面冷启动](evidence/core-pilot-01-r/backup-cold.png)

## 复跑

`npm run test:integration -- core-remote` 运行隔离 HTTPS 场景。加上 `VCP_TEST_CORE_RISK=1` 可复跑桌面删除和备份恢复。可设置 `VCP_TEST_CORE_MODEL_URL` 为独立回环模型端点，并用 `VCP_TEST_CORE_MODEL` 指定模型。实体 Android 验收可另设 `VCP_TEST_CORE_PHONE=1` 和 `VCP_TEST_CORE_PORT`。在测试输出目录读取 `phone-prepare.json` 中的公有证书、入口和话题，复用仓库的临时 Android WebView 驱动。手机完成配对后写入 `phone-ready`，在手机验证 `desktop-exited.json` 中的 Work 后写入 `phone-observed`。出现 `first-completed` 后从手机提交追问。这些标记仅用于夹具协调。

## 验收证据与范围

- Linux 上两个独立的 Electron GUI profile 与实体 Android Firefox 通过仅用于本轮的 HTTPS 入口连接。首个桌面发出红图并退出，Android 实际显示原图与在途任务，在首轮完成后提交追问。两次请求均由真实 SmolVLM 处理，且各带有一张图。
- ToolBox 排空并重启成功。第二个 Electron profile 从空白聊天配置接回目录，展示相同的四条消息。正式消息记录与附件字节在重启前后逐项一致，移动观察流收到了该 Work 的正式终态。终态截图是在夹具收尾时截取，画面保留了手机已显示的结果和断线提示。
- 未加载 NativeSync 插件。匿名读取、ToolBox Key 冒充设备、跨工作空间、跨来源、只读配置写入、撤销设备后的请求均被拒绝。受准 Agent 配置生效，话题和 Agent 删除保留墓碑。回归覆盖 Pilot 01 回环及原共享模式。原生套件 356 项通过、6 项历史夹具默认跳过，协作套件 61 项通过。
- 当前部署入口面向一个个人工作空间。设备会话不会取得原生可信人类审批资格。桌面冷连接时读取目录，必要的桌面节点仍负责自己的 Canvas、Workspace 和 Game 资源。本轮硬件验收覆盖 Linux 桌面及 Android Firefox，Windows 只作 USB 转发。

[机器回执](evidence/core-pilot-01-r/remote.json) · [手机观察在途任务](evidence/core-pilot-01-r/android-running.png) · [手机追问](evidence/core-pilot-01-r/android-followup.png) · [桌面冷启动](evidence/core-pilot-01-r/desktop-cold.png)
