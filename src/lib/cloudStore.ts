import { supabase } from './supabase'
import type { AttendanceRecord, AttendanceType, DemoData, NetworkMode } from './types'

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

export async function cloudRequest<T>(body?: Record<string, unknown>): Promise<T> {
  if (!supabase) throw new Error('網站的 Supabase 連線設定尚未完成，請聯絡管理者。')
  const { data, error } = await supabase.auth.getSession()
  if (error || !data.session) throw new Error('登入已失效，請重新登入。')
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

export const loadCloudData = () => cloudRequest<DemoData>()
export const punchCloud = (type: AttendanceType) => cloudRequest<{ ok: true; recordId: string }>({ action: 'punch', type })

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
export const saveNetworkCloud = (mode: NetworkMode, allowedIps: string[]) => cloudRequest<{ ok: true }>({ action: 'network.save', mode, allowedIps })
