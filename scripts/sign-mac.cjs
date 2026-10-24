const { execFileSync } = require('node:child_process')
const { readdirSync } = require('node:fs')
const { join } = require('node:path')
exports.default = async ({ appOutDir, packager }) => {
  if (packager.platform.name !== 'mac') return
  const app = join(appOutDir, 'LingoBar.app')
  const frameworks = join(app, 'Contents', 'Frameworks')
  const entitlements = join(packager.projectDir, 'build', 'entitlements.mac.plist')
  const sign = (path, id, ent) => execFileSync('/usr/bin/codesign', [
    '--force', '--sign', '-', ...(id ? ['--identifier', id] : []),
    ...(ent ? ['--entitlements', entitlements] : []), path
  ], { stdio: 'pipe' })
  for (const name of readdirSync(frameworks).filter(n => n.endsWith('.framework'))) sign(join(frameworks, name))
  for (const name of readdirSync(frameworks).filter(n => n.endsWith('.app'))) sign(join(frameworks, name), `com.lingobar.app.${name.includes('Renderer') ? 'renderer' : name.includes('GPU') ? 'gpu' : 'helper'}`, true)
  sign(join(app, 'Contents', 'Resources', 'native', 'system-audio-capture'), 'com.lingobar.app')
  sign(app, 'com.lingobar.app', true)
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' })
}
