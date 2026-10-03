# dsh-plugin-mac-notify

macOS Notification Center alerts for [DSH (DeepSeek Harness)](https://github.com/deepseek-ai/deepseek-harness)
sessions — so an unattended run can call you back to the machine.

```
┌──────────────────────────────────────────────┐
│ DSH · 任务完成                                │
│ browser_dsh                                  │
│ 插件已经写好并装好了，自检 57 项全过。        │
└──────────────────────────────────────────────┘
        ↑ click → the browser tab already showing DSH comes to the front
```

Host-only bundle: it subscribes to Host events and shells out to a notifier.
There is no browser half, so nothing renders in the page and no page refresh is
involved.

## What it notifies

| Host event | When | Banner |
|---|---|---|
| `agent/status` → `idle` | the turn ended (a `running` → `idle` transition) | `DSH · 任务完成`, body = the last assistant text |
| `user-questions/request` | the agent called `ask_user_question` and is blocked | `DSH · 需要你的回答`, body = header · question · options |
| `approval/request` | the agent is waiting on an approval decision | `DSH · 需要你的批准`, body = the reason or the tool name |
| `agent/error` | a step or turn errored | `DSH · 执行出错`; the closing banner then reads `任务结束（有报错）` |

Subagent children stay silent (`includeSubagents: false` by default), identical
banners inside 5 s collapse into one, and consecutive non-urgent banners respect
a pacing gap — while a question or approval always gets through.

## Requirements

- macOS. On any other platform the plugin activates, logs a debug line, and
  sends nothing.
- Optional, for click-to-open: [`terminal-notifier`](https://github.com/julienXX/terminal-notifier)
  (`brew install terminal-notifier`). Without it the plugin falls back to the
  `osascript` banner every macOS ships — same text, same sound, no click action.

On recent macOS an ad-hoc signed notifier is refused until you allow it once:
**System Settings → Notifications → terminal-notifier → Allow Notifications**
(style *Banners*, *Play notification sound* on). Until then
`terminal-notifier -diagnose` reports `authorization: not requested yet` and
sending returns `Notifications are not allowed for this application`.

## Install

```bash
dsh plugin --profile web add /path/to/dsh-plugin-mac-notify   # local directory
dsh plugin --profile web add github:<owner>/dsh-plugin-mac-notify
```

The package declares `dsh.bundle.patch`, so the profile records it in
`dsh.profile.bundles`, the layer applies on the next reconcile, and the plugin
appears in the GUI's Plugins page with an enable switch and an uninstall action.
No dependencies, no install scripts, no build step.

### Upgrading needs a restart

DSH caches host-side module code for the life of the process: replacing the
package, re-installing it, or toggling the row off and on re-runs the previous
generation. Restart `dsh web` (or `dsh tui`) after an upgrade. Browser halves
are the opposite — those need only a page refresh.

DSH has no plugin auto-update: upgrading means `dsh plugin remove` followed by
`dsh plugin add`.

## Configuration

The bundle row carries no `config`, so the defaults apply. Override them in the
profile's own `cordis.patch.yml` (applied after every bundle layer):

```yaml
- id: mac-notify
  name: 'dsh-plugin-mac-notify'
  config:
    sound: Ping
    notifyOnApproval: false
    url: 'http://127.0.0.1:3080'
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | master switch |
| `notifyOnFinish` | `true` | turn finished |
| `notifyOnQuestion` | `true` | waiting for an answer |
| `notifyOnApproval` | `true` | waiting for a decision |
| `notifyOnError` | `true` | a step or turn errored |
| `includeSubagents` | `false` | also notify for subagent children |
| `sound` | `'default'` | `'default'` = your system alert sound (read from `com.apple.sound.beep.sound`); a name from `/System/Library/Sounds` (`Ping`, `Glass`, `Hero`, …); `'off'` = silent |
| `onClick` | `'focus'` | `'focus'` = surface the existing DSH tab, else open the URL; `'open'` = always open; `'none'` = no click action |
| `notifier` | `'auto'` | `'auto'` prefers terminal-notifier, `'osascript'` forces the built-in banner |
| `url` | `''` | click target; empty means auto-detect (see below) |
| `language` | `'auto'` | `'auto'` follows `LANG`/system locale, or pin `'zh'` / `'en'` |
| `titlePrefix` | `'DSH'` | banner title prefix |
| `minIntervalMs` | `1500` | pacing gap between non-urgent banners |
| `bodyMaxChars` | `200` | banner body budget |

### How the click target is resolved

`url`, else the port this Host actually serves the Web UI on
(`ctx.get('webServer').port`), else `DSH_WEB_URL` from the environment — so a
non-default port needs no configuration.

A click runs `lib/click.mjs`, which asks every **running** browser (Chrome,
Edge, Brave, Vivaldi, Chromium, Safari — found with `pgrep`, so no browser is
launched just to answer) whether one of its windows holds a tab whose URL starts
with that target. The first match becomes the active tab and its window is
raised. Only when no running browser has it does the helper fall back to
`/usr/bin/open <url>`.

Reading another app's tabs needs macOS Automation permission, which the system
grants per browser on first use (click *Allow* on the “terminal-notifier wants
to control …” prompt). A denial is not fatal: the helper falls through to
`open`, so you land on the DSH page in a new tab instead of the existing one.

## Troubleshooting

Both switches are environment variables read at delivery time — set them on the
process that launches DSH:

```bash
DSH_MAC_NOTIFY_DRY_RUN=1 dsh web     # decide everything, spawn nothing
DSH_MAC_NOTIFY_LOG=/tmp/dsh-notify.jsonl dsh web
```

The JSONL trace records one line per `deliver`, `skip` (with `reason`:
`disabled` / `duplicate` / `paced`), `failure`, and `sound-failed`, including the
resolved backend and click mode.

- **No banner at all** → check `DSH_MAC_NOTIFY_LOG`; on macOS also
  `terminal-notifier -diagnose`.
- **Banner but no sound** → the plugin puts your system alert sound on the
  banner, so the usual causes are the system output volume, or *Play
  notification sound* being off for the notifier in System Settings.
- **Click does nothing** → the click action only exists on the
  terminal-notifier backend; `osascript` banners have none. Check
  `echo $DSH_MAC_NOTIFY_LOG` for `click: "focus"` vs `"none"`.
- **Click opens a new tab** → Automation permission for that browser was denied,
  or no running browser has the page (the helper then calls `open`).

## Self-test

```bash
node selftest.mjs      # 57 assertions, no notification, no sound, no browser
```

The suite drives the same `lib/index.js` the Harness loads, with `exec`,
`exists` and the clock stubbed: it covers the packaging contract (manifest,
patch, locale, icon, the zero-dependency compatibility rule), the pure functions
(config normalisation, copy, argv builders, parsers), the registration contract
(which events `apply` subscribes), and event-driven behaviour (what each Host
event actually sends, pacing, dedupe, subagent filtering, sound policy, backend
fallback, dry-run and trace). It also proves through a real `/bin/sh` that a
quoted click command round-trips.

## Layout

```
lib/index.js     Cordis plugin: apply + the injectable runtime
lib/click.mjs    click handler: focus an existing tab, else open the URL
cordis.patch.yml bundle patch (one insert row)
locale/*.json    display title/description for the Plugins page
icon.svg         package icon
selftest.mjs     offline assertions
```

## Security notes

- Notification text reaches the notifier as **argv**, never interpolated into
  AppleScript source, so a transcript line cannot become executed script.
- The click command is built from `process.execPath`, the package's own helper
  path, and the resolved URL, each single-quoted for the shell that runs it.
- The plugin reads `agent`/`session` state through `ctx.get(...)`, so a missing
  or restricted service degrades it to "no workspace in the subtitle" instead of
  an error, and every listener is wrapped so a notification failure can never
  break Host dispatch.

## Why every listener is global

Agent events are dispatched with a scope carrier, and Cordis keeps a listener
only when `hook.global || !filter || filter(carrier, hook.ctx)`. A listener
registered through a scope-tagged context therefore receives that one agent's
events and nothing else — and a row activated from inside an agent's scope,
which is exactly what installing through a plugin-manager tool call does, gets
that tag. Subscribing with `{ global: true }` takes the listener out of the
filter, so one plugin covers every agent in the process.

This is not theoretical: an earlier build registered plain listeners and
notified for the installing session only. `selftest.mjs` asserts the flag on
every registration so it cannot regress.

## Community catalog

The ready-to-PR entry for
[`awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
(the source behind [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com) and
dsh-market) lives in
[`contrib/AK-blank__dsh-plugin-mac-notify.yml`](contrib/AK-blank__dsh-plugin-mac-notify.yml).
To submit it, fork the list, copy that file to
`data/plugins/AK-blank__dsh-plugin-mac-notify.yml` and open a PR — the list's CI
requires the repository to be at least one day old, and the `dsh-plugin` topic
(which this repo carries) is what makes `dsh-plugin-radar` pick it up in the
meantime.

`scripts/submit-catalog.mjs` does the same thing without a local clone: it syncs
a fork of the list with upstream `main`, adds that one file on its own branch,
and opens the pull request. It is idempotent (a second run reports the pull
request it already opened), refuses to run before the repository's age floor
(exit code 3), and never force-pushes or touches an existing pull request.

```bash
node scripts/submit-catalog.mjs --dry-run   # validate the entry, write nothing
node scripts/submit-catalog.mjs             # fork, branch, commit, open the PR
```

## License

MIT

**Unofficial plugin.** Not affiliated with, endorsed by, or supported by DeepSeek.
“DeepSeek Harness” is a trademark of DeepSeek; this project uses the abbreviated “DSH”
designation for the ecosystem, as the project's brand guidelines recommend.
