---
change_id: add-nousresearch-provider
title: Add NousResearch as a first-class provider with free models
status: complete
created: 2025-08-18
updated: 2026-08-18
archived_at: null
---

## Notes

Add NousResearch inference API (`https://inference-api.nousresearch.com/v1`) as a first-class provider, following the exact same pattern as kilocode and openrouter. The gateway is OpenAI-compatible. Free models (all with `:free` suffix, zero-priced via API): `poolside/laguna-s-2.1:free`, `poolside/laguna-xs-2.1:free`, `tencent/hy3:free`, `stepfun/step-3.7-flash:free`, `upstage/solar-pro4:free`, `meituan/longcat-2.0:free`. Paid Hermes-4 models (`nousresearch/hermes-4-70b`, `nousresearch/hermes-4-405b`) are NOT free — confirmed via API pricing endpoint. `nousresearch_free_only` filter mirrors `kilocode_free_only`.