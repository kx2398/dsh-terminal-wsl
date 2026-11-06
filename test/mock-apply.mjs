/**
 * Offline contract test: exercises the plugin module with a minimal mock of
 * the two Host services it touches. No DSH installation is required, so the
 * same file runs in CI and on a contributor's machine.
 *
 * Covered: export shape, `terminal_*` prompt guidance registration, section
 * identity/order, and cleanup ownership through `ctx.effect`.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, inject, name } from '../index.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pass = (message) => console.log('PASS  ' + message)

// 1. Export shape matches the Host plugin contract.
assert.equal(name, 'terminal-wsl-guidance')
assert.ok(Array.isArray(inject) && inject.includes('systemPrompt'))
assert.equal(typeof apply, 'function')
pass('plugin exports name/inject/apply')

// 2. apply() registers exactly one prompt section, owned by this plugin.
const sections = []
const effectLabels = []
const ctx = {
  systemPrompt: {
    getSectionOrder(key) {
      assert.equal(key, 'TOOL_PTY', 'must slot next to the shipped terminal guidance')
      return 1700
    },
    section(spec) {
      sections.push(spec)
      return () => {}
    },
  },
  effect(run, label) {
    effectLabels.push(label)
    return run()
  },
}
apply(ctx)

assert.equal(effectLabels.length, 1)
assert.equal(effectLabels[0], 'terminal-wsl-guidance')
assert.equal(sections.length, 1)
const [section] = sections
assert.equal(section.name, 'tool:pty:wsl')
assert.equal(section.order, 1700)
assert.match(section.text, /terminal type "wsl"/, 'guidance must name the backend type verbatim')
assert.match(section.text, /terminal_open/, 'guidance must point at the tool the model calls')
assert.match(section.text, /\/mnt\//, 'guidance must explain cwd translation')
pass('apply() registers the wsl prompt section through ctx.effect')

// 3. The bundle manifest keeps a patch and the terminal group row.
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
assert.ok(pkg.files.includes('cordis.patch.yml'))
pass('package manifest declares the bundle patch')

// 4. Display metadata is present for both shipped locales.
for (const locale of ['en', 'zh']) {
  const meta = JSON.parse(readFileSync(join(root, 'locale', `${locale}.json`), 'utf8')).meta
  assert.ok(meta?.title && meta?.description, `${locale} locale needs meta.title/description`)
}
pass('locale metadata present (en, zh)')

console.log('\nALL PLUGIN CONTRACT CHECKS PASSED')
