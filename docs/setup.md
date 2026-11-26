# macOS 安装与启动

## 开发环境

当前启动入口面向 macOS。准备以下环境：

- DeepSeek Harness 桌面版 **0.2.2-rc.1**，先在 DSH 配好一个可用模型。启动器优先选 `v41f1017`，也可沿用当前配置中可用的模型。
- Node.js **24.21.0**、pnpm、Git、`uv` 和 Python **3.12**。DSSA 还使用 `gh` 和 `tmux`。
- 一个已登录的 GitHub CLI 账号，以及一个自己有写权限的开发仓库。固定版 DSSA 启动时会验证这个权限。HNU 的 QQ 工单仍在本机工作目录运行，GitHub 消息来源默认关闭。
- 实际读取 QQ 时，需要已登录、与本机 QQ 版本兼容的 NapCatQQ。可先启动 HNU 并打开设置页，再接通 QQ。

## 获取依赖并启动

在 GitHub 克隆本项目后，从根目录拉取这两个固定版本的上游。目录名供启动脚本使用。

```sh
git clone https://github.com/Tivonsico/hnu-super-agent.git
cd hnu-super-agent

git clone https://github.com/deepseek-ai/dsh-superagent-prototype.git dsh-superagent-prototype
git -C dsh-superagent-prototype checkout --detach 8c32a9dc5d72c033816c6a8110b37f40cf94fba4
(
  cd dsh-superagent-prototype
  pnpm install --frozen-lockfile
  pnpm build
)

git clone https://github.com/ExpertKT/notice-hub.git notice-hub
git -C notice-hub checkout --detach f268cd2eb53f58e3352f692061e7458598bce58d
```

把下方仓库名换成你有写权限的仓库，再从项目根目录启动。启动器为群务台建 Python 环境，装配 DSH profile 和 QQ 工单接入插件，然后打开 HNU 主界面。工作区和日志在 `.local/workspace/`。

```sh
HNU_DSSA_GITHUB_REPO=你的账号/你的开发仓库 node dsh/start.mjs
```

启动器默认从 `/Applications/DeepSeek Harness.app` 找 DSH。DSH 安装在别处时，通过 `HNU_DSH` 指定兼容版本的可执行文件。已配置的本机环境也可以双击 [启动 HNU Agent.command](<启动 HNU Agent.command>)。

macOS 用户先将 QQ 安装到 `/Applications/QQ.app`，在 HNU 的 QQ 连接页点击「安装并连接 QQ」。终端会下载并校验 NapCat Framework，备份入口，申请管理员授权并重启 QQ。随后在桌面 QQ 登录，HNU 自动检测当前账号并配置消息接入。QQ 更新导致接入失效时，可再次安装修复。启动接口变化的版本需要后续适配，当前实机验证版本为 QQ 7.0.3-54395。

进入「会话设置」，设置发起权限并开启监听。监听默认 30 分钟，可以修改。每次开启时默认回看截至开启时最近 20 条消息，可在前端设为 0–100 条；0 表示只处理新消息。回看消息同样按发起权限送评，不会重复创建已有工单。读取历史失败时不会开启监听，会提示重试。到期后停止送评，已生成的开单建议仍可在「工单」审核。详见 [QQ 接入说明](local-verification.md)。


依赖版本及许可证见[版本清单](../manifests/upstream.json)。
