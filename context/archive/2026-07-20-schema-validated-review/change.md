---
id: schema-validated-review
title: Add structured-output validation to review-action
status: archived
archived_at: 2026-08-01T21:33:46Z
created: 2026-07-20
updated: 2026-08-01
---

# schema-validated-review

Add Zod-typed Review/Finding schema, request JSON output from models (NIM
uses response_format, Mistral uses tools), validate deterministically against
the PR diff, render markdown only from the validated object. Truncation and
parse failures cause model skips through the existing fallback chain. Remove
dead per-file review path and orphan .txt prompt files.