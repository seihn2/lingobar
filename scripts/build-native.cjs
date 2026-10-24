const { execFileSync } = require('node:child_process')
const { chmodSync, mkdtempSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

if (process.platform === 'win32') require('./build-windows-native.cjs')
else if (process.platform !== 'darwin') throw new Error('Native audio builds require macOS or Windows x64.')

if (process.platform === 'darwin') {
  const projectDir = resolve(__dirname, '..')
  const source = join(projectDir, 'resources/native/SystemAudioCapture.swift')
  const output = join(projectDir, 'resources/native/system-audio-capture')
  const architecture = process.env.LINGOBAR_NATIVE_ARCH || process.arch
  if (!['arm64', 'x64'].includes(architecture)) throw new Error('Unsupported native architecture')
  const target = `${architecture === 'x64' ? 'x86_64' : 'arm64'}-apple-macosx13.0`
  const temporary = mkdtempSync(join(tmpdir(), 'lingobar-system-audio-build-'))
  const info = join(temporary, 'Info.plist')
  try {
    writeFileSync(
      info,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.lingobar.app</string>
<key>CFBundleName</key><string>LingoBar</string>
<key>CFBundleDisplayName</key><string>LingoBar</string>
<key>CFBundleVersion</key><string>1</string>
<key>NSAudioCaptureUsageDescription</key><string>LingoBar transcribes the computer audio you choose to share. No screen or microphone is captured by this helper.</string>
</dict></plist>
`
    )
    execFileSync(
      'xcrun',
      [
        'swiftc',
        '-O',
        '-target',
        target,
        '-framework',
        'CoreAudio',
        '-framework',
        'AVFAudio',
        '-framework',
        'Foundation',
        source,
        '-Xlinker',
        '-sectcreate',
        '-Xlinker',
        '__TEXT',
        '-Xlinker',
        '__info_plist',
        '-Xlinker',
        info,
        '-o',
        output
      ],
      { cwd: projectDir, stdio: 'inherit', timeout: 120000 }
    )
    chmodSync(output, 0o755)
    // The package signer replaces this development-only ad-hoc signature using
    // the same stable identity as the parent LingoBar application.
    execFileSync(
      '/usr/bin/codesign',
      ['--force', '--sign', '-', '--identifier', 'com.lingobar.app', output],
      { cwd: projectDir, stdio: 'inherit', timeout: 30000 }
    )
    console.log(`[build-native] built audio-only helper (${target})`)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}
