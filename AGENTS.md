# pi-agent-browser

Browser automation tool for Pi via `agent-browser` CLI.

## Architecture

**Archetype:** Model-facing tool extension (tool-first, minimal operator surface).

Single extension at `extensions/index.ts`. No build step -- jiti loads TypeScript directly.

### Tool: `browser`

One tool with a `command` string parameter. The model passes raw `agent-browser` subcommands
(without the `agent-browser` prefix). The extension shells out via `pi.exec()`.

Key runtime rules:

- **Serialization queue**: browser state is shared, Pi runs tools in parallel by default.
  A process-local promise chain serializes all `browser` tool calls.
- **Per-session isolation**: uses `--session pi-<sessionId>` so concurrent Pi sessions
  do not collide on the same daemon.
- **Output truncation**: snapshot and text output are truncated; full output saved to temp file.
- **Screenshots**: saved to temp, returned as `ImageContent` (base64) so vision models can see them.
- **Cleanup**: `session_shutdown` closes the browser session only when it was started by this package.

### Operator commands

Minimal:

- `/browser:doctor` -- binary check, version, Chrome status
- `/browser:examples` -- print common workflows

No TUI panels, no config files, no settings persistence.

## Dev workflow

- Install: `bun install`
- Typecheck: `bun run typecheck`
- Lint: `bun run lint`
- Format: `bun run lint:fix`
- Conventional commits enforced via commitlint + lefthook

## Coding guidelines

- Tabs, double quotes, semicolons (biome)
- Strict TS: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
- No `any`, no non-null assertions, no unsafe type assertions
- `node:` protocol for Node.js imports
- Peer dependencies only for Pi core packages

## Release

- semantic-release on `main` with npm trusted publishing (OIDC, no npm token)
- `@semantic-release/git` commits version bumps back to git
- Commit prefixes: `fix:` (patch), `feat:` (minor), `feat!:` (major)
- `chore:`, `docs:`, `refactor:` produce no version bump
