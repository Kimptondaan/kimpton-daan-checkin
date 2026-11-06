export type UserRole = 'employee' | 'admin' | 'hr' | 'manager'
export type AttendanceType = 'check_in' | 'check_out'
export type NetworkMode = 'test' | 'strict'

export interface Employee {
  id: string
  employeeNo: string
  name: string
  department: string
  departmentCode?: string
  title: string
  active: boolean
  password?: string
  accessRole?: UserRole
}

export interface Department {
  id: string
  code: string
  name: string
  manager: string
  active: boolean
}

export interface AttendanceRecord {
  id: string
  employeeId: string
  type: AttendanceType
  punchedAt: string
  ip: string
  networkName: string
  status: 'accepted' | 'rejected' | 'manual'
}

export interface NetworkSettings {
  mode: NetworkMode
  allowedIps: string[]
  updatedAt: string
}

export interface DemoData {
  employees: Employee[]
  departments: Department[]
  adminPassword: string
  records: AttendanceRecord[]
  network: NetworkSettings
}
