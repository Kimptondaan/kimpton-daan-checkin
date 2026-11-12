import { supabase } from './supabase'
import type { DemoData, AttendanceType } from './types'

export async function cloudRequest<T>(body?: Record<string, unknown>): Promise<T> {
  if (!supabase) throw new Error('網站的 Supabase 連線設定尚未完成，請聯絡管理者。')
  const { data, error } = await supabase.auth.getSession()
  if (error || !data.session) throw new Error('登入已失效，請重新登入。')
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 20000)
  try {
    const response = await fetch('/api/attendance', {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${data.session.access_token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      signal: controller.signal,
    })
    const result = await response.json().catch(() => null)
    if (!response.ok || !result) throw Object.assign(new Error(result?.message || '雲端資料服務尚未就緒，請聯絡管理者。'), { status: response.status })
    return result as T
  } finally { window.clearTimeout(timer) }
}

export const loadCloudData = () => cloudRequest<DemoData>()
export const punchCloud = (type: AttendanceType) => cloudRequest<{ ok: true; recordId: string }>({ action: 'punch', type })
