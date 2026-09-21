# Claude hooks integration

Orbit now observes Claude Code through command hooks and an Orbit-owned durable inbox. The normal runtime does not poll `claude agents`, session metadata, or transcripts. It performs one bounded recovery snapshot at startup and watches the session-registry directory for structured state transitions that hooks cannot report.

Collector files briefly land in `~/Library/Application Support/Orbit/claude-observation/inbox`. After reduction they are deleted; the atomic `state/checkpoint.json` retains the current reducer checkpoint plus a minimized event journal bounded to 24 hours, 10,000 events, and 32 MiB.

Global Claude settings are never changed when Orbit starts. Setup is an explicit transaction:

```sh
npm run build:collector
npm run hooks:preview
npm run hooks:install
```

`hooks:preview` reports the target settings file, collector, inbox, and event list without printing existing hook contents or changing files. `hooks:install` preserves all existing settings and hook groups, writes a mode-0600 backup, rechecks the source hash before an atomic replacement, and records an Orbit ownership manifest. Re-running it is idempotent.

To remove only unchanged Orbit-owned handlers:

```sh
npm run hooks:uninstall
```

For a packaged app, pass its bundled collector as the setup source:

```sh
node scripts/claude-hooks.mjs \
  --collector "/Applications/Orbit.app/Contents/Resources/orbit-claude-hook-collector"
```

Add `--apply` after reviewing that preview. Setup atomically copies the source to the stable Orbit-owned path shown in the preview, so settings never point into the repository or a replaceable app bundle. The collector inbox defaults to `~/Library/Application Support/Orbit/claude-observation/inbox`; `--observation-root` can target another Orbit data root.

Orbit is an observation and navigation layer. Hovering a worker shows its Claude session title (or a short title from the original prompt) a small state label, and one live activity. A single context block shows the current file path, command, search query, or available choices. Questions and permissions replace that activity with a short preview; the final response remains until another task starts. There is no detail panel, conversation history, reply composer, or permission control.

Clicking an astronaut navigates directly to Claude Code. On macOS, Orbit verifies the observed process and walks its ancestry to find the hosting app. Terminal and iTerm tabs/panes are selected by the process’s TTY; macOS Automation permission is required for that selection. Other hosts use application focus until they expose a supported session address. Orbit never writes to the terminal or starts/resumes Claude.

The hook integration emits no hook response, permission decision, rewritten input, injected context, or Claude command. `WorktreeCreate` and `MessageDisplay` are not registered. The collector retains a bounded command preview (up to 512 characters), the tool’s description, and a coarse activity label such as “Running tests.” Rebuild and reinstall the collector after updating it to enable these labels and question previews from notifications.

Focused verification:

```sh
npm run test:hooks
npm run test:preview
npx tsc --noEmit
npm run build
```
