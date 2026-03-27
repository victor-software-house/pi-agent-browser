# pi-agent-browser

Browser automation tool for [Pi](https://github.com/badlogic/pi-mono). Gives the model a `browser` tool that drives a real browser via [agent-browser](https://github.com/vercel-labs/agent-browser).

## Install

```bash
pi install npm:@victor-software-house/pi-agent-browser
```

Or try without installing:

```bash
pi -e npm:@victor-software-house/pi-agent-browser
```

## What it does

Registers a `browser` tool the model can call to:

- **Navigate** -- `open <url>`
- **Inspect** -- `snapshot -i` (interactive elements with `@ref` handles)
- **Interact** -- `click @e1`, `fill @e2 "text"`, `press Enter`, `scroll down`
- **Read** -- `get text`, `get title`, `get url`, `get text @e3`
- **Screenshot** -- image returned inline so vision models can describe what they see
- **Clean up** -- `close` (also auto-closes on Pi session shutdown)

Any valid `agent-browser` subcommand works. The model passes the command string without the `agent-browser` prefix.

## Features

| Feature | Details |
|---|---|
| **Inline screenshots** | Screenshots returned as base64 images for vision models |
| **Output truncation** | Large snapshot output is truncated; full output saved to a temp file |
| **Session isolation** | Each Pi session gets its own browser session (no cross-session collisions) |
| **Serialized execution** | Browser calls are queued to prevent parallel tool-call race conditions |
| **Session cleanup** | Browser auto-closed on Pi session shutdown |
| **TUI rendering** | Compact display: element counts for snapshots, screenshot paths, errors |

## Example

```
You: Open hacker news and tell me the top 3 stories

browser open https://news.ycombinator.com
browser wait --load networkidle
browser snapshot -i
browser close

The top 3 stories on Hacker News right now are:
1. ...
```

## Operator commands

| Command | Description |
|---|---|
| `/browser:doctor` | Check binary, version, Chrome status |
| `/browser:examples` | Print common workflow patterns |

## Requirements

- [agent-browser](https://github.com/vercel-labs/agent-browser) installed and on PATH:
  ```bash
  npm install -g agent-browser
  agent-browser install   # downloads Chrome
  ```
- A vision-capable model for screenshot descriptions (Claude Sonnet/Opus, GPT-4o, Gemini Pro)

## License

MIT
