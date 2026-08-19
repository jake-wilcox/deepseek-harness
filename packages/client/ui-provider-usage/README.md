# @deepseek-ai/dsh-client-ui-provider-usage

English | [中文](README.zh.md)

This browser plugin contributes provider-account allowance state to `conversation.composer.contextMeter.usage`, the provider-blind child slot inside the conversation ContextMeter popover. Opening the popover resolves the session's current provider through `ctx.modelDirectories` and calls the provider-neutral `llm.providerUsage` API. The section keeps context occupancy separate from subscription allowance, shows every returned window in provider order, and includes consumed percentage, optional duration, optional reset time, refresh status, and a manual retry or refresh action.

Each session owns one private reader with an identity-stable observable snapshot. The reader starts network work only while the popover contribution is mounted, aborts that work when the contribution closes or the session is disposed, and fences late results. A failed refresh keeps the last successful value visible for that session reader's lifetime; no result enters shared session state or durable storage. Unsupported providers display an explicit unavailable state.

## Model Experience

None, as the plugin reads account metadata for browser presentation and does not add content, tools, settings, or metadata to a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- Usage refresh is user-driven when the ContextMeter opens or the refresh action is selected; the plugin does not poll in the background.
- Window names derive from provider-reported durations. A window without a duration uses a positional provider-neutral label.
