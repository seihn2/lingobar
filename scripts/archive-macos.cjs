// Archive the verified CI .app only. Never launch capture, read a user profile,
// sign/notarize, alter quarantine, or contact an application service.
const assert = require('node:assert/strict')
const { execFileSync, spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir, release } = require('node:os')
const { dirname, isAbsolute, join, relative, resolve, sep } = require('node:path')

const sha256 = value => createHash('sha256').update(value).digest('hex')
function commitSha(value) {
  assert.match(value || '', /^[0-9a-f]{40}$/i, 'Expected a full immutable commit SHA')
  return value.toLowerCase()
}
function bundleInventory(directory) {
  const root = realpathSync(directory), entries = []
  function walk(path) {
    const name = relative(root, path).split(sep).join('/') || '.'
    assert.ok(!/(^|\/)(settings\.json(?:\.tmp)?|saved\.json(?:\.tmp)?|diagnostics(?:\.jsonl|-until)?|\.env(?:\..*)?|\.npmrc|\.git|artifacts|test)(\/|$)/i.test(name), `Profile/development file in bundle: ${name}`)
    assert.ok(!/\.(wav|mp3|pcm|pem|p12|pfx|key)$/i.test(name), `Sensitive file in bundle: ${name}`)
    const stat = lstatSync(path), entry = { path: name, mode: (stat.mode & 0o777).toString(8) }
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path), destination = resolve(dirname(path), target)
      assert.ok(!isAbsolute(target) && destination.startsWith(root + sep) && realpathSync(path).startsWith(root + sep), `External bundle symlink: ${name}`)
      entries.push({ ...entry, type: 'symlink', target })
    } else if (stat.isDirectory()) {
      entries.push({ ...entry, type: 'directory' })
      for (const child of readdirSync(path).sort()) walk(join(path, child))
    } else {
      assert.ok(stat.isFile(), `Unsupported bundle entry: ${name}`)
      entries.push({ ...entry, type: 'file', bytes: stat.size, sha256: sha256(readFileSync(path)) })
    }
  }
  walk(root)
  return entries
}

function main() {
  assert.equal(process.platform, 'darwin', 'macOS archiving requires macOS; Linux is not an acceptance substitute')
  assert.equal(process.arch, 'arm64', 'This preview is Apple Silicon only')
  const root = resolve(__dirname, '..'), app = join(root, 'dist/mac-arm64/LingoBar.app')
  const run = (command, args) => execFileSync(command, args, { cwd: root, encoding: 'utf8', timeout: 180000 }).trim()
  run('git', ['diff', '--exit-code', 'HEAD', '--', 'src', 'resources/native', 'build', 'scripts', 'package.json', 'package-lock.json', 'electron-builder.yml'])
  const checkoutCommit = commitSha(run('git', ['rev-parse', 'HEAD']))
  const sourceHead = commitSha(process.env.LINGOBAR_SOURCE_HEAD || checkoutCommit)
  const sourceBase = process.env.LINGOBAR_SOURCE_BASE ? commitSha(process.env.LINGOBAR_SOURCE_BASE) : null
  const pullRequest = process.env.LINGOBAR_PULL_REQUEST || ''
  assert.match(pullRequest, /^\d*$/, 'Invalid pull request number')
  const productionTree = run('git', ['rev-parse', 'HEAD:src'])
  const headProductionTree = run('git', ['rev-parse', `${sourceHead}:src`])
  const version = require('../package.json').version
  assert.match(version, /^\d+\.\d+\.\d+$/)
  const executable = join(app, 'Contents/MacOS/LingoBar')
  const helper = join(app, 'Contents/Resources/native/system-audio-capture')
  const verifySignature = path => run('/usr/bin/codesign', ['--verify', '--deep', '--strict', path])
  verifySignature(app)
  const signature = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', app], { encoding: 'utf8', timeout: 30000 })
  assert.equal(signature.status, 0, 'Cannot inspect existing signature')
  assert.match(signature.stdout + signature.stderr, /Signature=adhoc/, 'Review the manifest if signing policy changes')
  for (const path of [executable, helper]) {
    assert.equal(run('/usr/bin/lipo', ['-archs', path]), 'arm64')
    assert.ok(lstatSync(path).mode & 0o111, 'Packaged executable lost its execute bits')
  }
  const minimumMacOS = run('/usr/libexec/PlistBuddy', ['-c', 'Print :LSMinimumSystemVersion', join(app, 'Contents/Info.plist')])
  const before = bundleInventory(app)
  const output = join(root, 'dist/macos-artifact')
  mkdirSync(output, { recursive: true })
  // Keep a previously successful package separate rather than overwrite it.
  assert.equal(readdirSync(output).length, 0, 'Use a clean macos-artifact output directory')
  const archiveName = `LingoBar-${version}-macos-arm64-preview-${sourceHead.slice(0, 12)}.zip`
  const archive = join(output, archiveName)
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive])
  const temporary = mkdtempSync(join(tmpdir(), 'lingobar-mac-roundtrip-'))
  let nativeSelfTest
  try {
    run('/usr/bin/ditto', ['-x', '-k', archive, temporary])
    const restored = join(temporary, 'LingoBar.app')
    assert.deepEqual(bundleInventory(restored), before, 'ZIP roundtrip changed bytes, modes or symlinks')
    verifySignature(restored)
    nativeSelfTest = JSON.parse(run(join(restored, 'Contents/Resources/native/system-audio-capture'), ['--self-test']))
    assert.equal(nativeSelfTest.ok, true)
    assert.equal(nativeSelfTest.captureStarted, false, 'Self-test must never create a capture device')
  } finally { rmSync(temporary, { recursive: true, force: true }) }
  const manifest = {
    schemaVersion: 1, product: 'LingoBar', version, preview: true, platform: 'darwin', architecture: 'arm64', minimumMacOS,
    source: { repository: 'https://github.com/seihn2/lingobar', pullRequest: pullRequest ? Number(pullRequest) : null,
      sourceHead, sourceBase, checkoutCommit, productionTree, headProductionTree,
      note: 'PR CI builds the recorded test-merge checkout. This is not a combined-draft package or a main merge.' },
    build: { createdAt: new Date().toISOString(), node: process.version, macOSKernel: release(),
      electron: require('../package.json').devDependencies.electron,
      workflowRun: process.env.GITHUB_RUN_ID ? `https://github.com/seihn2/lingobar/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
      lockfileSha256: sha256(readFileSync(join(root, 'package-lock.json'))) },
    signature: { type: 'ad-hoc', appleNotarized: false, deepStrictVerifiedBeforeAndAfterArchive: true,
      policy: 'Existing sign-mac.cjs is unchanged. No certificate, notarization, quarantine or Gatekeeper change.' },
    archive: { name: archiveName, bytes: lstatSync(archive).size, sha256: sha256(readFileSync(archive)),
      roundtrip: 'Every entry byte hash, POSIX mode, type and relative symlink checked; restored signature verified.' },
    validation: { nativeSelfTest, hardwareAudio: 'not tested', realProviders: 'not tested', userMacAcceptance: 'not performed by this archive step' },
    license: 'CC-BY-NC-4.0; bundled notices retained', entries: before
  }
  const manifestName = 'BUILD-MANIFEST.json'
  writeFileSync(join(output, manifestName), JSON.stringify(manifest, null, 2) + '\n')
  const sums = [archiveName, manifestName].map(name => `${sha256(readFileSync(join(output, name)))}  ${name}`).join('\n') + '\n'
  writeFileSync(join(output, 'SHA256SUMS.txt'), sums)
  console.log(sums.trim())
  console.log(`macOS arm64 preview verified: ${before.length} entries, ZIP byte/mode/symlink roundtrip, existing ad-hoc signature, synthetic native self-test. No hardware or provider acceptance.`)
}

module.exports = { bundleInventory, commitSha }
if (require.main === module) { try { main() } catch (error) { console.error(error.message); process.exitCode = 1 } }
