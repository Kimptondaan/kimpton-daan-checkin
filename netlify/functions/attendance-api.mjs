import { createClient } from '@supabase/supabase-js'
import { BlockList, isIP } from 'node:net'

const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' },
})
const fail = (message, status = 500) => Object.assign(new Error(message), { status })

export function networkMatches(ip, cidr) {
  const family = isIP(ip)
  if (!family || typeof cidr !== 'string') return false
  const [address, prefixRaw] = cidr.split('/')
  if (isIP(address) !== family) return false
  const prefix = prefixRaw === undefined ? (family === 4 ? 32 : 128) : Number(prefixRaw)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)) return false
  const list = new BlockList()
  list.addSubnet(address, prefix, family === 4 ? 'ipv4' : 'ipv6')
  return list.check(ip, family === 4 ? 'ipv4' : 'ipv6')
}

async function allRows(makeQuery) {
  const rows = []
  for (let offset = 0; offset < 50000; offset += 1000) {
    const { data, error } = await makeQuery().range(offset, offset + 999)
    if (error) throw fail('雲端資料讀取失敗，請稍後重試。')
    rows.push(...data)
    if (data.length < 1000) return rows
  }
  throw fail('查詢資料量過大，請聯絡管理者分區間匯出。', 413)
}

export default async function handler(request, context) {
  try {
    const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) throw fail('網站的伺服器連線設定尚未完成。', 503)
    const token = request.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1]
    if (!token) throw fail('請先登入。', 401)
    const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data: userData, error: userError } = await db.auth.getUser(token)
    if (userError || !userData.user) throw fail('登入已失效，請重新登入。', 401)
    const { data: profile, error: profileError } = await db.from('profiles').select('*').eq('id', userData.user.id).maybeSingle()
    if (profileError) throw fail('員工權限讀取失敗。')
    if (!profile) throw fail('雲端員工資料尚未建立，請聯絡管理者。', 403)
    if (!profile.is_active) throw fail('此帳號已停用，請聯絡管理者。', 403)
    if (!['employee', 'manager', 'hr', 'it', 'admin'].includes(profile.role)) throw fail('帳號權限不正確。', 403)
    const { data: networks, error: networkError } = await db.from('allowed_networks').select('id, name, network').eq('is_active', true).order('id')
    if (networkError) throw fail('公司網路設定讀取失敗。')
    // In the initial schema an active whitelist enables strict mode; no entries means unrestricted.
    const strict = networks.length > 0

    if (request.method === 'GET') {
      const globalRole = ['admin', 'hr', 'it'].includes(profile.role)
      const employees = await allRows(() => {
        let query = db.from('profiles').select('id, employee_no, full_name, department_id, job_title, role, is_active').order('id')
        if (!globalRole) query = profile.role === 'manager' && profile.department_id
          ? query.eq('department_id', profile.department_id)
          : query.eq('id', profile.id)
        return query
      })
      const departments = await allRows(() => {
        let query = db.from('departments').select('id, code, name, manager_name, is_active').order('id')
        if (!globalRole) query = profile.department_id ? query.eq('id', profile.department_id) : query.eq('id', '00000000-0000-0000-0000-000000000000')
        return query
      })
      const records = await allRows(() => {
        let query = db.from('attendance_records').select('id, employee_id, attendance_type, punched_at, client_ip, status, matched_network_id').order('punched_at', { ascending: false }).order('id')
        if (!globalRole) query = query.in('employee_id', employees.map(e => e.id))
        return query
      })
      const departmentMap = new Map(departments.map(d => [d.id, d]))
      return response({
        employees: employees.map(e => ({ id: e.id, employeeNo: e.employee_no, name: e.full_name, department: departmentMap.get(e.department_id)?.name || '', departmentCode: departmentMap.get(e.department_id)?.code || '', title: e.job_title, accessRole: e.role, active: e.is_active })),
        departments: departments.map(d => ({ id: d.id, code: d.code, name: d.name, manager: d.manager_name, active: d.is_active })),
        records: records.map(r => ({ id: r.id, employeeId: r.employee_id, type: r.attendance_type, punchedAt: r.punched_at, ip: r.client_ip || '', networkName: r.matched_network_id ? '公司允許網路' : '未限制網路', status: r.status })),
        adminPassword: '',
        network: { mode: strict ? 'strict' : 'test', allowedIps: profile.role === 'admin' ? networks.map(n => n.network) : [], updatedAt: new Date().toISOString() },
      })
    }
    if (request.method !== 'POST') return response({ message: '不支援的操作。' }, 405)
    const input = await request.json().catch(() => { throw fail('請求內容不正確。', 400) })
    if (input.action !== 'punch') throw fail('雲端管理功能尚在資料搬移中，請先完成搬移。', 409)
    if (!['check_in', 'check_out'].includes(input.type)) throw fail('刷卡班別不正確。', 400)
    // Only Netlify-provided context.ip is trusted; never use input.ip or X-Forwarded-For.
    const ip = context?.ip
    const match = isIP(ip || '') ? networks.find(n => networkMatches(ip, n.network)) : undefined
    if (strict && !match) throw fail('目前不在允許的公司網路，無法刷卡。', 403)
    const { data: record, error } = await db.from('attendance_records').insert({
      employee_id: profile.id,
      attendance_type: input.type,
      punched_at: new Date().toISOString(),
      client_ip: isIP(ip || '') ? ip : null,
      matched_network_id: match?.id || null,
      user_agent: request.headers.get('user-agent')?.slice(0, 512) || '',
      status: 'accepted',
    }).select('id').single()
    if (error) throw fail('刷卡未儲存成功，請稍後重新操作。')
    return response({ ok: true, recordId: record.id })
  } catch (error) {
    return response({ message: error.status ? error.message : '服務暫時無法連線，請稍後再試。' }, error.status || 500)
  }
}

export const config = { path: '/api/attendance', method: ['GET', 'POST'] }
