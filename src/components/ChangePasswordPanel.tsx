import { useState, type FormEvent } from 'react'
import { Check, KeyRound, X } from 'lucide-react'

const PASSWORD_SUCCESS_MESSAGE = '密碼已更新，手機與電腦下次登入請使用新密碼。'

type ChangePassword = (currentPassword: string, newPassword: string) => Promise<void>

function errorMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message : '密碼更新失敗，請稍後再試。'
}

export default function ChangePasswordPanel({ onChangePassword, busy = false }: {
  onChangePassword: ChangePassword
  busy?: boolean
}) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  function clearForm() {
    setCurrentPassword('')
    setNewPassword('')
    setConfirmPassword('')
    setError('')
    setSuccess(false)
  }

  function updateField(setValue: (value: string) => void, value: string) {
    setValue(value)
    setError('')
    setSuccess(false)
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setError('')
    setSuccess(false)

    if (!currentPassword || !newPassword || !confirmPassword) {
      setError('請填寫目前密碼、新密碼與確認新密碼。')
      return
    }
    const newPasswordLength = Array.from(newPassword).length
    if (newPasswordLength < 8) {
      setError('新密碼至少需要 8 個字元。')
      return
    }
    if (newPasswordLength > 128) {
      setError('新密碼不可超過 128 個字元。')
      return
    }
    if (newPassword === currentPassword) {
      setError('新密碼不可與目前密碼相同。')
      return
    }
    if (newPassword !== confirmPassword) {
      setError('兩次輸入的新密碼不一致。')
      return
    }

    try {
      await onChangePassword(currentPassword, newPassword)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setSuccess(true)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  return <section className="content-card password-panel" aria-labelledby="change-password-title">
    <div className="card-heading password-panel-heading">
      <div>
        <p className="eyebrow">ACCOUNT SECURITY</p>
        <h2 id="change-password-title">更新登入密碼</h2>
        <p className="muted">請先驗證目前密碼，再設定只屬於自己的新密碼。</p>
      </div>
      <KeyRound size={22} aria-hidden="true" />
    </div>
    <form className="change-password-form" onSubmit={submit} aria-busy={busy}>
      <label className="password-field">
        <span>目前密碼</span>
        <input
          type="password"
          value={currentPassword}
          disabled={busy}
          autoComplete="current-password"
          autoCapitalize="none"
          spellCheck={false}
          aria-describedby={error ? 'change-password-error' : undefined}
          aria-invalid={Boolean(error)}
          onChange={(event) => updateField(setCurrentPassword, event.target.value)}
        />
      </label>
      <label className="password-field">
        <span>新密碼</span>
        <input
          type="password"
          value={newPassword}
          disabled={busy}
          autoComplete="new-password"
          autoCapitalize="none"
          spellCheck={false}
          aria-describedby={error ? 'change-password-error' : 'change-password-policy'}
          aria-invalid={Boolean(error)}
          onChange={(event) => updateField(setNewPassword, event.target.value)}
        />
      </label>
      <label className="password-field">
        <span>確認新密碼</span>
        <input
          type="password"
          value={confirmPassword}
          disabled={busy}
          autoComplete="new-password"
          autoCapitalize="none"
          spellCheck={false}
          aria-describedby={error ? 'change-password-error' : undefined}
          aria-invalid={Boolean(error)}
          onChange={(event) => updateField(setConfirmPassword, event.target.value)}
        />
      </label>
      <p className="password-policy-note" id="change-password-policy">新密碼長度為 8–128 個字元，可使用英文字母、數字或符號，不需混合特定字元類型。更新成功後會登出本裝置，請使用新密碼重新登入。</p>
      {busy && <p className="password-progress" role="status" aria-live="polite">正在安全更新密碼…</p>}
      {error && <p className="password-message error" id="change-password-error" role="alert" aria-live="assertive">{error}</p>}
      {success && <p className="password-message success" role="status" aria-live="polite"><Check size={16} />{PASSWORD_SUCCESS_MESSAGE}</p>}
      <div className="password-form-actions">
        <button type="button" className="secondary-button password-clear-button" onClick={clearForm} disabled={busy}>
          <X size={16} />清空／取消
        </button>
        <button type="submit" className="primary-button password-submit-button" disabled={busy} aria-busy={busy}>
          <KeyRound size={16} />{busy ? '更新中…' : '儲存新密碼'}
        </button>
      </div>
    </form>
  </section>
}
