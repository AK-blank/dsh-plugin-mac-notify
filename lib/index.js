/**
 * dsh-plugin-mac-notify — Host half.
 *
 * Turns Host events into macOS Notification Center banners, so an unattended
 * session can call its operator back to the machine:
 *
 *   agent/status  → idle     the turn finished
 *   user-questions/request   the agent is blocked on `ask_user_question`
 *   approval/request         the agent is blocked on an approval decision
 *   agent/error              a step or turn errored
 *
 * Two delivery backends, chosen by capability:
 *
 *   terminal-notifier   clickable banners: clicking runs `lib/click.mjs`, which
 *                       surfaces the browser tab already holding the DSH page
 *                       and only opens a new one when no running browser has it
 *   osascript           the banner every macOS ships; no click action
 *
 * The sound is the operator's own system alert sound (played by `afplay`), so
 * the cue works even when a banner is suppressed; `sound: '<Name>'` moves it
 * onto the banner itself, and `sound: 'off'` is silent.
 *
 * The module has no dependencies: `apply` is the Cordis entry point, and
 * `createRuntime` is the same logic with injectable `exec`/`env`/`platform`/
 * `exists`, which is what `selftest.mjs` drives.
 */

import { execFile } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import { platform as osPlatform } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The notifier every macOS ships. Overridable for tests, not for config. */
export const OSASCRIPT = '/usr/bin/osascript'

/** The system sound player. Overridable for tests, not for config. */
export const AFPLAY = '/usr/bin/afplay'

/** Where Homebrew and a default `open` install a clickable notifier. */
export const NOTIFIER_CANDIDATES = [
  '/opt/homebrew/bin/terminal-notifier',
  '/usr/local/bin/terminal-notifier',
]

/** Every sound `sound name` accepts, as installed under /System/Library/Sounds. */
export const SYSTEM_SOUNDS = new Set([
  'Basso', 'Blow', 'Bottle', 'Frog', 'Funk', 'Glass', 'Hero',
  'Morse', 'Ping', 'Pop', 'Purr', 'Sosumi', 'Submarine', 'Tink',
])

/** What `sound: 'default'` falls back to when the preference cannot be read. */
export const FALLBACK_ALERT_SOUND = '/System/Library/Sounds/Glass.aiff'

/** How long a "no clickable notifier installed" answer is trusted. */
const BACKEND_TTL_MS = 60_000

/**
 * Every field is optional in a bundle row's `config`; these are the values a
 * row without `config` gets.
 */
export const DEFAULTS = Object.freeze({
  enabled: true,
  notifyOnFinish: true,
  notifyOnQuestion: true,
  notifyOnApproval: true,
  notifyOnError: true,
  includeSubagents: false,
  language: 'auto',
  sound: 'default',
  onClick: 'focus',
  notifier: 'auto',
  url: '',
  titlePrefix: 'DSH',
  minIntervalMs: 1500,
  bodyMaxChars: 200,
})

const BOOLEAN_FIELDS = [
  'enabled',
  'notifyOnFinish',
  'notifyOnQuestion',
  'notifyOnApproval',
  'notifyOnError',
  'includeSubagents',
]

const NUMBER_FIELDS = {
  minIntervalMs: { min: 0, max: 60_000 },
  bodyMaxChars: { min: 40, max: 400 },
}

const ENUM_FIELDS = {
  language: new Set(['auto', 'zh', 'en']),
  onClick: new Set(['focus', 'open', 'none']),
  notifier: new Set(['auto', 'terminal-notifier', 'osascript']),
}

/** Notification kinds → the config switch that owns them. */
const KIND_SWITCH = {
  finish: 'notifyOnFinish',
  question: 'notifyOnQuestion',
  approval: 'notifyOnApproval',
  error: 'notifyOnError',
}

/** Kinds that must never be dropped by the global pacing gap. */
const URGENT_KINDS = new Set(['question', 'approval'])

/** Two identical banners inside this window are the same interruption. */
const IDENTICAL_WINDOW_MS = 5000

export const COPY = Object.freeze({
  zh: {
    finish: '任务完成',
    finishError: '任务结束（有报错）',
    question: '需要你的回答',
    approval: '需要你的批准',
    error: '执行出错',
    questionFallback: 'DSH 正在等待你的回答',
    approvalFallback: 'DSH 正在等待你的批准',
    errorFallback: 'DSH 运行出错',
    finishFallback: '本轮已结束，可以回来看看了',
    approvalWithTool: (tool) => `等待你批准：${tool}`,
  },
  en: {
    finish: 'Task finished',
    finishError: 'Task ended with errors',
    question: 'Your answer is needed',
    approval: 'Your approval is needed',
    error: 'Run failed',
    questionFallback: 'DSH is waiting for your answer',
    approvalFallback: 'DSH is waiting for your approval',
    errorFallback: 'DSH hit an error',
    finishFallback: 'The turn is over — come take a look',
    approvalWithTool: (tool) => `Waiting for your approval: ${tool}`,
  },
})

/**
 * Coerce a bundle row's `config` into the supported shape.
 * Unknown keys are dropped; malformed values fall back to the default.
 * @param raw - the row's config object, or anything else.
 * @returns a frozen config with every field present and valid.
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const config = { ...DEFAULTS }

  for (const field of BOOLEAN_FIELDS) {
    const value = source[field]
    if (typeof value === 'boolean') config[field] = value
    else if (value === 'true') config[field] = true
    else if (value === 'false') config[field] = false
  }

  for (const [field, { min, max }] of Object.entries(NUMBER_FIELDS)) {
    const value = Number(source[field])
    if (Number.isFinite(value)) config[field] = Math.min(max, Math.max(min, Math.round(value)))
  }

  for (const [field, allowed] of Object.entries(ENUM_FIELDS)) {
    if (allowed.has(source[field])) config[field] = source[field]
  }

  const prefix = typeof source.titlePrefix === 'string' ? source.titlePrefix.trim() : ''
  if (prefix) config.titlePrefix = prefix.slice(0, 40)

  // Three sound shapes: the system alert sound, one named system sound, silence.
  if (typeof source.sound === 'string') {
    const sound = source.sound.trim()
    if (sound === '' || sound === 'off' || sound === 'none') config.sound = 'off'
    else if (sound === 'default') config.sound = 'default'
    else if (SYSTEM_SOUNDS.has(sound)) config.sound = sound
  }

  if (typeof source.url === 'string' && /^https?:\/\/\S+$/.test(source.url.trim())) {
    config.url = source.url.trim()
  }

  return Object.freeze(config)
}

/**
 * Resolve `language: 'auto'` from the launch environment.
 * @param config - a normalized config.
 * @param env - environment variables (defaults to `process.env`).
 * @param locale - a BCP-47 locale to consult last; tests pass one explicitly.
 * @returns `'zh'` or `'en'`.
 */
export function pickLanguage(config, env = {}, locale) {
  if (config.language === 'zh' || config.language === 'en') return config.language
  const fromEnv = String(env.DSH_MAC_NOTIFY_LANG || env.LC_ALL || env.LC_MESSAGES || env.LANG || '')
  if (/^zh/i.test(fromEnv)) return 'zh'
  if (/^[a-z]/i.test(fromEnv)) return 'en'
  let fromSystem = locale
  if (fromSystem === undefined) {
    try {
      fromSystem = Intl.DateTimeFormat().resolvedOptions().locale
    } catch {
      fromSystem = ''
    }
  }
  return /^zh/i.test(String(fromSystem || '')) ? 'zh' : 'en'
}

/**
 * Collapse whitespace and clamp one line to the banner budget.
 * @param text - any value; non-strings are stringified.
 * @param max - maximum code points in the result, ellipsis included.
 * @returns a single-line string, never longer than `max`.
 */
export function truncate(text, max) {
  const collapsed = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (collapsed.length <= max) return collapsed
  return `${collapsed.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}

/**
 * Join the text blocks of a message's content.
 * @param message - an `AssistantMessage`-shaped value.
 * @returns its plain text, blocks joined by newlines.
 */
export function extractText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/**
 * Build the `osascript` argv for one banner.
 *
 * The script reads its four strings from `argv`, so titles and bodies are data
 * and can never break out into AppleScript.
 * @param notification - `{ title, subtitle, body, sound }`.
 * @returns argv for {@link OSASCRIPT}.
 */
export function buildOsascriptArgs(notification) {
  const { title, subtitle, body, sound } = notification
  const lines = [
    'on run argv',
    'set theTitle to item 1 of argv',
    'set theSubtitle to item 2 of argv',
    'set theBody to item 3 of argv',
    'set theSound to item 4 of argv',
    'if theSubtitle is "" then',
    'if theSound is "" then',
    'display notification theBody with title theTitle',
    'else',
    'display notification theBody with title theTitle sound name theSound',
    'end if',
    'else',
    'if theSound is "" then',
    'display notification theBody with title theTitle subtitle theSubtitle',
    'else',
    'display notification theBody with title theTitle subtitle theSubtitle sound name theSound',
    'end if',
    'end if',
    'end run',
  ]
  const args = []
  for (const line of lines) args.push('-e', line)
  args.push(String(title ?? ''), String(subtitle ?? ''), String(body ?? ''), String(sound ?? ''))
  return args
}

/** Single-quote one shell word for the `sh -c` that runs a click command. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * Build the `terminal-notifier` argv for one banner.
 * @param notification - `{ title, subtitle, body, sound }` plus the click action.
 * @param click - `{ mode, url, command }`.
 * @returns argv for the notifier binary.
 */
export function buildTerminalNotifierArgs(notification, click) {
  const args = [
    '-title', String(notification.title ?? ''),
    '-message', String(notification.body ?? ''),
  ]
  if (notification.subtitle) args.push('-subtitle', String(notification.subtitle))
  if (notification.sound) args.push('-sound', String(notification.sound))
  if (click?.mode === 'focus' && click.command) args.push('-execute', click.command)
  else if (click?.mode === 'open' && click.url) args.push('-open', click.url)
  return args
}

/** Promise wrapper over `execFile`, resolving instead of rejecting. */
function runExec(exec, file, args, options) {
  return new Promise((resolve) => {
    let settled = false
    const done = (outcome) => {
      if (settled) return
      settled = true
      resolve(outcome)
    }
    try {
      exec(file, args, options, (error, stdout, stderr) => {
        if (error) done({ ok: false, error: truncate(stderr || error.message || String(error), 200) })
        else done({ ok: true, stdout: String(stdout ?? '') })
      })
    } catch (error) {
      done({ ok: false, error: truncate(error?.message ?? String(error), 200) })
    }
  })
}

/**
 * Find a clickable notifier, preferring the process `PATH` over fixed prefixes,
 * so nvm/Homebrew/asdf layouts all resolve.
 * @param exists - existence probe, injectable for tests.
 * @param env - environment carrying `PATH`.
 * @returns the binary path, or `''` when none is installed.
 */
export function findNotifier(exists = existsSync, env = {}) {
  const fromPath = String(env.PATH ?? '')
    .split(':')
    .filter(Boolean)
    .map((dir) => join(dir, 'terminal-notifier'))
  for (const candidate of [...fromPath, ...NOTIFIER_CANDIDATES]) {
    try {
      if (exists(candidate)) return candidate
    } catch {
      /* unreadable candidate: keep looking */
    }
  }
  return ''
}

/**
 * Turn `defaults read -g com.apple.sound.beep.sound` output into a file path.
 * The preference holds either an absolute path or a bare sound name.
 * @param stdout - the command's stdout.
 * @returns an absolute `.aiff` path, or `''` when the output is unusable.
 */
export function parseAlertSound(stdout) {
  const first = String(stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)[0]
  if (!first) return ''
  if (first.startsWith('/')) return /\.aiff?$/i.test(first) ? first : ''
  const name = first.replace(/\.aiff?$/i, '')
  return /^[A-Za-z0-9 _-]+$/.test(name) ? `/System/Library/Sounds/${name}.aiff` : ''
}

/** Opt-in JSONL trace for "why did no banner appear" debugging. */
function trace(env, entry) {
  const path = env.DSH_MAC_NOTIFY_LOG
  if (!path) return
  try {
    appendFileSync(path, `${JSON.stringify({ at: Date.now(), ...entry })}\n`)
  } catch {
    /* a broken debug sink must never break a notification */
  }
}

/**
 * Build the notification logic against injected collaborators.
 *
 * `apply` calls this with the real `ctx`, `process.env`, `process.platform` and
 * `child_process.execFile`; `selftest.mjs` calls it with stubs and drives
 * `handlers` directly.
 *
 * @param options - `{ ctx, config, env, platform, exec, exists, now, helper }`.
 * @returns `{ config, language, copy, state, handlers, notify, flush, dispose }`.
 */
export function createRuntime(options = {}) {
  const {
    ctx,
    config: rawConfig,
    env = {},
    platform = osPlatform(),
    exec = execFile,
    exists = existsSync,
    now = () => Date.now(),
    helper = fileURLToPath(new URL('./click.mjs', import.meta.url)),
  } = options

  const config = normalizeConfig(rawConfig)
  const language = pickLanguage(config, env)
  const copy = COPY[language]
  const supported = platform === 'darwin'
  const dryRun = env.DSH_MAC_NOTIFY_DRY_RUN === '1'

  const state = {
    /** sessionId → last observed agent status. */
    status: new Map(),
    /** sessionId → last assistant text. */
    lastText: new Map(),
    /** sessionId → session header facts used for the subagent filter. */
    headers: new Map(),
    /** sessionId → whether the current run has errored. */
    errored: new Map(),
    /** Delivery bookkeeping, exposed for tests and troubleshooting. */
    sent: 0,
    skipped: 0,
    failures: [],
    lastSentAt: 0,
    lastKey: '',
    pending: Promise.resolve(),
    /** Cached capability answers. */
    backend: undefined,
    backendCheckedAt: 0,
    alertSound: undefined,
  }

  /* ------------------------------------------------------------------ reads */

  const readService = (name) => {
    try {
      return ctx?.get?.(name) ?? ctx?.[name] ?? undefined
    } catch {
      return undefined
    }
  }

  const headerOf = (sessionId) => {
    const cached = state.headers.get(sessionId)
    if (cached) return cached
    try {
      const session = readService('sessions')?.get?.(sessionId)
      const header = session?.header
      if (header) {
        const facts = { origin: header.origin, depth: header.delegationDepth, cwd: header.cwd }
        state.headers.set(sessionId, facts)
        return facts
      }
    } catch {
      /* the store may be unavailable during teardown */
    }
    return undefined
  }

  const workspaceOf = (sessionId) => {
    const cwd = headerOf(sessionId)?.cwd
    if (typeof cwd === 'string' && cwd) return basename(cwd)
    return typeof sessionId === 'string' && sessionId ? sessionId.slice(-12) : ''
  }

  /** Subagent children must not page the operator unless asked for. */
  const isSubagent = (sessionId) => {
    const facts = headerOf(sessionId)
    if (!facts) return false
    return facts.origin === 'subagent' || (typeof facts.depth === 'number' && facts.depth > 0)
  }

  const allows = (sessionId) => {
    if (!config.enabled) return false
    if (!supported) return false
    if (!config.includeSubagents && isSubagent(sessionId)) return false
    return true
  }

  /**
   * Where a click should land: the configured URL, else the port this Host is
   * actually serving the Web UI on, else the launch environment's URL.
   */
  const targetUrl = () => {
    if (config.url) return config.url
    const port = readService('webServer')?.port
    if (typeof port === 'number' && Number.isFinite(port)) return `http://127.0.0.1:${port}`
    const fromEnv = String(env.DSH_WEB_URL ?? '').trim()
    return /^https?:\/\//.test(fromEnv) ? fromEnv : ''
  }

  /* ------------------------------------------------------------- capability */

  /**
   * Pick the delivery backend, re-probing an absent terminal-notifier so that
   * installing it later starts working without a DSH restart.
   */
  const backend = () => {
    if (config.notifier === 'osascript') return { kind: 'osascript', path: '' }
    if (config.notifier === 'terminal-notifier') {
      const path = findNotifier(exists, env)
      return path ? { kind: 'terminal-notifier', path } : { kind: 'osascript', path: '' }
    }
    const at = now()
    if (state.backend && at - state.backendCheckedAt < BACKEND_TTL_MS) return state.backend
    const path = findNotifier(exists, env)
    state.backend = path ? { kind: 'terminal-notifier', path } : { kind: 'osascript', path: '' }
    state.backendCheckedAt = at
    return state.backend
  }

  /**
   * Resolve the operator's system alert sound once per process: the preference
   * holds either an absolute path or a bare name under /System/Library/Sounds.
   *
   * A built-in sound becomes the banner's own `sound name`, so the notification
   * system plays it exactly as it plays every other alert (and honours Focus).
   * A custom sound from `~/Library/Sounds` is not addressable by name, so that
   * one case plays through `afplay` beside a silent banner.
   */
  let alertSoundPromise
  const resolveAlertSound = () => {
    if (!alertSoundPromise) {
      alertSoundPromise = runExec(exec, '/usr/bin/defaults', ['read', '-g', 'com.apple.sound.beep.sound'], {
        timeout: 5000,
      }).then(({ ok, stdout }) => {
        const parsed = ok ? parseAlertSound(stdout) : ''
        let path = FALLBACK_ALERT_SOUND
        try {
          if (parsed && exists(parsed)) path = parsed
        } catch {
          /* unreadable preference path: keep the fallback */
        }
        const name = path.startsWith('/System/Library/Sounds/') ? basename(path).replace(/\.aiff$/i, '') : ''
        state.alertSound = path
        return { path, name: SYSTEM_SOUNDS.has(name) ? name : '' }
      })
    }
    return alertSoundPromise
  }

  /** The alert sound this process resolved, or the fallback before it has. */
  const alertSound = () => state.alertSound ?? FALLBACK_ALERT_SOUND

  /* -------------------------------------------------------------- delivery */

  /** The click action a clickable banner carries. */
  const clickFor = () => {
    if (config.onClick === 'none') return { mode: 'none', url: '', command: '' }
    const url = targetUrl()
    if (!url) return { mode: 'none', url: '', command: '' }
    if (config.onClick === 'open') return { mode: 'open', url, command: '' }
    let present = false
    try {
      present = exists(helper)
    } catch {
      present = false
    }
    if (!present) return { mode: 'open', url, command: '' }
    const command = `${shellQuote(process.execPath)} ${shellQuote(helper)} ${shellQuote(url)}`
    return { mode: 'focus', url, command }
  }

  /**
   * Post one banner through the selected backend, plus the sound policy.
   * `'default'` puts the operator's own alert sound on the banner, which is how
   * every other macOS alert reaches them; `'off'` is silent.
   */
  const post = async (banner) => {
    const chosen = backend()
    const click = chosen.kind === 'terminal-notifier' ? clickFor() : { mode: 'none' }

    // A dry run must observe the decision without spawning anything.
    if (dryRun) {
      trace(env, { event: 'deliver', backend: chosen.kind, dryRun, click: click.mode, ...banner })
      return { ok: true, dryRun: true }
    }

    let soundName = ''
    let soundFile = ''
    if (config.sound === 'default') {
      const resolved = await resolveAlertSound()
      soundName = resolved.name
      soundFile = resolved.name ? '' : resolved.path
    } else if (config.sound !== 'off') {
      soundName = config.sound
    }
    const payload = { ...banner, sound: soundName }

    trace(env, { event: 'deliver', backend: chosen.kind, dryRun, click: click.mode, ...payload })

    // The banner is the graded job; a fallback sound rides along and never gates it.
    const sound = soundFile
      ? runExec(exec, AFPLAY, [soundFile], { timeout: 10_000 }).then((outcome) => {
          if (!outcome.ok) trace(env, { event: 'sound-failed', error: outcome.error })
        })
      : Promise.resolve()

    const notice =
      chosen.kind === 'terminal-notifier'
        ? runExec(exec, chosen.path, buildTerminalNotifierArgs(payload, click), { timeout: 10_000 })
        : runExec(exec, OSASCRIPT, buildOsascriptArgs(payload), { timeout: 10_000 })

    const [result] = await Promise.all([notice, sound])
    if (result?.ok) state.sent += 1
    else {
      state.failures.push(result?.error ?? 'unknown')
      if (state.failures.length > 20) state.failures.shift()
      trace(env, { event: 'failure', error: result?.error })
    }
    return result ?? { ok: false }
  }

  /**
   * Queue one banner, applying the kind switch, the subagent filter, the
   * pacing gap and identical-content dedupe.
   * @param kind - `'finish' | 'question' | 'approval' | 'error'`.
   * @param notification - `{ title, subtitle, body }` after localization.
   * @param sessionId - the session the banner belongs to.
   * @returns a promise settling to `{ delivered, reason }`.
   */
  const notify = (kind, notification, sessionId) => {
    const refused = (() => {
      if (!config[KIND_SWITCH[kind]] || !allows(sessionId)) return 'disabled'
      const at = now()
      const key = `${notification.title}\u0000${notification.body}`
      if (key === state.lastKey && at - state.lastSentAt < IDENTICAL_WINDOW_MS) return 'duplicate'
      if (!URGENT_KINDS.has(kind) && config.minIntervalMs > 0 && at - state.lastSentAt < config.minIntervalMs) {
        return 'paced'
      }
      state.lastKey = key
      state.lastSentAt = at
      return ''
    })()

    if (refused) {
      state.skipped += 1
      trace(env, { event: 'skip', kind, reason: refused, ...notification })
      return Promise.resolve({ delivered: false, reason: refused })
    }

    const banner = {
      title: notification.title,
      subtitle: notification.subtitle ?? '',
      body: notification.body,
      sound: config.sound,
    }
    state.pending = state.pending.then(
      () => post(banner),
      () => post(banner),
    )
    return state.pending.then((result) => ({
      delivered: result.ok === true,
      reason: result.dryRun ? 'dry-run' : undefined,
    }))
  }

  const title = (suffix) => `${config.titlePrefix} · ${suffix}`

  /* -------------------------------------------------------------- handlers */

  /** `agent/status` — the only signal that says "the turn is over". */
  const status = (payload) => {
    try {
      const agent = payload?.agent
      const next = payload?.status
      if (!agent || (next !== 'idle' && next !== 'running')) return
      const previous = state.status.get(agent.id)
      state.status.set(agent.id, next)
      if (next === 'running') {
        state.errored.set(agent.id, false)
        return
      }
      if (previous !== 'running') return
      const failed = state.errored.get(agent.id) === true
      const text = state.lastText.get(agent.id)
      const body = text
        ? truncate(text, config.bodyMaxChars)
        : failed
          ? copy.errorFallback
          : copy.finishFallback
      void notify(
        'finish',
        {
          title: title(failed ? copy.finishError : copy.finish),
          subtitle: workspaceOf(agent.id),
          body,
        },
        agent.id,
      )
    } catch {
      /* a listener must never break the host's dispatch */
    }
  }

  /** `session/event` — keep the latest assistant text for the finish banner. */
  const sessionEvent = (session, event) => {
    try {
      if (!session || event?.type !== 'assistant/message') return
      const text = extractText(event.data?.message ?? event.message)
      if (text.trim()) state.lastText.set(session.id, text)
    } catch {
      /* ignore */
    }
  }

  /** `session/created` — cache header facts for the subagent filter. */
  const sessionCreated = (session) => {
    try {
      if (!session?.id) return
      const header = session.header
      if (header) {
        state.headers.set(session.id, {
          origin: header.origin,
          depth: header.delegationDepth,
          cwd: header.cwd,
        })
      }
    } catch {
      /* ignore */
    }
  }

  const forget = (sessionId) => {
    state.status.delete(sessionId)
    state.lastText.delete(sessionId)
    state.errored.delete(sessionId)
    state.headers.delete(sessionId)
  }

  const sessionDisposed = (session) => {
    try {
      if (session?.id) forget(session.id)
    } catch {
      /* ignore */
    }
  }

  const agentDisposed = (payload) => {
    try {
      if (payload?.agent?.id) forget(payload.agent.id)
    } catch {
      /* ignore */
    }
  }

  /** `user-questions/request` — waterfall: notify, then always delegate. */
  const question = (request, next) => {
    try {
      const first = Array.isArray(request?.questions) ? request.questions[0] : undefined
      const head = first
        ? [first.header, first.question].filter(Boolean).join(' · ')
        : copy.questionFallback
      const labels = Array.isArray(first?.options)
        ? first.options.map((option) => option?.label).filter(Boolean)
        : []
      const body = labels.length > 0 && labels.length <= 4 ? `${head} — ${labels.join(' / ')}` : head
      void notify(
        'question',
        {
          title: title(copy.question),
          subtitle: workspaceOf(request?.agent?.id),
          body: truncate(body || copy.questionFallback, config.bodyMaxChars),
        },
        request?.agent?.id,
      )
    } catch {
      /* ignore */
    }
    return next()
  }

  /** `approval/request` — waterfall: notify, then always delegate. */
  const approval = (req, next) => {
    try {
      const reason = req?.displayReason?.zh || req?.displayReason?.en || req?.reason
      const body = reason
        ? truncate(reason, config.bodyMaxChars)
        : copy.approvalWithTool(req?.toolName ?? copy.approvalFallback)
      void notify(
        'approval',
        {
          title: title(copy.approval),
          subtitle: workspaceOf(req?.agent?.id),
          body,
        },
        req?.agent?.id,
      )
    } catch {
      /* ignore */
    }
    return next()
  }

  /** `agent/error` — remember it for the finish banner, and page immediately. */
  const error = (payload) => {
    try {
      const agent = payload?.agent
      if (!agent) return
      state.errored.set(agent.id, true)
      const message = payload?.error?.message ?? payload?.error ?? ''
      void notify(
        'error',
        {
          title: title(copy.error),
          subtitle: workspaceOf(agent.id),
          body: truncate(message || copy.errorFallback, config.bodyMaxChars),
        },
        agent.id,
      )
    } catch {
      /* ignore */
    }
  }

  return {
    config,
    language,
    copy,
    state,
    supported,
    targetUrl,
    backend,
    clickFor,
    alertSound,
    handlers: {
      status,
      sessionEvent,
      sessionCreated,
      sessionDisposed,
      agentDisposed,
      question,
      approval,
      error,
    },
    notify,
    /** Await every queued delivery (tests and shutdown paths). */
    flush: () => state.pending,
    dispose: () => {
      state.status.clear()
      state.lastText.clear()
      state.errored.clear()
      state.headers.clear()
    },
  }
}

/**
 * Cordis entry point: subscribe this plugin's listeners for as long as its row
 * is active.
 *
 * Every listener is registered with `{ global: true }`. Without it a listener
 * carries the scope tag of the context it was registered through, and a tagged
 * listener only receives events for that one scope — so a row activated from
 * inside an agent's scope (which is what a plugin-manager tool call does: the
 * profile reconcile runs inside the calling agent's driver chain) would observe
 * exactly one session and stay silent for every other. `global: true` takes the
 * listener out of the scope filter entirely, which is what "notify me about any
 * session in this process" requires. The tag belongs to the *listener*, not to
 * the event: the dispatch is already agent-tagged, and Cordis keeps a hook when
 * `hook.global || !filter || filter(carrier, hook.ctx)` admits it.
 *
 * Listeners stay owned by this fiber through `ctx.on(...)`, so Cordis disposes
 * them with the plugin; the returned disposer covers a manual unload as well.
 *
 * @param ctx - the plugin's Cordis context.
 * @param config - this row's `config` from `cordis.patch.yml`.
 * @returns a disposer that detaches every listener.
 */
export function apply(ctx, config) {
  const runtime = createRuntime({ ctx, config, env: process.env })
  const { handlers } = runtime

  if (!runtime.supported) {
    ctx.logger?.debug?.('[mac-notify] macOS only: delivery is disabled on this platform')
    return () => runtime.dispose()
  }

  const listeners = [
    ['agent/status', handlers.status],
    ['agent/error', handlers.error],
    ['agent/disposed', handlers.agentDisposed],
    ['session/created', handlers.sessionCreated],
    ['session/event', handlers.sessionEvent],
    ['session/disposed', handlers.sessionDisposed],
    ['user-questions/request', handlers.question],
    ['approval/request', handlers.approval],
  ]

  const disposers = []
  for (const [name, listener] of listeners) {
    try {
      disposers.push(ctx.on(name, listener, { global: true }))
    } catch (error) {
      ctx.logger?.warn?.(`[mac-notify] could not subscribe ${name}: ${error?.message ?? error}`)
    }
  }

  return () => {
    for (const dispose of disposers) {
      try {
        dispose?.()
      } catch {
        /* ignore */
      }
    }
    runtime.dispose()
  }
}
