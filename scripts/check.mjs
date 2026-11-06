#!/usr/bin/env node
/**
 * Bundle self-check: verifies that this bundle's override still reproduces the
 * shipped terminal group and appends exactly the WSL backend.
 *
 * Usage (from the package directory, with a profile-launched shell):
 *   node scripts/check.mjs
 *
 * `js-yaml` is resolved from the DSH profile (`$DSH_PROFILE_DIR/node_modules`);
 * when that is unavailable the script falls back to a structural text check.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)
const upstreamFile = join(root, 'docs', 'upstream-terminal-bundle.patch.yml')
const oursFile = join(root, 'cordis.patch.yml')

/** Minimal YAML loader: js-yaml with a pass-through `!!js` scalar type. */
function loadYaml() {
  const profileDir = process.env.DSH_PROFILE_DIR
  if (!profileDir) return undefined
  try {
    const require = createRequire(join(profileDir, 'package.json'))
    const yaml = require('js-yaml')
    const jsType = new yaml.Type('tag:yaml.org,2002:js', {
      kind: 'scalar',
      resolve: (data) => typeof data === 'string' && data.length > 0,
      construct: (data) => `!!js ${data}`,
    })
    const schema = yaml.DEFAULT_SCHEMA.extend([jsType])
    return (file) => yaml.load(readFileSync(file, 'utf8'), { schema })
  } catch {
    return undefined
  }
}

const problems = []
const ok = (m) => console.log('PASS  ' + m)
const bad = (m) => {
  problems.push(m)
  console.log('FAIL  ' + m)
}

const load = loadYaml()
if (load === undefined) {
  console.log('NOTE  js-yaml unavailable (set DSH_PROFILE_DIR); using text checks only')
  const upstream = readFileSync(upstreamFile, 'utf8')
  const ours = readFileSync(oursFile, 'utf8')
  for (const id of ['optional-terminal-registry', 'optional-terminal-bash', 'optional-terminal-pwsh', 'optional-tool-terminal'])
    ours.includes(`id: ${id}`) ? ok(`child present: ${id}`) : bad(`child missing: ${id}`)
  ours.includes('id: optional-terminal-wsl') ? ok('wsl child present') : bad('wsl child missing')
  upstream.includes('isolate') && ours.includes('isolate') ? ok('isolate preserved') : bad('isolate missing')
  process.exit(problems.length === 0 ? 0 : 1)
}

const shippedGroup = load(upstreamFile)[0].insert[0]
const ours = load(oursFile)
const group = ours.find((entry) => entry.id === 'optional-persistent-terminals')
if (group === undefined) {
  bad('no override entry for optional-persistent-terminals')
  process.exit(1)
}

for (const key of ['name', 'group', 'isolate'])
  JSON.stringify(group[key]) === JSON.stringify(shippedGroup[key])
    ? ok(`group.${key} matches upstream`)
    : bad(`group.${key} differs from upstream`)

const shippedChildren = shippedGroup.config
const ourChildren = group.config
if (ourChildren.length !== shippedChildren.length + 1)
  bad(`child count ${ourChildren.length}, expected ${shippedChildren.length + 1}`)
shippedChildren.forEach((child, index) => {
  const ours = ourChildren[index]
  if (ours === undefined) return bad('missing upstream child #' + index + ' ' + child.id)
  JSON.stringify(child) === JSON.stringify(ours)
    ? ok('upstream child preserved: ' + child.id)
    : bad('upstream child changed: ' + child.id)
})

const wsl = ourChildren.find((child) => child.id === 'optional-terminal-wsl')
if (wsl === undefined) bad('wsl child missing')
else {
  wsl.config?.backendType === 'wsl' ? ok('backendType=wsl') : bad('backendType mismatch')
  wsl.config?.shellDialect === 'bash' ? ok('shellDialect=bash') : bad('shellDialect mismatch')
  wsl.config?.shellPath === 'C:\\Windows\\System32\\wsl.exe' ? ok('shellPath=wsl.exe') : bad('shellPath mismatch')
  const args = wsl.config?.shellArgs ?? []
  args.find((a) => a.startsWith('PS1=')) === 'PS1=dsh> ' ? ok('PS1 marker arg') : bad('PS1 marker arg changed')
  args.find((a) => a.startsWith('PROMPT_COMMAND=')) === "PROMPT_COMMAND=printf \"\\033]133;D;%s\\007\" \"$?\"; PS1='dsh> '"
    ? ok('PROMPT_COMMAND marker arg')
    : bad('PROMPT_COMMAND marker arg changed')
  for (const expected of ['TERM=dumb', 'PAGER=cat', 'GIT_PAGER=cat'])
    args.includes(expected) ? ok(`env parity: ${expected}`) : bad(`missing env parity arg: ${expected}`)
}

console.log('\n' + (problems.length === 0 ? 'ALL CHECKS PASSED' : `${problems.length} PROBLEM(S)\n- ` + problems.join('\n- ')))
process.exit(problems.length === 0 ? 0 : 1)
