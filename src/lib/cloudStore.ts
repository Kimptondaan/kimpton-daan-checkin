import { supabase } from './supabase'
import type { Announcement, AttendanceRecord, AttendanceType, DemoData, NetworkCheckResult, NetworkMode } from './types'

export type EmployeeWrite = {
  employeeNo: string
  name: string
  departmentCode: string
  title: string
  accessRole: NonNullable<import('./types').Employee['accessRole']>
}

export type EmployeePatch = EmployeeWrite
export type DepartmentWrite = { code: string; name: string; manager: string }
export type AttendanceWrite = { employeeId: string; type: AttendanceType; punchedAt: string }
export type ImportResult = { imported: number; failed: number }

export async function cloudRequest<T>(body?: Record<string, unknown>, expectedUserId?: string): Promise<T> {
  if (!supabase) throw new Error('網站的 Supabase 連線設定尚未完成，請聯絡管理者。')
  const { data, error } = await supabase.auth.getSession()
  if (error || !data.session) throw new Error('登入已失效，請重新登入。')
  if (expectedUserId && data.session.user.id !== expectedUserId) throw new Error('登入帳號已在其他分頁變更；請重新整理或重新登入，再確認自己的姓名後刷卡。')
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), body?.action === 'employees.import' ? 55000 : 20000)
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
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('雲端操作逾時或已取消；請先確認是否已寫入，再決定是否重試。')
    throw error
  } finally { window.clearTimeout(timer) }
}

export async function loadCloudData(): Promise<DemoData> {
  const snapshot = await cloudRequest<DemoData>()
  return { ...snapshot, announcement: snapshot.announcement ?? { format: 'text', items: [], version: 0, updatedAt: null, available: false } }
}
export const punchCloud = (type: AttendanceType, expectedUserId?: string) => cloudRequest<{ ok: true; recordId: string }>({ action: 'punch', type }, expectedUserId)

export const addEmployeeCloud = (employee: EmployeeWrite) => cloudRequest<{ ok: true; id: string }>({ action: 'employee.create', employee })
export const updateEmployeeCloud = (id: string, patch: EmployeePatch) => cloudRequest<{ ok: true }>({ action: 'employee.update', id, patch })
export const setEmployeeActiveCloud = (id: string, active: boolean) => cloudRequest<{ ok: true; warning?: string }>({ action: 'employee.active', id, active })
export const setPasswordCloud = (id: string, password: string) => cloudRequest<{ ok: true }>({ action: 'password.set', id, password })

export async function importEmployeesCloud(rows: string[][]): Promise<ImportResult> {
  const result = await cloudRequest<Partial<ImportResult>>({ action: 'employees.import', rows })
  return { imported: Number(result.imported ?? 0), failed: Number(result.failed ?? 0) }
}

export const addDepartmentCloud = (department: DepartmentWrite) => cloudRequest<{ ok: true; id: string }>({ action: 'department.create', department })
export const updateDepartmentCloud = (id: string, patch: Partial<DepartmentWrite>) => cloudRequest<{ ok: true }>({ action: 'department.update', id, patch })

export const addAttendanceCloud = (record: AttendanceWrite) => cloudRequest<{ ok: true; recordId: string }>({ action: 'attendance.create', record })
export const updateAttendanceCloud = (id: string, patch: Pick<AttendanceRecord, 'type' | 'punchedAt'>) => cloudRequest<{ ok: true }>({ action: 'attendance.update', id, patch })
export const saveNetworkCloud = (mode: NetworkMode, allowedIps: string[], adminIpExempt?: boolean) => cloudRequest<{ ok: true }>({ action: 'network.save', mode, allowedIps, ...(adminIpExempt === undefined ? {} : { adminIpExempt }) })
export const checkNetworkCloud = (expectedUserId?: string) => cloudRequest<NetworkCheckResult>({ action: 'network.check' }, expectedUserId)

export const saveAnnouncementCloud = (format: Announcement['format'], items: string[], expectedVersion: number, expectedUserId?: string) =>
  cloudRequest<{ ok: true; announcement: Announcement }>({ action: 'announcement.save', format, items, expectedVersion }, expectedUserId)
