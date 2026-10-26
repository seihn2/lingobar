// Inventory our own disabled build. No deploy, network, secrets or system changes.
const { readFileSync, readdirSync, writeFileSync } = require('node:fs')
const { join, resolve, relative } = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const root = resolve(__dirname, '..'), dist = join(root, 'dist')
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const head = process.env.LINGOBAR_SOURCE_HEAD || git('rev-parse', 'HEAD')
if (!/^[a-f0-9]{40}$/.test(head)) throw new Error('Invalid source head')
function files(directory) { return readdirSync(directory, { withFileTypes: true }).flatMap(item => item.isDirectory() ? files(join(directory, item.name)) : [join(directory, item.name)]) }
const paths = [...files(join(dist, 'worker')), ...files(join(dist, 'web'))].sort()
const entries = paths.map(path => ({ path: relative(dist, path).replaceAll('\\', '/'), bytes: readFileSync(path).byteLength, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }))
writeFileSync(join(dist, 'RELAY-MANIFEST.json'), JSON.stringify({ sourceHead: head, sourceTree: git('rev-parse', `${head}^{tree}`), sourceBase: process.env.LINGOBAR_SOURCE_BASE || '', checkoutHead: git('rev-parse', 'HEAD'),
  defaultEnabled: false, deployed: false, authentication: 'Required internal verifier binding; no hosted verifier is supplied.',
  validation: 'TypeScript, browser-target ESM build and synthetic Node/browser boundaries. No actual workerd, provider, iPhone or hardware acceptance.', files: entries }, null, 2) + '\n')
const manifest = { path: 'RELAY-MANIFEST.json', sha256: createHash('sha256').update(readFileSync(join(dist, 'RELAY-MANIFEST.json'))).digest('hex') }
writeFileSync(join(dist, 'RELAY-SHA256SUMS.txt'), [...entries, manifest].map(item => `${item.sha256}  ${item.path}`).join('\n') + '\n')
console.log(`Disabled relay/static artifact inventoried: ${entries.length} files, source ${head}.`)
