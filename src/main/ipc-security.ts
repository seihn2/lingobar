import { fileURLToPath } from 'node:url'

export interface RendererLocation { packaged: boolean; htmlPath: string; developmentUrl?: string }

/** Compare exact renderer locations; a matching origin or URL prefix is insufficient. */
export function trustedRendererUrl(value: string, location: RendererLocation): boolean {
  try {
    const url = new URL(value)
    if (!location.packaged && location.developmentUrl) {
      const expected = new URL(location.developmentUrl)
      return url.origin === expected.origin && url.pathname === expected.pathname &&
        !url.username && !url.password
    }
    return url.protocol === 'file:' && fileURLToPath(url) === location.htmlPath
  } catch { return false }
}

interface MicrophoneIdentity {
  sameContents: boolean
  mainFrame: boolean
  trustedUrl: boolean
  permission: string
  audioOnly: boolean
}

/** Audio permission status also controls input/output device metadata in Chromium.
 * Checking status does not authorize getUserMedia: its request is gated below.
 * Keep this restricted to the app's trusted main frame, including while idle.
 */
export function mayQueryMicrophone(input: MicrophoneIdentity): boolean {
  return input.sameContents && input.mainFrame && input.trustedUrl &&
    input.permission === 'media' && input.audioOnly
}

export function mayCaptureMicrophone(input: MicrophoneIdentity & {
  microphoneRun: number | null
  state: string
}): boolean {
  return mayQueryMicrophone(input) && input.microphoneRun !== null &&
    (input.state === 'starting' || input.state === 'listening')
}

export function mayUseLocalKeyImport(platform: string): boolean { return platform === 'darwin' }
