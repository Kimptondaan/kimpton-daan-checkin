import fs from 'node:fs/promises'
import net from 'node:net'
import { createHash } from 'node:crypto'

const SOURCE_DATASET_KEY = 'daanattend-preview-migration-v1'
const ADMIN_EMAIL = 'admin@checkin.kimptondaan.local'
const ADMIN_EMPLOYEE_NO = 'ADMIN'
const ADMIN_FULL_NAME = 'ADMIN'
const SUPPORTED_ROLES = new Set(['employee', 'admin', 'hr', 'it', 'manager'])
const SUPPORTED_TYPES = new Set(['check_in', 'check_out'])
const SUPPORTED_STATUSES = new Set(['accepted', 'rejected', 'manual'])
const MAX_AUTH_PAGE_SIZE = 1000

class PrecheckError extends Error {
  constructor(issues, networkPending = false) {
    super('precheck_failed')
    this.name = 'PrecheckError'
    this.issues = issues
    this.networkPending = networkPending
  }
}

class MigrationError extends Error {
  constructor(code, details = {}) {
    super(code)
    this.name = 'MigrationError'
    this.code = code
    this.details = details
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requiredText(value, path, issues) {
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push({ code: 'required_text', path })
    return null
  }
  return value.trim()
}

function optionalText(value, path, issues) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') {
    issues.push({ code: 'text_type', path })
    return ''
  }
  return value.trim()
}

function requiredBoolean(value, path, issues) {
  if (typeof value !== 'boolean') {
    issues.push({ code: 'required_boolean', path })
    return null
  }
  return value
}

function normalizedCode(value, path, issues) {
  const text = requiredText(value, path, issues)
  return text === null ? null : text.toUpperCase()
}

function validateBackup(backup) {
  const issues = []
  if (!isRecord(backup)) {
    throw new PrecheckError([{ code: 'backup_object_required', path: '$' }])
  }

  const adminPassword = requiredText(backup.adminPassword, 'adminPassword', issues)
  if (adminPassword && adminPassword.length < 6) {
    issues.push({ code: 'admin_password_too_short', path: 'adminPassword' })
  }

  const rawDepartments = backup.departments
  const rawEmployees = backup.employees
  const rawRecords = backup.records
  const rawNetwork = backup.network
  if (!Array.isArray(rawDepartments)) issues.push({ code: 'array_required', path: 'departments' })
  if (!Array.isArray(rawEmployees)) issues.push({ code: 'array_required', path: 'employees' })
  if (!Array.isArray(rawRecords)) issues.push({ code: 'array_required', path: 'records' })
  if (!isRecord(rawNetwork)) issues.push({ code: 'object_required', path: 'network' })

  const departments = []
  const departmentByCode = new Map()
  for (const [index, source] of (Array.isArray(rawDepartments) ? rawDepartments : []).entries()) {
    const path = `departments[${index}]`
    if (!isRecord(source)) {
      issues.push({ code: 'object_required', path })
      continue
    }
    const code = normalizedCode(source.code, `${path}.code`, issues)
    const name = requiredText(source.name, `${path}.name`, issues)
    const manager = optionalText(source.manager, `${path}.manager`, issues)
    const active = requiredBoolean(source.active, `${path}.active`, issues)
    if (code && departmentByCode.has(code)) issues.push({ code: 'duplicate_department_code', path: `${path}.code` })
    if (code && !departmentByCode.has(code)) {
      const row = { code, name, manager, active }
      departmentByCode.set(code, row)
      departments.push(row)
    }
  }

  const employees = []
  const employeeBySourceId = new Map()
  const employeeNoSet = new Set()
  const employeeIdSet = new Set()
  for (const [index, source] of (Array.isArray(rawEmployees) ? rawEmployees : []).entries()) {
    const path = `employees[${index}]`
    if (!isRecord(source)) {
      issues.push({ code: 'object_required', path })
      continue
    }
    const sourceId = requiredText(source.id, `${path}.id`, issues)
    const employeeNo = normalizedCode(source.employeeNo, `${path}.employeeNo`, issues)
    const name = requiredText(source.name, `${path}.name`, issues)
    const departmentCode = normalizedCode(source.departmentCode, `${path}.departmentCode`, issues)
    const title = optionalText(source.title, `${path}.title`, issues)
    const role = requiredText(source.accessRole, `${path}.accessRole`, issues)
    const password = requiredText(source.password, `${path}.password`, issues)
    const active = requiredBoolean(source.active, `${path}.active`, issues)

    if (sourceId && employeeIdSet.has(sourceId)) issues.push({ code: 'duplicate_employee_id', path: `${path}.id` })
    if (sourceId) employeeIdSet.add(sourceId)
    if (employeeNo && employeeNoSet.has(employeeNo)) issues.push({ code: 'duplicate_employee_no', path: `${path}.employeeNo` })
    if (employeeNo) employeeNoSet.add(employeeNo)
    if (employeeNo === ADMIN_EMPLOYEE_NO) issues.push({ code: 'reserved_employee_no', path: `${path}.employeeNo` })
    if (role && !SUPPORTED_ROLES.has(role)) issues.push({ code: 'invalid_role', path: `${path}.accessRole` })
    if (departmentCode && !departmentByCode.has(departmentCode)) issues.push({ code: 'unmapped_department_code', path: `${path}.departmentCode` })

    if (sourceId && !employeeBySourceId.has(sourceId)) {
      const employee = { sourceId, employeeNo, name, departmentCode, title, role, password, active }
      employeeBySourceId.set(sourceId, employee)
      employees.push(employee)
    }
  }

  const records = []
  const recordIdSet = new Set()
  for (const [index, source] of (Array.isArray(rawRecords) ? rawRecords : []).entries()) {
    const path = `records[${index}]`
    if (!isRecord(source)) {
      issues.push({ code: 'object_required', path })
      continue
    }
    const sourceId = requiredText(source.id, `${path}.id`, issues)
    const employeeId = requiredText(source.employeeId, `${path}.employeeId`, issues)
    const type = requiredText(source.type, `${path}.type`, issues)
    const punchedAt = requiredText(source.punchedAt, `${path}.punchedAt`, issues)
    const ip = requiredText(source.ip, `${path}.ip`, issues)
    const networkName = requiredText(source.networkName, `${path}.networkName`, issues)
    const status = requiredText(source.status, `${path}.status`, issues)

    if (sourceId && recordIdSet.has(sourceId)) issues.push({ code: 'duplicate_record_id', path: `${path}.id` })
    if (sourceId) recordIdSet.add(sourceId)
    if (employeeId && !employeeBySourceId.has(employeeId)) issues.push({ code: 'unmapped_record_employee_id', path: `${path}.employeeId` })
    if (type && !SUPPORTED_TYPES.has(type)) issues.push({ code: 'invalid_attendance_type', path: `${path}.type` })
    if (status && !SUPPORTED_STATUSES.has(status)) issues.push({ code: 'invalid_status', path: `${path}.status` })
    if (punchedAt && !Number.isFinite(Date.parse(punchedAt))) issues.push({ code: 'invalid_date', path: `${path}.punchedAt` })

    if (sourceId) {
      records.push({ sourceId, employeeId, type, punchedAt, ip, networkName, status })
    }
  }

  let networkMode = null
  let allowedIps = []
  if (isRecord(rawNetwork)) {
    networkMode = requiredText(rawNetwork.mode, 'network.mode', issues)
    if (networkMode && !new Set(['test', 'strict']).has(networkMode)) {
      issues.push({ code: 'invalid_network_mode', path: 'network.mode' })
    }
    if (!Array.isArray(rawNetwork.allowedIps)) {
      issues.push({ code: 'array_required', path: 'network.allowedIps' })
    } else {
      for (const [index, value] of rawNetwork.allowedIps.entries()) {
        const ip = requiredText(value, `network.allowedIps[${index}]`, issues)
        if (ip && net.isIP(ip) === 0) issues.push({ code: 'invalid_ip', path: `network.allowedIps[${index}]` })
        if (ip) allowedIps.push(ip)
      }
    }
    if (networkMode === 'strict' && allowedIps.length === 0) {
      issues.push({ code: 'strict_network_requires_ip', path: 'network.allowedIps' })
    }
    if (networkMode === 'strict' && allowedIps.length > 0) {
      issues.push({ code: 'strict_network_pending_schema', path: 'network.mode' })
    }
    if (rawNetwork.updatedAt !== undefined && (typeof rawNetwork.updatedAt !== 'string' || !Number.isFinite(Date.parse(rawNetwork.updatedAt)))) {
      issues.push({ code: 'invalid_date', path: 'network.updatedAt' })
    }
  }

  const networkPending = networkMode === 'test' || (networkMode === 'strict' && allowedIps.length > 0)
  if (issues.length > 0) throw new PrecheckError(issues, networkPending)

  return {
    adminPassword,
    departments,
    employees,
    records,
    network: { mode: networkMode, allowedIps },
    networkPending,
  }
}

function stableAttendanceUuid(sourceRecordId) {
  const digest = createHash('sha256')
    .update(`${SOURCE_DATASET_KEY}:${sourceRecordId}`, 'utf8')
    .digest()
  const bytes = Buffer.from(digest.subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function clientIpFor(record) {
  // The preview's networkName is the source network field. Only a real IP belongs in inet.
  return net.isIP(record.networkName) === 0 ? null : record.networkName
}

function sourceNoteFor(record) {
  return `preview-migration; source_id=${record.sourceId}; source_ip=${record.ip}; source_network_name=${record.networkName}`
}

function resourceName(path) {
  return path.split('?')[0].replace(/^\/rest\/v1\//, 'rest.v1.').replace(/^\/auth\/v1\//, 'auth.v1.')
}

function buildApiClient(url, secret) {
  const headers = {
    apikey: secret,
    Authorization: `Bearer ${secret}`,
    'Content-Type': 'application/json',
  }

  return async function api(path, options = {}) {
    const resource = resourceName(path)
    let response
    try {
      response = await fetch(`${url}${path}`, {
        ...options,
        headers: { ...headers, ...(options.headers || {}) },
      })
    } catch {
      throw new MigrationError('api_unreachable', { resource })
    }

    const text = await response.text()
    let body = null
    if (text) {
      try {
        body = JSON.parse(text)
      } catch {
        if (response.ok) throw new MigrationError('api_invalid_response', { resource })
      }
    }
    if (!response.ok) throw new MigrationError('api_request_failed', { resource, status: response.status })
    return body
  }
}

async function listAuthUsers(api) {
  const users = []
  for (let page = 1; ; page += 1) {
    const result = await api(`/auth/v1/admin/users?page=${page}&per_page=${MAX_AUTH_PAGE_SIZE}`)
    if (!isRecord(result) || !Array.isArray(result.users)) throw new MigrationError('api_invalid_users_response', { resource: 'auth.v1.admin.users' })
    users.push(...result.users)
    if (result.users.length < MAX_AUTH_PAGE_SIZE) return users
  }
}

async function findProfileByEmployeeNo(api, employeeNo) {
  const query = `/rest/v1/profiles?employee_no=eq.${encodeURIComponent(employeeNo)}&select=id,employee_no&limit=2`
  const result = await api(query)
  if (!Array.isArray(result)) throw new MigrationError('api_invalid_profiles_response', { resource: 'rest.v1.profiles' })
  if (result.length > 1) throw new MigrationError('target_duplicate_employee_no', { resource: 'rest.v1.profiles' })
  const profile = result[0]
  if (profile && typeof profile.id !== 'string') throw new MigrationError('target_profile_missing_id', { resource: 'rest.v1.profiles' })
  return profile || null
}

async function upsertDepartment(api, department) {
  const result = await api('/rest/v1/departments?on_conflict=code', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({
      code: department.code,
      name: department.name,
      manager_name: department.manager,
      is_active: department.active,
    }),
  })
  const saved = Array.isArray(result) ? result[0] : result
  if (!isRecord(saved) || typeof saved.id !== 'string') throw new MigrationError('api_invalid_department_response', { resource: 'rest.v1.departments' })
  return saved.id
}

async function upsertProfile(api, profile) {
  await api('/rest/v1/profiles?on_conflict=employee_no', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(profile),
  })
}

async function createAuthUser(api, email, password, metadata) {
  const result = await api('/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: metadata }),
  })
  if (!isRecord(result) || typeof result.id !== 'string') throw new MigrationError('api_invalid_auth_user_response', { resource: 'auth.v1.admin.users' })
  return result
}

async function migrate(validated, api) {
  const counts = {
    departmentsSeen: validated.departments.length,
    departmentsUpserted: 0,
    employeesSeen: validated.employees.length,
    profilesUpserted: 0,
    attendanceSeen: validated.records.length,
    attendanceInserted: 0,
    attendanceExisting: 0,
    adminAuthCreated: 0,
    adminProfileCreated: 0,
  }

  const departmentIdByCode = new Map()
  for (const department of validated.departments) {
    const id = await upsertDepartment(api, department)
    departmentIdByCode.set(department.code, id)
    counts.departmentsUpserted += 1
  }

  const existingUsers = await listAuthUsers(api)
  const userByEmail = new Map()
  for (const user of existingUsers) {
    if (typeof user?.email === 'string' && typeof user?.id === 'string') userByEmail.set(user.email.toLowerCase(), user)
  }

  const adminAuth = userByEmail.get(ADMIN_EMAIL)
  let adminUser = adminAuth
  if (!adminUser) {
    adminUser = await createAuthUser(api, ADMIN_EMAIL, validated.adminPassword, { employee_no: ADMIN_EMPLOYEE_NO, full_name: ADMIN_FULL_NAME })
    userByEmail.set(ADMIN_EMAIL, adminUser)
    counts.adminAuthCreated += 1
  }
  const existingAdminProfile = await findProfileByEmployeeNo(api, ADMIN_EMPLOYEE_NO)
  if (!existingAdminProfile) {
    await upsertProfile(api, {
      id: adminUser.id,
      employee_no: ADMIN_EMPLOYEE_NO,
      full_name: ADMIN_FULL_NAME,
      department_id: null,
      job_title: 'System Administrator',
      role: 'admin',
      is_active: true,
    })
    counts.adminProfileCreated += 1
  }

  const targetIdBySourceId = new Map()
  for (const employee of validated.employees) {
    // A profile found by employee_no wins over the source UUID and over email lookup.
    const existingProfile = await findProfileByEmployeeNo(api, employee.employeeNo)
    const email = `${employee.employeeNo.toLowerCase()}@checkin.kimptondaan.local`
    const existingUser = userByEmail.get(email)
    let user = existingProfile ? { id: existingProfile.id } : existingUser
    if (!user) {
      user = await createAuthUser(api, email, employee.password, {
        employee_no: employee.employeeNo,
        full_name: employee.name,
      })
      userByEmail.set(email, user)
    }

    const departmentId = departmentIdByCode.get(employee.departmentCode)
    if (!departmentId) throw new MigrationError('department_mapping_missing', { resource: 'rest.v1.departments' })
    await upsertProfile(api, {
      id: user.id,
      employee_no: employee.employeeNo,
      full_name: employee.name,
      department_id: departmentId,
      job_title: employee.title,
      role: employee.role,
      is_active: employee.active,
    })
    targetIdBySourceId.set(employee.sourceId, user.id)
    counts.profilesUpserted += 1
  }

  for (const record of validated.records) {
    const employeeId = targetIdBySourceId.get(record.employeeId)
    if (!employeeId) throw new MigrationError('record_mapping_missing', { resource: 'rest.v1.attendance_records' })
    const result = await api('/rest/v1/attendance_records', {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
      body: JSON.stringify({
        id: stableAttendanceUuid(record.sourceId),
        employee_id: employeeId,
        attendance_type: record.type,
        punched_at: new Date(record.punchedAt).toISOString(),
        client_ip: clientIpFor(record),
        matched_network_id: null,
        user_agent: 'preview-migration',
        status: record.status,
        note: sourceNoteFor(record),
      }),
    })
    if (!Array.isArray(result)) throw new MigrationError('api_invalid_attendance_response', { resource: 'rest.v1.attendance_records' })
    if (result.length === 0) counts.attendanceExisting += 1
    else counts.attendanceInserted += result.length
  }

  return { counts, networkPending: validated.networkPending }
}

function printSuccess({ dryRun, counts, networkPending }) {
  console.log(JSON.stringify({ ok: true, dryRun, networkPending, counts }))
}

function printFailure(error) {
  if (error instanceof PrecheckError) {
    console.error(JSON.stringify({
      ok: false,
      error: 'precheck_failed',
      issueCount: error.issues.length,
      issues: error.issues,
      networkPending: error.networkPending,
    }))
    return
  }
  if (error instanceof MigrationError) {
    console.error(JSON.stringify({ ok: false, error: error.code, ...error.details }))
    return
  }
  if (error?.code === 'ENOENT') {
    console.error(JSON.stringify({ ok: false, error: 'backup_read_failed' }))
    return
  }
  if (error instanceof SyntaxError) {
    console.error(JSON.stringify({ ok: false, error: 'backup_json_invalid' }))
    return
  }
  console.error(JSON.stringify({ ok: false, error: 'migration_failed' }))
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const paths = args.filter((argument) => argument !== '--dry-run')
  if (paths.length !== 1 || paths[0].startsWith('-')) {
    throw new MigrationError('usage', { usage: 'node scripts/migrate_preview_backup.mjs [--dry-run] <backup.json>' })
  }

  let backup
  try {
    backup = JSON.parse(await fs.readFile(paths[0], 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') throw error
    if (error instanceof SyntaxError) throw error
    throw new MigrationError('backup_read_failed')
  }

  const validated = validateBackup(backup)
  if (dryRun) {
    printSuccess({
      dryRun: true,
      networkPending: validated.networkPending,
      counts: {
        departments: validated.departments.length,
        employees: validated.employees.length,
        attendanceRecords: validated.records.length,
      },
    })
    return
  }

  const url = process.env.VITE_SUPABASE_URL
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !secret) throw new MigrationError('missing_supabase_environment')
  try {
    new URL(url)
  } catch {
    throw new MigrationError('invalid_supabase_url')
  }

  const api = buildApiClient(url, secret)
  const result = await migrate(validated, api)
  printSuccess({ dryRun: false, ...result })
}

try {
  await main()
} catch (error) {
  printFailure(error)
  process.exitCode = 1
}
