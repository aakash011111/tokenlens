# Token Lens

A VS Code extension that monitors Claude Code session logs in real-time, showing token usage, costs, and efficiency metrics as you work.

## What It Does

Token Lens watches the Claude Code session log files (`~/.claude/projects/**/*.jsonl`) and parses events to give you a live view of:

- **Cost breakdown** — what you paid vs. what you saved through caching and optimizations
- **Efficiency score** — percentage of total context saved via prompt cache, agents, and plugins
- **Live event feed** — cache hits, compaction events, large file reads, skill/agent usage
- **Actionable advice** — specific recommendations to reduce token spend based on your session patterns

Two tabs let you switch between the current project's metrics and a global aggregate across all Claude Code sessions on your machine.

## Installation (Development)

```bash
cd token-lens
npm install
npm run compile
```

Press **F5** in VS Code to launch an Extension Development Host with the extension loaded.

For active development, use watch mode instead:

```bash
npm run watch
```

## Requirements

- VS Code 1.85.0+
- Claude Code generating session logs in `~/.claude/projects/`

## How It Works

### Session Watching

`sessionWatcher.ts` uses [chokidar](https://github.com/paulmillr/chokidar) to monitor `~/.claude/projects/**/*.jsonl`. It tracks byte positions per file so only newly appended lines are processed — no re-parsing on each update.

### Event Parsing

`parser.ts` maintains one `SessionParser` per active `.jsonl` file. Each parser detects 8 event types:

| Event | Trigger |
|-------|---------|
| `CACHE_HIT` | `cache_read_input_tokens > 0` in an API response |
| `COMPACTION_FIRED` | System message mentioning compaction |
| `CLAUDE_MD_LOAD` | Session start with CLAUDE.md present |
| `LARGE_FILE_READ` | Read tool result exceeding ~3000 tokens |
| `REPEATED_FILE_READ` | Same file read more than twice in a session |
| `PLUGIN_FIRED` | Tool name in `plugin:tool` format |
| `SKILL_AGENT_USED` | Tool is `Task`, `Agent`, or a known installed skill |
| `TURN_COMPLETED` | Every assistant message (keeps cost counters live) |

Tool calls are stored as pending and matched against tool results in subsequent messages, allowing accurate correlation between calls and their token costs.

### Pricing

`pricer.ts` applies hard-coded per-MTok rates for Sonnet and Opus models. The model is auto-detected from assistant messages.

| Model | Input | Output | Cache Write | Cache Read |
|-------|-------|--------|-------------|------------|
| Sonnet | $3.00 | $15.00 | $3.75 | $0.30 |
| Opus | $15.00 | $75.00 | $18.75 | $1.50 |

Agent work uses a 6× cost multiplier to avoid undercounting savings from sub-agent parallelism.

### Feature Scanner

On startup, `scanner.ts` enumerates installed Claude Code features:

- `~/.claude/plugins/` — global plugins
- `~/.claude/agents/` — global agents
- `.claude/agents/` — project agents
- `.claude/skills/` — project skills
- `.claude/hooks/` — project hooks
- `~/.claude/decision-log/` — decision logs

Detected features appear in the sidebar and inform the advice engine.

### Advice Engine

`adviceEngine.ts` generates up to 7 deduplicated recommendations based on session patterns. Advice covers cache health, CLAUDE.md overhead, unused features, repeated file reads, and more. Recommendations are suppressed once efficiency exceeds the threshold.

## Project Structure

```
token_util/
└── token-lens/
    ├── src/
    │   ├── extension.ts       # Extension entry point, webview lifecycle
    │   ├── sessionWatcher.ts  # Chokidar-based JSONL file watcher
    │   ├── parser.ts          # Event parser and cost calculator
    │   ├── pricer.ts          # Token pricing and formatting utilities
    │   ├── scanner.ts         # Claude Code feature scanner
    │   ├── adviceEngine.ts    # Recommendation generator
    │   └── webview/
    │       ├── panel.html     # Sidebar UI template
    │       └── panel.js       # Webview frontend and message handler
    ├── resources/
    │   └── icon.svg           # Sidebar activity bar icon
    ├── package.json
    └── tsconfig.json
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run compile` | One-time TypeScript build to `out/` |
| `npm run watch` | Incremental watch build |
