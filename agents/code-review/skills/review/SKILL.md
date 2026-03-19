---
name: review
description: Deep code review on a specific file. Analyzes code for bugs, security vulnerabilities, performance issues, and design problems. Outputs structured JSON findings.
---

# Code Review Skill

You are performing a focused code review on a specific file in a repository.

## Input

You will receive:
- **File path**: The file to review
- **Repository root**: The workspace directory containing the cloned repository

## Review Process

### Step 1: Read and Understand the File

Use the `read` tool to load the target file. If the file is large, read it in sections.

### Step 2: Understand Context

Use `grep` and `read` to examine:
- How this file is imported/used by other files
- Related files (tests, types, configs) that provide context
- Any README or documentation in the same directory

### Step 3: Analyze for Issues

Focus on these categories (in priority order):

1. **Security** — injection, auth bypass, data exposure, insecure defaults, hardcoded secrets
2. **Bug** — logic errors, off-by-one, null/undefined handling, race conditions, resource leaks
3. **Performance** — unnecessary allocations, N+1 queries, missing caching, blocking operations
4. **Design** — violations of SOLID principles, tight coupling, missing error handling, unclear abstractions
5. **Maintainability** — dead code, duplicated logic, overly complex functions, missing type safety

**Do NOT report:**
- Style/formatting preferences
- Missing comments or documentation
- Minor naming suggestions
- Issues that are clearly intentional trade-offs

### Step 4: Output Findings

Write findings to the output path specified in the prompt (typically `/workspace/state/pending-findings.json`) as JSON:

```json
[
  {
    "file": "src/utils/parser.ts",
    "line": 42,
    "endLine": 50,
    "severity": "high",
    "category": "security",
    "title": "Unsanitized user input passed to SQL query",
    "description": "The `query` parameter from user input is interpolated directly into the SQL string without parameterization. This allows SQL injection attacks.",
    "codeSnippet": "db.query(`SELECT * FROM users WHERE name = '${query}'`)",
    "suggestion": "Use parameterized queries: db.query('SELECT * FROM users WHERE name = $1', [query])"
  }
]
```

**Field requirements:**
- `file`: Relative path from repository root
- `line`: Start line number of the issue
- `endLine`: End line number (can equal `line` for single-line issues)
- `severity`: `"critical"` | `"high"` | `"medium"` — only report issues worth filing
- `category`: `"security"` | `"bug"` | `"performance"` | `"design"` | `"maintainability"`
- `title`: Concise summary (under 80 chars), will become part of the GitHub issue title
- `description`: Clear explanation of why this is a problem and its impact
- `codeSnippet`: The relevant code (keep it short, 1-5 lines)
- `suggestion`: Actionable fix suggestion

### Important Rules

- Quality over quantity. Only report issues you are **confident** about.
- Each finding must be **specific** — point to exact lines and explain why it's a problem.
- If the file has no significant issues, output an empty array `[]`. This is a valid and good outcome.
- Do not hallucinate issues. If you're unsure, don't report it.
- Write the findings JSON file using the `write` tool.
