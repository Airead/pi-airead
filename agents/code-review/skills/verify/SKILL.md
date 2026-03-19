---
name: verify
description: Verify a code review finding by re-examining the actual code. Outputs a JSON decision (submitted or rejected) without executing any GitHub operations.
---

# Verify Skill

You are verifying a code review finding. Your job is to be skeptical — only real, confirmed issues should be approved for submission.

## Input

You will receive:
- **Finding**: A JSON object describing the issue (file, line, severity, category, title, description, codeSnippet, suggestion)
- **Repository root**: The workspace directory containing the cloned repository
- **GitHub repo**: The `owner/repo` identifier (for context only — you do NOT interact with GitHub)

## Verification Process

### Step 1: Go Back to the Code

Use the `read` tool to read the actual file at the specified line range. **Do not trust the finding blindly** — verify it against the real code.

Check:
- Does the code at that line actually match the `codeSnippet`?
- Is the described issue actually present?
- Could the issue be a false positive? Look for:
  - Sanitization/validation happening elsewhere (check callers and helpers)
  - Framework-level protections that make the issue moot
  - Intentional design choices with comments explaining why

### Step 2: Assess Severity

Ask yourself:
- Is this a real problem that could cause harm in production?
- Or is this theoretical/unlikely in practice?
- Would a senior developer agree this needs fixing?

If the answer to any of these is "no", **reject the finding**.

### Step 3: Submit or Reject

**If the finding is VERIFIED**, output status "submitted" in the result JSON. The host orchestrator will handle duplicate checking and GitHub issue creation.

**If the finding is REJECTED**, output status "rejected" with a brief explanation.

**IMPORTANT:** Do NOT run any `gh` commands. Do NOT attempt to create issues, check duplicates, or interact with GitHub in any way. All GitHub operations are handled by the host orchestrator.

### Output

Write the verification result to the file specified in the prompt as **compact JSON** (no extra whitespace or newlines — minimize output tokens):

```json
{"status":"submitted","finding":{...}}
```

Or if rejected:

```json
{"status":"rejected","reason":"The input is already sanitized by the middleware in src/middleware/sanitize.ts:15","finding":{...}}
```

### Important Rules

- **Be skeptical.** Your job is to filter out false positives, not to rubber-stamp findings.
- **Go back to the code.** Never verify a finding based only on its description.
- **One finding maximum.** Even if somehow multiple findings are provided, only process the first one.
- **No GitHub operations.** All `gh` commands are forbidden in this environment.
- Write the result JSON file using the `write` tool.
