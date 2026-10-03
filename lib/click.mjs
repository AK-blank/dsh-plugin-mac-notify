/**
 * Click handler for dsh-plugin-mac-notify.
 *
 * A notification click runs this script with the DSH Web URL as its only
 * argument. It tries to land the operator on the page they already have open:
 *
 *   1. every browser that is actually running is asked, by AppleScript, whether
 *      one of its windows holds a tab whose URL starts with the target, and the
 *      first match becomes that window's active tab (window raised);
 *   2. when no running browser has it, `/usr/bin/open <url>` hands the URL to
 *      the default browser.
 *
 * Only *running* browsers are asked: `tell application "X"` would otherwise
 * launch X just to answer the question. Process liveness comes from `pgrep`,
 * which needs no permission; the AppleScript half needs macOS Automation
 * permission for that browser, and a denial simply falls through to step 2.
 *
 * Usage: node click.mjs <url>
 */

import { execFile } from 'node:child_process'

const TIMEOUT_MS = 4000

/** Browsers whose AppleScript dictionary mirrors Chrome's. */
const CHROMIUM = [
  { process: 'Google Chrome', app: 'Google Chrome' },
  { process: 'Microsoft Edge', app: 'Microsoft Edge' },
  { process: 'Brave Browser', app: 'Brave Browser' },
  { process: 'Vivaldi', app: 'Vivaldi' },
  { process: 'Chromium', app: 'Chromium' },
]

/** Browsers using WebKit's `current tab` spelling. */
const WEBKIT = [{ process: 'Safari', app: 'Safari' }]

const CHROMIUM_SCRIPT = `on run argv
set target to item 1 of argv
tell application "%APP%"
repeat with w in windows
set i to 0
repeat with t in tabs of w
set i to i + 1
if (URL of t) starts with target then
set active tab index of w to i
set index of w to 1
activate
return "focused"
end if
end repeat
end repeat
end tell
return "absent"
end run`

const WEBKIT_SCRIPT = `on run argv
set target to item 1 of argv
tell application "%APP%"
repeat with w in windows
repeat with t in tabs of w
if (URL of t) starts with target then
set current tab of w to t
set index of w to 1
activate
return "focused"
end if
end repeat
end repeat
end tell
return "absent"
end run`

/** Run one command, resolving `{ ok, stdout }` instead of rejecting. */
function run(file, args) {
  return new Promise((resolve) => {
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      execFile(file, args, { timeout: TIMEOUT_MS }, (error, stdout) => {
        done({ ok: !error, stdout: String(stdout ?? '') })
      })
    } catch {
      done({ ok: false, stdout: '' })
    }
  })
}

/** Whether a process with this exact name is running. */
async function isRunning(processName) {
  const { ok } = await run('/usr/bin/pgrep', ['-x', processName])
  return ok
}

/** Ask one running browser to surface its DSH tab. */
async function focusIn(app, script) {
  const lines = script.replace('%APP%', app).split('\n')
  const args = []
  for (const line of lines) args.push('-e', line)
  args.push(target)
  const { ok, stdout } = await run('/usr/bin/osascript', args)
  return ok && stdout.includes('focused')
}

let target = ''

/** Entry point: focus first, open second, never throw. */
async function main() {
  target = String(process.argv[2] ?? '').trim()
  if (!/^https?:\/\//.test(target)) return

  const candidates = [
    ...CHROMIUM.map((entry) => ({ ...entry, script: CHROMIUM_SCRIPT })),
    ...WEBKIT.map((entry) => ({ ...entry, script: WEBKIT_SCRIPT })),
  ]

  for (const candidate of candidates) {
    if (!(await isRunning(candidate.process))) continue
    // The source reads the URL from argv, so no value is interpolated as code.
    if (await focusIn(candidate.app, candidate.script)) return
  }

  await run('/usr/bin/open', [target])
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
)
