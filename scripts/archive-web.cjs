// Inventory the disabled static site. No deployment, network, secrets or application execution.
const { readFileSync, readdirSync, writeFileSync } = require('node:fs')
const { join, resolve, relative } = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const assert = require('node:assert/strict')
const root = resolve(__dirname, '..'), dist = join(root, 'dist'), web = join(dist, 'web')
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const sourceHead = process.env.LINGOBAR_SOURCE_HEAD || git('rev-parse', 'HEAD')
assert.match(sourceHead, /^[a-f0-9]{40}$/)
assert.equal(git('status', '--porcelain'), '', 'Static artifact requires a clean committed checkout')
const sourceTree = git('rev-parse', `${sourceHead}^{tree}`), checkoutTree = git('rev-parse', 'HEAD^{tree}')
assert.equal(checkoutTree, sourceTree, 'Static artifact must build the exact recorded head tree')
assert.deepEqual(JSON.parse(readFileSync(join(web, 'app-config.json'), 'utf8')), { version: 1, backend: null })
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(item => {
    assert.ok(item.isDirectory() || item.isFile(), 'Static package must not contain symlinks or special files')
    return item.isDirectory() ? files(join(dir, item.name)) : [join(dir, item.name)]
  })
}
const sha256 = data => createHash('sha256').update(data).digest('hex')
const entries = files(web).sort().map(path => {
  const data = readFileSync(path)
  return { path: relative(dist, path).replaceAll('\\', '/'), bytes: data.byteLength, sha256: sha256(data) }
})
const manifest = 'WEB-MANIFEST.json'
writeFileSync(join(dist, manifest), JSON.stringify({ sourceHead, sourceTree, sourceBase: process.env.LINGOBAR_SOURCE_BASE || '',
  checkoutHead: git('rev-parse', 'HEAD'), checkoutTree, backend: null, deployed: false,
  validation: 'Static build and synthetic browser/media only; no iPhone/Android, live provider or deployment acceptance.', files: entries }, null, 2) + '\n')
writeFileSync(join(dist, 'WEB-SHA256SUMS.txt'), [...entries, { path: manifest, sha256: sha256(readFileSync(join(dist, manifest))) }].map(item => `${item.sha256}  ${item.path}`).join('\n') + '\n')
console.log(`Disabled static Web package inventoried: ${entries.length} files, source ${sourceHead}, tree ${sourceTree}.`)
