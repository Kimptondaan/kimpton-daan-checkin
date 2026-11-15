import { useState } from 'react'
import { Check, Pencil, Plus, X } from 'lucide-react'
import type { Announcement } from '../lib/types'

type Props = {
  announcement: Announcement
  canEdit: boolean
  saving: boolean
  onSave: (format: Announcement['format'], items: string[], expectedVersion: number) => Promise<boolean>
}

const TAIPEI_TIME_ZONE = 'Asia/Taipei'
const MAX_CODEPOINTS = 200
const MAX_BULLETS = 5

function normalizeLineBreaks(value: string) {
  return value.replace(/\r\n?/g, '\n').trim()
}

function countCodepoints(value: string) {
  return Array.from(normalizeLineBreaks(value).replace(/\n/g, '')).length
}

function formatUpdatedAt(value: string | null) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return '尚未更新'
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: TAIPEI_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(value))
}

export default function AnnouncementPanel({ announcement, canEdit, saving, onSave }: Props) {
  const [editing, setEditing] = useState(false)
  const [draftFormat, setDraftFormat] = useState<Announcement['format']>('text')
  const [textDraft, setTextDraft] = useState('')
  const [bulletDrafts, setBulletDrafts] = useState<string[]>([])
  const [submitError, setSubmitError] = useState('')
  const [draftVersion, setDraftVersion] = useState(0)

  const normalizedText = normalizeLineBreaks(textDraft)
  const normalizedBullets = bulletDrafts.map(normalizeLineBreaks)
  const characterCount = draftFormat === 'text'
    ? countCodepoints(textDraft)
    : normalizedBullets.reduce((total, item) => total + countCodepoints(item), 0)
  const hasBulletNewline = draftFormat === 'bullets' && bulletDrafts.some((item) => /\r|\n/.test(item))
  const hasBlankBullet = draftFormat === 'bullets' && bulletDrafts.length > 0 && normalizedBullets.some((item) => item.length === 0)
  const hasTooManyBullets = draftFormat === 'bullets' && bulletDrafts.length > MAX_BULLETS
  const validationMessage = [
    characterCount > MAX_CODEPOINTS ? '總字數超過 200 字，請自行調整內容。' : '',
    hasBulletNewline ? '條列內容不可包含換行。' : '',
    hasBlankBullet ? '條列不可留白；若要清空公告，請刪除所有條目。' : '',
    hasTooManyBullets ? '條列最多 5 條，請移除多餘條目。' : '',
  ].filter(Boolean).join(' ')

  function beginEditing() {
    setDraftFormat(announcement.format)
    setTextDraft(announcement.format === 'text' ? announcement.items.join('\n') : '')
    setBulletDrafts(announcement.format === 'bullets' ? [...announcement.items] : [])
    setSubmitError('')
    setDraftVersion(announcement.version)
    setEditing(true)
  }

  function cancelEditing() {
    if (saving) return
    setEditing(false)
    setSubmitError('')
  }

  function updateText(value: string) {
    setTextDraft(value)
    setSubmitError('')
  }

  function updateBullet(index: number, value: string) {
    setBulletDrafts((current) => current.map((item, itemIndex) => itemIndex === index ? value : item))
    setSubmitError('')
  }

  function addBullet() {
    if (bulletDrafts.length >= MAX_BULLETS || saving) return
    setBulletDrafts((current) => [...current, ''])
    setSubmitError('')
  }

  function removeBullet(index: number) {
    if (saving) return
    setBulletDrafts((current) => current.filter((_, itemIndex) => itemIndex !== index))
    setSubmitError('')
  }

  async function submit() {
    if (validationMessage || saving) return
    const items = draftFormat === 'text'
      ? (normalizedText ? [normalizedText] : [])
      : normalizedBullets
    setSubmitError('')
    try {
      const saved = await onSave(draftFormat, items, draftVersion)
      if (saved) {
        setEditing(false)
        return
      }
    } catch {
      // The parent reports the API error; keep this editor's independent draft intact.
    }
    setSubmitError('未儲存，內容仍保留。')
  }

  return <section className={`employee-hero announcement-panel${editing ? ' is-editing' : ''}`} aria-labelledby="announcement-panel-title">
    <div className="announcement-main">
      <span className="hero-kicker">SHARED ANNOUNCEMENT</span>
      <h2 id="announcement-panel-title">公告</h2>
      <p className="announcement-updated">最近更新：{formatUpdatedAt(announcement.updatedAt)}</p>

      {!announcement.available ? <p className="announcement-unavailable" role="status">公告功能尚未就緒</p> : editing && canEdit ? <div className="announcement-editor">
        <fieldset className="announcement-format" disabled={saving}>
          <legend>公告呈現方式</legend>
          <label><input type="radio" name="announcement-format" value="text" checked={draftFormat === 'text'} onChange={() => { setDraftFormat('text'); setSubmitError('') }} />一般文字</label>
          <label><input type="radio" name="announcement-format" value="bullets" checked={draftFormat === 'bullets'} onChange={() => { setDraftFormat('bullets'); setSubmitError('') }} />條列公告</label>
        </fieldset>

        {draftFormat === 'text' ? <label className="announcement-text-field">
          <span>公告內容</span>
          <textarea rows={4} value={textDraft} onChange={(event) => updateText(event.target.value)} disabled={saving} placeholder="輸入要分享給全體同仁的公告" aria-describedby="announcement-count announcement-error" />
        </label> : <div className="announcement-bullet-editor">
          <div className="announcement-bullet-heading"><strong>條列內容</strong><span>最多 5 條</span></div>
          {bulletDrafts.map((item, index) => <div className="announcement-bullet-row" key={index}>
            <label className="announcement-bullet-field"><span className="sr-only">第 {index + 1} 條公告</span><input value={item} onChange={(event) => updateBullet(index, event.target.value)} disabled={saving} placeholder={`第 ${index + 1} 條公告`} aria-describedby="announcement-count announcement-error" /></label>
            <button type="button" className="announcement-icon-button" aria-label={`刪除第 ${index + 1} 條公告`} onClick={() => removeBullet(index)} disabled={saving}><X size={17} /></button>
          </div>)}
          <button type="button" className="announcement-add-button" onClick={addBullet} disabled={saving || bulletDrafts.length >= MAX_BULLETS}><Plus size={16} />新增一條</button>
        </div>}

        <div id="announcement-count" className={`announcement-count${characterCount > MAX_CODEPOINTS ? ' over-limit' : ''}`} aria-live="polite">{characterCount}/200 字 · 中文、英數、空格及標點各計1字，換行不計</div>
        {announcement.version !== draftVersion && <p className="announcement-error" role="alert">公告已被其他管理者更新，草稿仍保留；請先複製草稿，再取消並重新編輯最新公告。</p>}
        <div className="announcement-form-actions">
          <button type="button" className="announcement-cancel-button" onClick={cancelEditing} disabled={saving}><X size={16} />取消</button>
          <button type="button" className="announcement-save-button" onClick={() => void submit()} disabled={saving || Boolean(validationMessage)} aria-busy={saving}><Check size={16} />{saving ? '儲存中…' : '儲存公告'}</button>
        </div>
        {(validationMessage || submitError) && <p id="announcement-error" className="announcement-error" role="alert">{validationMessage || submitError}</p>}
      </div> : <div className="announcement-content">
        {announcement.items.length === 0 ? <p className="announcement-empty">目前沒有公告內容。</p> : announcement.format === 'bullets' ? <ul>{announcement.items.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul> : <div className="announcement-copy">{announcement.items.join('\n')}</div>}
      </div>}
    </div>

    {!editing && canEdit && <div className="announcement-toolbar">
      <button type="button" className="announcement-edit-button" onClick={beginEditing} disabled={!announcement.available || saving}><Pencil size={16} />編輯公告</button>
    </div>}
    {!editing && !canEdit && announcement.available && <span className="announcement-readonly">全體共用</span>}
  </section>
}
