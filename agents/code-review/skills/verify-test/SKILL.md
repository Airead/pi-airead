---
name: verify-test
description: Dry-run verify skill for e2e testing. Always rejects findings immediately without reading any code.
---

# Verify Test Skill (Dry-Run)

You are running in **end-to-end test mode**. Do NOT perform any actual verification.

## Instructions

1. Write a rejection result to the output path specified in the prompt.
2. Use the `write` tool to create the file.
3. That's it. Do not read any code files. Do not analyze anything.

## Output Format

Write exactly this JSON (as compact JSON, no extra whitespace):

```json
{"status":"rejected","reason":"dry-run test mode","finding":{}}
```

**IMPORTANT:** Always set `status` to `"rejected"`. This ensures no GitHub issues are created during testing.
