# SuperDot Day 2 联调

贾天瑞负责采集、封包、消息侧持久化和前端。胡帆负责执行宿主、Router 和 Worker。支凌宇负责存储契约和工单持久化。本仓库用现有 SQLite 保存消息侧原件和队列，执行端通过稳定的引用读取。工单和通知以执行宿主返回的已提交记录为准。

## 实施与验收计划

1. 在消息入库时保存文字和附件原件。封包事务同时固定成员顺序、覆盖标记和队列条目。升级时，已有封包从快照补建原件引用。已监听的 QQ 群，实时收取和自动补采的消息都可组包。自动补采沿用配置的回溯范围和每群条数，补采消息按原发送时间进入组包窗口。新任务可以从网页直接进入队列。
2. 队列空闲时，看门狗每 5 秒检查一次待投递的包。执行端收到包 ID 后可立即读原件。收到 HTTP 200 及匹配的 `OK` 或 `REPLAYED` 回执，消息层才结束排队。超时、非成功响应或包 ID 不符时，保留原包并退避重试，等待期间继续投递其他包。
3. 工单台经同源 API 读取工单和待办通知，使用执行侧的工单 ID、节点 ID 和通知 ID。新任务经包队列提交。指定合并、终止、恢复、异常接续、补充、反馈和确认直接走工单操作接口。
4. 先用隔离数据重放回执丢失、重启、节点证据回查和附件授权，再用三方实际进程跑同一批场景。

## 选择监听范围

在「设置 → 监听范围与规则」打开对应渠道。QQ 勾选会话并保存。微信和钉钉可以从列表选择，也可以输入会话 ID 后保存。学习通连接账号后点「刷新课程」，勾选课程、保存订阅，再开启接收。各渠道的关键词、发送者及等待时间在「消息触发规则」中设置。已监听的 QQ 群自动进入筛选范围，只有命中规则并完成收集的消息包才交给 Router。

## 依据

11 月 21 日两场会议明确了先持久化原件与消息包、再按包 ID 入队，执行侧接管后的确认使消息层出队。Router 和 Worker 需要按引用从后端读原件，批读结果按发送时间排序。会议中存储引擎仍待支凌宇选定。

字段按两份独立执行接口文档一致的定义接入。旧联调原型中的 `receipt_id` 和 `kind=merge`，以及手工检查版中的包元数据读法，用于追溯方案演变。当前确认接管依据是 `code` 和 `package_ref.id`。合并通过工单操作提交。`readPackage` 直接返回原件批读结果。

执行宿主按独立接口清单在 DSH 注册具名业务工具。DSH 原生文件工具用于已知且有权访问的路径，能写任务草稿和待发布成果。正式工单和消息队列由业务接口提交。调用方可预分配 ID，收到持久写入的回执后才把操作视为已提交。

## 配置和权限

在消息服务的 `.env` 设置 `NOTICEHUB_EXECUTION_URL`，值为执行宿主的 HTTP(S) 源地址，例如部署给出的 `http://127.0.0.1:9000`。可选的 `NOTICEHUB_EXECUTION_TOKEN` 作为消息层调用执行宿主的 Bearer 令牌。留空执行地址时，消息包保留在本地，工单台继续显示本地预览。填入地址后，看门狗开始处理已有待接管项及之后封好的包。升级前没有待接管记录的旧包保留在收件箱。

消息侧 HTTP 沿用网页鉴权。执行宿主调用消息接口时，非无令牌环回部署需带 `X-Token: <NOTICEHUB_WEB_TOKEN>`。附件下载还需要执行宿主出示 `Authorization: Bearer <NOTICEHUB_EXECUTION_TOKEN>`。待下载的 QQ 文件由执行宿主核对该工单和附件的用户许可后，才传 `authorized: true`。绝对路径回执用于同机且可访问同一数据目录的部署。

## 消息侧接口

| 方法和路径 | 请求与回执 |
| --- | --- |
| `GET /api/packages/{id}` | `readPackage({package_id})` 的 HTTP 适配。返回 `{code:"OK",records,missing_refs}`。未封包或不存在回 404。 |
| `POST /api/raw/batch` | `readRawInBatch({raw_ids})` 的 HTTP 适配。去重后按发送时间排序，同一时刻按首次输入顺序。缺失引用列入 `missing_refs`。 |
| `POST /api/raw/attachments` | 浏览器上传 `{operation_id,filename,content_base64}`，单件上限 10 MiB。回 `{code:"OK",ref:{id}}`，同请求重放回 `REPLAYED`。 |
| `POST /api/raw/download` | 执行宿主提交 `{raw_id,authorized?}`，成功回 `{code:"OK",file_path}`。工具注册时将 `file_path` 解为 `askDownloadFile` 的字符串回执。 |
| `POST /api/packages` | 提交 `{kind:"new_task",operation_id,text?,attachment_refs?}`。原话和附件至少一项。首次回 HTTP 202 `QUEUED`，同请求回 HTTP 200 `REPLAYED`，改内容复用操作 ID 回 409。 |
| `GET /api/execution/status` | 回 `{configured}`，表示是否设置执行地址，同时返回 `artifacts_available` 表示是否配置共享成果目录。 |
| `GET /api/inbox?feed=packages` | QQ 包条目的 `delivery_state` 为 `queued` 或 `accepted`，分别表示待接管和已接管。 |

执行端负责实现 `POST /api/router/notify`。输入只含 `{"package_ref":{"id":"…"}}`。处理时先提交接管记录和待执行任务，再回 `{"code":"OK","package_ref":{"id":"…"}}`。同包重放改回 `REPLAYED`。

前端通过消息服务同源转发 `GET /api/tickets`、`GET /api/tickets/{id}`、`POST /api/tickets/actions`、`GET /api/notifications` 和 `POST /api/notifications/{id}/handle`。网络失败后重试工单操作需沿用原 `operation_id` 及原参数。存储、工单或通知的正式部署地址由各模块交接时提供。

同机部署可设置 `NOTICEHUB_EXECUTION_DATA_ROOT` 为执行宿主的 `<superdot>` 绝对目录。浏览器通过 `GET /api/artifacts/{ticket_id}/{filename}` 下载指定版本。服务先按执行接口核对成果节点中的引用，再从 `<superdot>/artifacts/{id}` 读取已发布文件。分机部署需要可共享的成果目录。
