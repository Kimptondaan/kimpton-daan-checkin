import { createClient } from '@supabase/supabase-js'

const fail = (message, status = 400) => Object.assign(new Error(message), { status })

export function validateOwnPasswordChange(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['action', 'currentPassword', 'newPassword'].includes(key))) {
    throw fail('只能修改目前登入帳號自己的密碼，請勿指定其他帳號。')
  }
  if (typeof input.currentPassword !== 'string' || !input.currentPassword
    || Array.from(input.currentPassword).length > 128) {
    throw fail('請輸入目前密碼。')
  }
  if (typeof input.newPassword !== 'string') throw fail('請輸入新密碼。')
  const length = Array.from(input.newPassword).length
  if (length < 8 || length > 128) throw fail('新密碼至少需要 8 個字元，最多 128 個字元。')
  if (/\p{Cc}/u.test(input.newPassword)) throw fail('新密碼不可包含換行或控制字元。')
  if (input.newPassword === input.currentPassword) throw fail('新密碼不可與目前密碼相同。')
  return { currentPassword: input.currentPassword, newPassword: input.newPassword }
}

async function timedFetch(input, init) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  init?.signal?.addEventListener('abort', abort, { once: true })
  if (init?.signal?.aborted) controller.abort()
  const timer = setTimeout(abort, 8000)
  try { return await fetch(input, { ...init, signal: controller.signal }) }
  finally { clearTimeout(timer); init?.signal?.removeEventListener('abort', abort) }
}

function createVerificationClient() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
  if (!url || !anonKey) throw fail('伺服器的密碼驗證設定尚未完成，請聯絡管理者。', 503)
  // Public-key Auth only: no service role and no persistent browser/global session.
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: timedFetch },
  })
}

export async function handleOwnPasswordChange(user, profile, input, makeClient = createVerificationClient) {
  const { currentPassword, newPassword } = validateOwnPasswordChange(input)
  if (!profile?.is_active || !user?.id || user.id !== profile.id || !user.email) {
    throw fail('登入已失效或帳號已停用，請重新登入。', 403)
  }
  const verifier = makeClient()
  let verified = false
  try {
    // Email comes from the server-verified Auth user, never from the request body.
    const { data, error } = await verifier.auth.signInWithPassword({ email: user.email, password: currentPassword })
    if (error) {
      if (error.code === 'invalid_credentials' || (error.status === 400 && !error.code)) {
        throw fail('目前密碼不正確，請重新輸入。')
      }
      if (error.status === 429) throw fail('嘗試次數過多，請稍後再試。', 429)
      throw fail('目前密碼驗證未完成，請檢查網路或稍後再試。', 503)
    }
    verified = Boolean(data?.user)
    if (!data?.user || data.user.id !== profile.id) throw fail('目前密碼驗證失敗，未修改密碼。', 403)
    const result = await verifier.auth.updateUser({ password: newPassword })
    if (result.error) {
      if (result.error.code === 'same_password') throw fail('新密碼不可與目前密碼相同。')
      if (result.error.code === 'weak_password') throw fail('新密碼不符合 Supabase 安全政策，請使用更安全的密碼。')
      if (result.error.status === 429) throw fail('操作次數過多，請稍後再試。', 429)
      throw fail('密碼更新結果未確認；請稍後以新密碼嘗試登入，勿反覆送出。', 502)
    }
    if (result.data?.user?.id !== profile.id) {
      throw fail('密碼更新結果未確認，請重新登入後檢查。', 502)
    }
    return { ok: true }
  } finally {
    // Close only the temporary verification session; never sign out other users.
    if (verified) {
      try { await verifier.auth.signOut({ scope: 'local' }) } catch { /* No plaintext logging. */ }
    }
  }
}
