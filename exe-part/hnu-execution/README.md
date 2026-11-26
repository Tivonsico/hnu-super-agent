# HNU 执行层（胡帆负责部分）

从看门狗唤醒后的解析、判断、工具调用，到 Worker、工单交互与本侧读写。寄生于 DSH，按
`PRD初稿_2026-11-16/流程图` 的 05/06 图与两份接口文档实现，不改动 DSH 与 DSSA 原始代码。

## 分层

纯核心 + 端口 + DSH 适配，仿 DSSA 的组织。核心无 DSH 依赖，可脱离 DSH 单测。

| 文件 | 职责 |
|---|---|
| `src/types.ts` | 工单、节点、原始记录、证据引用等数据类型。 |
| `src/io.ts` | 对外输入输出：绑定、steer 请求、通知，字段同 06 `$defs`。 |
| `src/ids.ts` | 稳定 ID：`key()`=sha256(JSON) 前 32 位，及各派生 ID。 |
| `src/files.ts` | superdot 文件存储：工单 JSONL（临时文件+rename）、操作、成果、Note、宿主记录。幂等写入。 |
| `src/tickets.ts` | 工单写入与读取：createTicket / appendTicketNote / mergeTickets / 候选。 |
| `src/notifications.ts` | 通知登记、查询、处理、回执投递。所有来源共用。 |
| `src/message-tools.ts` | 消息层读取：readPackage / readRawInBatch / askDownloadFile，批读排序去重。 |
| `src/tools.ts` | 按角色构造 HNU 工具定义与原生工具名单（06 `agentTools`）。 |
| `src/validate.ts` | 工具执行时的校验：引用形状、节点约束、成果与 Note 草稿位置、调用方与本单本包的绑定。 |
| `src/prompts.ts` | 加载 `prompts/` 下的角色模板，并注入 superdot 下的 `MEMORY.md`。 |
| `prompts/router.md`、`prompts/worker.md` | Router 与 Worker 的角色提示词。 |
| `src/orchestrator.ts` | 执行宿主：Router/Worker 生命周期、用户操作节点、确认、下载授权、通知回执。 |
| `src/http.ts` | 对外 HTTP：notify / tickets.actions / confirm / 视图 / notifications。框架无关。 |
| `src/ports.ts` | 外部能力接口：`MessageStore`（消息层）、`AgentLoop`（DSH 适配）。 |
| `src/dsh/loop.ts` | `AgentLoop` 的 DSH 实现：映射 Agent 生命周期、工具注册、幂等投递。 |
| `src/dsh/plugin.ts` | Cordis 插件入口：挂接 superdot、Web 服务、消息层。 |

## 设计约束（忠实于会议最终共识）

- **单写者**：宿主写固定头、session 与用户操作节点；Worker 用工具写
  input/result/blocked/unblocked/note。两者不同时写同一工单。
- **Router 只建单或归入**：判重用候选标题/简述，归入交由目标 Worker 追加 input。
  这条边界在工具层同样生效：Router 没有写文件和写工单的工具，`bash` 中的写入命令会被拒绝；
  `createTicket` 只接受本轮绑定的包号和工单号，并且要求本轮先调用过 `readCandidateTickets`。
- **Worker 只写本单**：`appendTicketNote` 只接受本单号，`refs` 必须符合 06 的 `EvidenceRef`；
  成果文件要放在 `workspace/artifacts/`，Note 草稿要放在 `workspace/notes/<note_id>.json`；
  `mergeTickets` 只能由目标单的 Worker 调用，参数要与已保存的原操作一致。
  校验不通过时回 `INVALID_INPUT` 或 `REF_NOT_FOUND`，并附 `detail` 说明，供模型修正。
- **每单一个 Worker Session 复用**：`worker-<ticket_id>`；package 开新轮（queue），
  用户操作用 steer。
- **追加式 JSONL**：工单只追加不改，原字节保留为前缀。可见性由节点顺序计算。
- **幂等**：接管按包 ID、操作按 operation_id、节点按 node_id、通知按 notification_id
  去重；同内容重放回 REPLAYED，异内容回 CONFLICT。
- **通知→前端→回执**：worker/router/Dreamer/DataBase 发通知，用户处理后回执投递回原来源。

## 测试

纯核心与宿主编排用内存/临时目录与 `FakeLoop`（仿 DSSA 的假宿主）驱动，零网络、零 API key。

```
npm test        # node --test --experimental-strip-types 'test/*.test.ts'
```

当前 45 个用例覆盖：文件存储与幂等、通知流转、工单写入与合并、消息批读排序、工具集与
授权、工具层校验与 Router 写入拦截、提示词加载、Router/Worker 全流程（新建/归入/补充/终止/
确认/下载授权）、HTTP 状态码。

### 真实模型测试

`live/` 下的脚本挂载真实 DSH 栈，用 DeepSeek 模型驱动 Router 和 Worker。需要网络，
key 从仓库根目录的 `API_KEY.txt` 读取（已被 `.gitignore` 忽略），不进 `npm test`。

```
node --experimental-strip-types live/router.mjs   # 新建、归入、忽略
node --experimental-strip-types live/worker.mjs   # 成果与 note、补充、反馈、确认、下载授权、终止与恢复、合并
```
