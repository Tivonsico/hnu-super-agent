# SuperDot 工单接口

命中规则或识别为确定通知的实时订阅消息会自动排入 Router 队列。手动添加的消息由用户在收件箱提交。历史导入可查看和手动提交。

- `POST /api/inbox/promote` 将已保存在收件箱的消息加入 Router 队列，参数为 `msg_id`。
- `GET /api/router/queue` 返回最多 50 条待处理输入及原文。
- `GET /api/router/orders` 返回可供 Router 判断归属的工单。
- `POST /api/router/decide` 接收 `msg_id`、`decision` 和可选的 `reason`。决定可为 `create`（可附 `title`、`due`）、`append`（需附整数 `task_id`）或 `ignore`。重复提交同一决定返回原结果。
- `GET /api/work-orders/inputs?id=<id>` 返回关联到该工单的 Router 输入，包括之后追加的消息。

- `GET /api/work-orders` 返回工单列表和服务端日期。工单含原文、执行要求、当前状态和 `revision`，前端用 `source_conversation_name` 和 `source_conversation_id` 展示会话来源。
- `GET /api/work-orders/events?id=<id>` 返回节点记录。
- `POST /api/work-orders/action` 接收界面操作。
- `POST /api/work-orders/worker` 接收 Worker 的 `claim`、`request_approval` 和 `complete`。

写入请求包含整数 `id`、整数 `revision` 和字符串 `action`。审批问题通过 `request_approval` 的 `note` 提交，可附上 `options` 字符串数组。用户选择一项或填写提示词后，通过 `approve` 的 `note` 提交。Worker 重新接单时可从 `approval_response` 读取答复，节点记录也会保留问题和答复。完成时可以用 `note` 回报产出。工单有变动时返回 HTTP 409，调用方重新读取当前状态。接口沿用实例的访问认证。

Router 建单后工单进入 `queued`。Worker 接单后进入 `running`，提出问题后进入 `blocked`。用户批准时，工单重新进入 `queued`，保留审批问题及记录。工单终止后，旧 Worker 的写入会被拒绝。恢复工单时会重新进入 `queued`。

对于同一事项的新版模板或补充要求，Router 使用 `append`。追加会写入节点记录，保留原工单和正在执行的 Worker，后续按最新输入继续处理。

DSH 运行端需要消费 Router 和 Worker 队列，执行前读取工单状态，追加后按最新修订号回写。


### 审批与 Worker 会话

助手等待你的指示时，在「给助手的提示词」输入要求并提交。正式执行端应将提示词投回发出请求的 Worker 会话，让它从原上下文继续。现行执行接口中的历史带选项通知要求精确回传对应的选项值，页面会列出提示，附件授权只接受明确答复。收到提交回执后，页面提示等待助手继续。

「打开 DSH 会话」目前显示会话绑定信息。正式工单的 Worker 会话取自执行端已提交的 `session` 节点及 `role: worker` 引用。真实 DSH 跳转等待执行宿主提供入口和鉴权方式。预览工单会提示没有真实会话。

消息包队列向执行宿主申请接管。Router 决定忽略、归入已有单或新建工单。建单或归单后的 Worker 绑定及执行由宿主完成。
