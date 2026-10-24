import type { Session, WebContents } from 'electron'
import { mayCaptureMicrophone, mayQueryMicrophone, trustedRendererUrl, type RendererLocation } from './ipc-security'

interface MediaContext {
  contents: WebContents | null
  location: RendererLocation
  microphoneRun: number | null
  state: string
}

/** Install both halves of Electron's media policy. Chromium uses the check for
 * device metadata; every real getUserMedia request still needs an active run.
 * The real-Electron fake-device regression verifies that request gate as well.
 */
export function installMediaPermissions(
  target: Pick<Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler'>,
  context: () => MediaContext
): void {
  target.setPermissionRequestHandler((contents, permission, callback, details) => {
    const current = context()
    callback(mayCaptureMicrophone({
      sameContents: current.contents !== null && contents === current.contents,
      mainFrame: details.isMainFrame,
      trustedUrl: trustedRendererUrl(details.requestingUrl, current.location),
      permission,
      audioOnly: 'mediaTypes' in details && details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio',
      microphoneRun: current.microphoneRun,
      state: current.state
    }))
  })
  target.setPermissionCheckHandler((contents, permission, _origin, details) => {
    const current = context()
    return mayQueryMicrophone({
      sameContents: current.contents !== null && contents === current.contents,
      mainFrame: details.isMainFrame,
      trustedUrl: trustedRendererUrl(details.requestingUrl || '', current.location),
      permission,
      audioOnly: details.mediaType === 'audio'
    })
  })
}
