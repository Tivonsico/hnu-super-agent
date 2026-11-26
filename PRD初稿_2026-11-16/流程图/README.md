# HNU Super Agent 流程图

[05 总体流程图](05_总体流程图.svg) 展示消息、工单和各角色的关系，共 55 个对象、76 个端口、38 条单向连线。[06 执行层流程图](06_执行层流程图.svg) 展开胡帆负责的输入输出，共 15 个对象、40 个端口、20 条单向连线。两图均可独立打开、编辑和解析。[执行模块对外接口文档](执行模块对外接口文档.md) · [数据库工具接口文档](执行模块与数据库间的工具接口文档.md)

## 05 中的 Router

上排从左至右是「监听和取任务」「识别任务」「忽略／待确认」。下排按连线去向排列，「分派 Worker」连 Worker，「新建初始工单」连工单 A，「归入已有工单」把新消息的包引用交给「工单补充／反馈（steer）」。新任务的实际执行顺序是先建单，再派 Worker。

前端的「恢复已终止工单」和「恢复异常中断工单」各有一个端口，直接连到 steer。前者追加恢复节点，由代码把简述的可见性恢复为 1。后者需要先确认旧 Worker 已退出，再根据工单及旧 Session 的记录继续执行。

## 胡帆在周五前交什么

11 月 17 日最后一次会议约定，下次开会前要把对外接口写到另外两人能据此开工的程度。按周五（11 月 20 日）交付，06 图就是这份初稿。贾天瑞负责采集、筛选、打包、排队和看门狗。胡帆从收到唤醒信号开始，负责执行侧的接管回执、Router 判断、Worker 执行和工单交互。支凌宇负责数据库、记忆与 Dreamer。[11 月 17 日最后一次会议](../会议文稿/20261117215855-贾天瑞的快速会议-逐字稿文本-1.md)

| 对接谁 | 06 给出的约定 |
|---|---|
| 贾天瑞 · 消息层 | 看门狗交付包引用。执行侧按包 ID 保存待办，回执只含 `code` 与 `package_ref`。按组回读原始记录时，文字和文件按 `sent_at` 从早到晚返回。 |
| 支凌宇 · 存储和记忆 | Router 读包后先取全部可见工单简述，再按路径读可能相关的工单。模板、Skills、记忆和 DSH 会话按需读取。工单按序追加节点，Worker 每轮正常退出前保存 Note。 |
| 前端 · 工单和通知 | 全局新任务先打包入队。已有工单的补充、反馈、终止、两类恢复和指定合并直接进 steer。确认成果追加节点，刷新读取已存工单。通知由实际发起方填写正文。待处理通知持续显示，用户处理后保存结果，并把回执送回原发起方。 |

执行层沿用 TypeScript 与 DSH 原生文件工具。调用方在提交前确定业务 ID。Router 查过候选后用 `createTicket` 建单，归入的新包经 steer 交给 Worker。Worker 用 `appendTicketNote` 追加节点，用 `mergeTickets` 合并两张指定工单。每单一份 JSONL，每次收尾一份 Note。[文件工具与业务回执](执行模块对外接口文档.md#result-fields)

## 06 与现有设计的五项核对

本次核对覆盖 11 月 11 日、14 日、17 日及 21 日的会议记录，以及 05、数据库草图和贾天瑞的可运行原型。11 日确定了按工单处理和保留依据的方向，14 日明确沿用 DSH 的 Agent 循环和 steer，17 日约定了交接、恢复、记忆与通知。21 日确定同单续用 Worker Session、收尾笔记分别记录时间，并保留单条消息 ID 和整包读取。[会议记录](../会议文稿/) · [14 日关于 Agent 循环的讨论](../会议文稿/20261114140013-贾天瑞的快速会议-逐字稿文本-1.md)

### 1. 消息层

看门狗按 `package_ref` 唤醒执行侧。首次持久接管后回 OK，回执丢失时按原包重投并回 REPLAYED。两次返回都带同一个包引用。正式任务包只有 `source_message` 和 `new_task`，都先存原始记录，再分别引用文字和文件。`readPackage` 按包 ID 一次返回原文。已有一条或一组原件 ID 时，使用 `readRawInBatch`。批读按发送时刻升序，重复 ID 只取一次，缺项随结果返回。[存储层草案](../消息层初稿-贾天瑞/01_存储层接口契约.md) · [演示实现](../消息层初稿-贾天瑞/server.py)

指定合并由前端经工单补充入口交给目标工单。等待回执属于看门狗的交接进度。原型的恢复按钮只改可见性，正式恢复还要追加节点并安排执行。真实 Worker 续跑和前端持久通知仍待联调。[前端契约](../消息层初稿-贾天瑞/02_前端接口契约.md) · [17 日会议](../会议文稿/20261117203036-转写_支凌宇预定的会议-逐字稿文本-1.md)

### 2. 记忆与存储

新 Router 或 Worker Session 启动时，宿主从本地存储直接读取角色模板和顶层 `MEMORY.md`。Skills 先读名称和简述，用到时再打开正文。顶层约 15 KB，用户和 Dreamer 都能维护。按任务再读能力条目、Note 和原始证据。Resources 放 Skills 与模板，Ticket 存固定头和追加的节点。每轮正常收尾写一份 Note，保留 `note_id`、`ticket_id`、`session_id`、首次写入时间 `created_at`、正文 `content` 和证据引用 `evidence_refs`。Raw Session 可软链接到 DSH 配置的存储根，独立 Log 是可选项。[支凌宇的数据库草图](../会议文稿/2026111721支凌宇数据库初步设计图.jpg) · [17 日存储讨论](../会议文稿/20261117212227-转写_支凌宇预定的会议-逐字稿文本-1.md)

每条文字、每份文件都可按 ID 用 `readRawInBatch` 读取。`content` 分别是原文和文件名，文件另带 `download_state`。已下载的文件直接按路径读取。未下载时 Worker 先请用户同意，`askDownloadFile` 返回路径后交给 DSH `read` 或对应二进制文件处理工具。通知回执由原 Worker 接收，消息层实际下载。[原始记录和附件](执行模块与数据库间的工具接口文档.md#raw-reads)

### 3. DSH 上下文轨迹

宿主独占写句柄，DSH 按 Session 追加事件，`seq` 从 0 连续增长。工单与 Note 给出会话 ID，Agent 用 `read` 或 `bash` 打开按该 ID 发布的明文 JSONL 链接。首行的 `cwd` 为会话工作目录。HNU 一张工单固定一个 Worker Session，多次执行在同一条轨迹上续写，成果文件另按引用读取。等待 `flush()` 成功后才确认已保存。模型上下文由事件投影得到，即使发生压缩，原始事件仍可追溯。[会话模型](../../deepseek-harness/docs/subsystems/session.md) · [持久化句柄](../../deepseek-harness/packages/session/session-persistence/src/handle.ts)

06 的例子中，第一轮是 `turn: 1, step: 1`。事件 8 调用 `read`，事件 10 用 `sourceEventSeqs: [8]` 和同一 `toolCallId` 指回它。Worker 收到程序转交的 QQ 要求时，会话里的消息角色是 `user`，投递来源是 `dsh-superagent/relay`。原发言人可按消息包回查。五条节选事件已用本地 DSH 的编解码器做往返校验，模型流和工具输出也分别用原版函数核对过。[工具返回](../../deepseek-harness/packages/core/tools/src/batch.ts) · [DSSA 投递实现](../../dsh-superagent-prototype/src/app/delivery.ts)

### 4. 移植到 DSSA

| 05 中的位置 | 可以沿用的部分 | HNU 要接上的部分 |
|---|---|---|
| QQ／微信／学习通 → 初筛 → 消息包 | NoticeHub 有三种来源的采集实现。DSSA 提供来源注册和线程上下文读取。 | 贾天瑞负责按校园规则封包。接入 DSSA 的 `Trigger` 时要从实际来源取得线程、发言人、是否为人发出和时间。QQ 演示包缺少完整身份与时间，不能凭它推定授权。 |
| Router → Worker、补充／反馈 | DSSA 有 Router／Worker 预设、接单／挂载／忽略工具、持久待办和去重投递。运行中的 Worker 可接 DSH 原生 steer，继续用现有 Agent 循环、工具和 Skills 加载机制。 | 原版保留一个主 Session，并以 `worker-工单ID` 寻址 Worker。HNU 按消息包开 Router Session，每轮 Worker 正常退出，派工、收输入与取消都要按本单固定的 Worker Session ID 寻址。 |
| 工单 → 数据库、Note → Dreamer | 可以沿用 DSSA 的工单输入、按引用查证和先持久保存再执行的做法。 | 原版 SQLite 会更新整张工单快照，HNU 以追加节点为准，另有终止后恢复、双单合并与跨工单记忆。DSSA 的 `MemoryRepositories` 是供测试或临时引擎使用的内存仓储。Dreamer 需要校园插件实现。 |

移植的主要工作是把校园消息映射成 DSSA 的 `Trigger`，并适配工单和 Session 的生命周期。例如，DSSA 人工停止后须重新接单，HNU 允许用户恢复原工单。仓库中的 DSSA 锁定 DSH `0.2.1-alpha.2` 依赖，本地 DSH 的 Session 包为 `0.2.2-rc.1`。本次验证了接口和事件，两个版本组合的插件尚未端到端运行。[NoticeHub 来源](../../notice-hub/README.md) · [DSSA 扩展指南](../../dsh-superagent-prototype/docs/008-扩展指南.md) · [Trigger 定义](../../dsh-superagent-prototype/src/core/model.ts) · [执行器](../../dsh-superagent-prototype/src/executor/dsh.ts) · [工单存储](../../dsh-superagent-prototype/src/app/store.ts) · [内存仓储](../../dsh-superagent-prototype/src/core/memory.ts) · [工单写入工具](执行模块对外接口文档.md#result-fields)

### 5. Super Agent 的设计取舍

05 的三条路径体现了“尽量少占用人的注意力”。已有工单收到补充时，Router 把依据直接交给 Worker，用户无需重述任务。工作进展留在工单，成果可用、缺少材料、遇到故障时再提示。Worker 正常收尾时写 Note。若还有通知等答复，先保存原事件与工单的关联，收到回执后才能继续依赖答复的步骤。用户可确认某一版成果，也可补充、终止或恢复。[05 总体图](05_总体流程图.svg) · [DSSA 设计理念](../../dsh-superagent-prototype/docs/000-理念.md)

差异主要在主动接单和通知去向。DSSA 对获准的明确请求可以直接接单。推断出的任务默认只在 `observe` 模式记录，切换 `auto` 并命中已启用的成文规则才会接单。DSSA 要求在请求发出的会话中答复。HNU 希望在用户选定的校园消息范围内认出任务就做，把成果交给个人工单。监听开关和关键词初筛只能说明哪些消息进入候选。若要复用 DSSA 原版授权，还需明确哪些来源、发言人和任务规则允许自动开工。未建单时，Router 可把通知事件关联到消息包。用户的回答连同发起方确定的 `notification_id` 交回 Router，接收程序据此找到原包。这条回执路径仍需与前端和存储联调。少打扰是目前的设计目标，实际误接单和无用通知仍要用校园消息验证。[DSSA 授权与接单模式](../../dsh-superagent-prototype/docs/002-授权.md) · [11 日关于自动处理与用户确认的讨论](../会议文稿/20261111215248-转写_贾天瑞的快速会议-逐字稿文本-1.md)

## 直接读 SVG

两图都使用 `hnu-flow-graph/1`。在 `metadata#hnu-graph` 中，每条边用 `source`、`sourcePort`、`target`、`targetPort` 指明两个对象和各自端口。对应的 SVG 路径具有同名 ID、对应的 `data-*` 属性和一个末端箭头。弧形跨线和背景上的白色描边属于原连线的绘制细节。

06 的 `contract.databaseTools` 列出四个查询和下载工具，以及三个工单写入工具。`contract.agentTools` 列出 Router 和 Worker 实际使用的 HNU 工具与 DSH 原生工具。`contract.interfaces` 中列出每个接口的调用方、接收方、位置、请求、响应和重试约定。`contract.schema` 定义字段，`contract.examples` 保存用虚构数据填写的输入输出。按边上的 `api` 可以找到相应接口。对象上的 `exampleIds` 指向图中展示的示例。`workflowResults` 单列执行程序交回的结果。每个角色的 `availableTools` 与实际注册清单对应。

[SVG 连接表](SVG连接表.md) 可按起终点查线。也可以在本目录运行下列命令，直接校验两张图或导出含接口约定的完整模型。[读取脚本](读取SVG连接.py)

```sh
python3 读取SVG连接.py 05_总体流程图.svg
python3 读取SVG连接.py 06_执行层流程图.svg
python3 读取SVG连接.py 06_执行层流程图.svg --format json
```
