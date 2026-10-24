// Adapted from Penumbra's audio build at 1b023aad26fc601045fc7948fe16666272d37661.
// CC BY-NC 4.0; see NOTICE.md. No mouse/input helpers are built or packaged.
const { execFileSync } = require('node:child_process')
const { existsSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

if (process.platform !== 'win32')
  throw new Error('Build the Windows audio helper on Windows using CMake and Visual Studio C++ tools.')
const architecture = process.env.LINGOBAR_NATIVE_ARCH || process.arch
if (architecture !== 'x64') throw new Error('LingoBar currently supports Windows x64 only.')

const root = join(__dirname, '..')
const source = join(root, 'resources', 'native', 'windows')
// Object files are deliberately outside out/**, which electron-builder packages.
const build = join(root, 'artifacts', 'native-audio', 'win-x64')
const output = join(root, 'resources', 'native', 'win-x64')
mkdirSync(output, { recursive: true })
const options = { cwd: root, stdio: 'inherit', windowsHide: true, shell: false }
execFileSync('cmake', [
  '--fresh', '-S', source, '-B', build, '-A', 'x64',
  `-DCMAKE_RUNTIME_OUTPUT_DIRECTORY_RELEASE=${output}`
], { ...options, timeout: 120000 })
execFileSync('cmake', ['--build', build, '--config', 'Release', '--parallel'], { ...options, timeout: 180000 })
if (!existsSync(join(output, 'system-audio-capture.exe')))
  throw new Error('The Windows x64 audio helper is missing after build.')
console.log('[build-native] built Windows x64 WASAPI audio helper')
