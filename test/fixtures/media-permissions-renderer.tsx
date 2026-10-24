// Actual App, device enumeration and AudioWorklet; Electron supplies fake devices.
import { createRoot } from 'react-dom/client'
import App from '../../src/renderer/App'
import { listMicrophones } from '../../src/renderer/microphone'
import '../../src/renderer/style.css'

const fixture = (window as unknown as { __mediaFixture: { control(action: string, value?: unknown): Promise<any> } }).__mediaFixture
if (fixture) {
  const acquired: MediaStream[] = []
  const nativeGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
  // Observe only tracks/constraints; never replace media devices or record PCM.
  navigator.mediaDevices.getUserMedia = async constraints => {
    const stream = await nativeGetUserMedia(constraints); acquired.push(stream); return stream
  }
  const wait = async (test: () => unknown | Promise<unknown>, label: string) => {
    const deadline = Date.now() + 12000
    while (!await test()) {
      if (Date.now() >= deadline) throw new Error(label)
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  const query = <T extends HTMLElement = HTMLElement>(selector: string): T => {
    const result = document.querySelector<T>(selector); if (!result) throw new Error(`Missing ${selector}`); return result
  }
  const clickText = (text: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === text)
    if (!button) throw new Error(`Missing button ${text}`); button.click()
  }
  const openSettings = async () => {
    query<HTMLButtonElement>('[title="设置"]').click()
    await wait(() => document.querySelector('.settings-form'), 'Settings did not open')
    clickText('服务连接')
    await wait(() => document.querySelectorAll('#microphone-device option').length >= 3, 'Idle settings cannot list the two named fake microphones')
  }
  const closeSettings = async () => { query<HTMLButtonElement>('[title="关闭面板"]').click(); await wait(() => !document.querySelector('.settings-form'), 'Settings did not close') }
  const rejected = async (constraints: MediaStreamConstraints) => {
    try { const stream = await navigator.mediaDevices.getUserMedia(constraints); stream.getTracks().forEach(track => track.stop()); return false }
    catch (error) { return error instanceof DOMException && error.name === 'NotAllowedError' }
  }
  ;(window as unknown as { __runMediaPermissionTests(): Promise<string[]> }).__runMediaPermissionTests = async () => {
    const checks: string[] = []
    const check = (value: unknown, label: string) => { if (!value) throw new Error(label); checks.push(label) }
    await wait(() => document.querySelector('.listen-button'), 'App did not mount')
    await openSettings()
    const select = query<HTMLSelectElement>('#microphone-device')
    const microphones = await listMicrophones()
    check(microphones.length === 2 && microphones.every(device => device.deviceId && device.label.startsWith('Fake Audio Input')), 'idle listMicrophones exposes exactly two named synthetic devices')
    check((await fixture.control('stats')).requests.length === 0 && acquired.length === 0, 'opening idle settings and enumeration does not request or start capture')
    const selected = microphones[1].deviceId
    select.value = selected; select.dispatchEvent(new Event('change', { bubbles: true }))
    clickText('保存设置')
    await wait(() => !document.querySelector('.settings-form'), 'Settings save did not close')
    check((await fixture.control('stats')).settings.microphoneDeviceId === selected, 'a specific microphone can be selected and saved before listening')
    check(await rejected({ audio: true }), 'idle getUserMedia is rejected despite named device metadata')
    check((await fixture.control('stats')).requests.at(-1).allowed === false, 'idle getUserMedia reached and was denied by the production request handler')
    query<HTMLButtonElement>('.listen-button').click()
    await wait(async () => (await fixture.control('stats')).state === 'listening', 'Explicit start did not capture the selected fake microphone')
    check(acquired.length === 1 && acquired[0].getAudioTracks()[0].getSettings().deviceId === selected, 'explicit App start captures the selected fake device through the real AudioWorklet path')
    check((await fixture.control('stats')).requests.at(-1).allowed === true, 'explicit start uses the real production permission request gate')
    check(await rejected({ video: true }), 'camera request is denied during an active microphone run')
    check(await rejected({ audio: true, video: true }), 'mixed microphone and camera request is denied during an active run')
    query<HTMLButtonElement>('.listen-button').click()
    await wait(async () => (await fixture.control('stats')).state === 'idle' && acquired.every(stream => stream.getTracks().every(track => track.readyState === 'ended')), 'Pause did not end fake tracks')
    check(true, 'pause ends every acquired fake audio track')
    await openSettings()
    check(query<HTMLSelectElement>('#microphone-device').value === selected, 'reopening paused settings retains the selected device')
    const beforeRefresh = (await fixture.control('stats')).requests.length
    clickText('刷新设备')
    await wait(() => query<HTMLSelectElement>('#microphone-device').options.length === 3, 'Device refresh did not complete')
    check((await listMicrophones()).length === 2 && (await fixture.control('stats')).requests.length === beforeRefresh, 'paused refresh re-enumerates named devices without a capture request')
    await closeSettings()
    check(await rejected({ audio: true }), 'paused getUserMedia remains denied')
    await fixture.control('hold', true)
    query<HTMLButtonElement>('.listen-button').click()
    await wait(async () => (await fixture.control('stats')).held === 1, 'Pending permission response was not held')
    query<HTMLButtonElement>('.listen-button').click()
    await wait(async () => (await fixture.control('stats')).state === 'idle', 'Starting run could not be cancelled')
    await fixture.control('release')
    await wait(() => acquired.length >= 2 && acquired.every(stream => stream.getTracks().every(track => track.readyState === 'ended')), 'Cancelled late permission grant leaked a track')
    check(true, 'cancelling startup releases the late synthetic stream and leaves capture idle')
    await openSettings()
    check((await listMicrophones()).length === 2, 'settings can enumerate devices again after cancelling startup')
    await closeSettings()
    await fixture.control('deny', true)
    query<HTMLButtonElement>('.listen-button').click()
    await wait(async () => (await fixture.control('stats')).state === 'error', 'Denied permission did not surface an error')
    check(acquired.every(stream => stream.getTracks().every(track => track.readyState === 'ended')), 'permission denial produces no live audio track')
    await openSettings()
    check((await listMicrophones()).length === 2, 'device enumeration remains available after a denied capture request')
    await closeSettings()
    await fixture.control('deny', false)
    check((await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput').every(device => !device.deviceId && !device.label), 'camera device identities remain hidden')
    return checks
  }
  createRoot(document.getElementById('root')!).render(<App />)
}
