import { createClient } from '@supabase/supabase-js'
import { BlockList, isIP } from 'node:net'

const AUTH_EMAIL_DOMAIN = 'checkin.kimptondaan.local'
const DEFAULT_PASSWORD = '00000000'
const LONG_BAN = '876000h'
const VALID_ROLES = new Set(['employee', 'manager', 'hr', 'it', 'admin'])
const VALID_ATTENDANCE_TYPES = new Set(['check_in', 'check_out'])
const ZERO_UUID = '00000000-0000-0000-0000-000000000000'

const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store',
  },
})

const fail = (message, status = 500) => Object.assign(new Error(message), { status })

const isUuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)

const trimText = (value, maxLength = 512) => typeof value === 'string' ? value.trim().slice(0, maxLength) : ''

function normalizeEmployeeNo(value) {
  const normalized = trimText(value, 64).toUpperCase()
  return /^[A-Z0-9][A-Z0-9._-]*$/.test(normalized) ? normalized : ''
}

function passwordValue(value, allowDefault = false) {
  if (value === undefined && allowDefault) return DEFAULT_PASSWORD
  if (typeof value !== 'string' || value.length < 6 || value.length > 128) return ''
  return value
}

function parseTimestamp(value) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/)
  if (!m) return ''
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number)
  const calendar = new Date(0)
  calendar.setUTCFullYear(year, month - 1, day)
  calendar.setUTCHours(hour, minute, second, 0)
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day
    || calendar.getUTCHours() !== hour || calendar.getUTCMinutes() !== minute || calendar.getUTCSeconds() !== second) return ''
  const date = new Date(text)
  return Number.isFinite(date.getTime()) ? date.toISOString() : ''
}

function authEmail(employeeNo) {
  return `${employeeNo.toLowerCase()}@${AUTH_EMAIL_DOMAIN}`
}

export function networkMatches(ip, cidr) {
  const family = isIP(ip)
  if (!family || typeof cidr !== 'string') return false
  const parts = cidr.split('/')
  if (parts.length > 2) return false
  const address = parts[0]
  if (isIP(address) !== family) return false
  const prefix = parts[1] === undefined ? (family === 4 ? 32 : 128) : Number(parts[1])
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)) return false
  try {
    const list = new BlockList()
    list.addSubnet(address, prefix, family === 4 ? 'ipv4' : 'ipv6')
    return list.check(ip, family === 4 ? 'ipv4' : 'ipv6')
  } catch {
    return false
  }
}

function normalizeCidr(value) {
  if (typeof value !== 'string') return ''
  const raw = value.trim()
  const parts = raw.split('/')
  if (parts.length > 2 || !parts[0]) return ''
  const family = isIP(parts[0])
  if (!family) return ''
  if (parts[1] !== undefined && !/^\d{1,3}$/.test(parts[1])) return ''
  const prefix = parts[1] === undefined ? (family === 4 ? 32 : 128) : Number(parts[1])
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)) return ''
  const normalized = `${parts[0].toLowerCase()}/${prefix}`
  return networkMatches(parts[0], normalized) ? normalized : ''
}

async function allRows(makeQuery) {
  const rows = []
  for (let offset = 0; offset < 50000; offset += 1000) {
    const { data, error } = await makeQuery().range(offset, offset + 999)
    if (error) throw fail('雲端資料讀取失敗，請稍後重試。')
    rows.push(...(data || []))
    if (!data || data.length < 1000) return rows
  }
  throw fail('查詢資料量過大，請聯絡管理者分區間匯出。', 413)
}

function createDb() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw fail('網站的伺服器連線設定尚未完成。', 503)
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

async function authenticate(request) {
  const token = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!token) throw fail('請先登入。', 401)
  const db = createDb()
  const { data: userData, error: userError } = await db.auth.getUser(token)
  if (userError || !userData?.user) throw fail('登入已失效，請重新登入。', 401)
  const { data: profile, error: profileError } = await db
    .from('profiles')
    .select('id, employee_no, full_name, department_id, job_title, role, is_active')
    .eq('id', userData.user.id)
    .maybeSingle()
  if (profileError) throw fail('員工權限讀取失敗。')
  if (!profile) throw fail('雲端員工資料尚未建立，請聯絡管理者。', 403)
  if (!profile.is_active) throw fail('此帳號已停用，請聯絡管理者。', 403)
  if (!VALID_ROLES.has(profile.role)) throw fail('帳號權限不正確。', 403)
  return { db, user: userData.user, profile }
}

async function rpc(db, name, args, message, status = 500) {
  const { data, error } = await db.rpc(name, args)
  if (error || !data || data.ok !== true) throw fail(message, status)
  return data
}

async function adminAuthUpdate(db, id, patch, message = '帳號更新失敗，請稍後重試。') {
  const { data, error } = await db.auth.admin.updateUserById(id, patch)
  if (error || !data?.user) throw fail(message, 502)
  return data.user
}

async function getProfile(db, id, message = '找不到指定員工。') {
  if (!isUuid(id)) throw fail(message, 400)
  const { data, error } = await db
    .from('profiles')
    .select('id, employee_no, full_name, department_id, job_title, role, is_active')
    .eq('id', id)
    .maybeSingle()
  if (error) throw fail('員工資料讀取失敗。')
  if (!data) throw fail(message, 404)
  return data
}

async function loadNetwork(db) {
  const [{ data: settings, error: settingsError }, { data: networks, error: networkError }] = await Promise.all([
    db.from('system_settings').select('id, network_mode, updated_at').eq('id', 1).maybeSingle(),
    db.from('allowed_networks').select('id, network').eq('is_active', true).order('id'),
  ])
  if (settingsError || networkError || !settings) throw fail('公司網路設定讀取失敗。')
  return {
    mode: settings.network_mode === 'strict' ? 'strict' : 'test',
    updatedAt: settings.updated_at,
    networks: networks || [],
  }
}

async function loadSnapshot(db, profile) {
  const globalRole = ['admin', 'hr', 'it'].includes(profile.role)
  const [employees, departments, network] = await Promise.all([
    allRows(() => {
      let query = db
        .from('profiles')
        .select('id, employee_no, full_name, department_id, job_title, role, is_active')
        .order('id')
      if (!globalRole) {
        query = profile.role === 'manager' && profile.department_id
          ? query.eq('department_id', profile.department_id)
          : query.eq('id', profile.id)
      }
      return query
    }),
    allRows(() => {
      let query = db
        .from('departments')
        .select('id, code, name, manager_name, manager_id, is_active')
        .order('id')
      if (!globalRole) {
        query = profile.department_id
          ? query.eq('id', profile.department_id)
          : query.eq('id', ZERO_UUID)
      }
      return query
    }),
    loadNetwork(db),
  ])

  const managerIds = [...new Set(departments.map((department) => department.manager_id).filter(isUuid))]
  const [managerResult, records] = await Promise.all([
    managerIds.length
      ? db.from('profiles').select('id, full_name').in('id', managerIds).order('id')
      : Promise.resolve({ data: [], error: null }),
    allRows(() => {
      let query = db
        .from('attendance_records')
        .select('id, employee_id, attendance_type, punched_at, client_ip, status, matched_network_id')
        .order('punched_at', { ascending: false })
        .order('id')
      if (!globalRole) {
        const ids = employees.map((employee) => employee.id)
        query = ids.length ? query.in('employee_id', ids) : query.eq('employee_id', ZERO_UUID)
      }
      return query
    }),
  ])
  if (managerResult.error) throw fail('部門主管資料讀取失敗。')
  const managerMap = new Map((managerResult.data || []).map((manager) => [manager.id, manager]))
  const departmentMap = new Map(departments.map((department) => [department.id, department]))

  const employeeSnapshot = employees.map((employee) => {
    const department = departmentMap.get(employee.department_id)
    const base = {
      id: employee.id,
      employeeNo: employee.employee_no,
      name: employee.full_name,
      department: department?.name || '',
      departmentCode: department?.code || '',
      active: employee.is_active,
    }
    // IT needs directory/export/activation fields only; do not expose titles or roles.
    if (profile.role === 'it') return {
      ...base, title: '', ...(employee.id === profile.id ? { accessRole: 'it' } : {}),
    }
    return { ...base, title: employee.job_title || '', accessRole: employee.role }
  })

  const departmentSnapshot = departments.map((department) => {
    const linkedManager = managerMap.get(department.manager_id)
    const manager = linkedManager?.full_name || department.manager_name || ''
    return {
      id: department.id,
      code: department.code,
      name: department.name,
      manager: profile.role === 'it' ? '' : manager,
      ...(department.manager_id && profile.role !== 'it' ? { managerId: department.manager_id } : {}),
      active: department.is_active,
    }
  })

  return {
    employees: employeeSnapshot,
    departments: departmentSnapshot,
    records: records.map((record) => ({
      id: record.id,
      employeeId: record.employee_id,
      type: record.attendance_type,
      punchedAt: record.punched_at,
      ip: record.client_ip || '',
      networkName: record.matched_network_id ? '公司允許網路' : '未限制網路',
      // Manual API records are intentionally returned as normal accepted records.
      status: record.status === 'rejected' ? 'rejected' : 'accepted',
    })),
    adminPassword: '',
    network: {
      mode: network.mode,
      // Test-mode values are retained as an admin-only draft; other roles never
      // receive the whitelist, even though they can see the current mode.
      allowedIps: profile.role === 'admin' ? network.networks.map((item) => item.network) : [],
      updatedAt: network.updatedAt,
    },
  }
}

async function handlePunch(db, profile, input, context, request) {
  if (!VALID_ATTENDANCE_TYPES.has(input.type)) throw fail('刷卡班別不正確。', 400)
  const network = await loadNetwork(db)
  const ip = isIP(context?.ip || '') ? context.ip : null
  const match = ip ? network.networks.find((item) => networkMatches(ip, item.network)) : undefined
  if (network.mode === 'strict' && !match) throw fail('目前不在允許的公司網路，無法刷卡。', 403)
  const result = await rpc(db, 'management_punch', {
    p_actor_uuid: profile.id,
    p_attendance_type: input.type,
    p_punched_at: new Date().toISOString(),
    p_client_ip: ip,
    p_user_agent: request.headers.get('user-agent')?.slice(0, 512) || '',
  }, '刷卡未儲存成功，請稍後重新操作。')
  return { ok: true, recordId: result.id }
}

function assertManagementRole(profile, roles, message = '目前帳號沒有執行此操作的權限。') {
  if (!roles.includes(profile.role)) throw fail(message, 403)
}

function parseEmployeePayload(payload, current = null) {
  const source = payload || {}
  const employeeNo = Object.hasOwn(source, 'employeeNo') ? normalizeEmployeeNo(source.employeeNo) : current?.employee_no
  const name = Object.hasOwn(source, 'name') ? trimText(source.name, 120) : current?.full_name
  const departmentCode = Object.hasOwn(source, 'departmentCode') ? trimText(source.departmentCode, 32).toUpperCase() : current?.department_code
  const title = Object.hasOwn(source, 'title') ? trimText(source.title, 120) : current?.job_title || ''
  const accessRole = Object.hasOwn(source, 'accessRole') ? trimText(source.accessRole, 16).toLowerCase() : current?.role
  if (!employeeNo || !name || !departmentCode || !VALID_ROLES.has(accessRole)) return null
  return { employeeNo, name, departmentCode, title, accessRole }
}

async function createAuthUser(db, employeeNo, password) {
  const { data, error } = await db.auth.admin.createUser({
    email: authEmail(employeeNo),
    password,
    email_confirm: true,
    user_metadata: { employee_no: employeeNo },
  })
  if (error || !data?.user?.id) return null
  return data.user
}

async function compensateNewAuthUser(db, id) {
  // The user was created by this request. Existing Auth users are never deleted.
  // Deleting only this just-created orphan is the safest compensation if the
  // profile transaction rejects (for example, a duplicate employee number).
  try { await db.auth.admin.deleteUser(id) } catch {
    try { await db.auth.admin.updateUserById(id, { ban_duration: LONG_BAN }) } catch { /* fail closed */ }
  }
}

async function handleEmployeeCreate(db, profile, payload) {
  assertManagementRole(profile, ['admin', 'hr'])
  if (!payload || typeof payload !== 'object') throw fail('員工資料不正確。', 400)
  const employee = parseEmployeePayload(payload.employee)
  if (!employee) throw fail('員工編號、姓名、部門或系統權限不正確。', 400)
  if (profile.role === 'hr' && employee.accessRole === 'admin') throw fail('人資不可建立 Admin 帳號。', 403)
  const password = passwordValue(payload.employee.password, true)
  if (!password) throw fail('密碼格式不正確。', 400)
  const authUser = await createAuthUser(db, employee.employeeNo, password)
  if (!authUser) throw fail('員工登入帳號建立失敗，請確認員工編號未使用。', 409)
  try {
    const result = await rpc(db, 'management_create_profile', {
      p_actor_uuid: profile.id,
      p_profile_uuid: authUser.id,
      p_employee_no: employee.employeeNo,
      p_full_name: employee.name,
      p_department_code: employee.departmentCode,
      p_job_title: employee.title,
      p_role: employee.accessRole,
      p_batch: false,
    }, '員工資料儲存失敗，請稍後重試。', 400)
    return { ok: true, id: result.id }
  } catch (error) {
    await compensateNewAuthUser(db, authUser.id)
    throw error
  }
}

async function handleEmployeeUpdate(db, profile, payload) {
  assertManagementRole(profile, ['admin', 'hr'])
  if (!payload || typeof payload !== 'object' || !isUuid(payload.id) || !payload.patch || typeof payload.patch !== 'object') {
    throw fail('員工更新資料不正確。', 400)
  }
  const target = await getProfile(db, payload.id)
  const allowed = new Set(['employeeNo', 'name', 'departmentCode', 'title', 'accessRole'])
  if (!Object.keys(payload.patch).some((key) => allowed.has(key))) throw fail('沒有可儲存的員工欄位。', 400)
  if (profile.role === 'hr' && (target.role === 'admin' || payload.patch.accessRole === 'admin')) {
    throw fail('人資不可操作或提升為 Admin。', 403)
  }
  const current = { ...target, department_code: '' }
  if (target.department_id) {
    const { data: department, error } = await db.from('departments').select('code').eq('id', target.department_id).maybeSingle()
    if (error) throw fail('員工部門資料讀取失敗。')
    current.department_code = department?.code || ''
  }
  const employee = parseEmployeePayload(payload.patch, current)
  if (!employee) throw fail('員工編號、姓名、部門或系統權限不正確。', 400)

  const employeeNoChanged = employee.employeeNo !== target.employee_no
  let oldAuthEmail = ''
  if (employeeNoChanged) {
    const { data: authData, error: authError } = await db.auth.admin.getUserById(target.id)
    if (authError || !authData?.user) throw fail('登入帳號讀取失敗，未進行資料修改。', 502)
    oldAuthEmail = authData.user.email || authEmail(target.employee_no)
    await adminAuthUpdate(db, target.id, { email: authEmail(employee.employeeNo), email_confirm: true }, '員工登入帳號更新失敗，資料尚未修改。')
  }
  try {
    const result = await rpc(db, 'management_update_profile', {
      p_actor_uuid: profile.id,
      p_profile_uuid: target.id,
      p_employee_no: employee.employeeNo,
      p_full_name: employee.name,
      p_department_code: employee.departmentCode,
      p_job_title: employee.title,
      p_role: employee.accessRole,
    }, '員工資料儲存失敗，已保留原資料。', 400)
    return { ok: true, id: result.id }
  } catch (error) {
    if (employeeNoChanged) {
      try {
        await adminAuthUpdate(db, target.id, { email: oldAuthEmail, email_confirm: true }, '員工資料儲存失敗，請聯絡管理者確認登入帳號。')
      } catch {
        throw fail('員工資料儲存失敗，登入帳號補償也未完成，請聯絡管理者。', 502)
      }
    }
    throw error
  }
}

async function handleEmployeeActive(db, profile, payload) {
  assertManagementRole(profile, ['admin', 'hr', 'it'])
  if (!payload || typeof payload !== 'object' || !isUuid(payload.id) || typeof payload.active !== 'boolean') {
    throw fail('帳號啟用狀態不正確。', 400)
  }
  const target = await getProfile(db, payload.id)
  if (target.role === 'admin' && profile.role !== 'admin') throw fail('人資與 IT 不可操作 Admin 帳號。', 403)
  if (!payload.active && target.id === profile.id) throw fail('不可停用目前登入中的帳號。', 403)
  if (target.is_active === payload.active) return { ok: true, id: target.id, active: target.is_active }

  if (!payload.active) {
    await rpc(db, 'management_set_profile_active', {
      p_actor_uuid: profile.id,
      p_profile_uuid: target.id,
      p_active: false,
    }, '帳號停用未完成。', 403)
    try {
      await adminAuthUpdate(db, target.id, { ban_duration: LONG_BAN }, '帳號停用未完成。')
    } catch {
      // The database denial must remain effective even if Auth is unavailable.
      return { ok: true, id: target.id, active: false, warning: '帳號已停用；登入服務封鎖同步未完成，但系統資料與刷卡存取已被拒絕。' }
    }
    return { ok: true, id: target.id, active: false }
  }

  try {
    // Activation first removes the Auth ban; a DB failure is compensated below.
    await adminAuthUpdate(db, target.id, { ban_duration: 'none' }, '帳號啟用未完成。')
    await rpc(db, 'management_set_profile_active', {
      p_actor_uuid: profile.id,
      p_profile_uuid: target.id,
      p_active: true,
    }, '帳號啟用未完成。', 403)
  } catch (error) {
    try { await adminAuthUpdate(db, target.id, { ban_duration: LONG_BAN }, '帳號啟用補償失敗，請聯絡管理者。') } catch { /* fail closed */ }
    throw error
  }
  return { ok: true, id: target.id, active: true }
}

function validateManagerValue(value, supplied = true) {
  if (!supplied) return { supplied: false, id: null }
  const text = trimText(value, 64)
  if (!text) return { supplied: true, id: null }
  if (!isUuid(text)) throw fail('部門主管必須是員工 UUID 或空字串。', 400)
  return { supplied: true, id: text }
}

async function handleDepartmentCreate(db, profile, payload) {
  assertManagementRole(profile, ['admin', 'hr'])
  const department = payload?.department
  if (!department || typeof department !== 'object') throw fail('部門資料不正確。', 400)
  const code = trimText(department.code, 32).toUpperCase()
  const name = trimText(department.name, 120)
  if (!code || !name) throw fail('部門代號與名稱都是必填欄位。', 400)
  const manager = validateManagerValue(department.manager)
  const result = await rpc(db, 'management_create_department', {
    p_actor_uuid: profile.id,
    p_code: code,
    p_name: name,
    p_manager_uuid: manager.id,
  }, '部門儲存失敗，請稍後重試。', 400)
  return { ok: true, id: result.id }
}

async function handleDepartmentUpdate(db, profile, payload) {
  assertManagementRole(profile, ['admin', 'hr'])
  if (!payload || typeof payload !== 'object' || !isUuid(payload.id) || !payload.patch || typeof payload.patch !== 'object') {
    throw fail('部門更新資料不正確。', 400)
  }
  const { data: target, error } = await db.from('departments').select('id, code, name, manager_id, manager_name').eq('id', payload.id).maybeSingle()
  if (error) throw fail('部門資料讀取失敗。')
  if (!target) throw fail('找不到指定部門。', 404)
  const patch = payload.patch
  const code = Object.hasOwn(patch, 'code') ? trimText(patch.code, 32).toUpperCase() : target.code
  const name = Object.hasOwn(patch, 'name') ? trimText(patch.name, 120) : target.name
  if (!code || !name) throw fail('部門代號與名稱都是必填欄位。', 400)
  const manager = validateManagerValue(patch.manager, Object.hasOwn(patch, 'manager'))
  const result = await rpc(db, 'management_update_department', {
    p_actor_uuid: profile.id,
    p_department_uuid: target.id,
    p_code: code,
    p_name: name,
    // Omitted manager is intentionally null + supplied=false; SQL retains the
    // old UUID and legacy manager_name in one atomic department UPDATE.
    p_manager_uuid: manager.id,
    p_manager_supplied: manager.supplied,
  }, '部門儲存失敗，原資料未變更。', 400)
  return { ok: true, id: result.id }
}

async function handlePasswordSet(db, profile, payload) {
  assertManagementRole(profile, ['admin'], '只有 Admin 可以重設密碼。')
  if (!payload || typeof payload !== 'object') throw fail('密碼資料不正確。', 400)
  const value = passwordValue(payload.password)
  if (!value) throw fail('密碼至少需要 6 個字元。', 400)
  let targetId = payload.id
  if (targetId === 'admin') {
    const { data: profiles, error } = await db.from('profiles').select('id, employee_no, role, is_active').ilike('employee_no', 'ADMIN').limit(10)
    if (error) throw fail('Admin 帳號讀取失敗。')
    const admin = (profiles || []).find((item) => item.employee_no.toUpperCase() === 'ADMIN')
    targetId = admin?.id
  }
  const target = await getProfile(db, targetId, '找不到要重設密碼的帳號。')
  await adminAuthUpdate(db, target.id, { password: value }, '密碼更新失敗，請稍後重試。')
  // Password contents are never placed in before/after audit JSON.
  try {
    await rpc(db, 'management_audit', {
      p_actor_uuid: profile.id,
      p_action: 'password.set',
      p_target_uuid: target.id,
      p_before: null,
      p_after: null,
    }, '稽核紀錄寫入失敗。')
  } catch { /* Do not expose or roll back a successful password change. */ }
  return { ok: true, id: target.id }
}

async function handleImport(db, profile, payload) {
  assertManagementRole(profile, ['admin', 'hr', 'it'])
  if (!Array.isArray(payload?.rows) || payload.rows.length < 2) throw fail('匯入檔案必須包含標題列與資料。', 400)
  if (payload.rows.length > 11) throw fail('每次最多匯入 10 筆員工資料。', 400)
  if (!payload.rows.every((row) => Array.isArray(row))) throw fail('匯入資料格式不正確。', 400)
  const header = payload.rows[0].map((value) => trimText(value, 64).toLowerCase())
  const headerOkay = (header[0]?.includes('員工') || header[0]?.includes('employee'))
    && (header[1]?.includes('姓名') || header[1]?.includes('name'))
    && (header[2]?.includes('部門') || header[2]?.includes('department'))
  if (!headerOkay) throw fail('匯入檔案標題列不正確。', 400)

  const departments = await allRows(() => db.from('departments').select('code, is_active').order('code'))
  const departmentCodes = new Set(departments.filter((department) => department.is_active).map((department) => department.code.toUpperCase()))
  const { data: existing, error: existingError } = await db.from('profiles').select('employee_no')
  if (existingError) throw fail('現有員工資料讀取失敗。')
  const usedNumbers = new Set((existing || []).map((item) => item.employee_no.toUpperCase()))
  let imported = 0
  let failed = 0

  for (const row of payload.rows.slice(1)) {
    const values = row.map((value) => trimText(value, 120))
    const employeeNo = normalizeEmployeeNo(values[0])
    const name = values[1] || ''
    const departmentCode = (values[2] || '').toUpperCase()
    const title = values[3] || ''
    const role = (values[4] || 'employee').toLowerCase()
    // The optional password column is intentionally ignored: every new import
    // account receives the documented default and existing accounts are skipped.
    if (!employeeNo || !name || !departmentCodes.has(departmentCode) || !VALID_ROLES.has(role)
      || usedNumbers.has(employeeNo) || (profile.role !== 'admin' && role === 'admin')) {
      failed += 1
      continue
    }
    if (profile.role === 'it' && role !== 'employee') {
      failed += 1
      continue
    }
    usedNumbers.add(employeeNo)
    const authUser = await createAuthUser(db, employeeNo, DEFAULT_PASSWORD)
    if (!authUser) {
      failed += 1
      continue
    }
    try {
      await rpc(db, 'management_create_profile', {
        p_actor_uuid: profile.id,
        p_profile_uuid: authUser.id,
        p_employee_no: employeeNo,
        p_full_name: name,
        p_department_code: departmentCode,
        p_job_title: title,
        p_role: role,
        p_batch: true,
      }, '員工匯入失敗。', 400)
      imported += 1
    } catch {
      await compensateNewAuthUser(db, authUser.id)
      failed += 1
    }
  }
  return { ok: true, imported, failed }
}

async function handleAttendanceCreate(db, profile, payload) {
  assertManagementRole(profile, ['admin'], '只有 Admin 可以新增出勤紀錄。')
  const record = payload?.record
  if (!record || typeof record !== 'object' || !isUuid(record.employeeId) || !VALID_ATTENDANCE_TYPES.has(record.type)) {
    throw fail('出勤資料不正確。', 400)
  }
  const punchedAt = parseTimestamp(record.punchedAt)
  if (!punchedAt) throw fail('刷卡時間格式不正確。', 400)
  const result = await rpc(db, 'management_create_attendance', {
    p_actor_uuid: profile.id,
    p_employee_uuid: record.employeeId,
    p_attendance_type: record.type,
    p_punched_at: punchedAt,
  }, '出勤紀錄儲存失敗。', 400)
  return { ok: true, recordId: result.id }
}

async function handleAttendanceUpdate(db, profile, payload) {
  assertManagementRole(profile, ['admin'], '只有 Admin 可以修改出勤紀錄。')
  const patch = payload?.patch
  if (!payload || !isUuid(payload.id) || !patch || typeof patch !== 'object') throw fail('出勤更新資料不正確。', 400)
  if (!VALID_ATTENDANCE_TYPES.has(patch.type)) throw fail('刷卡類型不正確。', 400)
  const punchedAt = parseTimestamp(patch.punchedAt)
  if (!punchedAt) throw fail('刷卡時間格式不正確。', 400)
  const result = await rpc(db, 'management_update_attendance', {
    p_actor_uuid: profile.id,
    p_record_uuid: payload.id,
    p_attendance_type: patch.type,
    p_punched_at: punchedAt,
  }, '出勤紀錄儲存失敗。', 400)
  return { ok: true, id: result.id }
}

async function handleNetworkSave(db, profile, payload) {
  assertManagementRole(profile, ['admin'], '只有 Admin 可以設定公司網路。')
  if (!['test', 'strict'].includes(payload?.mode) || !Array.isArray(payload.allowedIps)) throw fail('網路設定資料不正確。', 400)
  if (payload.allowedIps.length > 100) throw fail('允許網路數量過多。', 400)
  const networks = []
  const seen = new Set()
  for (const value of payload.allowedIps) {
    const cidr = normalizeCidr(value)
    if (!cidr) throw fail('允許網路包含無效 CIDR。', 400)
    if (!seen.has(cidr)) {
      seen.add(cidr)
      networks.push(cidr)
    }
  }
  if (payload.mode === 'strict' && networks.length === 0) throw fail('正式模式至少需要一組有效 CIDR。', 400)
  const result = await rpc(db, 'management_save_network', {
    p_actor_uuid: profile.id,
    p_mode: payload.mode,
    p_allowed_ips: networks,
  }, '網路設定儲存失敗，原設定未變更。', 400)
  return { ok: true, mode: result.mode, allowedIps: result.allowedIps || [] }
}

export default async function handler(request, context) {
  try {
    const { db, profile } = await authenticate(request)
    if (request.method === 'GET') return response(await loadSnapshot(db, profile))
    if (request.method !== 'POST') return response({ message: '不支援的操作。' }, 405)
    const input = await request.json().catch(() => { throw fail('請求內容不正確。', 400) })
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.action !== 'string') {
      throw fail('請求內容不正確。', 400)
    }
    switch (input.action) {
      case 'punch': return response(await handlePunch(db, profile, input, context, request))
      case 'employee.create': return response(await handleEmployeeCreate(db, profile, input))
      case 'employee.update': return response(await handleEmployeeUpdate(db, profile, input))
      case 'employee.active': return response(await handleEmployeeActive(db, profile, input))
      case 'password.set': return response(await handlePasswordSet(db, profile, input))
      case 'employees.import': return response(await handleImport(db, profile, input))
      case 'attendance.create': return response(await handleAttendanceCreate(db, profile, input))
      case 'attendance.update': return response(await handleAttendanceUpdate(db, profile, input))
      case 'department.create': return response(await handleDepartmentCreate(db, profile, input))
      case 'department.update': return response(await handleDepartmentUpdate(db, profile, input))
      case 'network.save': return response(await handleNetworkSave(db, profile, input))
      default: throw fail('不支援的管理操作。', 400)
    }
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 500
    const message = status >= 500 && !error?.status ? '服務暫時無法連線，請稍後再試。' : (error?.message || '操作未完成，請稍後再試。')
    return response({ message }, status)
  }
}

export const config = { path: '/api/attendance', method: ['GET', 'POST'] }
