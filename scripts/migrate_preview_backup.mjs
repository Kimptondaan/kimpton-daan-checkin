import fs from 'node:fs/promises'

const backupPath = process.argv[2]
if (!backupPath) throw new Error('用法：node scripts/migrate_preview_backup.mjs <預覽資料備份.json>')

const url = process.env.VITE_SUPABASE_URL
const secret = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !secret) throw new Error('缺少 Supabase 伺服器環境變數')

const backup = JSON.parse(await fs.readFile(backupPath, 'utf8'))
const departments = Array.isArray(backup.departments) ? backup.departments : []
const employees = Array.isArray(backup.employees) ? backup.employees : []
const records = Array.isArray(backup.records) ? backup.records : []
const passwordFallback = '00000000'
const headers = {
  apikey: secret,
  Authorization: `Bearer ${secret}`,
  'Content-Type': 'application/json',
}

async function api(path, options = {}) {
  const response = await fetch(`${url}${path}`, { ...options, headers: { ...headers, ...(options.headers || {}) } })
  const text = await response.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path} ${response.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`)
  return body
}

const existingUsers = []
for (let page = 1; ; page += 1) {
  const result = await api(`/auth/v1/admin/users?page=${page}&per_page=1000`)
  const pageUsers = result.users || []
  existingUsers.push(...pageUsers)
  if (pageUsers.length < 1000) break
}
const userByEmail = new Map(existingUsers.map((user) => [user.email, user]))
const departmentByCode = new Map()

for (const department of departments) {
  const row = {
    code: String(department.code || '').trim().toUpperCase(),
    name: String(department.name || '').trim(),
    manager_name: String(department.manager || '').trim(),
    is_active: department.active !== false,
  }
  if (!row.code || !row.name) continue
  const result = await api('/rest/v1/departments?on_conflict=code', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(row),
  })
  const saved = Array.isArray(result) ? result[0] : result
  if (saved?.id) departmentByCode.set(row.code, saved.id)
}

const employeeIdMap = new Map()
for (const employee of employees) {
  const employeeNo = String(employee.employeeNo || '').trim().toUpperCase()
  if (!employeeNo) continue
  const email = `${employeeNo.toLowerCase()}@checkin.kimptondaan.local`
  let user = userByEmail.get(email)
  if (!user) {
    user = await api('/auth/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password: employee.password || passwordFallback,
        email_confirm: true,
        user_metadata: { employee_no: employeeNo, full_name: employee.name || '' },
      }),
    })
    userByEmail.set(email, user)
  }
  const departmentCode = String(employee.departmentCode || '').trim().toUpperCase()
  const profile = {
    id: user.id,
    employee_no: employeeNo,
    full_name: String(employee.name || employeeNo).trim(),
    department_id: departmentByCode.get(departmentCode) || null,
    job_title: String(employee.title || '').trim(),
    role: employee.accessRole || 'employee',
    is_active: employee.active !== false,
  }
  await api('/rest/v1/profiles?on_conflict=employee_no', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(profile),
  })
  employeeIdMap.set(employee.id, user.id)
}

for (const record of records) {
  const employeeId = employeeIdMap.get(record.employeeId)
  if (!employeeId) continue
  await api('/rest/v1/attendance_records', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify({
      id: crypto.randomUUID(),
      employee_id: employeeId,
      attendance_type: record.type,
      punched_at: record.punchedAt,
      client_ip: null,
      matched_network_id: null,
      user_agent: 'preview-migration',
      status: record.status || 'accepted',
      note: '預覽資料搬移',
    }),
  })
}

console.log(JSON.stringify({
  ok: true,
  departments: departmentByCode.size,
  employees: employeeIdMap.size,
  attendanceRecords: records.filter((record) => employeeIdMap.has(record.employeeId)).length,
}))
