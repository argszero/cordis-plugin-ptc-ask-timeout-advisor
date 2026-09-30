/**
 * What is *published*, not what the tests happen to import.
 *
 * Three classes of claim live here, all of which can be false while every
 * behavioural suite stays green:
 *
 * 1. **The manifest.** A missing `dsh.bundle.patch`, a stray runtime dependency,
 *    or a `files` list that omits the patch turns a working checkout into a
 *    broken install.
 * 2. **The peer range.** `node-semver` decides what a range admits, and
 *    prerelease semantics make the intuitive reading wrong — `<0.2.0` does not
 *    admit the `0.2.0-rc.*` builds, and a lower bound with a prerelease suffix
 *    does not admit earlier builds of the same tuple. So the guard computes the
 *    *admitted set* and requires it to equal the versions this package was
 *    actually run against — an over-wide claim fails exactly as loudly as an
 *    over-narrow one. (Asserting the range *string* would be a guard that cannot
 *    fail, which is worse than no guard.)
 * 3. **The sentences this plugin keys on.** The advisory quotes the harness's own
 *    wording to the model, and the plugin decides by matching codes and one
 *    sentence. Those literals are read out of the published bundles here, so if
 *    upstream rewords one, this suite fails *before* the plugin silently stops
 *    matching.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import semver from 'semver'

import * as plugin from '../lib/index.js'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')

/**
 * Every published version of the two peer packages, as of 2026-09-30
 * (`npm view @deepseek-ai/dsh-llm versions --json`). A frozen snapshot is the
 * point: the admitted set is computed against what was published when the claim
 * was made, and refreshing the snapshot is a deliberate act.
 */
const PUBLISHED = [
  '0.0.1-rc.2', '0.0.1-rc.3', '0.0.1-rc.5',
  '0.1.0-rc.2', '0.1.0-rc.3', '0.1.0-rc.6', '0.1.0-rc.7', '0.1.0-rc.8',
  '0.1.1-rc.1', '0.1.1-rc.2',
  '0.1.2-alpha.2', '0.1.2-alpha.3', '0.1.2-alpha.4', '0.1.2-alpha.5', '0.1.2-rc.1',
  '0.1.3-alpha.2',
  '0.1.5-alpha.1', '0.1.5-alpha.2', '0.1.5-rc.1', '0.1.5-rc.2', '0.1.5-rc.3',
  '0.1.6-alpha.1', '0.1.6-alpha.2',
  '0.1.7-alpha.1', '0.1.7-alpha.2', '0.1.7-rc.1', '0.1.7-rc.2',
  '0.2.0-rc.1', '0.2.0-rc.2',
]

/** The versions `scripts/probe-lines.mjs` runs the suite against, one per `||` segment. */
const PROBED = ['0.1.7-rc.2', '0.2.0-rc.2']

/** Every version the range is allowed to admit — exactly the two 0.1.7 and 0.2.0 tuples. */
const SUPPORTED = [
  '0.1.7-alpha.1', '0.1.7-alpha.2', '0.1.7-rc.1', '0.1.7-rc.2',
  '0.2.0-rc.1', '0.2.0-rc.2',
]

/** The file a peer package publishes, resolved through the manifest's own dependency. */
function bundleOf(packageName) {
  return readFileSync(require.resolve(packageName), 'utf8')
}

test('the plugin publishes the shape a Cordis loader mounts', async () => {
  assert.equal(plugin.name, 'ptc-ask-timeout-advisor')
  assert.deepEqual(plugin.inject, ['tools'])
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(typeof plugin.resolveConfig, 'function')
})

test('the manifest declares a bundle patch and no runtime dependencies', () => {
  assert.deepEqual(manifest.dependencies ?? {}, {}, 'a harness package must not be a runtime dependency')
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.ok(existsSync(join(ROOT, manifest.dsh.bundle.patch)), 'the declared patch exists')
  assert.equal(manifest.publishConfig?.access, 'public', 'a scoped package needs an explicit public access')
  assert.equal(manifest.type, 'module')
  assert.ok(existsSync(join(ROOT, manifest.main)), 'the emitted entry exists')
})

test('every file the package needs to ship is in `files`', () => {
  const files = manifest.files.map(entry => entry.replace(/^\.\//, ''))
  for (const entry of [manifest.dsh.bundle.patch.replace(/^\.\//, ''), 'README.md', 'LICENSE']) {
    assert.ok(files.includes(entry), `${entry} must be listed in files: ${JSON.stringify(files)}`)
  }
  assert.ok(files.includes('lib/**/*.js') && files.includes('lib/types/**/*.d.ts'))
})

test('the peer range admits exactly the versions this package was run against', () => {
  assert.deepEqual(
    Object.keys(manifest.peerDependencies).sort(),
    ['@deepseek-ai/cordis', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools'],
    'a peer the code does not import is a claim nobody can honour',
  )
  for (const name of ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools']) {
    const range = manifest.peerDependencies[name]
    // `includePrerelease` is NOT passed: npm does not pass it, and passing it
    // here would make this guard read a wider set than npm resolves.
    const admitted = PUBLISHED.filter(version => semver.satisfies(version, range))
    assert.deepEqual(admitted, SUPPORTED, `${name} admits ${admitted.join(', ')}`)
    for (const version of PROBED) {
      assert.ok(admitted.includes(version), `${name} must admit the probed line ${version}`)
    }
  }
})

test('the shapes this family has been burned by are still refused', () => {
  const range = manifest.peerDependencies['@deepseek-ai/dsh-tools']
  // A bare comparator is the empty set on a prerelease-only registry.
  for (const bad of ['>=0.1.7', '^0.1.7', '^0.2.0', '*']) {
    const admitted = PUBLISHED.filter(version => semver.satisfies(version, bad))
    assert.equal(admitted.length, 0, `${bad} must be the empty set (got ${admitted.join(', ')})`)
  }
  // A tuple-level lower bound must still admit the whole tuple: the boundary
  // build is `0.1.7-alpha.1`, and every later build of that tuple rides with it.
  for (const version of ['0.1.7-rc.1', '0.1.7-rc.2', '0.2.0-rc.1']) {
    assert.ok(semver.satisfies(version, range), `${version} must be admitted`)
  }
  // And the line before it must not slip in through a wide-looking upper bound.
  for (const version of ['0.1.6-alpha.2', '0.1.5-rc.3', '0.1.2-rc.1']) {
    assert.equal(semver.satisfies(version, range), false, `${version} must be refused`)
  }
})

test('the README quotes the shipped range verbatim', () => {
  // A documentation copy of a range is a claim nobody checks unless it is
  // checked mechanically — and plugins get written by copying a README.
  // Per package and on one line: both packages ship the same range today, so a
  // whole-file `includes` would let one correct bullet answer for a wrong one.
  for (const name of ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools']) {
    const range = manifest.peerDependencies[name]
    const line = readme.split('\n').find(entry => entry.includes(`\`${name}\``) && entry.includes(range))
    assert.ok(line !== undefined, `README must quote the ${name} range verbatim on its own line: ${range}`)
  }
})

test('the shipped `run_code` failure class is the code this plugin matches on', () => {
  const tools = bundleOf('@deepseek-ai/dsh-tools')
  assert.ok(tools.includes('CODE_RUN_FAILED'), 'the failure code the plugin matches is in the bundle')
  const { CodeRunFailedError } = require('@deepseek-ai/dsh-tools')
  const failure = new CodeRunFailedError('code run failed (timeout): execution deadline reached (120000ms)')
  assert.equal(failure.code, 'CODE_RUN_FAILED')
  assert.equal(failure.name, 'CodeRunFailedError')
})

test('the shipped runtime reports a deadline with the kind and sentence this plugin matches', () => {
  const runtime = bundleOf('@deepseek-ai/dsh-ptc-runtime-node')
  assert.ok(runtime.includes('execution deadline reached'), 'the deadline sentence is in the bundle')
  assert.ok(runtime.includes('kind: "timeout"'), 'the deadline kind is in the bundle')
  // The advisory quotes both budgets to the model, so both are read back out of
  // the shipped schema rather than trusted from this repository's prose.
  const budget = /timeoutMs: [^,]*?\.default\(([\d.e_]+)\)/.exec(runtime)
  const cap = /maxTimeoutMs: [^,]*?\.default\(([\d.e_]+)\)/.exec(runtime)
  assert.ok(budget !== null, 'the shipped default deadline is discoverable')
  assert.ok(cap !== null, 'the shipped cap is discoverable')
  assert.equal(Number(budget[1].replaceAll('_', '')), plugin.DEFAULT_BUDGET_MS)
  assert.equal(Number(cap[1].replaceAll('_', '')), plugin.MAX_BUDGET_MS)
})

test('the shipped ask stack aborts with the code and sentence this plugin matches', () => {
  const questions = bundleOf('@deepseek-ai/dsh-user-questions')
  assert.ok(questions.includes('ASK_ABORTED'), 'the abort code is in the bundle')
  assert.ok(
    questions.includes('ask_user_question was aborted before the user answered'),
    'the abort sentence the advisory quotes is in the bundle',
  )
})

test('the patch file only adds this plugin', () => {
  const patch = readFileSync(join(ROOT, manifest.dsh.bundle.patch), 'utf8')
  // The header is prose and may name the peer packages; the YAML body may not.
  const body = patch.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n')
  assert.match(body, /- insert:/)
  assert.match(body, /id: ptc-ask-timeout-advisor/)
  assert.match(body, /name: '@argszero\/cordis-plugin-ptc-ask-timeout-advisor'/)
  assert.equal(body.includes('@deepseek-ai/dsh-'), false, 'a patch that repoints harness rows is not an addition')
})
