# noticehub

SuperDot 消息服务的 Python 包。从 [main.py](../main.py) 启动，配置由 `bootstrap/` 和 `platform/` 加载。

## 消息与执行联调

| 目录 | 改这里的情况 |
| --- | --- |
| [receivers/](receivers/) | 改消息入口、来源校验，或接入微信、钉钉、学习通。QQ 的 OneBot 上报、Framework 接入、会话读取和历史补采集中在 [receivers/qq/](receivers/qq/)。 |
| [rules/](rules/) | 改消息触发、监听范围和组包窗口，或维护已有自定义通知规则。 |
| [packages/](packages/) | 改向前取上下文、等待后续消息、封包、覆盖标记和原件成员索引。 |
| [queue/](queue/) | 改持久队列、看门狗和接管回执核对。 |
| [execution/](execution/) | 改执行宿主 HTTP 客户端、工单与通知转发，或读取已登记的成果文件。 |
| [storage/](storage/) | 改 SQLite 原件、消息、附件持久化或数据库维护。按包读原件的入口在 [storage/sqlite/store.py](storage/sqlite/store.py)。 |
| [work_orders/](work_orders/) | 改本地工单预览、SQLite 工单记录、兼容待办和日历。正式工单和通知由 `execution/` 请求执行宿主。 |
| [notifications/](notifications/) | 改推送通道、摘要和 Android 使用的推送记录。 |
| [runtime/](runtime/) | 改接收端、网页、看门狗的启停或周期调度。 |
| [web/](web/) | 改 HTTP 路由或页面。路由登记在 [web/routes.py](web/routes.py)，请求鉴权和错误响应复用 [web/product_api.py](web/product_api.py)，业务处理器在各目录的 `http.py`。页面和脚本在 [web/web_static/](web/web_static/)。 |

原文先入库。封包时，包成员、覆盖标记和队列项在同一个 SQLite 事务提交。执行宿主拿到包 ID 后可以立即回读原文。看门狗收到匹配的接管回执才结束排队。

## 兼容功能和系统代码

Android、悬浮球和已有日历订阅继续使用 `work_orders/` 的兼容待办入口。共用类型和资格判断在 `domain/`，时钟与配置在 `platform/`。

QQ 托管和公网访问在 `remote/`，更新在 `update/`，Windows 浮球在 `floatball/`。修改后按仓库 [AGENTS.md](../AGENTS.md) 选择相关用例。联调流程、接口和目录说明见 [架构](../docs/wiki/architecture.md) 和 [Day 2 联调](../docs/wiki/guides/day2-integration.md)。
