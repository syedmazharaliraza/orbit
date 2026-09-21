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

The hook integration is observation-only. It emits no hook response, permission decision, rewritten input, injected context, or Claude command. `WorktreeCreate` and `MessageDisplay` are not registered. A requested question or permission is displayed separately from a confirmed wait, and an ordinary response boundary is never presented as unanswered input. The detail view has a separate, explicit **Open session** action: on macOS it walks the observed process ancestry, discovers the outermost application bundle without a host allowlist, and foregrounds that existing application. It never writes to the terminal or starts/resumes Claude. Exact in-app tab, pane, or extension-conversation selection is unavailable unless the host exposes a stable addressable interface.

Focused verification:

```sh
npm run test:hooks
npx tsc --noEmit
npm run build
```
