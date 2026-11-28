# SuperDot 消息服务

SuperDot 把 QQ、微信、学习通和钉钉中命中规则的消息汇集到收件箱。可以手动添加消息，规则命中的订阅消息自动交给 Router。手动添加的消息可以在收件箱提交给 Router。自定义识别规则和订阅范围在设置里管理。

## 本机启动

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
cp .env.example .env
.venv/bin/python main.py run
```

在浏览器打开启动日志中的控制台地址。如果原群务台还在运行，在新副本的 `.env` 中把 `NOTICEHUB_WEB_PORT` 改成空闲端口。两个实例各自使用所在目录的配置和数据。

QQ 通过本机 NapCat Framework 接入。微信使用手动提供的数据库密钥，学习通在设置中导入本人已有的登录凭证。钉钉本地库读取使用环境变量 `NOTICEHUB_DINGTALK_DB_KEY` 中提供的授权密钥。选择需要监听的会话或课程并保存后，消息进入筛选流程。

## 工单工作台

左侧可以切换「今天到期」「今日新获取」「正在进行」和「全部」。右侧显示当前工单的原始消息、执行要求和节点记录。Router 建单后工单自动等待 Worker 接单。「审批卡点」用于回答 Worker 的问题。终止或忽略的工单可以恢复到 Worker 队列。

消息与工单写入本机 SQLite。设置里的规则、订阅和 AI API Key 会保存到本实例的 `.env` 或相应配置。执行端接口见 [Day 2 联调](docs/wiki/guides/day2-integration.md)，本地预览见 [工单工作台](docs/wiki/work-orders.md)，源码许可见 [LICENSE](LICENSE)。

此服务从当前已修改的 `notice-hub` 工作目录独立复制。旧版移除项记录在 [变更记录](docs/wiki/changelog.md)。

### 项目共享的 DSH 执行宿主

在 SuperDot 源码目录运行 `python3 main.py run`，会先启动回环地址 `127.0.0.1:18765` 的 DSH Web，再启动消息服务。各工单复用该宿主，通过工作台的「打开 DSH」进入各自的 Worker 会话。工单接口与 DSSA 管理接口均由这个进程提供。已有独立宿主时可设置 `NOTICEHUB_EXECUTION_URL`。

本地源码启动依赖 Node.js 24、npm、DeepSeek Harness Web CLI，以及同级的 `dsh-superagent-prototype/` 和 `execution-layer/exe-part/hnu-execution/`。首次启动按锁文件安装并构建插件，在 macOS 上自动查找已安装的 DeepSeek Harness.app，也可用 `SUPERDOT_DSH_BIN` 指定 CLI。macOS 的项目数据默认在 `~/Library/Application Support/SuperDot/execution/`，可用 `SUPERDOT_RUNTIME_DIR` 设置其他目录。`dsh/` 保存项目会话，`superdot/` 保存工单，`host.log` 记录启动诊断。模型可在这个独立 DSH 配置中设置。模型尚未配置时可以启动宿主、查看工单与已有会话。
