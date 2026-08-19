# Agent Note：Exa 默认搜索与凭证 seam 对齐

Status: implemented

[English](2026-08-18-exa-default-search-credential-parity.md) | 中文

## 问题

随附 base bundle 只挂载 DeepSeek 搜索提供方并固定 `web.searchProvider: deepseek-official`，因此即使部署的 agent 模型在别处鉴权（本 fork 的 agent 是经 OAuth 的 OpenAI Codex 订阅），`web_search` 也要求 `DEEPSEEK_API_KEY`。DeepSeek 搜索还是一次带服务端检索的辅助模型请求——本部署不想要的按次模型开销。仓库内的 Exa 提供方正是想要的形态（专用搜索端点、免费额度可取密钥、循环中无模型），却未被挂载、在构造时烘焙 `$EXA_API_KEY` 绕过凭证 seam、没有设置区段，而 Web UI 的搜索卡片硬绑定 `web-search-deepseek` 命名空间。

## 决定

**Exa 成为随附搜索默认值；DeepSeek 保持挂载但未被选中。**base bundle 挂载 `web-search-exa`（`apiKeyEnv: EXA_API_KEY`）并把 `web` 行改指 `searchProvider: exa`。改回只需一行配置，因此 DeepSeek 行保留其凭证引用与基址覆盖。`tool-web` 的 60 秒搜索预算保留：它覆盖仍可选中的 DeepSeek 路由，该路由的搜索是一次完整模型请求。

**Exa 提供方获得与 DeepSeek 同级的集成。**其配置新增 `apiKeyEnv`（`role('credential-ref')`，默认 `EXA_API_KEY`），`apiKey` 改为 `role('secret')`；插件安装 `web-search-exa` 设置区段；提供方改取选项 thunk，每次搜索入口快照一次，一次操作绝不混用两个区段；密钥每次搜索经凭证 seam 解析，启动环境为无缝回退。`available()` 报告密钥路径（字面量或 resolver）加配置有效性；搜索解析不到值时以点名引用的可操作 `WEB_PROVIDER_CREDENTIAL_MISSING` 消息失败。

**共享的提供方机制迁入其归属包，而不是被克隆。**`dsh-credentials` 新增 `resolveCredential(ctx, ref)`（组合服务时由服务作答，否则环境即凭证平面）与 `credentialPlan(ctx, config, defaultRef)`（每个带密钥提供方都要组装的字面量优先展开）。`dsh-web` 新增 `resolveProviderApiKey`、`providerErrorMessage`、`abortable` 与 `isAbortError`，均接受提供方的 `ProviderRequestErrors` 文案——机制与错误码归 seam，消息条条归提供方。DeepSeek 提供方改用同一组 helper，也借此统一了两者的中止分类：携带自定义原因的中止在两个提供方中都映射为 `WEB_ABORTED`。

**Web UI 搜索卡片跟随随附提供方。**`ui-settings-plugins` 把 `WEB_SEARCH_NS` 改指 `web-search-exa`、默认凭证引用改为 `EXA_API_KEY`、数字字段从 DeepSeek 的 `maxUses` 改为 Exa 的 `numResults`。DeepSeek 命名空间仍由 Host 提供；只是在有人交付卡片之前没有卡片。

**浏览器搜索快照 lane 显式固定其提供方。**`apps/web/tests/scaffold.ts` 在场景提供 `deepSeekSearch` 时补丁 `web.searchProvider: deepseek-official`：该 lane 有意驱动 DeepSeek 提供方对着本地 Anthropic 形状的替身；随附组合现在选中 Exa，不固定则 lane 会组合出一个其固件并不建模的提供方。

## 备选方案

**用现有 Google AI Studio 密钥走 Gemini grounding。**被部署所有者否决：grounding 又是一次辅助 LLM 搜索（正是要离开的形态），且要为按查询计费的路由新写一个提供方包。

**Google Custom Search JSON API。**否决：Google 已于 2025 年停止新用户注册并宣布 2027-01-01 关停；无法再取得新密钥。

**Tavily。**不作默认：需要新提供方包，免费额度又小于已在仓库内的 Exa。

**保留 DeepSeek 默认、经 profile 补丁切换。**否决：本 fork 的产品立场是 Exa 优先；按机器补丁会让随附组合仍要求一个部署并不持有的密钥。

**把 DeepSeek 的凭证／中止机制克隆进 Exa 提供方。**被重复检测门禁与归属否决：机制与 `WebError` 错误码属于 seam，回退准则属于 `dsh-credentials`，第三个提供方将再克隆一遍。

## 后果

全新检出的 `web_search` 由 Exa 提供：经 Web UI 搜索卡片（写入凭证域）、`~/.dsh/.credentials.yaml`、任一 `.env` 层或环境存入 `EXA_API_KEY`，下一次搜索即用、无需重启。`web-search-exa` 现在 peer 依赖 `dsh-credentials` 与 `dsh-settings`，不再依赖 `dsh-launch-environment`；`dsh-credentials` 为环境回退 peer 依赖 `dsh-launch-environment`。无密钥 Exa 组合从选择期的 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` 变为搜索期附带存储指引的 `WEB_PROVIDER_CREDENTIAL_MISSING`，与 DeepSeek 行为一致。

Exa 形状的浏览器快照 lane（真实提供方与凭证 seam 背后的本地 Exa 替身）暂缓：录制其模型流需要本部署不持有的 `DEEPSEEK_API_KEY`。固定住的 DeepSeek lane 暂时保留搜索回合的组装转录覆盖。

## 测试

Exa 包测试覆盖经真实 `LocalCredentialProvider` 的凭证 lane（缺失、存入、轮换、无需重启）、空环境值、resolver 拒绝与中止交错、每次搜索单快照规则、设置区段（存储端点免重注册、密钥脱敏、脱离回退、命名空间释放），以及组内强制的双服务器重定向证明——其对照用例记录了原生 fetch 在跨源跟随时剥除 `authorization`，而私有请求体仍会跨源。seam 测试直接固定 `abortable` 的取消契约。客户端测试覆盖改指后的卡片字段与命名空间路由。DeepSeek 提供方的整套测试在共享 helper 之上原样通过。
