# SuperDot 消息层联调原型

用 Python 3.9 或更新版本运行，无第三方依赖。

```sh
python3 server.py
```

打开 <http://127.0.0.1:8780>。数据写入本目录的 `demo.sqlite3`。关闭并重启程序会保留队列和接管记录。想开一轮独立演示时，可以用 `--db round2.sqlite3` 指定另一份数据库。

## 对接文档

- [存储层接口契约](01_存储层接口契约.md)
- [前端接口契约](02_前端接口契约.md)

## 演示

| 操作 | 预期 |
|---|---|
| 加入一条 QQ 消息，运行正常接管 | 列表从排队中变为已接管。展开「接口数据」可看到原包和回执。 |
| 加包后选择 Router 不可用并运行 | 包进入待重试。重启程序后包仍在，切回正常接管即可交付。 |
| 加包后选择接管后丢失回执并运行 | 执行侧已有接管记录，消息层显示待重试。切回正常再运行，返回原回执，执行侧记录只有一条。 |
| 添加 A 合并到 B | Router 按引用读到操作类型和两个 ID。正式执行层之后通知 B 的 Worker，由 Worker 做合并。 |
| 恢复 C 的可见性 | 确定性程序直接恢复可见性。包列表和接管记录没有新增。 |

## 接口

接口与存储均为联调草案。看门狗以按钮或 HTTP 调用推进一轮，按 FIFO 处理队首。服务用单进程串行处理。QQ、附件正文和真正的 Router／Worker 使用示例数据或假适配器；本原型覆盖消息交接，不运行模型。

| 方法与路径 | 输入 | 输出 |
|---|---|---|
| POST /api/packages | 下表任一种包输入 | 202、`package_ref`。重复请求 200、原包。 |
| GET /api/packages/{id} | 包 ID | 包正文、附件引用和当前交接状态。重复读取安全。 |
| POST /api/router/notify | `{"package_ref":{"id":"pkg-…"}}` | 接管后返回 `package_ref` 和 `receipt_id`。按包 ID 去重。 |
| POST /api/watchdog/tick | `{"mode":"normal"}`，或 `offline`、`lost_ack` | 运行一轮交接。 |
| GET /api/settings | 无 | 监听开关和版本。模拟源立即应用设置。 |
| POST /api/settings | `{"enabled":false,"expected_revision":0}` | 保存并返回当前版本；版本冲突返回 409。 |
| GET /api/health | 无 | 模拟来源、待交接数量和缺口列表。 |
| POST /api/context | `{"account_id":"qq-1","conversation_id":"group-1","limit":10}` | 模拟上下文读取，按倒序分页，继续查时传 `before_cursor`。 |
| GET /api/state | 无 | 包列表、执行侧接管记录、工单可见性。供界面和联调核对。 |
| POST /api/tickets/restore | `{"ticket_id":"C"}` | 原工单 ID、`visible:1`。 |
| GET /api/router/tickets | 无 | Router 当前可见的工单 ID。 |

| kind | 示例输入 |
|---|---|
| source_message | `{"kind":"source_message","account_id":"qq-1","conversation_id":"group-1","message_id":"msg-017","text":"请按模板制作志愿活动 PPT。","attachment_refs":[{"id":"template-017"}]}` |
| new_task | `{"kind":"new_task","operation_id":"op-018","text":"帮我整理实验报告"}` |
| merge | `{"kind":"merge","operation_id":"op-019","source_ticket_id":"A","target_ticket_id":"B"}` |

文本包的附件引用可省略。三个来源字段共同标识一条 QQ 消息。前端操作使用稳定的操作 ID。相同身份和内容返回原包，相同身份但内容有变化则返回冲突。

## 交接契约

看门狗从待交接队列取最早的一包。本地程序调用 Router 适配器，联调方也可以独立调用 `POST /api/router/notify` 来驱动假 Router。一次通知只带包引用。

```json
{"package_ref":{"id":"pkg-8d9b4eb395bd"}}
```

Router 用 `GET /api/packages/pkg-8d9b4eb395bd` 取包。实际联调时使用入队返回的 ID，示例 ID 仅说明格式。如果触发来自合并按钮，读取结果如下。

```json
{
  "code": "OK",
  "package": {
    "package_ref": {"id": "pkg-8d9b4eb395bd"},
    "state": "AWAITING_ACK",
    "code": "OK",
    "receipt_id": null,
    "kind": "merge",
    "operation_id": "op-019",
    "source_ticket_id": "A",
    "target_ticket_id": "B"
  }
}
```

执行侧保存接管记录后才返回以下回执。重复通知返回同一个 `receipt_id`，外层业务码变为 `REPLAYED`。单独读包没有副作用。单独调用假 Router 接口只写执行侧记录，消息层在看门狗收到回执并落盘之后才出队。

```json
{"code":"OK","package_ref":{"id":"pkg-8d9b4eb395bd"},"receipt_id":"ack-03a18ef70f6c"}
```

| 字段 | 类型与约束 |
|---|---|
| `kind` | 必填字符串。取 `source_message`、`new_task` 或 `merge`。 |
| `package_ref.id` | 服务端生成的非空字符串。按完整值查询，重试沿用同一个值。 |
| `account_id`、`conversation_id`、`message_id` | QQ 包必填非空字符串，组合构成消息幂等身份。 |
| `text`、`attachment_refs` | 文本包原文是必填的非空字符串。附件引用可省略，默认为空数组，每项有非空字符串 `id`。 |
| `operation_id` | 两类前端操作必填。重试复用原值，新的操作使用新值。 |
| `source_ticket_id`、`target_ticket_id` | 合并包必填的两个不同 ID。方向是来源并入目标，工单存在性及操作规则由执行侧校验。 |
| `state`、`code`、`receipt_id` | 分别表示包交接状态、最近一次处理结果和消息层保存的回执。接管确认落盘前 `receipt_id` 为 `null`。 |

本地存储默认路径为同目录的 `demo.sqlite3`。`inbox` 保存冻结包和消息层队列状态，`router_acceptance` 保存执行侧的包 ID 与回执，`settings` 存模拟监听设置，`tickets` 存模拟工单可见性。正式存储使用的路径、原始消息字段和引用解析方式由三方对齐。

## 状态与返回码

`QUEUED`（保存并入队） → `AWAITING_ACK`（开始通知） → `ACCEPTED`（消息层保存接管回执）。

若通知失败或回执未知，进入 `RETRY_WAIT`。下轮用原包 ID 重试。重启时，仍为 `AWAITING_ACK` 的包也可以重试。接管后，包继续可读，通过状态将其排除在待交接队列之外。

| HTTP | code | 含义 |
|---|---|---|
| 200 | OK / REPLAYED | 成功或复用原记录。 |
| 200 | FILTERED | 监听关闭，QQ 输入没有入队。 |
| 200 | NO_WORK | 队列为空。原型保留 JSON 响应体供程序读取。 |
| 202 | QUEUED | 已持久化入队。 |
| 400 | INVALID_INPUT | 请求字段无效。 |
| 404 | REF_NOT_FOUND | 引用不可解析。 |
| 409 | CONFLICT | 同一身份对应不同内容。 |
| 503 | ROUTER_UNAVAILABLE / STORE_UNAVAILABLE | 依赖暂不可用。 |
| 504 | ACK_UNKNOWN | 消息层不知道执行侧是否已接管。 |

## 替换假模块

- 胡帆的执行层对接 `notify_router` 的入参和回执。收到包引用后，先持久化可恢复的待处理记录，再回执。正式的执行侧续跑消费这条记录，自行管理 Router／Worker 的进度。
- 两侧用同一个演示库里的不同表，分两次提交。第一笔记录执行侧接管，第二笔才记录消息层收到回执。这个间隙就是丢回执用例的观察点。
- 支凌宇的存储实现替换示例里的包保存、引用读取和接管确认。演示用已封包的 QQ 样例模拟上下文，监听设置只控制当前模拟开关。正式存储需提供原始消息索引、真实上下文窗口、监听的历史生效时段和附件读取。
- 本目录可独立复制。接口路径、数据库结构和状态名都可以在三方对齐后调整。

## 存储与前端交接

| 谁来接 | 走哪条接口 | 演示的交接行为 |
|---|---|---|
| 支凌宇负责的存储 | `POST /api/packages`、`GET /api/packages/{id}`、`POST /api/context` | 包与队列一起保存，按稳定引用读回正文与附件引用，用账号、会话和游标查询模拟上下文。 |
| 支凌宇负责的存储 | 看门狗调用 Router 后记录回执，`GET /api/state` 可核对 | 执行侧接管和消息侧确认分别提交。重启能重投未确认包，同时可继续读已接管的原包。 |
| 前端 | `POST /api/packages`、`GET /api/state` | 全局输入和指定合并入队，页面刷新后读回包和交接状态。 |
| 前端 | `GET/POST /api/settings`、`GET /api/health` | 可通过接口读写模拟监听设置、查询积压和缺口。当前页面将主要空间留给交接，设置与健康暂通过接口演示。 |
| 前端和工单程序 | `POST /api/tickets/restore`、`GET /api/router/tickets` | 恢复后 Router 查询可见，包和接管记录没有新增。 |

程序联调方可直接运行 `python3 verify.py`。它在临时数据库中启动服务，验证存储、交接和前端接口；会主动重启服务一次，不使用现场演示数据库。页面演示可以按上方表格点击。

正式接入时，支凌宇需确认原始消息与附件存放位置、上下文读取规则以及包引用解析方式。前端仍需与执行层对齐 steer、确认成果和工单刷新。本原型演示的前端范围是消息交接和恢复可见性，模拟存储为独立 SQLite。
