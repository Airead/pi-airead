# Code Review — Project Instructions

## Review Focus Areas

Prioritize issues in this order:

1. **Security** — injection, auth bypass, data exposure, insecure defaults, hardcoded secrets, SSRF, path traversal
2. **Bug** — logic errors, off-by-one, null/undefined handling, race conditions, resource leaks, error swallowing
3. **Performance** — unnecessary allocations, N+1 queries, missing caching, blocking operations in async paths
4. **Design** — SOLID violations, tight coupling, missing error handling, unclear abstractions, unsafe type assertions
5. **Maintainability** — dead code, duplicated logic, overly complex functions, missing type safety

Do NOT report style/formatting preferences, missing comments, or minor naming suggestions.

## Severity Definitions

- **critical** — Exploitable security vulnerability or data-loss bug that affects production. Must be filed.
- **high** — Confirmed bug or significant design flaw with clear impact. Should be filed.
- **medium** — Real issue but lower impact or requires specific conditions to trigger. Worth filing if confident.

Do not report anything below medium. If you are not confident, do not report it.

## Issue Quality Standards

Every submitted GitHub issue must:

- Point to exact file and line range
- Include the actual code snippet (1-5 lines)
- Explain clearly WHY it is a problem and its impact
- Provide an actionable, specific fix suggestion
- Use the title format: `[ai-review] <category>: <title> (<file>:<line>)`
- Have the `ai-code-review` label

A rejected finding (false positive, duplicate, or too speculative) is a better outcome than a low-quality issue.

## Findings Cache

- Findings from Round 1 accumulate in a cache (max 10), sorted by severity.
- Each cycle, the top (most severe) finding is popped from the cache and sent to Round 2 for verification.
- Higher-severity findings naturally displace lower-severity ones when the cache is full.
- The cache persists across cycles, so a finding discovered in cycle N may be verified in cycle N+1 or later.
