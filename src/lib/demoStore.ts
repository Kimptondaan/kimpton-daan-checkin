import type { AttendanceRecord, Department, DemoData, Employee, NetworkSettings } from './types'

// Compatibility filename only: all live data now comes from Supabase.
// No demo employees, passwords, localStorage writes or reset operations remain.
export const ATTENDANCE_TIMEZONE = 'Asia/Taipei'

const localParts = (value: string) => {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error('刷卡時間格式不正確。')
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ATTENDANCE_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date)
  return Object.fromEntries(parts.map(part => [part.type, part.value]))
}

export function toTaipeiLocal(value: string) {
  const p = localParts(value)
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`
}

export function fromTaipeiLocal(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('請選擇完整日期與時間。')
  const date = new Date(`${value}:00+08:00`)
  if (!Number.isFinite(date.getTime()) || toTaipeiLocal(date.toISOString()) !== value) throw new Error('日期或時間不正確。')
  return date.toISOString()
}

export function isSameDay(dateA: string, dateB = new Date().toISOString()) {
  return toTaipeiLocal(dateA).slice(0, 10) === toTaipeiLocal(dateB).slice(0, 10)
}

export function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: ATTENDANCE_TIMEZONE,
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(value))
}

export function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: ATTENDANCE_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).format(new Date(value))
}

export function toTxt(records: AttendanceRecord[], employees: Employee[]) {
  const employeeById = new Map(employees.map(employee => [employee.id, employee]))
  return [...records]
    .filter(record => record.status !== 'rejected')
    .sort((a, b) => new Date(a.punchedAt).getTime() - new Date(b.punchedAt).getTime() || a.id.localeCompare(b.id))
    .map(record => {
      const employee = employeeById.get(record.employeeId)
      if (!employee || !employee.employeeNo) throw new Error('找不到紀錄所屬員工，請重新整理後再下載。')
      const p = localParts(record.punchedAt)
      const punchCode = record.type === 'check_in' ? 'F1' : 'F2'
      return `${p.year}${p.month}${p.day}${p.hour}${p.minute}${employee.employeeNo}${punchCode}`
    }).join('\r\n')
}

export type { Department, DemoData, Employee, NetworkSettings }
