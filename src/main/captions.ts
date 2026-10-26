import { randomUUID } from 'node:crypto'
import type { Caption } from '../shared/types'
import { CaptionQueue as PortableCaptionQueue } from '../shared/caption-queue'
import { translateCaption, type TranslationConfig } from './translation'
import { annotateJapanese } from './japanese'
import { trace } from './diagnostics'

/** Desktop platform hooks; the original scheduling implementation is shared unchanged. */
export class CaptionQueue extends PortableCaptionQueue {
  constructor(saved: Caption[], config: () => TranslationConfig, changed: () => void,
    persist: (captions: Caption[]) => void, translator = translateCaption, annotator = annotateJapanese) {
    super(saved, config, changed, persist, translator, annotator, { id: randomUUID, trace })
  }
}
