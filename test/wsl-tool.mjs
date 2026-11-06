/**
 * Offline contract test for the `wsl` tool: no DSH, no WSL, no network.
 *
 * Asserts the permission choreography (approval only when the session is
 * restricted, one request, `allowed-once` required), the base64 argument
 * transport, Linux workdir handling, and result rendering.
 */
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'

import { apply } from '../wsl-tool.js'

const pass = (message) => console.log('PASS  ' + message)

/** Relative fixture workspace: keeps the source free of machine absolute paths. */
const WORKSPACE = join('fixtures', 'workspace')

/**
 * Build a mock Cordis context and capture the registered tool.
 * @param {object} options - `mode` for the session policy, `approvalOutcome`, `result` override.
 * @returns the captured tool plus its call harness.
 */
function makeHarness(options = {}) {
  const approvals = []
  const registrations = []
  const effects = []
  let lastSpec
  const services = {
    sandboxPolicy: {
      resolve: () => ({ mode: options.mode ?? 'workspace-write' }),
    },
    approval: options.noApproval === true
      ? undefined
      : {
        request: async (request) => {
          approvals.push(request)
          return options.approvalOutcome ?? 'allowed-once'
        },
      },
    shellEnv: { collect: () => ({ DSH_SESSION_ID: 'test-session' }) },
  }
  const ctx = {
    effect(run, label) {
      effects.push(label)
      return run()
    },
    get(name) {
      return services[name]
    },
    tools: {
      register(tool) {
        registrations.push(tool)
        return () => {}
      },
    },
    shell: {
      sandboxMode: 'workspace-write',
      resolve: (spec) => spec,
      execute: async (spec) => {
        lastSpec = spec
        const result = options.result ?? {
          stdout: { text: 'hello\n', truncated: false },
          stderr: { text: '', truncated: false },
          exitCode: 0,
          signal: null,
          timedOut: false,
          aborted: false,
          timeoutMs: spec.timeoutMs,
        }
        return { result: async () => result }
      },
    },
    workingDirectory: {
      ensure: async () => WORKSPACE,
    },
  }
  apply(ctx, options.config ?? {})
  assert.equal(registrations.length, 1, 'exactly one tool is registered')
  return {
    tool: registrations[0],
    approvals,
    effects,
    spec: () => lastSpec,
    exec: {
      agent: { session: {} },
      callId: 'call-1',
      signal: new AbortController().signal,
    },
  }
}

/** Decode the bash script embedded in the platform-shell command line. */
function embeddedScript(command) {
  const match = command.match(/echo ([A-Za-z0-9+/=]+) \| base64 -d \| bash/)
  assert.ok(match, `base64 transport missing from: ${command}`)
  return Buffer.from(match[1], 'base64').toString('utf8')
}

// 1. Export shape.
assert.equal(typeof apply, 'function')
pass('wsl-tool exports apply')

// 2. Restricted session: one approval, then one-shot full access.
{
  const harness = makeHarness({ mode: 'workspace-write' })
  assert.equal(harness.effects[0], 'wsl-tool')
  const text = await harness.tool.execute({ command: 'echo hi' }, harness.exec)
  assert.equal(harness.approvals.length, 1, 'one approval request')
  const request = harness.approvals[0]
  assert.equal(request.toolName, 'wsl')
  assert.equal(request.callId, 'call-1')
  assert.match(request.reason, /danger-full-access/)
  assert.match(request.displayReason, /danger-full-access/)
  assert.match(request.displayReason, /echo hi/)
  assert.equal(harness.spec().sandboxPolicy.mode, 'danger-full-access')
  assert.equal(embeddedScript(harness.spec().command), 'echo hi')
  assert.match(harness.spec().command, /-d 'kali-linux'/)
  assert.equal(text, 'hello\n')
  pass('restricted mode asks once and runs with one-shot full access')
}

// 2b. The Linux exit status must survive the Windows shell executor.
{
  const harness = makeHarness({ mode: 'danger-full-access' })
  await harness.tool.execute({ command: 'exit 7' }, harness.exec)
  assert.match(harness.spec().command, /; exit \$LASTEXITCODE$/)
  pass('shell command propagates the Linux exit status')
}

// 3. Already full access: no approval, policy stays as resolved.
{
  const harness = makeHarness({ mode: 'danger-full-access' })
  await harness.tool.execute({ command: 'uname -s' }, harness.exec)
  assert.equal(harness.approvals.length, 0, 'no approval under full access')
  assert.equal(harness.spec().sandboxPolicy.mode, 'danger-full-access')
  pass('full-access session runs without an approval prompt')
}

// 4. Rejected approval fails closed with actionable text.
{
  const harness = makeHarness({ mode: 'workspace-write', approvalOutcome: 'rejected' })
  await assert.rejects(
    () => harness.tool.execute({ command: 'ls' }, harness.exec),
    /权限申请未通过/,
  )
  pass('rejected approval fails closed')
}

// 5. Missing approval service: fail closed, tell the model to ask the user.
{
  const harness = makeHarness({ mode: 'workspace-write', noApproval: true })
  await assert.rejects(
    () => harness.tool.execute({ command: 'ls' }, harness.exec),
    /no approval service/,
  )
  pass('missing approval service fails closed')
}

// 6. Linux absolute workdir is entered inside the distribution.
{
  const harness = makeHarness({ mode: 'danger-full-access' })
  await harness.tool.execute({ command: 'pwd', workdir: '/fixture/home' }, harness.exec)
  assert.equal(embeddedScript(harness.spec().command), "cd -- '/fixture/home' || exit 1\npwd")
  pass('linux workdir becomes a cd inside the distribution')
}

// 7. Relative workdir resolves against the session workspace.
{
  const harness = makeHarness({ mode: 'danger-full-access' })
  await harness.tool.execute({ command: 'pwd', workdir: 'sub/dir' }, harness.exec)
  assert.equal(harness.spec().workdir, resolve(WORKSPACE, 'sub/dir'))
  pass('relative workdir resolves against the session workspace')
}

// 8. Explicit config overrides distro and timeout.
{
  const harness = makeHarness({
    mode: 'workspace-write',
    config: { distro: 'Ubuntu-24.04', timeoutMs: 15000 },
  })
  await harness.tool.execute({ command: 'echo x' }, harness.exec)
  assert.match(harness.spec().command, /-d 'Ubuntu-24\.04'/)
  assert.equal(harness.spec().timeoutMs, 15000)
  pass('row config overrides distro and timeout')
}

// 9. Rendering: non-zero exit, timeout and abort markers.
{
  const nonzero = makeHarness({
    mode: 'danger-full-access',
    result: {
      stdout: { text: '', truncated: false },
      stderr: { text: 'boom\n', truncated: false },
      exitCode: 3,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: 120000,
    },
  })
  const text = await nonzero.tool.execute({ command: 'false' }, nonzero.exec)
  assert.match(text, /\[stderr\]\nboom/)
  assert.match(text, /\[exit code: 3\]/)
  pass('non-zero exit renders stderr and exit marker')

  const timedOut = makeHarness({
    mode: 'danger-full-access',
    result: {
      stdout: { text: '', truncated: false },
      stderr: { text: '', truncated: false },
      exitCode: null,
      signal: null,
      timedOut: true,
      aborted: false,
      timeoutMs: 500,
    },
  })
  const timedOutText = await timedOut.tool.execute({ command: 'sleep 9', timeoutMs: 500 }, timedOut.exec)
  assert.match(timedOutText, /\[timed out after 500ms\]/)
  pass('timeout marker renders')
}

// 10. Empty command is rejected before any approval or spawn.
{
  const harness = makeHarness({ mode: 'workspace-write' })
  await assert.rejects(() => harness.tool.execute({ command: '   ' }, harness.exec), /non-empty/)
  assert.equal(harness.approvals.length, 0)
  pass('empty command rejected before approval')
}

console.log('\nALL WSL TOOL CHECKS PASSED')
