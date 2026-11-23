# 移动群聊阅读区与顶部导航

同一轮给乙的邀请，使用上轮留存的中央测试库副本和独立 Chromium Profile，在 393 × 770 CSS 像素视口对照原版与新版。原版在这组浏览器条件下显示 92 像素的历史区，新版为 588 像素。用户的问候和乙的回复均完整可读。上轮实体 Firefox 在当时布局下测得的 18 像素另见[实机记录](../mobile-group-invite/README.md)。本次新版只做浏览器验证。

[改前](before.png) · [改后](after.png) · [话题切换](topics.png) · [执行状态](work.png) · [320 像素长标题](long-title-320.png)

顶部的话题切换器以话题名为主标题，群名和连接状态在第二行。长名称省略，切换和设置仍有独立可触达入口。会话导航和任务状态在阅读区内按需展开；输入和邀请留在底部。同一消息和回复的 ID、角色、正文核对一致，打开详情未触发模型调用。[控件及状态文案](controls.json) · [中央账本对照](stored-facts.json)

从仓库根目录使用 Node 24 运行：
```sh
node scripts/build.mjs --mobile
node tests/mobile-chat-layout/browser.cjs apps/server/Plugin/NativeSync/mobile-dist /tmp/mobile-chat-layout-proof
```
浏览器回归使用独立的合成 API 验证 320、360 和 390 像素竖屏、640 × 360 横屏及只读会话，覆盖来源、成员、话题、发送、邀请、任务详情和设置。390 × 330 使用缩短视口模拟输入时可用高度，底部跟随状态下最新消息仍可见。[改前几何记录](narrow-before.json) · [改后几何记录](narrow-after.json)
