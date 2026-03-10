# pi-airead

Personal extensions for [pi coding-agent](https://github.com/nicepkg/pi-mono).

## Extensions

### stream

Streams assistant thinking, tool calls, and text replies to the terminal during agent execution.

All output goes to **stderr** so it never conflicts with built-in stdout output (`-p` text mode, `--mode stream`, etc.):

- text deltas (white)
- thinking (dim italic)
- tool labels (cyan)
- tool errors (red)

#### Usage

```bash
pi --extension /path/to/pi-airead/extensions/stream.ts --stream -p "hello"
```

#### Tool Label Formatting

| Tool | Label |
|------|-------|
| bash | `$ <command>` |
| read/write/edit | `<filePath>` |
| grep | `<pattern> <path>` |
| find/glob | `<pattern>` |
| ls | `<path>` |
