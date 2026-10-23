import { useState } from 'react'
import { ArrowLeft, ArrowRight, Check, X } from 'lucide-react'
import type { Settings, SettingsInput } from '../shared/types'
import { LANGUAGES, MAX_TARGET_LANGUAGES, languageInfo, type TargetLanguage } from '../shared/languages'

export default function LanguageSettings({ draft, onChange }: { draft: Settings; onChange: (next: SettingsInput) => void }) {
  const [message, setMessage] = useState('')
  const selected = draft.targetLanguages

  function toggle(code: TargetLanguage) {
    setMessage('')
    if (selected.includes(code)) {
      if (selected.length === 1) { setMessage('至少保留一种字幕语言。'); return }
      onChange({ targetLanguages: selected.filter(value => value !== code) })
    } else {
      if (selected.length >= MAX_TARGET_LANGUAGES) { setMessage(`最多选择 ${MAX_TARGET_LANGUAGES} 种语言，请先移除一种。`); return }
      onChange({ targetLanguages: [...selected, code] })
    }
  }

  function move(code: TargetLanguage, direction: -1 | 1) {
    const index = selected.indexOf(code)
    const destination = index + direction
    if (index < 0 || destination < 0 || destination >= selected.length) return
    const next = [...selected]
    ;[next[index], next[destination]] = [next[destination], next[index]]
    onChange({ targetLanguages: next })
    setMessage('')
  }

  return <>
    <section className="settings-section language-choices-section">
      <div className="section-title"><h3>想看哪几种语言？</h3><span className="selection-count">{selected.length} / {MAX_TARGET_LANGUAGES}</span></div>
      <p className="settings-explanation">按下方顺序显示字幕，只翻译所选语言。小窗同时显示原文与所有所选语言；第一种用于历史预览。</p>
      <div className="selected-languages" aria-label="字幕语言显示顺序">{selected.map((code, index) => <div className="selected-language" key={code}>
        <span className="language-order">{index + 1}</span><span className="selected-language-label">{languageInfo(code).nativeName}</span>
        <button type="button" disabled={index === 0} title={`${languageInfo(code).label}向前移动`} aria-label={`${languageInfo(code).label}向前移动`} onClick={() => move(code, -1)}><ArrowLeft size={11} /></button>
        <button type="button" disabled={index === selected.length - 1} title={`${languageInfo(code).label}向后移动`} aria-label={`${languageInfo(code).label}向后移动`} onClick={() => move(code, 1)}><ArrowRight size={11} /></button>
        <button type="button" disabled={selected.length === 1} title={`移除${languageInfo(code).label}`} aria-label={`移除${languageInfo(code).label}`} onClick={() => toggle(code)}><X size={11} /></button>
      </div>)}</div>
      <div className="language-options" aria-label="可选字幕语言">{LANGUAGES.map(language => {
        const active = selected.includes(language.code)
        return <button key={language.code} type="button" className={active ? 'selected' : ''} aria-pressed={active} onClick={() => toggle(language.code)}><span className="language-check">{active && <Check size={10} />}</span><span className="language-option-label">{language.label}<small>{language.nativeName}</small></span></button>
      })}</div>
      {message && <p className="language-validation" role="alert">{message}</p>}
      <p className="settings-explanation language-change-note">保存后，新句子按此设置翻译。历史句子缺少的语言，可回看时重新翻译。</p>
    </section>
    <section className="settings-section">
      <label className="toggle-setting"><div><b>展开视图显示原文</b><span>小窗始终保留原文，方便与译文对照</span></div><input type="checkbox" checked={draft.showOriginal} onChange={event => onChange({ showOriginal: event.target.checked })} /><i /></label>
      <label className={`toggle-setting ${selected.includes('ja') ? '' : 'inactive-setting'}`}><div><b>日语汉字注音</b><span>{selected.includes('ja') ? '在对应汉字上方显示假名读音' : '选择日语后生效，保留你的注音偏好'}</span></div><input type="checkbox" checked={draft.showFurigana} onChange={event => onChange({ showFurigana: event.target.checked })} /><i /></label>
    </section>
  </>
}
