# SVG 连接表

每行是一条从起点到终点的单向线。两图的端口 ID 都由边 ID 加后缀构成，起点用 `-out`，终点用 `-in`。例如 `edge-router-input-out` 属于「归入已有工单」，`edge-router-input-in` 属于「工单补充／反馈」。

## [05_总体流程图](05_总体流程图.svg)

55 个对象，76 个端口，38 条单向连线。

| 边 ID | 起点对象 | 终点对象 | 含义 |
|---|---|---|---|
| `edge-qq-filter` | QQ<br>`node-qq` | 规则初筛<br>`node-rule-filter` | 将QQ消息送入规则初筛 |
| `edge-wechat-filter` | 微信<br>`node-wechat` | 规则初筛<br>`node-rule-filter` | 将微信消息送入规则初筛 |
| `edge-xuexitong-filter` | 学习通<br>`node-xuexitong` | 规则初筛<br>`node-rule-filter` | 将学习通消息送入规则初筛 |
| `edge-filter-context` | 规则初筛<br>`node-rule-filter` | 追溯和补齐上下文<br>`node-complete-context` | 初筛后追溯和补齐上下文 |
| `edge-context-queue` | 追溯和补齐上下文<br>`node-complete-context` | 消息包队列<br>`node-message-queue` | 将消息包加入队列 |
| `edge-queue-router` | 消息包队列<br>`node-message-queue` | 监听和取任务<br>`node-router-listen` | 消息包队列交给监听和取任务功能；线身和箭头沿用筛选／打包层橙色。全局新任务也由此进入后续Router判断。 |
| `edge-filter-raw-storage` | 筛选 / 打包<br>`node-filter` | 原始消息 / 附件引用<br>`node-raw-messages` | 保存原始消息和附件引用 |
| `edge-tickets-router` | 工单（左侧读取视图）<br>`node-tickets-left` | Router（本质是 Agent）<br>`node-router` | 程序只返回 description.visible=1 的候选工单。Router 先看简述，命中后再读节点。 |
| `edge-contexts-router` | 各级上下文（Worker / Router）<br>`node-contexts-left` | Router（本质是 Agent）<br>`node-router` | 向Router按需提供已保存的实际模型上下文与追加轨迹；复用DSH原生Session事件，消息及工具往返可回读。 |
| `edge-memories-router` | 用户记忆与分类记忆等（左侧读取视图）<br>`node-memories-left` | Router（本质是 Agent）<br>`node-router` | 向 Router 提供记忆 |
| `edge-contexts-worker` | 各级上下文（Worker / Router）<br>`node-contexts-left` | Worker（对应工单 B）<br>`node-worker-b` | 向 Worker 提供已保存的上下文与追加轨迹。同一工单续用同一 Worker Session。 |
| `edge-skills-worker` | Skills（左侧视图）<br>`node-skills-left` | Worker（对应工单 B）<br>`node-worker-b` | 向 Worker 提供 Skills（以 B 为例） |
| `edge-memories-worker` | 用户记忆与分类记忆等（左侧读取视图）<br>`node-memories-left` | Worker（对应工单 B）<br>`node-worker-b` | 向 Worker 提供记忆（以 B 为例） |
| `edge-dispatch-worker` | 分派 Worker<br>`node-router-dispatch` | Worker（对应工单 A）<br>`node-worker-a` | 分派 Worker（以 A 为例） |
| `edge-create-ticket` | 新建初始工单<br>`node-router-create-ticket` | 工单 A<br>`node-ticket-a` | Router调用建单工具，保存初始工单和原始要求；创建时自动设description.visible=1（以A为例） |
| `edge-worker-ticket-a` | Worker（对应工单 A）<br>`node-worker-a` | 工单 A<br>`node-ticket-a` | Worker仅向工单A追加业务节点：用户输入、补充、卡点、解除和阶段成果 |
| `edge-worker-ticket-b` | Worker（对应工单 B）<br>`node-worker-b` | 工单 B<br>`node-ticket-b` | Worker仅向工单B追加业务节点，原始记录不覆盖 |
| `edge-worker-ticket-c` | Worker（对应工单 C）<br>`node-worker-c` | 工单 C<br>`node-ticket-c` | Worker仅向工单C追加业务节点，原始记录不覆盖 |
| `edge-worker-finish-note` | Worker（对应工单 B）<br>`node-worker-b` | Worker 收尾，各自生成任务笔记（note）<br>`node-worker-note` | 等待、待用户或交付时正常收尾，保存上下文与每轮note后退出（以B为例） |
| `edge-dreamer-memories` | Dreamer（记忆整理 Agent）<br>`node-dreamer` | 用户记忆与分类记忆等<br>`node-memories-right` | Dreamer整个模块到用户记忆与分类记忆等存储的统一连接；不再单独绘制内部读取笔记、更新目录的两条连线。 |
| `edge-note-storage` | Worker 收尾，各自生成任务笔记（note）<br>`node-worker-note` | 用户记忆与分类记忆等<br>`node-memories-right` | 保存每轮事实与证据Note到合并后的用户记忆与分类记忆等存储；保留Note关联和工单任务记忆索引。 |
| `edge-global-input-package` | 全局输入：新任务<br>`node-global-input` | 拼预制描述模板并打包<br>`node-user-package` | 全局新任务保留用户原文，套预制模板打包后进入消息队列。 |
| `edge-global-merge-input` | 指定合并工单<br>`node-global-merge` | 工单补充／反馈（steer）<br>`node-input` | 用户指定来源和目标工单后进入工单补充／反馈（steer）入口，不经过模板打包和消息队列。 |
| `edge-global-resume-input` | 恢复已终止工单<br>`node-global-resume` | 工单补充／反馈（steer）<br>`node-input` | 恢复已终止工单进入同一steer入口，保留恢复事实；代码自动维护description.visible=1。 |
| `edge-global-recover-input` | 恢复异常中断工单<br>`node-global-recover` | 工单补充／反馈（steer）<br>`node-input` | 恢复异常中断工单进入同一steer入口，依据已保存工单、Session和输入记录安排继续；旧执行退出未确认时不另开。 |
| `edge-user-package-queue` | 拼预制描述模板并打包<br>`node-user-package` | 消息包队列<br>`node-message-queue` | 新任务模板消息包进入既有消息包队列。 |
| `edge-review-input` | 阶段成果／反馈<br>`node-review` | 工单补充／反馈（steer）<br>`node-input` | 前端把用户补充或阶段成果反馈送到指定工单的 steer 入口。Worker 先追加输入节点，再处理要求。 |
| `edge-router-input` | 归入已有工单<br>`node-router-merge` | 工单补充／反馈（steer）<br>`node-input` | Router的归入已有工单功能将新增包和补充要求交给工单补充／反馈（steer）入口；Worker先留节点再处理。 |
| `edge-input-worker` | 工单补充／反馈（steer）<br>`node-input` | Worker（对应工单 A）<br>`node-worker-a` | 指定合并、两类恢复、补充、成果反馈和终止统一经工单输入入口处理；给对应Worker的新增要求先留节点，终止按已有规则收尾。 |
| `edge-frontend-skills` | 编辑 Skills<br>`node-edit-skills` | Skills（左侧视图）<br>`node-skills-left` | 前端编辑Skills直接连接左侧数据库的Skills存储框；沿图外缘走线，不与其他业务线交叉。 |
| `edge-frontend-memory` | 查看／编辑记忆<br>`node-edit-memory` | 用户记忆与分类记忆等<br>`node-memories-right` | 用户查看／编辑合并后的用户记忆与分类记忆等。 |
| `edge-tickets-frontend` | 工单（左侧读取视图）<br>`node-tickets-left` | 查看工单<br>`node-view-tickets` | 向前端提供工单节点流；显示从事件推导，不保存工单status |
| `edge-ticket-a-storage` | 工单 A<br>`node-ticket-a` | 工单（右侧存储视图）<br>`node-tickets-right` | 以工单A为例，直接向右侧数据库工单／节点流保存固定工单信息和不可变节点流；包索引与Note索引由节点生成。 |
| `edge-stop-input` | 终止工单<br>`node-global-stop` | 工单补充／反馈（steer）<br>`node-input` | 终止要求进入与阶段成果反馈相同的工单输入入口；代码记录终止节点并自动设visible=0，再向对应Worker传递终止要求 |
| `edge-refresh-ticket` | 刷新工单状态<br>`node-global-refresh` | 工单（右侧存储视图）<br>`node-tickets-right` | 刷新从数据库读取工单固定字段、已提交节点和引用，更新前端显示 |
| `edge-router-notification` | Router（本质是 Agent）<br>`node-router` | 接收agent提示通知<br>`node-agent-notifications` | Router向前端发送需要用户注意的提示通知。 |
| `edge-worker-notification` | Worker（对应工单 A）<br>`node-worker-a` | 接收agent提示通知<br>`node-agent-notifications` | Worker向前端发送提示通知（以工单A的Worker为例），例如补材料、等待答复或阶段成果。 |
| `edge-dreamer-notification` | Dreamer（记忆整理 Agent）<br>`node-dreamer` | 接收agent提示通知<br>`node-agent-notifications` | Dreamer向前端发送记忆整理相关的提示通知。 |

## [06_执行层流程图](06_执行层流程图.svg)

15 个对象，40 个端口，20 条单向连线。

| 边 ID | 起点对象 | 终点对象 | 含义 |
|---|---|---|---|
| `in-message` | 看门狗与消息包<br>`message` | Router<br>`router` | 看门狗交付包 ID，宿主保存待办后回执。Router 凭该 ID 一次读取包内原文。 |
| `in-worker-evidence` | 看门狗与消息包<br>`message` | Worker<br>`worker` | Worker 按包 ID 读整包原文，按 ref.id 回查指定原件。下载后沿实际路径打开文件。 |
| `in-knowledge-router` | Skills、模板与记忆<br>`knowledge` | Router<br>`router` | Router 用 read 或 skill 读资料，按会话 ID 用 read 或 bash 读原生 JSONL。 |
| `in-knowledge-worker` | Skills、模板与记忆<br>`knowledge` | Worker<br>`worker` | Worker 用 read 或 bash 按固定路径读取原操作、Note 和 Session 轨迹。 |
| `in-candidates-router` | 工单合并匹配检索<br>`candidates` | Router<br>`router` | 每个包先查全部可见简述，再读命中工单详情，然后判断新建、归入或忽略。 |
| `in-user-steer` | 用户对已有工单的操作<br>`user` | 工单补充／反馈（steer）<br>`steer` | 用户的补充、反馈、终止、恢复已终止工单、恢复异常中断及指定合并，均按目标工单直接交到 steer。 |
| `in-user-ticket` | 用户对已有工单的操作<br>`user` | 工单与节点<br>`ticket` | 工单程序追加确认节点。刷新由前端宿主直接读取已提交工单。 |
| `router-dispatch` | Router<br>`router` | Worker<br>`worker` | 建单成功后，宿主交付本单路径、Worker Session ID 和首个包引用。 |
| `router-existing` | Router<br>`router` | 工单补充／反馈（steer）<br>`steer` | Router 把目标工单 ID 和新包引用交给对应 Worker 的补充入口。 |
| `router-ticket` | Router<br>`router` | 工单与节点<br>`ticket` | 新建分支调用 createTicket。写入工单头与首节点后返回工单 ID。 |
| `steer-worker` | 工单补充／反馈（steer）<br>`steer` | Worker<br>`worker` | 归入的新包由宿主直接投递，Worker 用 appendTicketNote 先写 input 再处理。用户指定两单合并时投递原操作。 |
| `worker-ticket` | Worker<br>`worker` | 工单与节点<br>`ticket` | Worker 用 appendTicketNote 追加本单节点，用 mergeTickets 合并两张指定工单并取得目标单 ID。 |
| `out-router-session` | Router<br>`router` | 上下文与新增轨迹<br>`contexts` | DSH 追加 Router 的原生事件。宿主确认本轮轨迹已保存前须完成 flush。 |
| `out-worker-session` | Worker<br>`worker` | 上下文与新增轨迹<br>`contexts` | DSH 追加 Worker 的消息、工具调用及返回。本轮正常收尾时确认 flush 成功。 |
| `out-router-notify` | Router<br>`router` | 给前端的通知<br>`notices` | Router 以自己的来源发布问题或故障。前端查询 pending 通知并持续展示。 |
| `out-worker-notify` | Worker<br>`worker` | 给前端的通知<br>`notices` | Worker 填写成果、材料、授权或提问的正文。前端持续展示待处理通知。 |
| `notice-receipt-router` | 给前端的通知<br>`notices` | Router<br>`router` | 通知存储保存用户答复后送回原 Router，宿主按 notification_id 找回待判断的包。 |
| `notice-receipt-worker` | 给前端的通知<br>`notices` | Worker<br>`worker` | 通知 ID 定位原工单、卡点和文件引用。宿主持久接收结果，仅安排一次后续工作。 |
| `out-notes` | Worker<br>`worker` | 任务笔记 Note<br>`notes` | Worker 写 Note 草稿后调用 appendTicketNote，宿主发布文件并追加引用。 |
| `out-tickets` | 工单与节点<br>`ticket` | 工单及其节点流<br>`tickets` | 固定头与节点按 JSONL 保存。刷新直接读取已提交工单并组装 nodes。 |
