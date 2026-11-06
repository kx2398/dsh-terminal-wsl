/**
 * `wsl` tool — one-shot commands inside the configured WSL distribution.
 *
 * Why a dedicated tool instead of telling the model to run `wsl.exe` through
 * `pwsh`: WSL cannot run at all under the default `workspace-write` policy,
 * because the Windows sandbox denies the named pipes the WSL service needs.
 * A persistent `terminal_open({ type: "wsl" })` cannot help either — the
 * escalation channel is per call and `allowed-once`, while the terminal
 * backend reads the session-level policy. This tool therefore asks for one
 * explicit `danger-full-access` approval (per call, through `ctx.approval` —
 * which the Auto Review preset can answer automatically), then runs the
 * command with argv-safe quoting so the model never has to detour into
 * PowerShell.
 *
 * Argument transport is base64 through `bash -lc`: the command text never has
 * to survive PowerShell quoting, and arbitrary quotes/newlines stay intact.
 */
import { isAbsolute, resolve } from 'node:path'

/** Cordis plugin name. */
export const name = 'wsl-tool'

/** Required services: tool registry, command executor, session working directory. */
export const inject = ['tools', 'shell', 'workingDirectory']

/** Default distribution when the row's config does not name one. */
const DEFAULT_DISTRO = 'kali-linux'
/** Default launcher path (the WSL system executable). */
const DEFAULT_WSL_PATH = 'C:\\Windows\\System32\\wsl.exe'
/** Default per-command wait, mirroring the shipped one-shot tools. */
const DEFAULT_TIMEOUT_MS = 120000
/** Default cap for one model-facing result. */
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024

/** Full-access mode is the only mode in which WSL can run at all. */
const FULL_ACCESS = 'danger-full-access'

/** Model-facing output rendering: the tool returns final text directly. */
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

/**
 * Escape one value for a PowerShell single-quoted string, which is also the
 * escape the launcher path receives.
 * @param {string} value - raw text.
 * @returns the escaped text without surrounding quotes.
 */
function pwshQuote(value) {
  return value.replace(/'/g, "''")
}

/**
 * Escape one value for a bash single-quoted string.
 * @param {string} value - raw text.
 * @returns the escaped text without surrounding quotes.
 */
function bashQuote(value) {
  return value.replace(/'/g, `'\\''`)
}

/**
 * Build the platform-shell command line that hands the script to bash inside
 * the distribution without exposing it to PowerShell parsing.
 * @param {object} options - resolved launcher settings.
 * @param {string} options.wslPath - launcher executable path.
 * @param {string} options.distro - distribution name.
 * @param {string} script - bash script text.
 * @returns the shell command string for `ctx.shell.execute`.
 */
function buildShellCommand({ wslPath, distro, script }) {
  const encoded = Buffer.from(script, 'utf8').toString('base64')
  // `exit $LASTEXITCODE` is required: the Windows shell executor otherwise
  // folds any nonzero native exit into 1, losing the Linux command's status.
  return `& '${pwshQuote(wslPath)}' -d '${pwshQuote(distro)}' -- bash -lc 'echo ${encoded} | base64 -d | bash'; exit $LASTEXITCODE`
}

/**
 * Bound one stream for the model-facing result.
 * @param {object} stream - `{ text, truncated }` from the shell result.
 * @param {number} maxBytes - byte cap.
 * @returns bounded text.
 */
function bounded(stream, maxBytes) {
  if (stream === undefined) return ''
  const text = stream.text ?? ''
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const buffer = Buffer.from(text, 'utf8')
  const tail = buffer.subarray(buffer.length - maxBytes).toString('utf8')
  return `[output truncated to the last ${maxBytes} bytes]\n${tail}`
}

/**
 * Render one settled shell result the way the shipped one-shot tools do.
 * @param {object} result - settled shell result.
 * @param {number} maxBytes - per-stream cap.
 * @returns model-facing text.
 */
function render(result, maxBytes) {
  const out = bounded(result.stdout, maxBytes)
  const err = bounded(result.stderr, maxBytes)
  let body = out
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${err}`
  }
  if (body.length === 0) body = '(no output)'
  const markers = []
  if (result.sandbox?.denied) markers.push(`[sandbox: file access denied under ${result.sandbox.mode} mode]`)
  if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs}ms]`)
  if (result.signal !== null && result.signal !== undefined) markers.push(`[killed by signal: ${result.signal}]`)
  else if (result.exitCode !== 0 && result.exitCode !== null) markers.push(`[exit code: ${result.exitCode}]`)
  if (markers.length === 0) return body
  if (!body.endsWith('\n')) body += '\n'
  return body + markers.join('\n')
}

/**
 * Register the `wsl` tool.
 * @param {object} ctx - Cordis context.
 * @param {object} config - row config: `distro`, `wslPath`, `timeoutMs`, `maxOutputBytes`.
 */
export function apply(ctx, config = {}) {
  const distro = typeof config.distro === 'string' && config.distro.length > 0 ? config.distro : DEFAULT_DISTRO
  const wslPath = typeof config.wslPath === 'string' && config.wslPath.length > 0 ? config.wslPath : DEFAULT_WSL_PATH
  const timeoutMs = Number.isSafeInteger(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS
  const maxOutputBytes = Number.isSafeInteger(config.maxOutputBytes) && config.maxOutputBytes > 0 ? config.maxOutputBytes : DEFAULT_MAX_OUTPUT_BYTES

  ctx.effect(() => ctx.tools.register({
    name: 'wsl',
    description:
      'Run one command inside the configured WSL Linux distribution (an interactive bash shell, not Windows). '
      + 'Linux paths, commands and package managers work. WSL cannot run under the default workspace-write policy, '
      + 'so this tool first asks the user for a single danger-full-access approval for this command; approve or reject '
      + 'it in the approval prompt. If approval is denied or unavailable, report that to the user and do not work '
      + 'around it with PowerShell.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        command: {
          type: 'string',
          description: 'The bash command to run in the WSL distribution. Use Linux/POSIX syntax and paths.',
        },
        workdir: {
          type: 'string',
          description: 'Working directory. A Windows path or a relative path resolves against the session workspace and is translated by WSL; a Linux path (starting with "/") is entered with `cd` inside the distribution.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Timeout in milliseconds; the command is killed on expiry. Defaults to the tool config.',
        },
      },
      required: ['command'],
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const script = typeof args.command === 'string' ? args.command : ''
      if (script.trim().length === 0) throw new Error('wsl: command must be a non-empty string')
      if (exec.signal?.aborted) throw Object.assign(new Error('tool call aborted'), { name: 'AbortError' })

      const sessionPolicy = ctx.get('sandboxPolicy')
      const standingPolicy = sessionPolicy === undefined
        ? undefined
        : sessionPolicy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
      const currentMode = standingPolicy?.mode

      let policy = standingPolicy
      if (currentMode !== undefined && currentMode !== FULL_ACCESS) {
        const approval = ctx.get('approval')
        if (approval === undefined) {
          throw new Error(
            'wsl: WSL requires danger-full-access, but this composition has no approval service to ask for it. '
            + 'Ask the user to switch the session to danger-full-access; do not fall back to PowerShell silently.',
          )
        }
        const oneLine = script.replace(/\s+/g, ' ').trim().slice(0, 120)
        const justification = `运行 WSL 命令需要完全访问（Windows 沙箱无法约束 Linux 子系统）：${oneLine}`
        let outcome
        try {
          outcome = await approval.request({
            agent: exec.agent,
            toolName: 'wsl',
            callId: exec.callId,
            reason: `escalate sandbox to ${FULL_ACCESS}: ${justification}`,
            displayReason: `允许本次操作使用 ${FULL_ACCESS} 权限：${justification}`,
            signal: exec.signal,
          })
        } catch (error) {
          throw new Error(`wsl: 权限申请失败（${error instanceof Error ? error.message : String(error)}）；请向用户说明，不要改用 PowerShell 绕路`)
        }
        if (outcome !== 'allowed-once') {
          throw new Error(
            `wsl: 权限申请未通过（${outcome ?? 'unknown'}）。WSL 无法在受限模式下运行；请向用户说明需要完全访问或改用 pwsh 工具，不要静默绕路。`,
          )
        }
        policy = { ...standingPolicy, mode: FULL_ACCESS }
      }

      const sessionCwd = exec.agent === undefined ? undefined : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      let spawnWorkdir = sessionCwd
      let effectiveScript = script
      if (typeof args.workdir === 'string' && args.workdir.length > 0) {
        if (args.workdir.startsWith('/')) {
          // A Linux path cannot be a Windows spawn cwd; enter it inside the distro instead.
          effectiveScript = `cd -- '${bashQuote(args.workdir)}' || exit 1\n${script}`
        } else {
          spawnWorkdir = isAbsolute(args.workdir) ? args.workdir : resolve(sessionCwd ?? process.cwd(), args.workdir)
        }
      }
      const requestedTimeout = Number.isSafeInteger(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : timeoutMs
      const dshEnv = ctx.get('shellEnv')?.collect(exec)

      const spec = ctx.shell.resolve({
        command: buildShellCommand({ wslPath, distro, script: effectiveScript }),
        ...(spawnWorkdir === undefined ? {} : { workdir: spawnWorkdir }),
        timeoutMs: requestedTimeout,
        ...(dshEnv === undefined ? {} : { dshEnv }),
        ...(policy === undefined ? {} : { sandboxPolicy: policy }),
        signal: exec.signal,
      })
      const result = await (await ctx.shell.execute(spec)).result()
      if (result.aborted) throw Object.assign(new Error('tool call aborted'), { name: 'AbortError' })
      return render(result, maxOutputBytes)
    },
  }), 'wsl-tool')
}
