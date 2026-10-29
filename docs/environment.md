# Provider configuration

Choose `INVESTIGATION_PROVIDER=baseten` or `INVESTIGATION_PROVIDER=meta`. `createLiveModelProvider` rejects missing or unknown values and never substitutes a mock. The selected provider reads its key only on the server. Keep secrets in ignored `.env.local` or deployment secrets; `.env.example` contains placeholders.

For the Legacy Pricing example at `/examples/legacy-pricing`, `ENABLE_LIVE_INVESTIGATION_HTTP=1` explicitly enables the paid investigation button. It is disabled by default and should only be used in a trusted local environment. Operator verification uses `npm run demo:report` and does not depend on this HTTP flag; see [demo instructions](demo.md).

For Baseten Model APIs, set `BASETEN_API_KEY`. The adapter defaults to the [official Baseten Chat Completions endpoint](https://docs.baseten.co/reference/inference-api/llm-openapi-spec.json), `https://inference.baseten.co/v1/chat/completions`, and the hackathon model ID `meta-models/muse-spark-open-1026`, which the user confirmed from the onboarding email. Public [Muse Spark Open documentation](https://dev.meta.ai/docs/muse-spark-open/deploy) lists `meta-models/muse-spark-open`; the hackathon ID is not publicly documented and has not yet been tested with a live request. `BASETEN_MODEL_ID` can override the default. `BASETEN_MODEL_ENDPOINT` is optional for an officially documented endpoint change.

For direct Meta inference, set `MODEL_API_KEY` and select `meta`. The existing adapter defaults to `muse-spark-1.3`; `META_MODEL_ID` and `META_MODEL_ENDPOINT` remain optional. Provider configuration does not affect the deterministic mock tests.

## Prepared live smoke test

The command below is **paid** and must be run only after approval. It loads the ignored `.env.local`, selects Baseten explicitly, and makes exactly one request about two lines of the checked-in pricing fixture. It pins the hackathon model and official endpoint, permits no retries, caps the request at 12 seconds and 512 output tokens, and requests `low` reasoning effort. It prints provider, returned model, latency, sanitized completion diagnostics, a candidate rule, locally resolved evidence, and `NOT_TESTED` verification status. It never prints the API key or raw response.

```bash
RUN_BASETEN_LIVE_SMOKE=1 INVESTIGATION_PROVIDER=baseten node --env-file=.env.local node_modules/vitest/vitest.mjs run --config vitest.live.config.mts
```

The live test has not been run. Its request pins the onboarding-confirmed hackathon slug, so an environment override cannot silently change the model. An invalid slug or unsupported schema returns a provider error; the application does not switch to mock results.

The first live request with 256 output tokens failed because the completion did not have `finish_reason: "stop"`; the earlier adapter did not record the actual reason. [Baseten's API specification](https://docs.baseten.co/reference/inference-api/llm-openapi-spec.json) documents `stop`, `length`, and `tool_calls`, and exposes optional reasoning-token usage. [Meta's Muse Spark Open settings](https://dev.meta.ai/docs/muse-spark-open/settings) say the model reasons before answering and defaults to `xhigh` reasoning strength. The next request uses `low` and 512 tokens to leave room for a short JSON answer while remaining bounded. Any `length`, missing, filtered, tool-call, or unknown finish reason remains a failure.
