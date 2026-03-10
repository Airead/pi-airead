# pi-airead

Personal extensions for [pi coding-agent](https://github.com/badlogic/pi-mono).

## Installation

### Option 1: Download individual extensions

Download the extension file directly to `~/.pi/agent/extensions/`:

```bash
mkdir -p ~/.pi/agent/extensions
curl -o ~/.pi/agent/extensions/stream.ts \
  https://raw.githubusercontent.com/Airead/pi-airead/main/extensions/stream.ts
```

### Option 2: Clone and symlink (recommended for development)

Clone this repo and run the install script to symlink all extensions to `~/.pi/agent/extensions/`:

```bash
git clone https://github.com/Airead/pi-airead.git
cd pi-airead
bash install.sh
```

The script creates symbolic links, so extensions stay up to date as you `git pull`.

### Usage

After installation, extensions in `~/.pi/agent/extensions/` are auto-loaded by `pi`:

```bash
pi --stream -p "hello"
```

To uninstall, remove the corresponding files or symlinks from `~/.pi/agent/extensions/`.

## Extensions

### stream

Streams assistant thinking, tool calls, and text replies to the terminal during agent execution.

All output goes to **stderr** so it never conflicts with built-in stdout output (`-p` text mode, `--mode json`, etc.):

- text deltas (bright blue)
- thinking (dim italic)
- tool labels (cyan) with arguments (dim)
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
