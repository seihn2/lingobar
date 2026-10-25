// These are benchmark-only insertions into the exact pinned CaptionQueue source.
// No production source file is edited or copied into the repository.
const needle = '        this.work.get(caption.id)!.revision++\n'
const refresh = `        const queued = this.waiting.find(job => job.caption === caption && job.config.partial)
        if (queued) {
          queued.original = caption.original
          queued.revision = this.work.get(caption.id)!.revision
`

module.exports = [
  { id: 'baseline', label: 'Baseline', insertion: '' },
  {
    id: 'snapshot-keep-timer', label: 'Snapshot refresh; keep timer',
    needle, insertion: refresh + '        }\n'
  },
  {
    id: 'snapshot-merge-timer', label: 'Snapshot refresh; merge waiting timer',
    needle, insertion: refresh + `          const state = this.work.get(caption.id)!
          if (state.timer) { clearTimeout(state.timer); state.timer = undefined }
          continue
        }
`
  }
]
