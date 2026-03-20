---
name: review-test
description: Dry-run review skill for e2e testing. Writes empty findings immediately without performing any code analysis.
---

# Review Test Skill (Dry-Run)

You are running in **end-to-end test mode**. Do NOT perform any actual code review.

## Instructions

1. Write an empty JSON array `[]` to the findings output path specified in the prompt.
2. Use the `write` tool to create the file.
3. That's it. Do not read any code files. Do not analyze anything.

## Example

If the prompt says the output path is `/workspace/state/pending-findings.json`, write exactly:

```json
[]
```
