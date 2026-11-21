# 群聊上下文的成对对照

在已构建的 Linux x64 集成检出中，使用 Node 24、Xvfb、Chromium 和已配置系统沙箱的 Electron。设置 `ELECTRON_BIN`、`XVFB_BIN` 和 `CHROME_BIN` 可选择本机可用的二进制。服务、浏览器与桌面都使用新建的合成数据，Provider 只监听回环地址。

从仓库根目录准备一次基线桌面。下列命令复用当前检出的锁定依赖和已构建 CDS 二进制，基线的本地规则包、桌面源码、preload 和 renderer bundles 从固定提交获得。

```sh
repo="$PWD"
mkdir -p .runs/group-context
baseline_dir="$(mktemp -d "$repo/.runs/group-context/native-baseline-XXXXXX")"
git archive 6f34d0c0a260 apps/desktop packages/core-rules | tar -x -C "$baseline_dir"
desktop="$baseline_dir/apps/desktop"
mkdir -p "$desktop/node_modules/@vcp" "$desktop/modules/services/chatDataService/bin"
for dependency in "$repo/apps/desktop/node_modules/"*; do
  if [ "${dependency##*/}" != @vcp ]; then
    ln -s "$dependency" "$desktop/node_modules/${dependency##*/}"
  fi
done
ln -s "$baseline_dir/packages/core-rules" "$desktop/node_modules/@vcp/core-rules"
ln -s "$repo/apps/desktop/modules/services/chatDataService/bin/linux-x64" \
  "$desktop/modules/services/chatDataService/bin/linux-x64"
(
  cd "$desktop"
  node scripts/build-shared-renderer-rules.cjs
  node scripts/build-portable-agent-owner.cjs "$desktop"
  node scripts/build-sandbox-preloads.cjs "$desktop"
)
```

运行前后对照，记录两次输出的 evidence.json 路径，再运行比对。基线 ToolBox 由夹具从 Git 固定提交独立暂存，基线的两个本地 `@vcp` 服务端依赖都指向该提交的源码。两次共用已构建的 PWA 和 Vexus。

```sh
node tests/group-context/run.cjs baseline "$baseline_dir"
node tests/group-context/run.cjs candidate
node tests/group-context/compare.cjs "$baseline_evidence" "$candidate_evidence"
```

两次都会先用配对后的 PWA 会话提交固定 ID 的群聊消息，再重放同一提交。夹具读取中央账本保存的计划，将共享成员 ID 映射为桌面成员 ID，在原生桌面配置保存该计划后发起真实发送。完整合成请求、账本、IPC、源文件签名及桌面截图保存在 `.runs/group-context` 的各自运行目录。已完成运行会清理临时 Profile、服务数据库、证书和运行树。提交到仓库的本次结果见[验收回执](../../docs/evidence/group-context/README.md)。
