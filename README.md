# pi-edit-fence

Run two or more pi sessions in the same directory without losing work.

pi-edit-fence gives each session lightweight, per-file locks that it claims automatically as it edits, so two sessions never overwrite each other's work. No git worktrees, no manual setup, same directory. Without it, concurrent sessions editing the same file just let the last write win, silently discarding the other session's changes.

## How it works

Each session auto-claims a lock the moment it edits a file. If another live session tries to edit a file you hold, its edit is fenced.

- **Per-file by default.** Editing `src/api/handlers.ts` locks that exact file. A second session editing `src/api/routes.ts` is never blocked. Only a true same-file collision is stopped.
- **Temporary, not fatal.** A blocked edit waits briefly for the lock to free. If it is still held, the agent gets a retry-later message telling it to work elsewhere and come back, not to abort.
- **Self-releasing.** Locks auto-expire after the owner stops editing that file (lease). When another session is waiting, the idle lease shortens so a finished owner hands over fast.
- **Crash-safe.** A session that crashes leaves its lock behind. The next session detects the dead process and reclaims it. No stuck locks.
- **Shared files warn, never block.** Config and lockfiles (`package.json`, `tsconfig*.json`, `*.config.*`, `.env*`, root-level files, `.pi/**`) are coordination-free zones: you get a heads-up, the edit proceeds.

The lock registry lives at `<cwd>/.pi/ownership.json` and is runtime data, auto-added to `.pi/.gitignore`.

## Install

From npm:

```bash
pi install npm:pi-edit-fence
```

From git, without waiting for an npm publish:

```bash
pi install git:github.com/anh-chu/pi-edit-fence
```

By default this writes to user settings (`~/.pi/agent/settings.json`). Use `-l` to install into project settings (`.pi/settings.json`) so a team shares it.

Try it for one run without installing:

```bash
pi -e npm:pi-edit-fence
```

Or drop `extensions/edit-fence.ts` into `~/.pi/agent/extensions/` for a global, no-npm install.

## Usage

It works with zero configuration. Open the same project in two pi sessions and edit away. Same-file collisions are fenced; everything else runs free.

### Agent tool

- `release_path` — an agent can release its lock(s) the instant it finishes an area, for immediate handover. Locks also auto-expire, so this is optional hygiene.

### Commands (type in the pi prompt)

- `/claims` — list live locks and who holds them
- `/claim <key>` — manually claim a file or subtree
- `/release [key]` — drop one or all of your locks
- `/steal <key>` — force-reassign a lock to your session (use when an owner is stuck or idle)

## Configuration

Edit the tunables at the top of `extensions/edit-fence.ts`:

| Constant             | Default            | Meaning                                                                             |
| -------------------- | ------------------ | ----------------------------------------------------------------------------------- |
| `SCOPE`              | `"file"`           | `"file"` locks the exact file. `"dir"` locks a subtree for area-level coordination. |
| `CLAIM_DEPTH`        | `2`                | Subtree depth when `SCOPE === "dir"` (2 keeps `src/api` and `src/ui` distinct).     |
| `LEASE_MS`           | `5 min`            | Idle time before a lock auto-expires.                                               |
| `CONTENDED_LEASE_MS` | `10 s`             | Shorter idle lease applied while another session is waiting.                        |
| `WAIT_MS`            | `15 s`             | How long a blocked edit waits before returning the retry-later message.             |
| `SHARED_PATTERNS`    | configs, lockfiles | Glob patterns treated as warn-only shared zones.                                    |

### File scope vs dir scope

- **`"file"` (default)** matches the real threat: two sessions writing the same file. Zero false fences on sibling files.
- **`"dir"`** is for coordination: keep two agents out of the same area entirely, even across different files. Use it when files in an area share tight coupling (common imports, generated code) that a per-file lock would miss.

## Limitations

- **Single host.** Liveness uses the local process table. On a shared filesystem with sessions on different machines, lease expiry still bounds staleness, but cross-host liveness is not reliable.
- **Shared zone is unfenced by design.** Concurrent edits to `package.json` and other shared files are not prevented, only warned. Coordinate those manually.

## License

MIT
