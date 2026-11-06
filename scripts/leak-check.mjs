/**
 * Leak check: fails when a publishable file contains information that must not
 * be open-sourced — local absolute paths, user/home directories, credentials,
 * contact addresses, or private network addresses.
 *
 * Allowlisted: the Windows system path of the WSL launcher, which is part of
 * the plugin's configuration, not of anyone's environment.
 *
 * Runs offline with no dependencies; wired into `npm test` and CI.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/** Files/directories never published and therefore not scanned. */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist'])
const SKIP_EXT = new Set(['.tgz', '.png', '.jpg', '.jpeg', '.ico', '.webp', '.map'])

/** The WSL launcher's system path is configuration, not anyone's environment. */
const ALLOWED_NORMALIZED_PATH = 'c:\\windows\\system32\\wsl.exe'

/** This scanner's own source necessarily contains the patterns it looks for. */
const SELF = join('scripts', 'leak-check.mjs')

/** Token prefixes, assembled from parts so this scanner's source stays grep-clean. */
const CREDENTIAL_RE = new RegExp(
  '\\b(gh[pousr]_[A-Za-z0-9]{20,}|' + 'github' + '_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{16,})\\b',
)

const RULES = [
  {
    name: 'windows absolute path',
    test: (line) => {
      // Drop URL schemes (`https://`, `file://`, `git+https://`) so only real paths remain.
      const withoutUrls = line.replace(/\b[a-z][a-z0-9+.-]*:\/\//gi, '')
      const match = withoutUrls.match(/[A-Za-z]:[\\/][^\s'"`)]*/)
      if (match === null) return null
      // Sources spell the WSL launcher path with either one or two backslashes.
      const normalized = match[0].replace(/\\+/g, '\\').toLowerCase()
      return normalized.startsWith(ALLOWED_NORMALIZED_PATH) ? null : match[0]
    },
  },
  { name: 'user directory', test: (line) => /(^|[^A-Za-z])users[\\/][^\s'"`)]*/i.exec(line)?.[0] ?? null },
  { name: 'linux home directory', test: (line) => /\/home\/(?!<)[A-Za-z0-9._-]+/.exec(line)?.[0] ?? null },
  { name: 'wsl path into a user profile', test: (line) => /\/mnt\/[a-z]\/users\/[^\s'"`)]*/i.exec(line)?.[0] ?? null },
  { name: 'credential-like token', test: (line) => CREDENTIAL_RE.exec(line)?.[0] ?? null },
  { name: 'email address', test: (line) => /[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(line)?.[0] ?? null },
  { name: 'private network address', test: (line) => /(^|[^\d.])(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?![\d.])/.exec(line)?.[0] ?? null },
]

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' && dir === root) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      yield* walk(full)
    } else if (entry.isFile()) {
      const ext = entry.name.slice(entry.name.lastIndexOf('.'))
      if (SKIP_EXT.has(ext)) continue
      yield full
    }
  }
}

const problems = []
let scanned = 0
for (const file of walk(root)) {
  const rel = relative(root, file)
  const fail = (lineNumber, rule, sample) =>
    problems.push(`${rel.split(sep).join('/')}:${lineNumber}  [${rule}] ${sample.trim().slice(0, 120)}`)

  if (rel === SELF) continue
  const text = readFileSync(file, 'utf8')
  scanned += 1
  text.split(/\r?\n/).forEach((line, index) => {
    for (const rule of RULES) {
      const hit = rule.test(line)
      if (hit) fail(index + 1, rule.name, hit)
    }
  })
}

console.log(`scanned ${scanned} publishable file(s)`)
if (problems.length === 0) {
  console.log('PASS  no local paths, user dirs, credentials, e-mails or private IPs')
  console.log('\nLEAK CHECK PASSED')
} else {
  console.log(`FAIL  ${problems.length} finding(s):`)
  for (const problem of problems) console.log('  ' + problem)
  process.exitCode = 1
}
