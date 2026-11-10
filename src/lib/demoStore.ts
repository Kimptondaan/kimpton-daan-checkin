import type { AttendanceRecord, Department, DemoData, Employee, NetworkSettings } from './types'

const STORAGE_KEY = 'daan-kimpton-attendance-demo-v1'
const DEFAULT_PASSWORD = '00000000'

const todayAt = (hour: number, minute: number) => {
  const value = new Date()
  value.setHours(hour, minute, 0, 0)
  return value.toISOString()
}

const seedEmployees: Employee[] = [
  { id: 'emp-001', employeeNo: 'DA001', name: '林芷安', department: '客務部', departmentCode: 'FO', title: '前台接待', active: true, password: DEFAULT_PASSWORD, accessRole: 'employee' },
  { id: 'emp-002', employeeNo: 'DA002', name: '陳柏宇', department: '房務部', departmentCode: 'HK', title: '房務主任', active: true, password: DEFAULT_PASSWORD, accessRole: 'employee' },
  { id: 'emp-003', employeeNo: 'DA003', name: '黃詠晴', department: '餐飲部', departmentCode: 'FB', title: '餐飲服務', active: true, password: DEFAULT_PASSWORD, accessRole: 'employee' },
  { id: 'emp-004', employeeNo: 'DA004', name: '王昱翔', department: '工程部', departmentCode: 'EN', title: '工程主管', active: true, password: DEFAULT_PASSWORD, accessRole: 'manager' },
  { id: 'emp-005', employeeNo: 'DA005', name: '許雅雯', department: '管理部', departmentCode: 'AD', title: '人資專員', active: true, password: DEFAULT_PASSWORD, accessRole: 'hr' },
  { id: 'emp-006', employeeNo: 'DA006', name: 'IT 測試帳號', department: '管理部', departmentCode: 'AD', title: 'IT 管理員', active: true, password: DEFAULT_PASSWORD, accessRole: 'it' },
]

const seedDepartments: Department[] = [
  { id: 'dept-001', code: 'FO', name: '客務部', manager: '林經理', active: true },
  { id: 'dept-002', code: 'HK', name: '房務部', manager: '陳經理', active: true },
  { id: 'dept-003', code: 'FB', name: '餐飲部', manager: '黃經理', active: true },
  { id: 'dept-004', code: 'EN', name: '工程部', manager: '王經理', active: true },
  { id: 'dept-005', code: 'AD', name: '管理部', manager: '許經理', active: true },
]

const seedRecords: AttendanceRecord[] = [
  { id: 'rec-001', employeeId: 'emp-001', type: 'check_in', punchedAt: todayAt(8, 48), ip: '測試模式', networkName: '預覽環境', status: 'accepted' },
  { id: 'rec-002', employeeId: 'emp-002', type: 'check_in', punchedAt: todayAt(8, 56), ip: '測試模式', networkName: '預覽環境', status: 'accepted' },
  { id: 'rec-003', employeeId: 'emp-003', type: 'check_in', punchedAt: todayAt(9, 3), ip: '測試模式', networkName: '預覽環境', status: 'accepted' },
  { id: 'rec-004', employeeId: 'emp-001', type: 'check_out', punchedAt: todayAt(18, 12), ip: '測試模式', networkName: '預覽環境', status: 'accepted' },
]

const defaultData: DemoData = {
  employees: seedEmployees,
  departments: seedDepartments,
  adminPassword: DEFAULT_PASSWORD,
  records: seedRecords,
  network: { mode: 'test', allowedIps: [], updatedAt: new Date().toISOString() },
}

function cloneDefault(): DemoData {
  return JSON.parse(JSON.stringify(defaultData)) as DemoData
}

function normalizeData(value: Partial<DemoData>): DemoData {
  const departments = value.departments?.length ? value.departments : cloneDefault().departments
  const employees = (value.employees ?? cloneDefault().employees).map((employee) => ({
    ...employee,
    password: employee.password ?? DEFAULT_PASSWORD,
    accessRole: employee.accessRole ?? 'employee',
    departmentCode: employee.departmentCode ?? departments.find((department) => department.name === employee.department)?.code ?? departments[0]?.code ?? '',
  }))
  return {
    employees,
    departments,
    adminPassword: value.adminPassword ?? DEFAULT_PASSWORD,
    records: value.records ?? cloneDefault().records,
    network: value.network ?? cloneDefault().network,
  }
}

export function loadDemoData(): DemoData {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) return normalizeData(JSON.parse(stored) as Partial<DemoData>)
  } catch {
    // Preview may block storage in an embedded context; use in-memory defaults.
  }
  return cloneDefault()
}

export function saveDemoData(data: DemoData) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch {
    // Keep the preview usable even when browser storage is unavailable.
  }
}

export function resetDemoData() {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // no-op
  }
  return cloneDefault()
}

export function createRecord(employeeId: string, type: AttendanceRecord['type'], network: DemoData['network']): AttendanceRecord {
  return {
    id: `rec-${Date.now()}`,
    employeeId,
    type,
    punchedAt: new Date().toISOString(),
    ip: network.mode === 'test' ? '測試模式' : network.allowedIps[0] || '未設定',
    networkName: network.mode === 'test' ? '預覽環境' : '公司允許網路',
    status: 'accepted',
  }
}

export function isSameDay(dateA: string, dateB = new Date().toISOString()) {
  const a = new Date(dateA)
  const b = new Date(dateB)
  return a.toLocaleDateString('zh-TW') === b.toLocaleDateString('zh-TW')
}

export function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('zh-TW', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

export function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-TW', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).format(new Date(value))
}

export function toTxt(records: AttendanceRecord[], employees: Employee[]) {
  return records.map((record) => {
    const employee = employees.find((item) => item.id === record.employeeId)
    const punchedAt = new Date(record.punchedAt)
    const date = `${punchedAt.getFullYear()}${String(punchedAt.getMonth() + 1).padStart(2, '0')}${String(punchedAt.getDate()).padStart(2, '0')}`
    const time = `${String(punchedAt.getHours()).padStart(2, '0')}${String(punchedAt.getMinutes()).padStart(2, '0')}`
    const punchCode = record.type === 'check_in' ? 'F1' : 'F2'
    return `${date}${time}${employee?.employeeNo ?? ''}${punchCode}`
  }).join('\n')
}

export type { Department, DemoData, Employee, NetworkSettings }
