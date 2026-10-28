// Inventory only committed project builds. No network, execution, credentials or deployment.
const { readFileSync, readdirSync, writeFileSync } = require('node:fs')
const { join, resolve, relative } = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const assert = require('node:assert/strict')
const root = resolve(__dirname, '..'), dist = join(root, 'dist')
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const head = process.env.LINGOBAR_SOURCE_HEAD || git('rev-parse', 'HEAD')
assert.match(head, /^[a-f0-9]{40}$/)
assert.equal(git('status', '--porcelain'), '', 'Gateway artifact requires clean source')
const tree = git('rev-parse', `${head}^{tree}`)
assert.equal(git('rev-parse', 'HEAD^{tree}'), tree)
assert.deepEqual(JSON.parse(readFileSync(join(dist, 'web/app-config.json'), 'utf8')), { version: 1, backend: null })
function files(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap(item => {
  assert.ok(item.isDirectory() || item.isFile()); return item.isDirectory() ? files(join(dir, item.name)) : [join(dir, item.name)]
}) }
const hash = data => createHash('sha256').update(data).digest('hex')
const entries = [...files(join(dist, 'gateway')), ...files(join(dist, 'web'))].sort().map(path => {
  const data = readFileSync(path); return { path: relative(dist, path).replaceAll('\\', '/'), bytes: data.byteLength, sha256: hash(data) }
})
writeFileSync(join(dist, 'GATEWAY-MANIFEST.json'), JSON.stringify({ sourceHead: head, sourceTree: tree, sourceBase: process.env.LINGOBAR_SOURCE_BASE || '', checkoutHead: git('rev-parse', 'HEAD'),
  runtime: 'Node.js22 Linux, loopback gateway only', enabled: false, deployed: false, backend: null,
  validation: 'Generated Access signatures, temporary budget ledger, actual loopback HTTP/ws and synthetic providers. No live Access/provider/VM/phone acceptance.', files: entries }, null, 2) + '\n')
writeFileSync(join(dist, 'GATEWAY-SHA256SUMS.txt'), [...entries, { path: 'GATEWAY-MANIFEST.json', sha256: hash(readFileSync(join(dist, 'GATEWAY-MANIFEST.json'))) }].map(v => `${v.sha256}  ${v.path}`).join('\n') + '\n')
console.log(`Disabled gateway/static artifact inventoried: ${entries.length} files, source ${head}.`)
