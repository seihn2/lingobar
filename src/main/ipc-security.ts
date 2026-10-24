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

export function mayCaptureMicrophone(input: {
  sameContents: boolean
  mainFrame: boolean
  trustedUrl: boolean
  permission: string
  audioOnly: boolean
  microphoneRun: number | null
  state: string
}): boolean {
  return input.sameContents && input.mainFrame && input.trustedUrl &&
    input.permission === 'media' && input.audioOnly && input.microphoneRun !== null &&
    (input.state === 'starting' || input.state === 'listening')
}

export function mayUseLocalKeyImport(platform: string): boolean { return platform === 'darwin' }
