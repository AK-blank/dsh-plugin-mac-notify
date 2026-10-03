#!/usr/bin/env node
/**
 * Submit this plugin to the `awesome-dsh-plugin` catalog.
 *
 * Usage:
 *   node scripts/submit-catalog.mjs [--dry-run] [--force]
 *
 * The catalog wants exactly one new file, `data/plugins/<owner>__<repo>.yml`,
 * in a pull request based on a **fresh** upstream `main` (its CI fails a PR
 * that deletes entries, which is what a stale fork looks like). This script
 * does that and nothing else: it never force-pushes, never touches an existing
 * pull request, and is safe to re-run — a second run reports the pull request
 * it already opened instead of opening another.
 *
 * `contrib/AK-blank__dsh-plugin-mac-notify.yml` in this repository is the
 * single source of truth for the entry; the script copies it verbatim.
 *
 * Requirements this script checks before it submits anything:
 *   - the repository is at least 1 day old (the catalog's `MIN_AGE_DAYS`);
 *     exit code 3 means "too young, run me later" and is not a failure
 *   - `gh` is authenticated for the account that owns the plugin repository
 *
 * Exit codes: 0 submitted / already present, 3 too young, 1 anything else.
 *
 * GitHub's Git Data API is used for the commit because some networks reach
 * `api.github.com` but not `github.com:443`; `gh api` only needs the former.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const OWNER = 'AK-blank'
const PLUGIN_REPO = 'dsh-plugin-mac-notify'
const CATALOG = 'awesome-dsh-plugin/awesome-dsh-plugin'
const ENTRY_PATH = `data/plugins/${OWNER}__${PLUGIN_REPO}.yml`
const BRANCH = `add-${PLUGIN_REPO}`
const CONTRIB = fileURLToPath(new URL('../contrib/AK-blank__dsh-plugin-mac-notify.yml', import.meta.url))

const MIN_AGE_DAYS = 1
const CATEGORIES = new Set([
  'agi', 'ui', 'usage', 'theme', 'model', 'identity', 'session', 'memory', 'tools', 'wsl',
  'browser', 'vision', 'voice', 'docs', 'skill', 'workflow', 'git', 'notify', 'dev',
  'security', 'remote', 'market', 'fun',
])

const argv = new Set(process.argv.slice(2))
const dryRun = argv.has('--dry-run')
const force = argv.has('--force')

/** Run `gh api`, returning parsed JSON; `null` on 404 and on empty bodies. */
function api(args, { allow404 = false } = {}) {
  try {
    const out = execFileSync('gh', ['api', ...args], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      // Captured rather than inherited, so an expected 404 probe stays quiet.
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return out.trim() ? JSON.parse(out) : {}
  } catch (error) {
    const text = `${error.stdout ?? ''}${error.stderr ?? ''}`
    if (allow404 && /HTTP 404|Not Found/.test(text)) return null
    throw new Error(`gh api ${args.join(' ')} failed: ${text.trim().split('\n').slice(-2).join(' ')}`)
  }
}

/** POST/PUT/PATCH with a JSON body through stdin. */
function apiWrite(method, path, body) {
  const out = execFileSync('gh', ['api', '-X', method, path, '--input', '-'], {
    input: JSON.stringify(body),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  return out.trim() ? JSON.parse(out) : {}
}

/** Read and structurally validate the entry we are about to submit. */
function readEntry() {
  const raw = readFileSync(CONTRIB, 'utf8')
  const field = (name) => raw.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1]?.trim().replace(/^['"]|['"]$/g, '')
  const url = field('url')
  const name = field('name')
  const category = field('category')
  const en = raw.match(/^\s{2}en:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '')

  const problems = []
  if (url !== `https://github.com/${OWNER}/${PLUGIN_REPO}`) problems.push(`url must be the repository exactly (got ${url})`)
  if (name !== `${OWNER}/${PLUGIN_REPO}`) problems.push(`name must be ${OWNER}/${PLUGIN_REPO} (got ${name})`)
  if (!CATEGORIES.has(category)) problems.push(`category ${category} is not in the catalog's list`)
  if (!en) problems.push('description.en is required')
  else if (!en.endsWith('.')) problems.push('description.en must end with a period')
  // The catalog's parser treats `": "` inside an unquoted scalar as a nested
  // key; quoting is the fix its contributing guide asks for. Test the VALUE,
  // not the whole line — `en:` itself carries the `": "` a naive check trips on.
  for (const line of raw.split('\n')) {
    const value = line.match(/^\s{2}(?:en|zh):\s*(.*)$/)?.[1]
    if (value === undefined) continue
    if (!/^['"]/.test(value) && value.includes(': ')) {
      problems.push(`quote this description value, it contains ": ": ${line.trim()}`)
    }
  }
  if (problems.length) {
    console.error('entry file is not submittable:')
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  return { raw, url, category }
}

/** Refuse to submit before the catalog's age floor; exit 3 means "try later". */
function checkAge(createdAt) {
  const ageDays = (Date.now() - new Date(createdAt).getTime()) / 86_400_000
  if (ageDays >= MIN_AGE_DAYS || force) return ageDays
  const hours = Math.ceil((MIN_AGE_DAYS - ageDays) * 24)
  console.log(`too young: repository is ${ageDays.toFixed(2)} days old, the catalog needs ${MIN_AGE_DAYS}`)
  console.log(`earliest valid submission: ${new Date(new Date(createdAt).getTime() + 86_400_000).toISOString()}`)
  console.log(`(about ${hours}h from now — re-run this script then)`)
  process.exit(3)
}

async function main() {
  const entry = readEntry()
  console.log(`entry      : ${ENTRY_PATH} (category: ${entry.category})`)

  const repo = api([`repos/${OWNER}/${PLUGIN_REPO}`])
  const ageDays = checkAge(repo.created_at)
  console.log(`plugin repo: ${repo.full_name} — ${ageDays.toFixed(2)} days old`)

  // Already merged?
  const existing = api([`repos/${CATALOG}/contents/${ENTRY_PATH}`], { allow404: true })
  if (existing && !dryRun) {
    console.log(`already listed: https://github.com/${CATALOG}/blob/main/${ENTRY_PATH}`)
    return
  }

  const upstream = api([`repos/${CATALOG}`])
  const base = upstream.default_branch

  // Already open?
  const open = api([`repos/${CATALOG}/pulls?head=${OWNER}:${BRANCH}&state=open`])
  if (Array.isArray(open) && open.length > 0) {
    console.log(`pull request already open: ${open[0].html_url}`)
    return
  }

  if (dryRun) {
    console.log(`[dry-run] would fork ${CATALOG}, sync ${base}, add ${ENTRY_PATH} on ${BRANCH}, and open a pull request`)
    return
  }

  // A fork of the catalog, kept in step with upstream `main` (its CI rejects a
  // PR that looks like a stale fork).
  let fork = api([`repos/${OWNER}/${CATALOG.split('/')[1]}`], { allow404: true })
  if (!fork) {
    console.log(`forking ${CATALOG} ...`)
    apiWrite('POST', `repos/${CATALOG}/forks`, { default_branch_only: true })
    for (let attempt = 0; attempt < 30 && !fork; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      fork = api([`repos/${OWNER}/${CATALOG.split('/')[1]}`], { allow404: true })
    }
    if (!fork) throw new Error('fork did not appear within 60s')
  }
  console.log(`fork       : ${fork.full_name}`)

  // A fresh fork is already in step; a conflict here is not fatal, because the
  // branch below is created from the fork's own base either way.
  try {
    apiWrite('POST', `repos/${fork.full_name}/merge-upstream`, { branch: base })
  } catch (error) {
    console.log(`note: could not fast-forward the fork (${error.message}) — continuing`)
  }
  const head = api([`repos/${fork.full_name}/git/ref/heads/${base}`]).object.sha
  console.log(`base       : ${base} @ ${head.slice(0, 8)}`)

  // Re-runnable: drop a leftover branch from an earlier attempt.
  const stale = api([`repos/${fork.full_name}/git/ref/heads/${BRANCH}`], { allow404: true })
  if (stale) {
    api(['-X', 'DELETE', `repos/${fork.full_name}/git/refs/heads/${BRANCH}`])
    console.log(`removed stale branch ${BRANCH}`)
  }
  apiWrite('POST', `repos/${fork.full_name}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: head })

  apiWrite('PUT', `repos/${fork.full_name}/contents/${ENTRY_PATH}`, {
    message: `Add ${OWNER}/${PLUGIN_REPO} to the list`,
    content: Buffer.from(entry.raw, 'utf8').toString('base64'),
    branch: BRANCH,
  })
  console.log(`added      : ${ENTRY_PATH}`)

  const pr = apiWrite('POST', `repos/${CATALOG}/pulls`, {
    title: `Add ${OWNER}/${PLUGIN_REPO}`,
    head: `${OWNER}:${BRANCH}`,
    base,
    body: [
      `Adds \`${OWNER}/${PLUGIN_REPO}\` under \`${entry.category}\`.`,
      '',
      `- \`package.json\` declares \`dsh.bundle.patch\` → \`./cordis.patch.yml\``,
      `- repository: ${entry.url}`,
      '- no dependencies, no build step, `node selftest.mjs` covers the logic offline',
      '',
      'The entry file is copied from the repository\'s `contrib/` directory, which is its source of truth.',
    ].join('\n'),
  })
  console.log(`\npull request: ${pr.html_url}`)
}

main().catch((error) => {
  console.error(`submission failed: ${error.message}`)
  process.exit(1)
})
