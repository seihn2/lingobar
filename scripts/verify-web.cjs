// Inspect a build; never run audio or a provider. Only existing project dependencies are used.
const { readdirSync, readFileSync, statSync } = require('node:fs')
const { resolve, join } = require('node:path')
const assert = require('node:assert/strict')
const root = resolve(__dirname, '../dist/web')
const paths = []
function walk(dir) { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else paths.push(path) } }
walk(root)
const html = readFileSync(join(root, 'index.html'), 'utf8')
assert.ok(html.includes('manifest.webmanifest') && html.includes('Content-Security-Policy'))
assert.deepEqual(JSON.parse(readFileSync(join(root, 'app-config.json'), 'utf8')), { version: 1, backend: null })
for (const name of ['LICENSE', 'NOTICE.md', 'licenses/react-LICENSE.txt', 'licenses/react-dom-LICENSE.txt', 'licenses/scheduler-LICENSE.txt', 'licenses/lucide-react-LICENSE.txt', 'licenses/vite-LICENSE.md']) assert.ok(readFileSync(join(root, name)).length)
const icon = readFileSync(join(root, 'icon.png')); assert.equal(icon.readUInt32BE(16), 512); assert.equal(icon.readUInt32BE(20), 512)
for (const path of paths) {
  assert.ok(!/\.(?:map|pem|key|p12|pfx|wav|pcm)$/i.test(path) && !/\/(?:\.env[^/]*|settings\.json|saved\.json|learning-v1\.json(?:\.[^/]+\.tmp)?|dictionary-learning-v1\.json(?:\.[^/]+\.tmp)?|diagnostics\.jsonl)$/.test(path), 'Unexpected private/development data in web build')
  if (!/\.(?:js|html)$/.test(path)) continue
  const text = readFileSync(path, 'utf8')
  for (const marker of ['node:child_process', 'node:fs', 'from"electron"', 'require("electron")', 'dashscope.aliyuncs.com', 'api.deepseek.com', 'test/fixtures', 'Synthetic source', 'Providers are disabled in UI tests']) assert.ok(!text.includes(marker), `Forbidden web bundle import/fixture: ${marker}`)
}
console.log(`Standalone web build verified: ${paths.length} files, backend unconfigured, license notices retained, no desktop runtime/provider fixture/private data.`)
