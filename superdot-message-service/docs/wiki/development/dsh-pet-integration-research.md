# SuperDot 与 dsh-pet 接入调研

本机预览已连接 dsh-pet 独立版 0.4.9。以下以该版本发布源码与 SuperDot 当前实现为准。上游主分支的 API 概览仍把独立模式的对话写为不可用，0.4.9 源码已提供独立模型适配。本文记录调研和建议，产品代码未改动。 [dsh-pet 0.4.9 release](https://github.com/PC2005-cloud/dsh-pet/releases/tag/v0.4.9) · [上游 API 概览](https://github.com/PC2005-cloud/dsh-pet/blob/main/API.md#独立模式不打开-dsh)

## 已核实的能力

| 功能 | 0.4.9 的实现 |
| --- | --- |
| 设置和桌宠本体 | 原生设置管理显隐、位置、大小、动作、每只宠物的人设和对话选项。SuperDot 当前「显示大肥鱼桌宠」会直接写入默认实例 `main` 的显隐，桌宠重连时也会重新设为桌面显示。两处都能改同一设置。 [原生配置说明](https://github.com/PC2005-cloud/dsh-pet/blob/v0.4.9/CONFIG.md) · [SuperDot 当前桌宠桥接](../../../noticehub/web/desktop_pet.py#L136) |
| 表情包和动画 | 上游内置透明动画和表情包，表情包池用于碎碎念及聊天配图，模型按名称和描述选择；业务也可选定图片和动画后广播固定文案。两种配图方式可并存。适合工单的素材宜挑选，避免把聊天梗图用于审批和错误。 [功能说明](https://github.com/PC2005-cloud/dsh-pet/blob/v0.4.9/FEATURES.md) · [表情包池实现](https://github.com/PC2005-cloud/dsh-pet/blob/v0.4.9/dsh-pet/src/host/memes.ts) |
| 原生对话和语音 | 独立版接受 OpenAI 兼容及 Anthropic 两类协议，可填服务地址、模型、API Key，列出模型并测试连接。配置完成后可启用原生聊天、持久记忆和碎碎念。DeepSeek 语音可以配置专用 Key。设置读接口返回密钥是否已配置，密钥由桌宠写入本机私有配置文件。 [模型就绪判断](https://github.com/PC2005-cloud/dsh-pet/blob/v0.4.9/dsh-pet/src/standalone/ai-provider/create.ts#L64) · [模型接口](https://github.com/PC2005-cloud/dsh-pet/blob/v0.4.9/dsh-pet/src/standalone/ai-transport.ts) · [设置脱敏](https://github.com/PC2005-cloud/dsh-pet/blob/v0.4.9/dsh-pet/src/standalone/ai-config.ts#L149) · [配置落盘](https://github.com/PC2005-cloud/dsh-pet/blob/v0.4.9/dsh-pet/src/standalone/ai-storage.ts) |
| 工单状态和菜单 | `/work-status` 的第三方工单状态只有一个槽，后写覆盖。SuperDot 从工单及待处理通知中选一条，优先待审批，右键「更多 → 打开 SuperDot 工单」可回到当前工单。已经确定的文案无需模型或 API Key。 [外部工单状态接口](https://github.com/PC2005-cloud/dsh-pet/blob/v0.4.9/dsh-pet/src/host/routes/state.ts#L110) · [SuperDot 状态投影与菜单](../../../noticehub/web/desktop_pet.py#L189) |
| 气泡和系统通知 | 原生气泡渲染只有一个槽，聊天、余额和工作状态等根据优先级切换。工作状态可能被对话等遮住，睡觉也会暂停普通工作播报。`/broadcast` 支持固定文案、配图、动画、时长及可选朗读，需要短时占用锁。工作状态写入只更新状态，无法附上任意工单链接或要求原生逐条触发系统通知。原生面板若要同时堆叠并始终保留多个待审批项，需要扩展上游。 [原生气泡渲染](https://github.com/PC2005-cloud/dsh-pet/blob/v0.4.9/dsh-pet/runtime/electron-helper/sprite/bubble.js#L62) · [外部广播](https://github.com/PC2005-cloud/dsh-pet/blob/v0.4.9/dsh-pet/src/host/routes/interaction.ts#L103) |
| 本机设置入口 | 从桌宠右键选择「打开 AI 设置」可进入其设置页。独立版也将带本次运行令牌的设置地址写入私有运行文件，SuperDot 已用这份文件连接桌宠。可考虑让受信的本机 SuperDot 动作在系统浏览器打开该地址，前端只取得结果。0.4.9 独立服务校验本机 Host、来源及令牌，设置地址和令牌应留在本机。 [桌宠菜单](https://github.com/PC2005-cloud/dsh-pet/blob/v0.4.9/dsh-pet/runtime/electron-helper/sprite/menu.js#L11) · [设置地址的运行文件](https://github.com/PC2005-cloud/dsh-pet/blob/v0.4.9/dsh-pet/src/standalone/cli.ts#L77) · [独立版请求校验](https://github.com/PC2005-cloud/dsh-pet/blob/v0.4.9/dsh-pet/src/standalone/request-security.ts#L70) |
| 授权 | 上游代码用 MIT。大肥鱼角色公开授权为 CC BY-NC-SA 4.0，公开使用核对署名，二创遵守相同方式共享，商业分发前另取角色授权或换用自有角色。 [上游许可和署名](https://github.com/PC2005-cloud/dsh-pet#许可) · [角色授权条款](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans) |

## 建议的接入顺序

1. 把 SuperDot 的入口改成「桌宠播报工单」，展示连接状态和原生设置入口。开关只控制是否同步工单，关闭时清掉 SuperDot 写入的状态、菜单项和监听。显隐、位置、尺寸、动作、闲聊、音色和 API Key 由桌宠保存。桌宠暂时离线时，网页消息与审批照常可用。
2. 继续使用 `/work-status` 表达工单阶段，保持审批在 SuperDot 中独立记录。多条审批由网页气泡和工单列表承载。原生只预览当前最重要的一条，文案可显示待审批总数，右键可加「查看待审批」。若要求网页关闭后也要多个可点击气泡，固定上游版本后扩展原生渲染，让桌宠读由 SuperDot 提供的待审批列表，每项打开对应工单。
3. 先按场景挑素材。已转工单用点头或挥手，执行中用工作动作，待审批用举手或等候，成果用庆祝，失败用轻微困惑。以原生工作状态动画为主；额外的短播报要避开审批提示和用户的聊天。网页上的品牌、新手引导和设置继续用尺寸合适且经过筛选的静态图或短动画。
4. 保留桌宠的闲聊选项。若验证出用户确实会问「有哪些待审批」「这个工单到哪一步了」，再做由 SuperDot 查询的只读问答，让用户从桌宠打开对应页面。数据范围跟随当前认证和工单权限，发送给模型前限制到必要字段。可以先用固定查询和回答模板验证需求；审批仍由用户在工单页执行。
