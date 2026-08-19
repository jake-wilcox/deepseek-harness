# Agent Note: OpenAI Codex 订阅认证与用量

Status: implemented

[English](2026-08-18-openai-codex-subscription-oauth.md) | 中文

## 问题

pi-ai catalog 已经包含 `openai-codex` 提供方及其 ChatGPT OAuth 实现，但 DeepSeek Harness 没有提供 pi-ai 有意留给应用层的任何组成部分：持久凭据存储、登录编排和用户交互界面。无密钥 profile 因而会走到 `Provider is not configured`；把 access token 粘进 API 密钥字段虽能暂时工作，却只能维持到该 token 过期。

2026-08-13 的临时决策在这三部分齐备之前，将仅支持 OAuth 的提供方从可配置提供方目录中隐藏。本决策针对 OpenAI Codex 取代该临时姿态。它不会把 Codex SDK 变成主 agent，也不会把一个 harness 塞进另一个 harness；既有 DeepSeek agent loop 仍然构造每个请求，再调用 pi-ai 提供方适配器，与 API 密钥提供方的路径完全相同。

## 决策

**凭据提供方增加串行替换操作。** `CredentialProvider.modify(ref, update)` 在与 `set`、`unset` 相同的互斥下读取确切的当前机密，并可选择替换它。`undefined` 表示保留当前值；删除仍显式使用 `unset`。本地提供方会在异步回调运行期间持有跨进程原子写锁。这正是 pi-ai 在 OAuth 提供方轮换 refresh token 时需要的不变量：并发模型请求或 harness 进程不能各自交换同一个一次性 token，再由后写方覆盖胜出的结果。

**pi-ai 凭据保留在 Harness 引用之后。** `HarnessCredentialStore` 把每个提供方 id 映射到确定性的 `DSH_PI_AI_<PROVIDER>_AUTH` 引用，在持久化边界校验带类型标签的 JSON 文档，并通过 `ctx.credentials` 实现 pi-ai 的 `read`、`list`、`modify` 与 `delete`。settings 与任何配置响应都不携带值。适配器把同一个存储交给每一份不可变 `Models` 快照，因此登录、认证检查、普通流式请求与自动刷新都观察同一份持久凭据。

**LLM seam 持有提供方无关的认证生命周期。** 适配器插件为一个提供方注册认证方式、不含机密的状态查询、登录、退出和可选用量查询。`LlmRuntime` 允许每个提供方同时只有一次活动登录尝试，在后台运行它，发布已分离的 device-code 或进度通知，支持按确切尝试轮询和取消，把一份终止结果保留到被下一次尝试替换，并在注册 dispose 时取消并排空登录或用量工作。提供方失败会写入日志，对外缩减为安全文本。`llm/auth-updated(provider)` 是失效事件，不是状态或凭据传输。

**账户额度是该提供方注册上的可选操作。** 能解析和刷新交互式凭据的同一所有者可以提供 `usage(signal?)`，而 `LlmRuntime.providerUsage()` 只返回提供方本地周期 id、已用百分比、可选周期长度、可选重置纪元和捕获时间。Core 会校验这些值并分离快照。账户额度不是逐请求 `TokenUsage`、会话状态、遥测或持久事件；Core 不提供缓存或用量更新事件。

**OpenAI Codex 使用 pi-ai 的 device-code 流程。** `llm-pi-ai` 注册一种方式 `使用 ChatGPT 登录`，选择 pi-ai 的 `device_code` 选项，并在意外收到手动输入或回调 prompt 时直接拒绝，而不是临时发明另一种交互。Host 把启动、轮询、取消与退出 RPC 暴露为仅限回环同源的特权操作。Models 卡片渲染验证 URL 与用户代码，轮询不透明尝试 id，只在认证成功后启用「应用」，并支持退出。它永远不会收到 access token 或 refresh token。

**Codex 额度使用 Harness 持有的 OAuth 文档。** 用量操作先向 pi-ai 请求当前认证，使其通过 `HarnessCredentialStore` 串行刷新 token，再从同一份已刷新文档读取账户 id。随后它带 bearer token 与账户 id 调用 Codex 账户端点，对完整响应施加大小限制并解析，只投影主周期和次周期额度。该操作不会调用 Codex CLI，不会读取 `~/.codex/auth.json`，也不会暴露凭据、账户 id、请求标头、套餐标签、credits 或原始响应。

**ContextMeter 提供不感知提供方的用量 slot。** ui-conversation 在上下文明细之后声明并渲染一个 session 作用域的子 slot，但不接收提供方或用量状态。独立的 ui-provider-usage 插件从 ui-model-selection 解析当前路由，只在弹层打开期间调用受保护的提供方无关 RPC，并持有加载、刷新、取消、陈旧结果隔离和呈现。上下文圆环继续只表示上下文占用；订阅额度显示在独立标记的分区中。

**目录只公布已经实现的认证。** API 密钥 catalog 路由照常可用。组合了 `ctx.credentials` 时，插件额外提供 `openai-codex`；没有它时就不存在持久存储或登录注册，该路由继续隐藏。`llm-pi-ai` 会跟随这个可选服务的生命周期，而不是只在插件启动时取一次快照：较晚挂载会加入存储、登录注册与目录路由，移除则撤销它们；存储身份变化后，适配器会在下一次操作时重建 `Models` 快照。其他碰巧声明了 pi-ai OAuth 的提供方不会自动获得交互界面。手写且点名 `apiKeyEnv` 的 `openai-codex` profile 仍是显式 token 覆盖。

## 曾考虑的替代方案

**读取 `~/.codex/auth.json`。** 不采用，因为这会让当前 harness 依赖另一个应用的私有存储格式与生命周期。所选存储归 DeepSeek Harness 所有，并使用 pi-ai 的公开凭据接口。

**把 Codex SDK 作为提供方运行。** 不采用，因为 Codex SDK 是 agent harness API，不是更低层的模型传输。嵌套它会增加另一套 loop、工具策略、会话模型和压缩层。所需的模型替换只需让既有提供方适配器能够对 Codex 路由完成认证。

**把完整登录生命周期放进 `llm-pi-ai` 或 Models UI。** 不采用，因为尝试必须跨越单次 RPC 存活，而且提供方认证是其他提供方也能实现的适配器能力。Core 持有生命周期与安全进度；适配器持有协议细节；客户端持有呈现。

**刷新只使用进程内 mutex。** 不采用，因为两个产品进程可以共享同一份凭据文档。轮换 token 的不变量必须延伸到持久提供方的跨进程写锁。

**立即提供所有 pi-ai OAuth 提供方。** 不采用，因为 catalog 元数据本身不能证明该客户端能渲染提供方的 prompt 序列。这里仅实现了 OpenAI Codex 的 device-code 交互；未来认证方式必须先增加自身的生命周期翻译与真实组装 UI 覆盖，才能出现在目录中。

**从轮次响应标头推断额度。** 不采用，因为标头只描述最近完成的某次请求，当前 pi-ai WebSocket 响应观察也拿不到它们，而且无法形成按需账户快照。账户端点会独立于模型轮次，回答确切已登录账户。

**把订阅额度放进 Models settings。** 不采用，因为额度是工作会话中需要查看的短暂当前账户状态。ContextMeter 弹层让它在上下文容量旁保持可见，同时不混淆两项读数，也不让会话呈现依赖具体提供方。

## 影响

用户可以从**设置 → 模型**添加 OpenAI Codex，完成**使用 ChatGPT 登录**，应用该提供方，再选择其 catalog 模型。后续请求仍是 DeepSeek Harness 轮次，并通过 pi-ai 使用由 ChatGPT 订阅支持的 Codex 提供方。凭据以 `DSH_PI_AI_OPENAI_CODEX_AUTH` 存放在 `$DSH_HOME/.credentials.yaml`，自动刷新，也可以从同一张卡片移除。打开会话 ContextMeter 会读取同一账户当前的订阅周期，并在独立分区中显示已用百分比和重置时间。

凭据 seam 有五个操作，每个提供方实现或测试替身都实现 `modify`。Host 与 remote event allowlist 携带一项认证失效事件，以及受保护的认证和用量方法。终止登录状态与额度快照只存在于进程内；重启会从持久凭据重建已认证状态，但既不会恢复未完成的 device-code 尝试，也不会恢复用量数据。

## 测试

凭据测试覆盖串行回调、无操作替换、遮蔽、文件 fallback 提升，以及拒绝之后的队列恢复。LLM 测试覆盖认证生命周期、用量能力与校验、取消、安全失败和 dispose。pi-ai 测试覆盖不回显机密的 JSON 持久化、OAuth 状态、由刷新获得的用量标头、端点选择、有界解析和中立周期映射。Host 与 connection 测试覆盖 RPC 投影、取消、安全错误、schema 校验和回环权限。组件与真实组合覆盖会把按需用量分区放进 ContextMeter，浏览器录制则针对功能分支的真实服务器与账户演示该行为。
