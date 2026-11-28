# 为 SuperDot 配置 API Key

打开群务台「设置 → AI API Key 配置」，选择服务商和模型，填写 API Key 后点击「保存配置」。模型列表首项为推荐模型。点击「获取 API Key」可打开服务商的密钥入口，展开「接入说明」可查看注册步骤和 API 官网链接。

所需模型未出现在列表中时，可选择「手动填写模型 ID」。使用自己的接口地址时，选择「自定义服务」。

群务台只保存配置。手工编辑时，在群务台实例的 `.env` 中填写 `NOTICEHUB_LLM_API_KEY`、`NOTICEHUB_LLM_ENDPOINT` 和 `NOTICEHUB_LLM_MODEL`。
