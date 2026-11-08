# macOS 的 QQ 接入

先按 [README](../README.md) 启动 HNU Agent。常规接入方式是独立安装并启动与本机 QQ 版本兼容的 NapCatQQ，按 QQ 界面提示登录，然后在 HNU 的权限设置里点「接入群消息」。勾选要监听的群，保存后从消息大屏确认能看到新消息。切换采集账号时，先选「使用此 QQ」，再重新接入群消息。[NapCat 的 macOS 安装说明](https://napneko.github.io/guide/boot/Shell#macos)

「QQ 会话」可以读取当前连接可见的群聊和私聊。选中一条会话后，可用「加载更早消息」查看 QQ 仍能返回的历史。自动开单仍受群的监听和发起人规则控制。

## 可选的桌面 QQ 接入脚本

[启动桌面 QQ.command](<../启动桌面 QQ.command>) 是针对已配置 NapCat Mac 安装器的 **QQ 7.0.2-53644** 编写的实验入口。它使用 **NapCat Framework v4.18.42**，需要将发行包 `NapCat.Framework.zip` 放进项目的 `.local/qq-desktop/`。脚本启动前会校验 SHA-256，并检查 QQ 的加载入口。[NapCat Framework 发布包](https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.42/NapCat.Framework.zip) · [NapCat Mac 安装器](https://github.com/NapNeko/NapCat-Mac-Installer)

首次安装时会请求本机管理员授权来更新 QQ 启动入口。需要恢复时，先退出 QQ，再从项目根目录运行：

```sh
./启动桌面\ QQ.command --restore
```
