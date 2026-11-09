# HNU Super Agent

HNU Super Agent 是一个运行在本机的 QQ 群事务台。打开 HNU Agent 后，可以选群、设置谁能发起任务、查看消息和工单，并在具体会话里补充要求或审核交付。当前流程可以根据一条符合条件的群消息准备 Markdown 提纲。QQ 接入以读取消息为主，工单交付留在本机。

```text
NapCatQQ → OneBot 收件端 → HNU 会话监听与权限 → DSSA 评估 → 人工审核 → DSSA 工单 → DSH Worker
```

NapCatQQ 负责读取 QQ。HNU 在开启会话监听时读取最近消息，并在监听期间将有发起权限的人发出的新消息送给 DSSA，DSSA 根据讨论判断是否有任务。用户批准开单后，DSSA 创建工单并派工，DSH 运行 Worker 会话。群务台（notice-hub）提供群收件和附件支持。

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

进入「会话设置」，设置发起权限并开启监听。监听默认 30 分钟，可以修改。每次开启时默认回看截至开启时最近 20 条消息，可在前端设为 0–100 条；0 表示只处理新消息。回看消息同样按发起权限送评，不会重复创建已有工单。读取历史失败时不会开启监听，会提示重试。到期后停止送评，已生成的开单建议仍可在「工单」审核。详见 [QQ 接入说明](docs/local-verification.md)。

## 代码放在哪里

| 目录 | 职责 |
| --- | --- |
| `dsh/` | 启动 HNU，装配 DSH profile，管理本地进程。包含可选的桌面 QQ 接入脚本。 |
| `plugins/hnu-companion/` | QQ 工单接入插件及 HNU 界面。处理送评、开单审批、DSSA 工单和 DSH 会话。 |
| `qq-ingest/` | OneBot HTTP 收件、去重和本地队列。 |
| `hnu/` | 工单工作目录、文件交付和版本审批。 |
| `tests/` | 事件接收、权限、文件交付和审批的本地回归。 |
| `manifests/` | 上游版本记录。 |

仓库包含本项目源码、启动入口、回归测试和界面原型。DSH 使用独立安装的桌面运行时，DSSA 和群务台按上述提交获取，NapCatQQ 按本机兼容性安装。上游源码和发行包由各项目发布。群务台采用 PolyForm Noncommercial 1.0.0，NapCatQQ 附有自己的分发许可，DSSA 使用 MIT。各依赖的版本和许可见 [版本清单](manifests/upstream.json)、[群务台许可](https://github.com/ExpertKT/notice-hub/blob/f268cd2eb53f58e3352f692061e7458598bce58d/LICENSE)、[NapCatQQ 许可](https://github.com/NapNeko/NapCatQQ/blob/98d781d19815d1625b24d717ce280ecf0a4f6d0c/LICENSE) 和 [DSSA 许可](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/LICENSE)。

## 验证与版本范围

```sh
node --test tests/*.test.mjs
```

测试可独立运行，无需登录 QQ 或请求模型。真实收件、历史读取和派工应在自己的 QQ 与 DSH 环境分别验收。当前发布的是 1.0 的开发快照。湖大官网、`hnu_query`、微信、个人记忆和插件目录属于后续计划。[本机验证范围](docs/verification-status.md)

[使用说明原型](hnu-superagent-v2-user-guide.html) · [消息大屏原型](hnu-superagent-message-dashboard.html)
