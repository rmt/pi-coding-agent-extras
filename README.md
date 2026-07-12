# Pi Agent Extensions

This directory contains my local Pi coding-agent extensions.

## Extensions

### `codex-status.ts`

Registers `/codex-status`, which displays local ChatGPT/Codex subscription
status in Pi. It fetches rate-limit information from ChatGPT's usage API using
Pi's `openai-codex` OAuth credentials, falling back to `~/.codex/auth.json`.
The rendered status includes the active model, working directory, discovered
`AGENTS.md`, account/auth source, session id, primary and weekly limit
progress, credits, and reset credits.

### `codex-usage.ts`

Registers `/codex-usage [daily|weekly|redeem]`, which shows ChatGPT Codex usage
activity and reset-credit information. It queries ChatGPT Codex profile, usage,
and reset-credit APIs with Pi's `openai-codex` credentials. Daily mode renders
a year-style token heatmap, weekly mode renders recent weekly token bars, and
`redeem` attempts to consume an available reset credit before showing the
report.

### `copilot-usage.ts`

Registers `/copilot-usage`, which reads the GitHub Copilot OAuth token from
`~/.pi/agent/auth.json` and queries GitHub's Copilot internal user API. It
reports the Copilot username, plan, quota reset date, premium-interaction usage
and projection, chat/completion quotas, enabled features, and API endpoints.

### `kiro-usage.ts`

Registers `/kiro-usage`, which retrieves a Kiro CLI access token from the local
`kiro-cli` SQLite database and calls the Amazon CodeWhisperer `GetUsageLimits`
API. It reports the current Kiro plan, credit usage, reset date, overage
status, overage credits used, estimated overage cost, and
organization-management notes when applicable.

### `save.ts`

Registers `/save <filename.md>`, which saves the most recent assistant response
from the current session branch to a new file. Relative filenames are resolved
from the current working directory, while absolute paths are used as given. It
refuses to overwrite existing files and reports success or errors
through the Pi UI.

### `shell-permissions.ts`

Adds shell and write-tool safety controls. It intercepts `bash` tool calls,
splits compound shell commands into segments, checks them against configurable
whitelist and blacklist regexes, detects common read/write file accesses, and
prompts for approval when needed. It also protects write/edit tools for targets
outside the current working directory or in sensitive locations. Commands
include `/whitelist`, `/blacklist`, and `/yolo [on|off]`; settings are
persisted in `~/.pi/agent/shell-permissions.json`.

This implementation also has explicit support for the approval hooks in
https://github.com/rmt/pi-snap-edit-approval-handshake

### `single-line-footer.ts`

Installs a compact Pi UI footer that shows the current working directory, git
branch, shell-permissions mode, extension statuses, estimated session cost,
context-window usage, selected model, and thinking level. It updates on session
start, model selection, thinking-level changes, and branch changes.
