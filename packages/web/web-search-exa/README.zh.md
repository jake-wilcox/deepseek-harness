# @deepseek-ai/dsh-web-search-exa

[English](README.md) | 中文

由 [Exa](https://exa.ai) 支持的 `WebSearchProvider`，用于 harness [web 能力 seam](../web/README.md)（`ctx.web`），也是随附 base bundle 选定的搜索提供方。它调用 Exa 的 `POST /search` 端点并请求高亮摘要内容，把扁平 `results[]` 映射为 seam 规范化的 `WebSearchResult`，并在每次搜索时通过凭证 seam 解析 API 密钥——托管存储、两个 `.env` 层与启动环境都可用，存入或轮换的密钥无需重启即可生效。

这是一个**实现**包：它向 `ctx.web` 注册提供方，不拥有 `ctx.web` 键，也不注册面向模型的工具（后者属于 `@deepseek-ai/dsh-tool-web`）。与 `@deepseek-ai/dsh-llm-deepseek` 一样，它是函数／命名空间插件（`inject: ['web']`），负责注册后端，而非默认导出服务。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | （未设置） | 字面量 Exa API 密钥；建议改用 `apiKeyEnv`，避免密钥进入配置文件。 |
| `apiKeyEnv` | `EXA_API_KEY` | 每次搜索通过 `ctx.credentials` 解析的凭证引用；未组合凭证服务时，启动环境即整个凭证平面。 |
| `baseURL` | `https://api.exa.ai` | 端点基址；追加 `/search`。无法解析时提供方不可用。 |
| `searchType` | `auto` | 以 Exa `type` 发送的检索模式：`auto`（由 Exa 决定）、`keyword` 或 `neural`。 |
| `numResults` | （未设置） | 请求不含 `maxResults` 时使用的默认结果数。未设置时不发送默认值。必须是正整数。 |
| `highlightsPerResult` | `1` | 每个结果请求的 highlight 句子数（Exa `highlightsPerUrl`）。必须是正整数。 |

```yaml
- id: web-search-exa
  name: '@deepseek-ai/dsh-web-search-exa'
  config:
    apiKeyEnv: EXA_API_KEY
```

## 设置

插件安装 `web-search-exa` 设置区段，因此 `$DSH_HOME/settings.yaml`（以及 Web UI 的搜索卡片——它把 `apiKey` 写入凭证域而非区段本身）可以在运行时更改每个配置键：选项在每次搜索时从已解析区段投影，即使写入发生在解析中途，一次搜索也绝不混用两个区段。存在密钥路径（字面量或引用）即令 `available()` 为真；搜索时解析不到值则以可操作的 `WEB_PROVIDER_CREDENTIAL_MISSING` 消息失败，消息中点名该引用。

## 映射

Exa 返回扁平 `results[]`，不返回生成答案，因此省略 `content`。每项结果映射为 `WebSearchSource`：`url` ← `url`、`title` ← `title`、`snippet` ← 第一个非空的 `highlights[]` 条目（没有高亮摘要的结果缺少可移植的 snippet，会被丢弃）、`publishedAt` ← `publishedDate`。请求的 `maxResults` 优先于已配置的默认 `numResults`，并作为 Exa `numResults` 发送，以优化成本和延迟；最终上限由 seam 强制执行。提供方失败（HTTP 错误、网络失败、响应体无法解析或结构不符、凭证解析失败）以 `WebError` `WEB_PROVIDER_ERROR` 呈现；缺失密钥以 `WEB_PROVIDER_CREDENTIAL_MISSING` 呈现；中止请求——无论中止原因携带什么——以 `WEB_ABORTED` 呈现。HTTP 重定向会在访问 `Location` 指向的目标之前被拒绝，并以 `WEB_PROVIDER_ERROR` 呈现。

## 模型体验

通过 [`dsh-tool-web`](../tool-web/README.md) 间接影响；该工具保留此提供方经 `maxResults` 限制的 URL、标题、首条 highlight 与发布日期，或将确切的错误消息 `Exa search aborted`、`Exa search request failed: <error>`、`Exa returned an unprocessable response body: <error>` 与 `Exa search has no API key for "<ref>"…` 置于消费方的错误包装层内；生成答案与提供方私有字段不进入上下文。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与暂缓事项

- **没有非空白高亮摘要的结果会被整个丢弃**：没有可映射的可移植 snippet，因此返回源可能少于请求数量。
- **只公开 `searchType`／`numResults`／`highlightsPerResult`**：Exa 的其他控制项（livecrawl、category、域名／日期过滤条件、全文内容）等待提供方无关的 Service Definition 字段（见 [seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)）。
