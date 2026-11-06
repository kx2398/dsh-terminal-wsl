/**
 * WSL terminal bundle — model-facing guidance only.
 *
 * The actual capability is configuration: `cordis.patch.yml` extends the
 * shipped terminal scope with one more `@deepseek-ai/dsh-terminal-bash`
 * instance that launches `wsl.exe` instead of pwsh. The terminal tools
 * (`terminal_open` … `terminal_list`) already accept a backend type, but the
 * shipped schema only names `shell`, so this plugin adds one prompt section
 * so the model knows the `wsl` type exists.
 *
 * Host-only plugin: no imports, no build step.
 */

/** Cordis plugin name. */
export const name = 'terminal-wsl-guidance'

/** Required service: prompt-section registry. */
export const inject = ['systemPrompt']

/**
 * Prompt section text: states the registered backend type, what it runs, and
 * the two facts that differ from the Windows `shell` backend (POSIX tooling,
 * translated cwd).
 */
const GUIDANCE =
  'A WSL terminal backend is registered as terminal type "wsl": it runs an interactive bash shell inside the Windows Subsystem for Linux distribution configured for this profile (kali-linux by default), reached through the same terminal_* tools, e.g. terminal_open with type "wsl". Inside that session use Linux/POSIX paths and commands; the Windows session working directory is translated to its /mnt/<drive>/... equivalent, and processes started there run in the Linux subsystem, not on Windows.'

/**
 * Register the guidance section next to the shipped terminal guidance.
 * @param {object} ctx - Cordis context.
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'tool:pty:wsl',
        order: ctx.systemPrompt.getSectionOrder('TOOL_PTY'),
        text: GUIDANCE,
      }),
    'terminal-wsl-guidance',
  )
}
