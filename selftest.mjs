#!/usr/bin/env node
/**
 * Offline self-test for dsh-plugin-mac-notify: `node selftest.mjs`.
 *
 * Everything here runs against the same `lib/index.js` the Harness loads, with
 * `exec`/`exists`/`now` stubbed, so the suite sends no notification, plays no
 * sound, and touches no browser. It covers four layers:
 *
 *   1. module and packaging contract  — manifest, patch, locale, icon wiring
 *   2. pure functions                 — config, copy, argv builders, parsers
 *   3. registration contract          — which events `apply` subscribes
 *   4. event-driven behaviour         — what each Host event actually sends
 *
 * The only real subprocess is `/bin/sh`, used to prove that a quoted click
 * command survives the shell that terminal-notifier will run it in.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as plugin from './lib/index.js'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const PACKAGE = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

const results = []
let current = ''

/** Register one named assertion; async bodies are awaited by the runner. */
function test(name, body) {
  current = name
  try {
    const value = body()
    if (value && typeof value.then === 'function') {
      return value.then(
        () => results.push({ name, ok: true }),
        (error) => results.push({ name, ok: false, error }),
      )
    }
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error })
  }
  return Promise.resolve()
}

/* ------------------------------------------------------------------ stubs */

const BLOW = '/System/Library/Sounds/Blow.aiff'
const NOTIFIER = '/opt/homebrew/bin/terminal-notifier'
const HELPER = join(ROOT, 'lib/click.mjs')

/** Records every spawned command and answers from `responder`. */
function makeExec(responder = () => ({})) {
  const calls = []
  const exec = (file, args, options, callback) => {
    const call = { file, args, options }
    calls.push(call)
    const reply = responder(call) ?? {}
    queueMicrotask(() => {
      if (reply.error) callback(new Error(reply.error), '', reply.stderr ?? reply.error)
      else callback(null, reply.stdout ?? '', '')
    })
    return { on() {}, kill() {} }
  }
  return { exec, calls }
}

/** A Cordis-shaped context whose two services are opt-in per test. */
function makeCtx({ sessions, webServer } = {}) {
  const registered = []
  return {
    registered,
    on(name, listener, options) {
      registered.push({ name, listener, options })
      return () => {
        const index = registered.findIndex((entry) => entry.listener === listener)
        if (index >= 0) registered.splice(index, 1)
      }
    },
    get(name) {
      if (name === 'sessions' && sessions) return { get: (id) => sessions.get(id) }
      if (name === 'webServer' && webServer) return webServer
      return undefined
    },
    logger: { debug() {}, warn() {} },
  }
}

/**
 * Build a runtime over stubs.
 * @param options - `{ config, env, platform, present, responder, sessions, webServer, clock }`.
 */
function makeRuntime(options = {}) {
  const present = new Set(options.present ?? [BLOW, '/System/Library/Sounds/Glass.aiff'])
  const responder =
    options.responder ?? ((call) => (call.file === '/usr/bin/defaults' ? { stdout: 'Blow\n' } : {}))
  const { exec, calls } = makeExec(responder)
  const ctx = makeCtx(options)
  const clock = options.clock ?? { at: 1_000_000 }
  const runtime = plugin.createRuntime({
    ctx,
    config: options.config,
    env: options.env ?? {},
    platform: options.platform ?? 'darwin',
    exec,
    exists: (path) => present.has(path),
    now: () => clock.at,
    helper: HELPER,
  })
  return { runtime, ctx, calls, clock, present, exec }
}

/** The four trailing argv items `buildOsascriptArgs` appends. */
function osascriptBanner(call) {
  const args = call.args
  return { title: args.at(-4), subtitle: args.at(-3), body: args.at(-2), sound: args.at(-1) }
}

/** Parse `-flag value` pairs back into an object. */
function flags(args) {
  const out = {}
  for (let index = 0; index < args.length; index += 2) out[args[index]] = args[index + 1]
  return out
}

const osascriptCalls = (calls) => calls.filter((call) => call.file === plugin.OSASCRIPT)
const soundCalls = (calls) => calls.filter((call) => call.file === plugin.AFPLAY)
const notifierCalls = (calls) => calls.filter((call) => call.file === NOTIFIER)

const assistantEvent = (text) => [
  { id: 'session-1' },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } },
]

/* ------------------------------------------------- 1. packaging contract */

await test('package name matches the row name in the patch', () => {
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.equal(PACKAGE.name, 'dsh-plugin-mac-notify')
  assert.match(patch, /id: mac-notify/)
  assert.match(patch, new RegExp(`name: '${PACKAGE.name}'`))
})

await test('dsh.bundle.patch is declared and shipped', () => {
  const patch = PACKAGE.dsh?.bundle?.patch
  assert.equal(patch, './cordis.patch.yml')
  assert.ok(existsSync(join(ROOT, patch)), 'patch file must exist')
  assert.ok(PACKAGE.files.includes('cordis.patch.yml'), 'patch must be published')
})

await test('the entry point and the publish list cover every runtime file', () => {
  assert.equal(PACKAGE.type, 'module')
  assert.equal(PACKAGE.main, 'lib/index.js')
  assert.equal(PACKAGE.exports['.'], './lib/index.js')
  assert.ok(PACKAGE.files.includes('lib'), 'lib must be published')
  assert.ok(PACKAGE.files.includes('locale/*.json'))
  assert.ok(PACKAGE.files.includes('icon.svg'))
  for (const file of ['lib/index.js', 'lib/click.mjs', 'icon.svg', 'locale/en.json', 'locale/zh.json']) {
    assert.ok(existsSync(join(ROOT, file)), `${file} must exist`)
  }
})

await test('a zero-dependency host bundle carries no compatibility gate', () => {
  // evaluatePluginCompatibility only inspects @deepseek-ai/dsh* peer ranges.
  const peers = Object.keys(PACKAGE.peerDependencies ?? {})
  assert.equal(peers.filter((name) => name.startsWith('@deepseek-ai/dsh')).length, 0)
  assert.equal(PACKAGE.dependencies, undefined)
  assert.equal(PACKAGE.dsh.client, undefined, 'host-only: no browser half')
})

await test('locale files carry the display metadata the Plugins page reads', () => {
  for (const language of ['en', 'zh']) {
    const dict = JSON.parse(readFileSync(join(ROOT, `locale/${language}.json`), 'utf8'))
    assert.ok(dict.meta?.title, `${language} meta.title`)
    assert.ok(dict.meta?.description, `${language} meta.description`)
  }
})

await test('the icon is a small SVG', () => {
  const size = statSync(join(ROOT, 'icon.svg')).size
  assert.ok(size < 256 * 1024, 'icon must stay under 256 KiB')
  assert.match(readFileSync(join(ROOT, 'icon.svg'), 'utf8'), /^<svg /)
})

/* ---------------------------------------------------- 2. pure functions */

await test('normalizeConfig fills every default', () => {
  for (const raw of [undefined, null, 42, 'x', []]) {
    const config = plugin.normalizeConfig(raw)
    for (const [key, value] of Object.entries(plugin.DEFAULTS)) assert.equal(config[key], value, key)
    assert.ok(Object.isFrozen(config))
  }
})

await test('normalizeConfig coerces booleans and rejects junk', () => {
  const config = plugin.normalizeConfig({
    enabled: 'false',
    notifyOnFinish: false,
    notifyOnQuestion: 'true',
    includeSubagents: 'yes',
  })
  assert.equal(config.enabled, false)
  assert.equal(config.notifyOnFinish, false)
  assert.equal(config.notifyOnQuestion, true)
  assert.equal(config.includeSubagents, false)
})

await test('normalizeConfig clamps numbers into their budgets', () => {
  assert.equal(plugin.normalizeConfig({ minIntervalMs: -5 }).minIntervalMs, 0)
  assert.equal(plugin.normalizeConfig({ minIntervalMs: 999_999 }).minIntervalMs, 60_000)
  assert.equal(plugin.normalizeConfig({ minIntervalMs: 12.6 }).minIntervalMs, 13)
  assert.equal(plugin.normalizeConfig({ bodyMaxChars: 5 }).bodyMaxChars, 40)
  assert.equal(plugin.normalizeConfig({ bodyMaxChars: 10_000 }).bodyMaxChars, 400)
  assert.equal(plugin.normalizeConfig({ minIntervalMs: 'abc' }).minIntervalMs, plugin.DEFAULTS.minIntervalMs)
})

await test('normalizeConfig accepts only the three enums it documents', () => {
  assert.equal(plugin.normalizeConfig({ language: 'zh' }).language, 'zh')
  assert.equal(plugin.normalizeConfig({ language: 'fr' }).language, 'auto')
  assert.equal(plugin.normalizeConfig({ onClick: 'open' }).onClick, 'open')
  assert.equal(plugin.normalizeConfig({ onClick: 'bogus' }).onClick, 'focus')
  assert.equal(plugin.normalizeConfig({ notifier: 'osascript' }).notifier, 'osascript')
  assert.equal(plugin.normalizeConfig({ notifier: 'bogus' }).notifier, 'auto')
})

await test('normalizeConfig understands the three sound shapes', () => {
  assert.equal(plugin.normalizeConfig({}).sound, 'default')
  assert.equal(plugin.normalizeConfig({ sound: 'default' }).sound, 'default')
  assert.equal(plugin.normalizeConfig({ sound: 'Ping' }).sound, 'Ping')
  assert.equal(plugin.normalizeConfig({ sound: 'off' }).sound, 'off')
  assert.equal(plugin.normalizeConfig({ sound: 'none' }).sound, 'off')
  assert.equal(plugin.normalizeConfig({ sound: '' }).sound, 'off')
  assert.equal(plugin.normalizeConfig({ sound: 'NotASound' }).sound, 'default')
})

await test('normalizeConfig keeps only an absolute http(s) url', () => {
  assert.equal(plugin.normalizeConfig({ url: ' http://127.0.0.1:3080 ' }).url, 'http://127.0.0.1:3080')
  assert.equal(plugin.normalizeConfig({ url: 'https://dsh.example/s' }).url, 'https://dsh.example/s')
  assert.equal(plugin.normalizeConfig({ url: 'file:///etc/passwd' }).url, '')
  assert.equal(plugin.normalizeConfig({ url: 'javascript:alert(1)' }).url, '')
  assert.equal(plugin.normalizeConfig({ url: 'nonsense' }).url, '')
})

await test('normalizeConfig trims and caps titlePrefix', () => {
  assert.equal(plugin.normalizeConfig({ titlePrefix: '  DSH  ' }).titlePrefix, 'DSH')
  assert.equal(plugin.normalizeConfig({ titlePrefix: '   ' }).titlePrefix, plugin.DEFAULTS.titlePrefix)
  assert.equal(plugin.normalizeConfig({ titlePrefix: 'x'.repeat(80) }).titlePrefix.length, 40)
})

await test('pickLanguage follows config, then environment, then system locale', () => {
  const auto = plugin.normalizeConfig({})
  assert.equal(plugin.pickLanguage(plugin.normalizeConfig({ language: 'zh' }), { LANG: 'en_US.UTF-8' }), 'zh')
  assert.equal(plugin.pickLanguage(plugin.normalizeConfig({ language: 'en' }), { LANG: 'zh_CN.UTF-8' }), 'en')
  assert.equal(plugin.pickLanguage(auto, { LANG: 'zh_CN.UTF-8' }), 'zh')
  assert.equal(plugin.pickLanguage(auto, { LANG: 'en_GB.UTF-8' }), 'en')
  assert.equal(plugin.pickLanguage(auto, {}, 'zh-CN'), 'zh')
  assert.equal(plugin.pickLanguage(auto, {}, 'en-US'), 'en')
  assert.equal(plugin.pickLanguage(auto, {}, ''), 'en')
  assert.equal(plugin.pickLanguage(auto, { LANG: 'en_US.UTF-8', DSH_MAC_NOTIFY_LANG: 'zh' }), 'zh')
})

await test('both dictionaries describe the same four kinds', () => {
  for (const language of ['zh', 'en']) {
    const copy = plugin.COPY[language]
    for (const key of ['finish', 'finishError', 'question', 'approval', 'error']) {
      assert.equal(typeof copy[key], 'string')
      assert.ok(copy[key].length > 0)
    }
    assert.equal(typeof copy.approvalWithTool('bash'), 'string')
  }
  assert.notEqual(plugin.COPY.zh.finish, plugin.COPY.en.finish)
})

await test('truncate collapses whitespace and respects the budget', () => {
  assert.equal(plugin.truncate('  a\n\n b\tc  ', 100), 'a b c')
  assert.equal(plugin.truncate('abc', 3), 'abc')
  assert.equal(plugin.truncate('abcd', 3), 'ab…')
  assert.equal(plugin.truncate('x'.repeat(50), 10).length, 10)
  assert.equal(plugin.truncate(null, 10), '')
  assert.equal(plugin.truncate(42, 10), '42')
})

await test('extractText joins only text blocks', () => {
  assert.equal(plugin.extractText({ content: 'plain' }), 'plain')
  assert.equal(
    plugin.extractText({
      content: [{ type: 'text', text: 'a' }, { type: 'tool_use', id: 'x' }, { type: 'text', text: 'b' }],
    }),
    'a\nb',
  )
  assert.equal(plugin.extractText({ content: {} }), '')
  assert.equal(plugin.extractText(undefined), '')
})

await test('the AppleScript reads its strings from argv, never from source', () => {
  const hostile = '"; do shell script "touch /tmp/pwned"; --'
  const args = plugin.buildOsascriptArgs({ title: 'T', subtitle: 'S', body: hostile, sound: 'Glass' })
  assert.equal(args.length % 2, 0, '-e flags come in pairs')
  assert.deepEqual(args.slice(-4), ['T', 'S', hostile, 'Glass'])
  const script = args.slice(0, -4).filter((_, index) => index % 2 === 1).join('\n')
  assert.ok(!script.includes(hostile), 'the payload must not enter the script source')
  for (const item of ['item 1 of argv', 'item 2 of argv', 'item 3 of argv', 'item 4 of argv']) {
    assert.ok(script.includes(item), item)
  }
  assert.ok(script.includes('on run argv'))
})

await test('a command built with shellQuote survives /bin/sh', () => {
  for (const value of ['plain', "it's", 'a b', 'x"y', '$HOME `id`', 'back\\slash', 'new\nline']) {
    const quoted = plugin.shellQuote(value)
    const echoed = execFileSync('/bin/sh', ['-c', `printf %s ${quoted}`], { encoding: 'utf8' })
    assert.equal(echoed, value, `round-trip failed for ${JSON.stringify(value)}`)
  }
})

await test('terminal-notifier argv carries the click action it was asked for', () => {
  const banner = { title: 'T', subtitle: 'S', body: 'B', sound: 'Ping' }
  const focus = flags(plugin.buildTerminalNotifierArgs(banner, { mode: 'focus', url: 'u', command: 'CMD' }))
  assert.equal(focus['-title'], 'T')
  assert.equal(focus['-message'], 'B')
  assert.equal(focus['-subtitle'], 'S')
  assert.equal(focus['-sound'], 'Ping')
  assert.equal(focus['-execute'], 'CMD')
  assert.equal(focus['-open'], undefined)

  const open = flags(plugin.buildTerminalNotifierArgs(banner, { mode: 'open', url: 'http://x/', command: '' }))
  assert.equal(open['-open'], 'http://x/')
  assert.equal(open['-execute'], undefined)

  const none = flags(plugin.buildTerminalNotifierArgs({ title: 'T', body: 'B', sound: '' }, { mode: 'none' }))
  assert.equal(none['-open'], undefined)
  assert.equal(none['-execute'], undefined)
  assert.equal(none['-sound'], undefined)
  assert.equal(none['-subtitle'], undefined)
  assert.equal(none['-message'], 'B')
})

await test('parseAlertSound understands both preference shapes', () => {
  assert.equal(plugin.parseAlertSound('/System/Library/Sounds/Blow.aiff'), BLOW)
  assert.equal(plugin.parseAlertSound('Blow\n'), '/System/Library/Sounds/Blow.aiff')
  assert.equal(plugin.parseAlertSound('Blow.aiff'), '/System/Library/Sounds/Blow.aiff')
  assert.equal(plugin.parseAlertSound(''), '')
  assert.equal(plugin.parseAlertSound('   '), '')
  assert.equal(plugin.parseAlertSound('/etc/passwd'), '')
  assert.equal(plugin.parseAlertSound('Blow; rm -rf /'), '')
})

await test('findNotifier prefers PATH, then the Homebrew prefixes', () => {
  const present = new Set([
    '/custom/bin/terminal-notifier',
    '/opt/homebrew/bin/terminal-notifier',
  ])
  assert.equal(
    plugin.findNotifier((path) => present.has(path), { PATH: '/custom/bin:/opt/homebrew/bin' }),
    '/custom/bin/terminal-notifier',
  )
  const brewOnly = new Set(['/opt/homebrew/bin/terminal-notifier'])
  assert.equal(plugin.findNotifier((path) => brewOnly.has(path), { PATH: '/usr/bin' }), NOTIFIER)
  assert.equal(plugin.findNotifier(() => false, { PATH: '/usr/bin' }), '')
  assert.equal(plugin.findNotifier(() => false, {}), '')
})

/* ------------------------------------------------ 3. registration contract */

await test('apply subscribes exactly the events this plugin documents', () => {
  const ctx = makeCtx()
  const dispose = plugin.apply(ctx, {})
  assert.deepEqual(
    ctx.registered.map((entry) => entry.name).sort(),
    [
      'agent/disposed',
      'agent/error',
      'agent/status',
      'approval/request',
      'session/created',
      'session/disposed',
      'session/event',
      'user-questions/request',
    ],
  )
  assert.equal(typeof dispose, 'function')
  dispose()
  assert.equal(ctx.registered.length, 0, 'the returned disposer detaches every listener')
})

await test('every listener opts out of the scope filter, or other sessions go silent', () => {
  // Regression guard for the shipped bug: a row activated from inside an
  // agent's scope (which is what a plugin-manager tool call does) registers
  // listeners carrying that scope's tag, and a tagged listener receives only
  // that one agent's events — so a plugin installed mid-session notified for
  // that session alone. `global: true` is what lets one plugin observe every
  // agent in the process. Verified against the real @deepseek-ai/dsh-scope:
  // with two agents emitting, a scoped listener saw 1 of 2 events and the same
  // listener with `global: true` saw both.
  const ctx = makeCtx()
  plugin.apply(ctx, {})
  assert.equal(ctx.registered.length, 8)
  for (const entry of ctx.registered) {
    assert.equal(entry.options?.global, true, `${entry.name} must subscribe globally`)
  }
})

await test('apply survives a context whose service lookups throw', () => {
  const ctx = makeCtx()
  ctx.get = () => {
    throw new Error('service unavailable')
  }
  const dispose = plugin.apply(ctx, {})
  assert.equal(ctx.registered.length, 8)
  dispose()
})

await test('the waterfall listeners always delegate to next()', async () => {
  const { runtime } = makeRuntime({ config: {} })
  let questionNext = 0
  const question = await runtime.handlers.question({ questions: [], agent: { id: 's' } }, () => {
    questionNext += 1
    return Promise.resolve('answered')
  })
  assert.equal(question, 'answered')
  assert.equal(questionNext, 1)

  let approvalNext = 0
  const approval = await runtime.handlers.approval({ agent: { id: 's' } }, () => {
    approvalNext += 1
    return Promise.resolve('decided')
  })
  assert.equal(approval, 'decided')
  assert.equal(approvalNext, 1)
})

/* ------------------------------------------------- 4. event-driven behaviour */

await test('a running → idle transition reports the turn with the last reply', async () => {
  const { runtime, calls } = makeRuntime({ config: {} })
  runtime.handlers.sessionEvent(...assistantEvent('插件已经写好并且装好了，自检 60 项全过。'))
  runtime.handlers.status({ agent: { id: 'session-1' }, status: 'running' })
  runtime.handlers.status({ agent: { id: 'session-1' }, status: 'idle' })
  await runtime.flush()

  const [call] = osascriptCalls(calls)
  const banner = osascriptBanner(call)
  assert.equal(banner.title, 'DSH · 任务完成')
  assert.equal(banner.body, '插件已经写好并且装好了，自检 60 项全过。')
  assert.equal(banner.sound, 'Blow', "the operator's own alert sound rides on the banner")
})

await test('idle without a preceding running turn sends nothing', async () => {
  const { runtime, calls } = makeRuntime({ config: {} })
  runtime.handlers.status({ agent: { id: 's' }, status: 'idle' })
  runtime.handlers.status({ agent: { id: 's' }, status: 'idle' })
  await runtime.flush()
  assert.equal(osascriptCalls(calls).length, 0)
})

await test('a second idle after a run does not repeat the banner', async () => {
  const { runtime, calls, clock } = makeRuntime({ config: {} })
  runtime.handlers.status({ agent: { id: 's' }, status: 'running' })
  runtime.handlers.status({ agent: { id: 's' }, status: 'idle' })
  await runtime.flush()
  clock.at += 60_000
  runtime.handlers.status({ agent: { id: 's' }, status: 'idle' })
  await runtime.flush()
  assert.equal(osascriptCalls(calls).length, 1)
})

await test('the subtitle names the workspace, or the session tail', async () => {
  const headed = makeRuntime({
    config: {},
    sessions: new Map([['s', { header: { cwd: '/Users/kkkk/Downloads/browser_dsh' } }]]),
  })
  headed.runtime.handlers.status({ agent: { id: 's' }, status: 'running' })
  headed.runtime.handlers.status({ agent: { id: 's' }, status: 'idle' })
  await headed.runtime.flush()
  assert.equal(osascriptBanner(osascriptCalls(headed.calls)[0]).subtitle, 'browser_dsh')

  const headless = makeRuntime({ config: {} })
  headless.runtime.handlers.status({ agent: { id: 'session-abcdef123456' }, status: 'running' })
  headless.runtime.handlers.status({ agent: { id: 'session-abcdef123456' }, status: 'idle' })
  await headless.runtime.flush()
  assert.equal(osascriptBanner(osascriptCalls(headless.calls)[0]).subtitle, 'abcdef123456')
})

await test('session/created alone supplies the header facts', async () => {
  const { runtime, calls } = makeRuntime({ config: {} })
  runtime.handlers.sessionCreated({ id: 's', header: { cwd: '/tmp/my-project' } })
  runtime.handlers.status({ agent: { id: 's' }, status: 'running' })
  runtime.handlers.status({ agent: { id: 's' }, status: 'idle' })
  await runtime.flush()
  assert.equal(osascriptBanner(osascriptCalls(calls)[0]).subtitle, 'my-project')
})

await test('subagent children stay silent unless asked for', async () => {
  const quiet = makeRuntime({ config: {}, sessions: new Map([['c', { header: { origin: 'subagent' } }]]) })
  quiet.runtime.handlers.status({ agent: { id: 'c' }, status: 'running' })
  quiet.runtime.handlers.status({ agent: { id: 'c' }, status: 'idle' })
  await quiet.runtime.flush()
  assert.equal(osascriptCalls(quiet.calls).length, 0)

  const loud = makeRuntime({
    config: { includeSubagents: true },
    sessions: new Map([['c', { header: { origin: 'subagent' } }]]),
  })
  loud.runtime.handlers.status({ agent: { id: 'c' }, status: 'running' })
  loud.runtime.handlers.status({ agent: { id: 'c' }, status: 'idle' })
  await loud.runtime.flush()
  assert.equal(osascriptCalls(loud.calls).length, 1)

  const deep = makeRuntime({ config: {}, sessions: new Map([['d', { header: { delegationDepth: 1 } }]]) })
  deep.runtime.handlers.status({ agent: { id: 'd' }, status: 'running' })
  deep.runtime.handlers.status({ agent: { id: 'd' }, status: 'idle' })
  await deep.runtime.flush()
  assert.equal(osascriptCalls(deep.calls).length, 0)
})

await test('a question banner carries the header, the question and its options', async () => {
  const { runtime, calls } = makeRuntime({ config: {} })
  runtime.handlers.question(
    {
      agent: { id: 's' },
      questions: [
        {
          id: 'q1',
          header: '安装目标',
          question: '是否装到 web profile？',
          options: [{ label: '直接装' }, { label: '先不装' }],
        },
      ],
    },
    () => Promise.resolve(),
  )
  await runtime.flush()
  const banner = osascriptBanner(osascriptCalls(calls)[0])
  assert.equal(banner.title, 'DSH · 需要你的回答')
  assert.equal(banner.body, '安装目标 · 是否装到 web profile？ — 直接装 / 先不装')
})

await test('a question with many options drops them instead of truncating the question', async () => {
  const { runtime, calls } = makeRuntime({ config: {} })
  runtime.handlers.question(
    {
      agent: { id: 's' },
      questions: [{ id: 'q', question: '选一个', options: [1, 2, 3, 4, 5].map((n) => ({ label: `o${n}` })) }],
    },
    () => Promise.resolve(),
  )
  await runtime.flush()
  assert.equal(osascriptBanner(osascriptCalls(calls)[0]).body, '选一个')
})

await test('an empty question request still produces a usable banner', async () => {
  const { runtime, calls } = makeRuntime({ config: {} })
  runtime.handlers.question({ agent: { id: 's' } }, () => Promise.resolve())
  await runtime.flush()
  const banner = osascriptBanner(osascriptCalls(calls)[0])
  assert.equal(banner.title, 'DSH · 需要你的回答')
  assert.ok(banner.body.length > 0)
})

await test('an approval banner prefers the localized reason, then the tool name', async () => {
  const first = makeRuntime({ config: {} })
  first.runtime.handlers.approval(
    { agent: { id: 's' }, toolName: 'bash', displayReason: { en: 'Run a command', zh: '运行一条命令' } },
    () => Promise.resolve(),
  )
  await first.runtime.flush()
  assert.equal(osascriptBanner(osascriptCalls(first.calls)[0]).body, '运行一条命令')

  const second = makeRuntime({ config: {}, env: { LANG: 'en_US.UTF-8' } })
  second.runtime.handlers.approval({ agent: { id: 's' }, toolName: 'bash' }, () => Promise.resolve())
  await second.runtime.flush()
  const banner = osascriptBanner(osascriptCalls(second.calls)[0])
  assert.equal(banner.title, 'DSH · Your approval is needed')
  assert.equal(banner.body, 'Waiting for your approval: bash')
})

await test('an error pages immediately and colours the closing banner', async () => {
  const { runtime, calls, clock } = makeRuntime({ config: {} })
  runtime.handlers.status({ agent: { id: 's' }, status: 'running' })
  runtime.handlers.error({ agent: { id: 's' }, turn: 1, step: 2, error: new Error('boom') })
  await runtime.flush()
  assert.equal(osascriptBanner(osascriptCalls(calls)[0]).title, 'DSH · 执行出错')
  assert.equal(osascriptBanner(osascriptCalls(calls)[0]).body, 'boom')

  // An error and the closing turn are one incident: the error banner is the
  // one the operator needs, so the finish banner is paced out.
  runtime.handlers.status({ agent: { id: 's' }, status: 'idle' })
  await runtime.flush()
  assert.equal(osascriptCalls(calls).length, 1)

  clock.at += 60_000
  runtime.handlers.status({ agent: { id: 's' }, status: 'running' })
  runtime.handlers.status({ agent: { id: 's' }, status: 'idle' })
  await runtime.flush()
  assert.equal(osascriptBanner(osascriptCalls(calls).at(-1)).title, 'DSH · 任务完成')
})

await test('a new run clears the previous error colour', async () => {
  const { runtime, calls, clock } = makeRuntime({ config: {} })
  runtime.handlers.status({ agent: { id: 's' }, status: 'running' })
  runtime.handlers.error({ agent: { id: 's' }, error: new Error('boom') })
  await runtime.flush()
  clock.at += 60_000
  runtime.handlers.status({ agent: { id: 's' }, status: 'idle' })
  await runtime.flush()
  assert.equal(osascriptBanner(osascriptCalls(calls).at(-1)).title, 'DSH · 任务结束（有报错）')

  clock.at += 60_000
  runtime.handlers.status({ agent: { id: 's' }, status: 'running' })
  runtime.handlers.status({ agent: { id: 's' }, status: 'idle' })
  await runtime.flush()
  assert.equal(osascriptBanner(osascriptCalls(calls).at(-1)).title, 'DSH · 任务完成')
})

await test('disposed sessions and agents release their state', async () => {
  const { runtime } = makeRuntime({ config: {} })
  runtime.handlers.status({ agent: { id: 's' }, status: 'running' })
  runtime.handlers.sessionEvent(...assistantEvent('text'))
  assert.equal(runtime.state.status.get('s'), 'running')
  runtime.handlers.agentDisposed({ agent: { id: 's' } })
  assert.equal(runtime.state.status.has('s'), false)
  assert.equal(runtime.state.lastText.has('s'), false)

  runtime.handlers.sessionCreated({ id: 't', header: { cwd: '/tmp/t' } })
  runtime.handlers.sessionDisposed({ id: 't' })
  assert.equal(runtime.state.headers.has('t'), false)
})

await test('the pacing gap holds ordinary banners but never a question', async () => {
  const { runtime, calls, clock } = makeRuntime({ config: {} })
  runtime.handlers.status({ agent: { id: 'a' }, status: 'running' })
  runtime.handlers.status({ agent: { id: 'a' }, status: 'idle' })
  await runtime.flush()
  runtime.handlers.status({ agent: { id: 'b' }, status: 'running' })
  runtime.handlers.status({ agent: { id: 'b' }, status: 'idle' })
  await runtime.flush()
  assert.equal(osascriptCalls(calls).length, 1, 'the second finish is paced out')

  clock.at += 1
  const outcome = await runtime.notify('question', { title: 'T', subtitle: '', body: 'B' }, 'b')
  assert.equal(outcome.delivered, true, 'questions bypass the gap')
  assert.equal(osascriptCalls(calls).length, 2)
})

await test('identical banners inside the dedupe window collapse into one', async () => {
  const { runtime, calls } = makeRuntime({ config: {} })
  const banner = { title: 'DSH · 任务完成', subtitle: 'w', body: 'same text' }
  assert.equal((await runtime.notify('finish', banner, 'a')).delivered, true)
  const second = await runtime.notify('finish', banner, 'b')
  assert.equal(second.delivered, false)
  assert.equal(second.reason, 'duplicate')
  assert.equal(runtime.state.skipped, 1)
  assert.equal(osascriptCalls(calls).length, 1)
})

await test('every kind switch can silence its own kind', async () => {
  const config = {
    notifyOnFinish: false,
    notifyOnQuestion: false,
    notifyOnApproval: false,
    notifyOnError: false,
  }
  const { runtime, calls } = makeRuntime({ config })
  runtime.handlers.status({ agent: { id: 's' }, status: 'running' })
  runtime.handlers.status({ agent: { id: 's' }, status: 'idle' })
  runtime.handlers.question({ agent: { id: 's' }, questions: [{ question: 'q' }] }, () => Promise.resolve())
  runtime.handlers.approval({ agent: { id: 's' }, toolName: 'bash' }, () => Promise.resolve())
  runtime.handlers.error({ agent: { id: 's' }, error: new Error('x') })
  await runtime.flush()
  assert.equal(calls.length, 0)
})

await test('the master switch and non-macOS hosts disable delivery', async () => {
  const off = makeRuntime({ config: { enabled: false } })
  assert.equal((await off.runtime.notify('question', { title: 'T', body: 'B' }, 's')).reason, 'disabled')

  const linux = makeRuntime({ config: {}, platform: 'linux' })
  assert.equal(linux.runtime.supported, false)
  assert.equal((await linux.runtime.notify('question', { title: 'T', body: 'B' }, 's')).reason, 'disabled')
  assert.equal(linux.calls.length, 0)
})

await test("sound: 'default' puts the operator's own alert sound on the banner", async () => {
  const { runtime, calls } = makeRuntime({ config: {}, present: [BLOW, '/System/Library/Sounds/Blow.aiff'] })
  await runtime.notify('question', { title: 'T', subtitle: '', body: 'B' }, 's')
  assert.equal(osascriptBanner(osascriptCalls(calls)[0]).sound, 'Blow')
  assert.equal(soundCalls(calls).length, 0, 'a built-in sound needs no afplay beside it')
  assert.equal(runtime.alertSound(), BLOW)
})

await test("sound: 'default' falls back to the standard alert when the preference is unreadable", async () => {
  const { runtime, calls } = makeRuntime({
    config: {},
    present: [plugin.FALLBACK_ALERT_SOUND],
    responder: (call) => (call.file === '/usr/bin/defaults' ? { error: 'no such key' } : {}),
  })
  await runtime.notify('question', { title: 'T', subtitle: '', body: 'B' }, 's')
  assert.equal(osascriptBanner(osascriptCalls(calls)[0]).sound, 'Glass')
  assert.equal(runtime.alertSound(), plugin.FALLBACK_ALERT_SOUND)
})

await test("sound: 'default' plays a custom user sound through afplay instead", async () => {
  const custom = '/Users/someone/Library/Sounds/Custom.aiff'
  const { runtime, calls } = makeRuntime({
    config: {},
    present: [custom],
    responder: (call) => (call.file === '/usr/bin/defaults' ? { stdout: `${custom}\n` } : {}),
  })
  await runtime.notify('question', { title: 'T', subtitle: '', body: 'B' }, 's')
  assert.equal(osascriptBanner(osascriptCalls(calls)[0]).sound, '', 'a user sound has no system name')
  assert.deepEqual(soundCalls(calls)[0].args, [custom])
})

await test('a named sound rides on the banner and skips afplay', async () => {
  const { runtime, calls } = makeRuntime({ config: { sound: 'Ping' } })
  await runtime.notify('question', { title: 'T', subtitle: '', body: 'B' }, 's')
  assert.equal(soundCalls(calls).length, 0)
  assert.equal(osascriptBanner(osascriptCalls(calls)[0]).sound, 'Ping')
})

await test("sound: 'off' is silent on both channels", async () => {
  const { runtime, calls } = makeRuntime({ config: { sound: 'off' } })
  await runtime.notify('question', { title: 'T', subtitle: '', body: 'B' }, 's')
  assert.equal(soundCalls(calls).length, 0)
  assert.equal(osascriptBanner(osascriptCalls(calls)[0]).sound, '')
})

await test('a clickable notifier turns the banner into a jump back to DSH', async () => {
  const { runtime, calls } = makeRuntime({
    config: {},
    present: [NOTIFIER, HELPER, BLOW],
    webServer: { port: 3080 },
  })
  await runtime.notify('question', { title: 'T', subtitle: '', body: 'B' }, 's')
  const [call] = notifierCalls(calls)
  assert.ok(call, 'terminal-notifier is the backend when it is installed')
  assert.equal(osascriptCalls(calls).length, 0)
  const parsed = flags(call.args)
  assert.ok(parsed['-execute'].includes(HELPER))
  assert.ok(parsed['-execute'].includes('http://127.0.0.1:3080'))
  assert.ok(parsed['-execute'].startsWith(plugin.shellQuote(process.execPath)))
})

await test('the click target comes from config, then the served port, then the env', async () => {
  const configured = makeRuntime({ config: { url: 'https://dsh.example/s' }, webServer: { port: 9 } })
  assert.equal(configured.runtime.targetUrl(), 'https://dsh.example/s')

  const served = makeRuntime({ config: {}, webServer: { port: 4321 }, env: { DSH_WEB_URL: 'http://x/' } })
  assert.equal(served.runtime.targetUrl(), 'http://127.0.0.1:4321')

  const fromEnv = makeRuntime({ config: {}, env: { DSH_WEB_URL: 'http://127.0.0.1:9999' } })
  assert.equal(fromEnv.runtime.targetUrl(), 'http://127.0.0.1:9999')

  const nowhere = makeRuntime({ config: {} })
  assert.equal(nowhere.runtime.targetUrl(), '')
})

await test('onClick picks focus, open, or no action', async () => {
  const focus = makeRuntime({ config: {}, present: [NOTIFIER, HELPER], webServer: { port: 3080 } })
  assert.equal(focus.runtime.clickFor().mode, 'focus')

  const open = makeRuntime({ config: { onClick: 'open' }, present: [NOTIFIER], webServer: { port: 3080 } })
  focus.present.add(HELPER)
  assert.equal(open.runtime.clickFor().mode, 'open')
  await open.runtime.notify('question', { title: 'T', subtitle: '', body: 'B' }, 's')
  assert.equal(flags(notifierCalls(open.calls)[0].args)['-open'], 'http://127.0.0.1:3080')

  const none = makeRuntime({ config: { onClick: 'none' }, present: [NOTIFIER], webServer: { port: 3080 } })
  assert.equal(none.runtime.clickFor().mode, 'none')

  const noUrl = makeRuntime({ config: {}, present: [NOTIFIER, HELPER] })
  assert.equal(noUrl.runtime.clickFor().mode, 'none', 'nothing to jump to without a URL')
})

await test('a missing click helper downgrades focus to opening the URL', async () => {
  const { runtime } = makeRuntime({ config: {}, present: [NOTIFIER], webServer: { port: 3080 } })
  const click = runtime.clickFor()
  assert.equal(click.mode, 'open')
  assert.equal(click.url, 'http://127.0.0.1:3080')
})

await test('requesting terminal-notifier without it installed falls back to osascript', async () => {
  const { runtime, calls } = makeRuntime({ config: { notifier: 'terminal-notifier' }, webServer: { port: 3080 } })
  assert.equal(runtime.backend().kind, 'osascript')
  await runtime.notify('question', { title: 'T', subtitle: '', body: 'B' }, 's')
  assert.equal(osascriptCalls(calls).length, 1)
  assert.equal(notifierCalls(calls).length, 0)
})

await test('an absent notifier is re-probed so a later install just starts working', async () => {
  const { runtime, present, clock } = makeRuntime({ config: {} })
  assert.equal(runtime.backend().kind, 'osascript')
  present.add(NOTIFIER)
  assert.equal(runtime.backend().kind, 'osascript', 'the miss is cached for the TTL')
  clock.at += 61_000
  assert.equal(runtime.backend().kind, 'terminal-notifier')
})

await test('dry-run mode delivers nothing and reports why', async () => {
  const { runtime, calls } = makeRuntime({ config: {}, env: { DSH_MAC_NOTIFY_DRY_RUN: '1' }, present: [BLOW] })
  const outcome = await runtime.notify('question', { title: 'T', subtitle: '', body: 'B' }, 's')
  assert.equal(outcome.delivered, true)
  assert.equal(outcome.reason, 'dry-run')
  assert.equal(calls.length, 0)
})

await test('the debug trace records deliveries, skips and failures', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-mac-notify-'))
  const log = join(directory, 'trace.jsonl')
  try {
    const { runtime } = makeRuntime({
      config: { sound: 'off' },
      env: { DSH_MAC_NOTIFY_LOG: log },
      responder: () => ({ error: 'notifier exploded' }),
    })
    await runtime.notify('question', { title: 'T', subtitle: '', body: 'B' }, 's')
    // A non-urgent kind inside the pacing gap is a skip, not a delivery.
    await runtime.notify('finish', { title: 'T2', subtitle: '', body: 'B2' }, 's')
    const lines = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.ok(lines.some((line) => line.event === 'deliver'))
    assert.ok(lines.some((line) => line.event === 'failure'))
    assert.ok(lines.some((line) => line.event === 'skip'))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

await test('a failing notifier is reported, not thrown', async () => {
  const { runtime } = makeRuntime({
    config: { sound: 'off' },
    responder: () => ({ error: 'nope' }),
  })
  const outcome = await runtime.notify('question', { title: 'T', subtitle: '', body: 'B' }, 's')
  assert.equal(outcome.delivered, false)
  assert.ok(runtime.state.failures.length >= 1)
  assert.equal(runtime.state.sent, 0)
})

await test('a listener never throws into the Host dispatch', async () => {
  const { runtime } = makeRuntime({ config: {} })
  assert.doesNotThrow(() => runtime.handlers.status(undefined))
  assert.doesNotThrow(() => runtime.handlers.status({ agent: { id: 's' }, status: 'paused' }))
  assert.doesNotThrow(() => runtime.handlers.error({}))
  assert.doesNotThrow(() => runtime.handlers.sessionEvent(undefined, undefined))
  assert.doesNotThrow(() => runtime.handlers.sessionEvent({ id: 's' }, { type: 'assistant/message' }))
  assert.doesNotThrow(() => runtime.handlers.sessionCreated({}))
  assert.doesNotThrow(() => runtime.handlers.sessionCreated(undefined))
  assert.doesNotThrow(() => runtime.handlers.sessionDisposed(undefined))
  assert.doesNotThrow(() => runtime.handlers.agentDisposed(undefined))
  assert.doesNotThrow(() => runtime.handlers.approval(undefined, () => Promise.resolve()))
})

/* ----------------------------------------------------------------- report */

let failures = 0
for (const [index, result] of results.entries()) {
  if (result.ok) continue
  failures += 1
  console.error(`FAIL ${index + 1}. ${result.name}\n     ${String(result.error?.message ?? result.error).split('\n').join('\n     ')}`)
}

const passed = results.length - failures
console.log(`${failures === 0 ? 'PASS' : 'FAIL'} ${passed}/${results.length} assertions`)
if (failures > 0) process.exit(1)
