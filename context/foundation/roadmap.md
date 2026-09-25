# Roadmap

## Active / Planned

| Change | Status | Summary |
| --- | --- | --- |
| [per-model-timeout](../changes/per-model-timeout/change.md) | planned | Add per-model timeouts (60s) so no single slow model exhausts the chain budget; make aggregate timeout configurable (default: unlimited) |

## Completed

| Change | Status | Summary |
| --- | --- | --- |
| [swe-score-resolver](../changes/swe-score-resolver/change.md) | impl_reviewed | Auto-map 0.5 models to real SWE-bench scores via deterministic matching + LLM fallback |
| [swe-list-order](../changes/swe-list-order/change.md) | impl_reviewed | Hybrid model management with two-tier ranking and auto-discovery |
| [simplify-test-data](../changes/simplify-test-data/change.md) | impl_reviewed | Simplify test data by removing unnecessary user.login field |
| [openrouter-provider](../changes/openrouter-provider/change.md) | impl_reviewed | Add OpenRouter and Kilo as first-class providers with free-model support |
| [lgtm-review](../changes/lgtm-review/change.md) | impl_reviewed | Post LGTM comment when no review findings |
| [improvements-research](../changes/improvements-research/change.md) | impl_reviewed | Comprehensive research identifying improvement areas across safety, maintainability, review quality, and performance |
| [mistral-hallucination-bench-visibility](../changes/mistral-hallucination-bench-visibility/change.md) | impl_reviewed | Add Groq provider & bench ranking visibility |
| [always-comment-in-review](../changes/always-comment-in-review/change.md) | preparing | Always use a single summary comment instead of inline line comments |
| [custom-api-support](../changes/custom-api-support/change.md) | impl_reviewed | Generic custom API support (any OpenAI-compatible endpoint) |
| [daily-benchmark](../changes/daily-benchmark/change.md) | planned | Daily model benchmark & auto-reorder |
| [mistral-support](../changes/mistral-support/change.md) | impl_reviewed | First-class Mistral API support |
| [model-recheck](../changes/model-recheck/change.md) | impl_reviewed | Daily model recheck + API discovery |
| [nodejs-rewrite](../changes/nodejs-rewrite/change.md) | impl_reviewed | Rewrite GitHub Action from Go to Node.js |
| [review-improvements](../changes/review-improvements/change.md) | impl_reviewed | Comprehensive improvements across quality, performance, and features |
| [schema-validated-review](../changes/schema-validated-review/change.md) | impl_reviewed | Structured-output validation with Zod schema |
| [severity-based-review-messages](../changes/severity-based-review-messages/change.md) | impl_reviewed | Differentiate review messages by finding severity |
| [v1-rewrite](../changes/v1-rewrite/change.md) | impl_reviewed | NIM model benchmarking, env prompt override, per-language templates |

## Cancelled

| Change | Reason |
| --- | --- |
| [kilocode-provider](../changes/kilocode-provider/change.md) | Privacy concerns with kilo-auto/free; existing custom_api_url covers the use case |
