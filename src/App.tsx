import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent, ReactNode } from 'react'
import {
  ArrowDownToLine,
  ArrowLeft,
  Building2,
  CalendarDays,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Download,
  FileDown,
  FileSpreadsheet,
  Globe2,
  KeyRound,
  LogOut,
  Menu,
  Network,
  Pencil,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Upload,
  UserRound,
  UsersRound,
  Wifi,
  X,
} from 'lucide-react'
import type { AttendanceRecord, DemoData, Employee, NetworkMode, UserRole } from './lib/types'
import { fromTaipeiLocal, toTaipeiLocal, toTxt } from './lib/demoStore'
import { supabase, supabaseReady } from './lib/supabase'
import {
  addAttendanceCloud,
  addDepartmentCloud,
  addEmployeeCloud,
  importEmployeesCloud,
  loadCloudData,
  punchCloud,
  saveNetworkCloud,
  setEmployeeActiveCloud,
  setPasswordCloud,
  updateAttendanceCloud,
  updateDepartmentCloud,
  updateEmployeeCloud,
} from './lib/cloudStore'

const EMPTY_DATA: DemoData = {
  employees: [],
  departments: [],
  records: [],
  network: { mode: 'test', allowedIps: [], updatedAt: '' },
}

const VALID_USER_ROLES: ReadonlySet<UserRole> = new Set(['employee', 'manager', 'hr', 'it', 'admin'])

const TAIPEI_TIME_ZONE = 'Asia/Taipei'

type View = 'dashboard' | 'attendance' | 'clock' | 'personal' | 'employees' | 'departments' | 'settings'
type Session = { role: UserRole; employee?: Employee }
type NewEmployee = { employeeNo: string; name: string; departmentCode: string; title: string; accessRole: UserRole }
type EmployeePatch = NewEmployee
type DepartmentDraft = { code: string; name: string; managerId: string }
type DepartmentPatch = { code: string; name: string; manager?: string }
type Toast = { tone: 'success' | 'error' | 'info'; message: string }
type BusyAction = string | null

function taipeiInputToIso(value: string) {
  try { return fromTaipeiLocal(value) } catch { return null }
}

function isoToTaipeiInput(value: string) {
  try { return toTaipeiLocal(value) } catch { return '' }
}

function formatTaipeiDate(value: string) {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: TAIPEI_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).format(new Date(value))
}

function formatTaipeiDateTime(value: string) {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: TAIPEI_TIME_ZONE, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(value))
}

function formatTaipeiTime(value: string) {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: TAIPEI_TIME_ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(new Date(value))
}

function isSameTaipeiDay(value: string, compare = new Date().toISOString()) {
  const parts = (input: string) => new Intl.DateTimeFormat('en-CA', { timeZone: TAIPEI_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(input))
  return parts(value) === parts(compare)
}

function errorText(error: unknown, fallback = '操作失敗，請稍後再試。') {
  return error instanceof Error && error.message ? error.message : fallback
}

function parseCsvRows(text: string) {
  return text.replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => line.split(/,|\t/).map((value) => value.trim().replace(/^"|"$/g, '')))
}

function downloadCsvTemplate(forIt = false) {
  const template = forIt
    ? '員工編號,姓名,部門代號,職稱\nDA006,王小明,FO,前台接待\n'
    : '員工編號,姓名,部門代號,職稱,系統權限\nDA006,王小明,FO,前台接待,employee\n'
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob(['\uFEFF', template], { type: 'text/csv;charset=utf-8;' }))
  link.download = '員工批次匯入範本.csv'
  link.click()
  URL.revokeObjectURL(link.href)
}

function App() {
  const [cloudData, setCloudData] = useState<DemoData | null>(null)
  const data = cloudData ?? EMPTY_DATA
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null)
  const [loginBusy, setLoginBusy] = useState(false)
  const [loginError, setLoginError] = useState('')
  const [punchBusy, setPunchBusy] = useState(false)
  const [session, setSession] = useState<Session | null>(null)
  const [loginMode, setLoginMode] = useState<UserRole>('employee')
  const [employeeNo, setEmployeeNo] = useState('')
  const [password, setPassword] = useState('')
  const [activeView, setActiveView] = useState<View>('dashboard')
  const [toast, setToast] = useState<Toast | null>(null)
  const [now, setNow] = useState(() => new Date())
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [networkDraft, setNetworkDraft] = useState('')
  const [networkModeDraft, setNetworkModeDraft] = useState<NetworkMode>('test')
  const [busyAction, setBusyAction] = useState<BusyAction>(null)
  const busyRef = useRef<BusyAction>(null)
  const refreshPromiseRef = useRef<Promise<DemoData> | null>(null)
  const refreshGenerationRef = useRef(0)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 3600)
    return () => window.clearTimeout(timer)
  }, [toast])

  const notify = (message: string, tone: Toast['tone'] = 'success') => setToast({ message, tone })

  function startBusy(action: string) {
    if (busyRef.current) return false
    busyRef.current = action
    setBusyAction(action)
    return true
  }

  function endBusy(action: string) {
    if (busyRef.current !== action) return
    busyRef.current = null
    setBusyAction(null)
  }

  function applySnapshot(snapshot: DemoData, syncNetworkDraft = false) {
    setCloudData(snapshot)
    if (syncNetworkDraft) {
      setNetworkDraft(snapshot.network?.allowedIps?.join('\n') ?? '')
      setNetworkModeDraft(snapshot.network?.mode ?? 'test')
    }
    setLastSyncedAt(new Date().toISOString())
    setSession(current => {
      if (!current?.employee) return current
      const employee = snapshot.employees.find(item => item.id === current.employee?.id)
      return employee?.active ? { role: employee.accessRole ?? current.role, employee } : current
    })
  }

  function refreshSnapshot(force = false) {
    if (force) {
      refreshGenerationRef.current += 1
      refreshPromiseRef.current = null
    }
    if (refreshPromiseRef.current) return refreshPromiseRef.current
    const generation = refreshGenerationRef.current
    const promise = loadCloudData().then((snapshot) => {
      if (generation === refreshGenerationRef.current) applySnapshot(snapshot)
      return snapshot
    }).finally(() => {
      if (refreshPromiseRef.current === promise) refreshPromiseRef.current = null
    })
    refreshPromiseRef.current = promise
    return promise
  }

  async function openCloudSession(userId: string) {
    if (!supabase) throw new Error('網站的 Supabase 連線設定尚未完成。')
    const snapshot = await loadCloudData()
    const employee = snapshot.employees.find((item) => item.id === userId)
    if (!employee) throw new Error('找不到自己的雲端員工資料。')
    if (!employee.active) throw new Error('此帳號已停用，請聯絡管理者。')
    const accessRole = employee.accessRole
    if (!accessRole || !VALID_USER_ROLES.has(accessRole)) throw new Error('雲端員工權限資料不正確，請聯絡管理者。')
    applySnapshot(snapshot, true)
    setSession({ role: accessRole, employee })
    setActiveView('dashboard')
  }

  useEffect(() => {
    if (!supabase) return
    let alive = true
    void supabase.auth.getSession().then(async ({ data: auth }) => {
      if (!alive || !auth.session) return
      setLoginBusy(true)
      try { await openCloudSession(auth.session.user.id) }
      catch (error) {
        if (alive) setLoginError(errorText(error, '登入狀態已失效，請重新登入。'))
        await supabase?.auth.signOut({ scope: 'local' })
      } finally { if (alive) setLoginBusy(false) }
    })
    const { data: listener } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT' && alive) {
        refreshGenerationRef.current += 1
        refreshPromiseRef.current = null
        setSession(null)
        setCloudData(null)
        setLastSyncedAt(null)
      }
    })
    return () => { alive = false; listener.subscription.unsubscribe() }
  }, [])

  useEffect(() => {
    if (!cloudData || !session?.employee) return
    let alive = true
    const refresh = async () => {
      if (document.visibilityState !== 'visible') return
      try {
        const requestedGeneration = refreshGenerationRef.current
        const snapshot = await refreshSnapshot()
        if (!alive || requestedGeneration !== refreshGenerationRef.current) return
        const employee = snapshot.employees.find((item) => item.id === session.employee?.id)
        if (!employee?.active) { await logout(); return }
        setSession({ role: employee.accessRole ?? 'employee', employee })
      } catch (error) {
        if (!alive) return
        const status = (error as { status?: number }).status
        if (status === 401 || status === 403) {
          await logout()
          setLoginError(errorText(error, '登入已失效，請重新登入。'))
        } else notify('雲端資料更新失敗，目前顯示上次成功讀取結果；請檢查網路。', 'error')
      }
    }
    const timer = window.setInterval(() => { void refresh() }, 15000)
    window.addEventListener('focus', refresh)
    return () => { alive = false; window.clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [Boolean(cloudData), session?.employee?.id])

  async function handleLogin(event: FormEvent) {
    event.preventDefault()
    if (loginBusy) return
    const normalized = employeeNo.trim().toUpperCase()
    setLoginError('')
    if (!normalized || !password) { setLoginError('請輸入帳號與密碼。'); return }
    if (!/^[A-Z0-9][A-Z0-9._-]*$/.test(normalized)) { setLoginError('員工編號格式不正確。'); return }
    if (!supabase) { setLoginError('網站的 Supabase 連線設定尚未完成，請聯絡管理者。'); return }
    setLoginBusy(true)
    try {
      const { data: auth, error } = await supabase.auth.signInWithPassword({
        email: `${normalized.toLowerCase()}@checkin.kimptondaan.local`, password,
      })
      if (error || !auth.user) throw new Error(error?.status === 400 || error?.code === 'invalid_credentials'
        ? '員工編號或密碼不正確，請確認帳號已搬移至雲端。'
        : '登入服務暫時無法連線，請檢查網路後再試。')
      await openCloudSession(auth.user.id)
      setPassword('')
      notify('雲端登入成功，歡迎回來。')
    } catch (error) {
      setLoginError(errorText(error, '登入失敗，請稍後再試。'))
      await supabase.auth.signOut({ scope: 'local' }).catch(() => {})
    } finally { setLoginBusy(false) }
  }

  async function logout() {
    const result = await supabase?.auth.signOut({ scope: 'local' })
    if (result?.error) { notify('登出未完成，請檢查網路後重試。', 'error'); return }
    setSession(null)
    setCloudData(null)
    setLastSyncedAt(null)
    setEmployeeNo('')
    setPassword('')
    setLoginError('')
    setMobileNavOpen(false)
  }

  async function handlePunch(type: 'check_in' | 'check_out') {
    if (!session?.employee || punchBusy) return
    if (!cloudData) { notify('雲端資料尚未載入，暫時不能刷卡。', 'error'); return }
    setPunchBusy(true)
    try {
      await punchCloud(type)
      notify(type === 'check_in' ? '上班刷卡已儲存至雲端，可再次刷卡。' : '下班刷卡已儲存至雲端，可再次刷卡。')
      try { await refreshSnapshot(true) }
      catch { notify('刷卡已儲存，但畫面更新失敗；請重新整理查看，不需要重刷。', 'info') }
    } catch (error) { notify(errorText(error, '刷卡未儲存成功。'), 'error') }
    finally { setPunchBusy(false) }
  }

  async function refreshAfterWrite(successMessage: string, syncNetworkDraft = false) {
    notify(successMessage)
    try {
      const snapshot = await refreshSnapshot(true)
      if (syncNetworkDraft) {
        setNetworkDraft(snapshot.network.allowedIps.join('\n'))
        setNetworkModeDraft(snapshot.network.mode)
      }
    }
    catch { notify(`${successMessage}；雲端重新讀取失敗，寫入已成功，請勿重複建立。`, 'info') }
  }

  async function saveNetworkSettings() {
    if (session?.role !== 'admin') { notify('只有 admin 可以修改系統設定。', 'error'); return false }
    const action = 'network.save'
    if (!startBusy(action)) return false
    const allowedIps = networkDraft.split(/[\n,]/).map((item) => item.trim()).filter(Boolean)
    if (networkModeDraft === 'strict' && allowedIps.length === 0) {
      endBusy(action)
      notify('正式 IP 模式至少需要輸入一組 IP、CIDR 或 IPv6 網段。', 'error')
      return false
    }
    try {
      await saveNetworkCloud(networkModeDraft, allowedIps)
      await refreshAfterWrite(networkModeDraft === 'test' ? '已儲存網路設定：目前未限制 IP。' : '已儲存公司允許的 IP／CIDR／IPv6 設定。', true)
      return true
    } catch (error) { notify(errorText(error, '網路設定儲存失敗。'), 'error'); return false }
    finally { endBusy(action) }
  }

  async function updateEmployee(id: string, patch: EmployeePatch) {
    if (session?.role !== 'admin' && session?.role !== 'hr') { notify('沒有員工資料異動權限。', 'error'); return false }
    const current = data.employees.find((employee) => employee.id === id)
    const normalized: EmployeePatch = {
      employeeNo: patch.employeeNo.trim().toUpperCase(), name: patch.name.trim(), departmentCode: patch.departmentCode.trim().toUpperCase(), title: patch.title.trim(), accessRole: patch.accessRole,
    }
    if (!normalized.employeeNo || !normalized.name || !normalized.departmentCode) { notify('員工編號、姓名與部門都是必填欄位。', 'error'); return false }
    if (session.role === 'hr' && normalized.accessRole === 'admin') { notify('HR 不可指派 admin 權限。', 'error'); return false }
    if (session.role === 'hr' && current?.accessRole === 'admin' && normalized.accessRole !== 'admin') { notify('HR 不可異動既有 admin 權限。', 'error'); return false }
    const action = `employee.update:${id}`
    if (!startBusy(action)) return false
    try {
      await updateEmployeeCloud(id, normalized)
      await refreshAfterWrite(`員工 ${normalized.employeeNo} 已儲存。`)
      return true
    } catch (error) { notify(errorText(error, '員工資料儲存失敗。'), 'error'); return false }
    finally { endBusy(action) }
  }

  async function addEmployee(input: NewEmployee) {
    if (session?.role !== 'admin' && session?.role !== 'hr') { notify('沒有新增員工權限。', 'error'); return false }
    const employee = { employeeNo: input.employeeNo.trim().toUpperCase(), name: input.name.trim(), departmentCode: input.departmentCode.trim().toUpperCase(), title: input.title.trim(), accessRole: input.accessRole }
    if (!employee.employeeNo || !employee.name || !employee.departmentCode) { notify('員工編號、姓名與部門都是必填欄位。', 'error'); return false }
    if (session.role === 'hr' && employee.accessRole === 'admin') { notify('HR 不可新增 admin 帳號。', 'error'); return false }
    if (data.employees.some((item) => item.employeeNo === employee.employeeNo)) { notify('這個員工編號已經存在。', 'error'); return false }
    const action = 'employee.create'
    if (!startBusy(action)) return false
    try {
      await addEmployeeCloud(employee)
      await refreshAfterWrite(`已新增 ${employee.employeeNo}；初始密碼由雲端設為 00000000。`)
      return true
    } catch (error) { notify(errorText(error, '新增員工失敗。'), 'error'); return false }
    finally { endBusy(action) }
  }

  async function importEmployees(rows: string[][]) {
    if (!['admin', 'hr', 'it'].includes(session?.role ?? '')) { notify('沒有批次匯入權限。', 'error'); return false }
    if (rows.length < 2) { notify('匯入檔案至少需要標題列與一筆資料。', 'error'); return false }
    if (session?.role === 'hr') {
      const roleIndex = rows[0].findIndex((value) => value.includes('權限') || value.toLowerCase() === 'role' || value.toLowerCase() === 'accessrole')
      if (roleIndex >= 0 && rows.slice(1).some((row) => row[roleIndex]?.trim().toLowerCase() === 'admin')) {
        notify('HR 不可匯入或指派 admin 權限。', 'error')
        return false
      }
    }
    const importRows = session?.role === 'it' ? rows.map((row) => row.slice(0, 4)) : rows
    const action = 'employees.import'
    if (!startBusy(action)) return false
    const header = rows[0]
    let imported = 0
    let failed = 0
    try {
      for (let index = 1; index < importRows.length; index += 9) {
        const batch = [importRows[0], ...importRows.slice(index, index + 9)]
        const result = await importEmployeesCloud(batch)
        imported += result.imported
        failed += result.failed
      }
      await refreshAfterWrite(`批次匯入完成：成功 ${imported} 筆，失敗 ${failed} 筆；既有帳號不會被覆寫。`)
      return failed === 0
    } catch (error) {
      notify(imported || failed ? `部分批次已寫入（成功 ${imported} 筆、失敗 ${failed} 筆）；請勿重複匯入整份檔案。` : errorText(error, '批次匯入失敗。'), 'error')
      return false
    } finally { endBusy(action) }
  }

  async function toggleEmployeeActive(id: string) {
    if (!['admin', 'hr', 'it'].includes(session?.role ?? '')) { notify('沒有帳號狀態異動權限。', 'error'); return false }
    const employee = data.employees.find((item) => item.id === id)
    if (!employee) return false
    const action = `employee.active:${id}`
    if (!startBusy(action)) return false
    try {
      const result = await setEmployeeActiveCloud(id, !employee.active)
      await refreshAfterWrite(`${employee.employeeNo} 已${employee.active ? '停用' : '啟用'}。`)
      if (result.warning) notify(result.warning, 'info')
      return true
    } catch (error) { notify(errorText(error, '帳號狀態更新失敗。'), 'error'); return false }
    finally { endBusy(action) }
  }

  async function addAttendanceRecord(input: { employeeId: string; type: AttendanceRecord['type']; punchedAt: string }) {
    if (session?.role !== 'admin') { notify('只有 admin 可以補登或修改刷卡時間。', 'error'); return false }
    if (!input.employeeId || !input.punchedAt) { notify('員工與刷卡時間都是必填欄位。', 'error'); return false }
    const action = 'attendance.create'
    if (!startBusy(action)) return false
    try {
      await addAttendanceCloud(input)
      await refreshAfterWrite('已新增刷卡時間資料。')
      return true
    } catch (error) { notify(errorText(error, '刷卡時間新增失敗。'), 'error'); return false }
    finally { endBusy(action) }
  }

  async function updateAttendanceRecord(id: string, patch: { type: AttendanceRecord['type']; punchedAt: string }) {
    if (session?.role !== 'admin') { notify('只有 admin 可以修改刷卡時間。', 'error'); return false }
    if (!patch.punchedAt) { notify('刷卡時間不可為空白。', 'error'); return false }
    const action = `attendance.update:${id}`
    if (!startBusy(action)) return false
    try {
      await updateAttendanceCloud(id, patch)
      await refreshAfterWrite('刷卡時間資料已更新。')
      return true
    } catch (error) { notify(errorText(error, '刷卡時間更新失敗。'), 'error'); return false }
    finally { endBusy(action) }
  }

  async function addDepartment(input: DepartmentDraft) {
    if (session?.role !== 'admin' && session?.role !== 'hr') { notify('沒有新增部門權限。', 'error'); return false }
    const department = { code: input.code.trim().toUpperCase(), name: input.name.trim(), manager: input.managerId }
    if (!department.code || !department.name) { notify('部門代號與部門名稱都是必填欄位。', 'error'); return false }
    if (data.departments.some((item) => item.code === department.code || item.name === department.name)) { notify('部門代號或名稱已經存在。', 'error'); return false }
    const action = 'department.create'
    if (!startBusy(action)) return false
    try {
      await addDepartmentCloud(department)
      await refreshAfterWrite(`已新增 ${department.code}｜${department.name}。`)
      return true
    } catch (error) { notify(errorText(error, '新增部門失敗。'), 'error'); return false }
    finally { endBusy(action) }
  }

  async function updateDepartment(id: string, patch: DepartmentPatch) {
    if (session?.role !== 'admin' && session?.role !== 'hr') { notify('沒有部門異動權限。', 'error'); return false }
    const normalized: DepartmentPatch = { code: patch.code.trim().toUpperCase(), name: patch.name.trim() }
    if (patch.manager !== undefined) normalized.manager = patch.manager
    if (!normalized.code || !normalized.name) { notify('部門代號與部門名稱都是必填欄位。', 'error'); return false }
    const action = `department.update:${id}`
    if (!startBusy(action)) return false
    try {
      await updateDepartmentCloud(id, normalized)
      await refreshAfterWrite(`部門 ${normalized.code} 已儲存。`)
      return true
    } catch (error) { notify(errorText(error, '部門資料儲存失敗。'), 'error'); return false }
    finally { endBusy(action) }
  }

  async function updatePassword(accountId: string, nextPassword: string) {
    if (session?.role !== 'admin') { notify('只有 admin 可以重設密碼。', 'error'); return false }
    const value = nextPassword.trim()
    if (value.length < 6) { notify('密碼至少需要 6 個字元。', 'error'); return false }
    const action = `password.set:${accountId}`
    if (!startBusy(action)) return false
    try {
      await setPasswordCloud(accountId, value)
      await refreshAfterWrite('密碼已更新，下次登入請使用新密碼。')
      return true
    } catch (error) { notify(errorText(error, '密碼更新失敗。'), 'error'); return false }
    finally { endBusy(action) }
  }

  function exportAttendance(records: DemoData['records']) {
    const txt = toTxt(records, data.employees)
    const blob = new Blob([txt], { type: 'text/plain;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `大安金普頓出勤紀錄-${new Date().toISOString().slice(0, 10)}.txt`
    link.click()
    URL.revokeObjectURL(url)
    notify('已下載 TXT 刷卡資料。')
  }

  if (!session) {
    return <LoginPage {...{ loginMode, setLoginMode, employeeNo, setEmployeeNo, password, setPassword, handleLogin, loginBusy, loginError }} />
  }

  if (session.role === 'employee' && session.employee) {
    return <EmployeePortal employee={session.employee} data={data} now={now} activeView={activeView} setActiveView={setActiveView} handlePunch={handlePunch} punchBusy={punchBusy} exportAttendance={exportAttendance} logout={logout} toast={toast} />
  }

  return <AdminShell
    data={data}
    employee={session.employee}
    handlePunch={handlePunch}
    punchBusy={punchBusy}
    accessRole={session.role}
    scopeDepartmentCode={session.employee?.departmentCode}
    now={now}
    lastSyncedAt={lastSyncedAt}
    activeView={activeView}
    setActiveView={setActiveView}
    mobileNavOpen={mobileNavOpen}
    setMobileNavOpen={setMobileNavOpen}
    logout={logout}
    exportAttendance={exportAttendance}
    networkDraft={networkDraft}
    setNetworkDraft={setNetworkDraft}
    networkModeDraft={networkModeDraft}
    setNetworkModeDraft={setNetworkModeDraft}
    saveNetworkSettings={saveNetworkSettings}
    updateEmployee={updateEmployee}
    toggleEmployeeActive={toggleEmployeeActive}
    importEmployees={importEmployees}
    addAttendanceRecord={addAttendanceRecord}
    updateAttendanceRecord={updateAttendanceRecord}
    addEmployee={addEmployee}
    addDepartment={addDepartment}
    updateDepartment={updateDepartment}
    updatePassword={updatePassword}
    busyAction={busyAction}
    toast={toast}
  />
}

function LoginPage(props: {
  loginMode: UserRole
  setLoginMode: (value: UserRole) => void
  employeeNo: string
  setEmployeeNo: (value: string) => void
  password: string
  setPassword: (value: string) => void
  handleLogin: (event: FormEvent) => void | Promise<void>
  loginBusy: boolean
  loginError: string
}) {
  return <main className="login-page">
    <div className="login-art" aria-hidden="true"><div className="art-topline"><span>DAAN DISTRICT</span><span>INTERNAL USE</span></div><div className="art-wordmark"><span className="mark-line" />KIMPTON<span className="mark-line" /></div><div className="art-caption">A softer way to start the day.</div><div className="art-footer"><span>大安金普頓</span><span>TAIPEI · 2026</span></div></div>
    <section className="login-panel">
      <div className="login-brand"><div className="brand-mark">K</div><div><p className="eyebrow">DAAN KIMPTON</p><h1>員工刷卡系統</h1></div></div>
      <div className="login-intro"><p className="eyebrow">GOOD TO SEE YOU</p><h2>準備開始今天的班次了嗎？</h2><p>使用員工編號登入，簡單完成每一次上下班刷卡。</p></div>
      <div className="mode-switch" role="tablist" aria-label="登入身分"><button className={props.loginMode === 'employee' ? 'active' : ''} onClick={() => props.setLoginMode('employee')} type="button"><UserRound size={16} />員工登入</button><button className={props.loginMode === 'admin' ? 'active' : ''} onClick={() => props.setLoginMode('admin')} type="button"><ShieldCheck size={16} />管理者登入</button></div>
      <form className="login-form" onSubmit={props.handleLogin}><label><span>{props.loginMode === 'admin' ? '管理者帳號' : '員工編號'}</span><div className="input-wrap"><UserRound size={18} /><input disabled={props.loginBusy} autoCapitalize="none" spellCheck={false} value={props.employeeNo} onChange={(event) => props.setEmployeeNo(event.target.value)} autoComplete="username" /></div></label><label><span>登入密碼</span><div className="input-wrap"><KeyRound size={18} /><input type="password" disabled={props.loginBusy} value={props.password} onChange={(event) => props.setPassword(event.target.value)} autoComplete="current-password" /></div></label><button className="primary-button login-button" type="submit" disabled={props.loginBusy} aria-busy={props.loginBusy}>{props.loginBusy ? '登入中…' : '進入系統'} <ChevronRight size={18} /></button>{props.loginError && <p className="login-error" role="alert">{props.loginError}</p>}</form>
      <p className="login-footnote">資料服務：Supabase 雲端。請使用管理者提供的雲端帳號登入。</p>
    </section>
  </main>
}

function EmployeePortal({ employee, data, now, activeView, setActiveView, handlePunch, punchBusy, exportAttendance, logout, toast }: {
  employee: Employee; data: DemoData; now: Date; activeView: View; setActiveView: (value: View) => void; handlePunch: (type: 'check_in' | 'check_out') => void; punchBusy: boolean; exportAttendance: (records: DemoData['records']) => void; logout: () => void; toast: Toast | null
}) {
  const todayRecords = data.records.filter((record) => record.employeeId === employee.id && isSameTaipeiDay(record.punchedAt))
  const didCheckIn = todayRecords.some((record) => record.type === 'check_in')
  const didCheckOut = todayRecords.some((record) => record.type === 'check_out')
  const latestRecords = data.records.filter((record) => record.employeeId === employee.id).slice(0, 6)
  const mobileEmployeeNav = <nav className="mobile-employee-nav" aria-label="員工快速導覽"><button type="button" className={activeView === 'dashboard' ? 'active' : ''} aria-current={activeView === 'dashboard' ? 'page' : undefined} onClick={() => setActiveView('dashboard')}><Clock3 size={17} />今日刷卡</button><button type="button" className={activeView === 'attendance' ? 'active' : ''} aria-current={activeView === 'attendance' ? 'page' : undefined} onClick={() => setActiveView('attendance')}><CalendarDays size={17} />我的紀錄</button></nav>
  return <div className="employee-app"><header className="mobile-topbar"><div className="brand-inline"><div className="brand-mark small">K</div><span>大安金普頓</span></div><button className="icon-button" onClick={logout} aria-label="登出"><LogOut size={18} /></button></header>{mobileEmployeeNav}<div className="employee-shell"><aside className="employee-rail"><div className="rail-brand"><div className="brand-mark">K</div><p>DAAN<br />KIMPTON</p></div><div className="rail-person"><div className="avatar">{employee.name.slice(0, 1)}</div><div><strong>{employee.name}</strong><small>{employee.employeeNo} · {employee.department}</small></div></div><nav className="rail-nav"><button className={activeView === 'dashboard' ? 'active' : ''} onClick={() => setActiveView('dashboard')}><Clock3 size={18} />今日刷卡</button><button className={activeView === 'attendance' ? 'active' : ''} onClick={() => setActiveView('attendance')}><CalendarDays size={18} />我的紀錄</button></nav><button className="rail-logout" onClick={logout}><LogOut size={17} />登出</button></aside><main className="employee-main"><div className="page-heading"><div><p className="eyebrow">EMPLOYEE PORTAL</p><h1>{activeView === 'dashboard' ? '今天，從容開始。' : '我的刷卡紀錄'}</h1><p className="muted">{formatTaipeiDate(now.toISOString())} · {formatTaipeiTime(now.toISOString())}</p></div></div>{activeView === 'dashboard' ? <EmployeeDashboard employee={employee} data={data} now={now} didCheckIn={didCheckIn} didCheckOut={didCheckOut} handlePunch={handlePunch} punchBusy={punchBusy} /> : <PersonalRecords records={latestRecords} allRecords={data.records.filter((record) => record.employeeId === employee.id)} exportAttendance={exportAttendance} />}</main></div>{toast && <ToastMessage toast={toast} />}</div>
}

function EmployeeDashboard({ employee, data, now, didCheckIn, didCheckOut, handlePunch, punchBusy }: { employee: Employee; data: DemoData; now: Date; didCheckIn: boolean; didCheckOut: boolean; handlePunch: (type: 'check_in' | 'check_out') => void; punchBusy: boolean }) {
  const todayRecords = data.records.filter((record) => record.employeeId === employee.id && isSameTaipeiDay(record.punchedAt))
  const checkIn = todayRecords.find((record) => record.type === 'check_in')
  const checkOut = todayRecords.find((record) => record.type === 'check_out')
  return <><section className="employee-hero"><div><span className="hero-kicker">{now.getHours() < 12 ? 'GOOD MORNING' : 'GOOD AFTERNOON'}</span><h2>{employee.name}，今天辛苦了。</h2><p>請在開始與結束班次時完成刷卡，系統會自動留下時間紀錄。</p></div><div className="hero-date"><span>{new Intl.DateTimeFormat('zh-TW', { timeZone: TAIPEI_TIME_ZONE, month: 'long', day: 'numeric' }).format(now)}</span><strong>{new Intl.DateTimeFormat('zh-TW', { timeZone: TAIPEI_TIME_ZONE, weekday: 'long' }).format(now)}</strong></div></section><section className="punch-grid"><button className={`punch-card check-in ${didCheckIn ? 'done' : ''}`} disabled={punchBusy} aria-busy={punchBusy} onClick={() => handlePunch('check_in')}><div className="punch-card-top"><span className="punch-index">01</span><span className="punch-state">{didCheckIn ? '已完成' : '尚未刷卡'}</span></div><div className="punch-icon"><ArrowDownToLine size={25} /></div><h3>上班刷卡</h3><p>{checkIn ? `最近一次 ${formatTaipeiDateTime(checkIn.punchedAt)}` : '記錄你的到班時間'}</p><span className="punch-action">再次刷卡 <ChevronRight size={17} /></span></button><button className={`punch-card check-out ${didCheckOut ? 'done' : ''}`} disabled={punchBusy} aria-busy={punchBusy} onClick={() => handlePunch('check_out')}><div className="punch-card-top"><span className="punch-index">02</span><span className="punch-state">{didCheckOut ? '已完成' : '尚未刷卡'}</span></div><div className="punch-icon"><ArrowLeft size={25} /></div><h3>下班刷卡</h3><p>{checkOut ? `最近一次 ${formatTaipeiDateTime(checkOut.punchedAt)}` : '結束班次時記得刷卡'}</p><span className="punch-action">再次刷卡 <ChevronRight size={17} /></span></button></section><section className="employee-status-row"><div className="section-label">TODAY AT A GLANCE</div><div className="status-list"><div><span className={didCheckIn ? 'mini-status done' : 'mini-status'}>{didCheckIn ? <Check size={14} /> : '—'}</span><span>上班時間</span><strong>{checkIn ? formatTaipeiDateTime(checkIn.punchedAt).slice(-5) : '待刷卡'}</strong></div><div><span className={didCheckOut ? 'mini-status done' : 'mini-status'}>{didCheckOut ? <Check size={14} /> : '—'}</span><span>下班時間</span><strong>{checkOut ? formatTaipeiDateTime(checkOut.punchedAt).slice(-5) : '待刷卡'}</strong></div></div></section></>
}

function PersonalRecords({ records, allRecords, exportAttendance }: { records: DemoData['records']; allRecords: DemoData['records']; exportAttendance: (records: DemoData['records']) => void }) {
  const [downloadStart, setDownloadStart] = useState('')
  const [downloadEnd, setDownloadEnd] = useState('')
  const [downloadError, setDownloadError] = useState('')
  const filteredPersonalRecords = allRecords.filter((record) => { const time = new Date(record.punchedAt).getTime(); const start = taipeiInputToIso(downloadStart); const end = taipeiInputToIso(downloadEnd); return (!start || time >= new Date(start).getTime()) && (!end || time <= new Date(end).getTime()) })
  function download() {
    const start = downloadStart ? taipeiInputToIso(downloadStart) : null
    const end = downloadEnd ? taipeiInputToIso(downloadEnd) : null
    if ((downloadStart && !start) || (downloadEnd && !end)) { setDownloadError('請輸入有效的台北日期時間。'); return }
    if (start && end && new Date(start).getTime() > new Date(end).getTime()) { setDownloadError('開始時間不可晚於結束時間。'); return }
    setDownloadError('')
    exportAttendance(filteredPersonalRecords)
  }
  return <section className="content-card personal-records"><div className="card-heading"><div><p className="eyebrow">MY ATTENDANCE</p><h2>最近刷卡</h2></div><div className="heading-actions"><label className="download-time-field">開始<input type="datetime-local" value={downloadStart} onChange={(event) => setDownloadStart(event.target.value)} /></label><label className="download-time-field">結束<input type="datetime-local" value={downloadEnd} onChange={(event) => setDownloadEnd(event.target.value)} /></label><button className="secondary-button" onClick={download}><Download size={16} />下載我的 TXT</button><FileSpreadsheet size={22} /></div></div>{downloadError && <p className="download-error">{downloadError}</p>}{records.length === 0 ? <EmptyState title="還沒有刷卡紀錄" detail="完成第一次刷卡後，紀錄會出現在這裡。" /> : <div className="simple-list">{records.map((record) => <div className="simple-row" key={record.id}><div className={`record-badge ${record.type}`}>{record.type === 'check_in' ? <ArrowDownToLine size={16} /> : <ArrowLeft size={16} />}</div><div><strong>{record.type === 'check_in' ? '上班刷卡' : '下班刷卡'}</strong><small>{formatTaipeiDate(record.punchedAt)} · {record.networkName}</small></div><time>{formatTaipeiDateTime(record.punchedAt)}</time></div>)}</div>}</section>
}

function AdminShell(props: {
  data: DemoData; accessRole: UserRole; scopeDepartmentCode?: string; now: Date; lastSyncedAt: string | null; activeView: View; setActiveView: (value: View) => void; mobileNavOpen: boolean; setMobileNavOpen: (value: boolean) => void; logout: () => void; exportAttendance: (records: DemoData['records']) => void; networkDraft: string; setNetworkDraft: (value: string) => void; networkModeDraft: NetworkMode; setNetworkModeDraft: (value: NetworkMode) => void; saveNetworkSettings: () => Promise<boolean>; updateEmployee: (id: string, patch: EmployeePatch) => Promise<boolean>; toggleEmployeeActive: (id: string) => Promise<boolean>; importEmployees: (rows: string[][]) => Promise<boolean>; addAttendanceRecord: (input: { employeeId: string; type: AttendanceRecord['type']; punchedAt: string }) => Promise<boolean>; updateAttendanceRecord: (id: string, patch: { type: AttendanceRecord['type']; punchedAt: string }) => Promise<boolean>; addEmployee: (input: NewEmployee) => Promise<boolean>; addDepartment: (input: DepartmentDraft) => Promise<boolean>; updateDepartment: (id: string, patch: DepartmentPatch) => Promise<boolean>; updatePassword: (accountId: string, password: string) => Promise<boolean>; busyAction: BusyAction; toast: Toast | null
  employee?: Employee; handlePunch: (type: 'check_in' | 'check_out') => void; punchBusy: boolean
}) {
  const { data, accessRole, scopeDepartmentCode, now, lastSyncedAt, activeView, setActiveView, mobileNavOpen, setMobileNavOpen, logout, exportAttendance, networkDraft, setNetworkDraft, networkModeDraft, setNetworkModeDraft, saveNetworkSettings, updateEmployee, toggleEmployeeActive, importEmployees, addAttendanceRecord, updateAttendanceRecord, addEmployee, addDepartment, updateDepartment, updatePassword, busyAction, toast } = props
  const { employee, handlePunch, punchBusy } = props
  const [query, setQuery] = useState('')
  const [dateFilter, setDateFilter] = useState<'today' | 'all'>('today')
  const scopedEmployees = data.employees.filter((employee) => accessRole !== 'manager' || employee.departmentCode === scopeDepartmentCode)
  const scopedEmployeeIds = new Set(scopedEmployees.map((employee) => employee.id))
  const todayRecords = data.records.filter((record) => isSameTaipeiDay(record.punchedAt) && scopedEmployeeIds.has(record.employeeId))
  const scopedRecords = data.records.filter((record) => {
    if (accessRole === 'admin' || accessRole === 'hr' || accessRole === 'it') return true
    const employee = data.employees.find((item) => item.id === record.employeeId)
    return accessRole === 'manager' && employee?.departmentCode === scopeDepartmentCode
  })
  const visibleRecords = scopedRecords.filter((record) => { const employee = data.employees.find((item) => item.id === record.employeeId); const matchesQuery = !query || [employee?.employeeNo, employee?.name, employee?.department].some((value) => value?.toLowerCase().includes(query.toLowerCase())); const matchesDate = dateFilter === 'all' || isSameTaipeiDay(record.punchedAt); return matchesQuery && matchesDate })
  const activeEmployees = scopedEmployees.filter((employee) => employee.active)
  const checkedEmployeeIds = new Set(todayRecords.map((record) => record.employeeId))
  const personalRecords = employee ? data.records.filter((record) => record.employeeId === employee.id) : []
  const personalTodayRecords = personalRecords.filter((record) => isSameTaipeiDay(record.punchedAt))
  const personalDidCheckIn = personalTodayRecords.some((record) => record.type === 'check_in')
  const personalDidCheckOut = personalTodayRecords.some((record) => record.type === 'check_out')
  const navItems = ([{ id: 'dashboard', label: '總覽', icon: SlidersHorizontal }, { id: 'attendance', label: accessRole === 'manager' ? '部門出勤' : '出勤紀錄', icon: CalendarDays }, { id: 'employees', label: '員工資料', icon: UsersRound }, { id: 'departments', label: '部門設定', icon: Building2 }, { id: 'settings', label: '系統設定', icon: Settings }] as { id: View; label: string; icon: typeof Clock3 }[]).filter((item) => accessRole === 'admin' || accessRole === 'hr' ? true : item.id === 'dashboard' || item.id === 'attendance')
  navItems.push({ id: 'clock', label: '我的刷卡', icon: Clock3 }, { id: 'personal', label: '我的紀錄', icon: CalendarDays })
  const viewTitle = navItems.find((item) => item.id === activeView)?.label ?? '總覽'
  return <div className="admin-app"><header className="admin-mobile-topbar"><button type="button" className="icon-button admin-menu-toggle" onClick={() => setMobileNavOpen(!mobileNavOpen)} aria-label="管理選單" aria-expanded={mobileNavOpen} aria-controls="admin-sidebar"><Menu size={20} /><span>管理選單</span></button><div className="brand-inline"><div className="brand-mark small">K</div><span>管理者後台</span></div><button className="icon-button" onClick={logout} aria-label="登出"><LogOut size={18} /></button></header><aside id="admin-sidebar" className={`admin-sidebar ${mobileNavOpen ? 'open' : ''}`}><div className="sidebar-brand"><div className="brand-mark">K</div><div><p>DAAN KIMPTON</p><strong>員工刷卡系統</strong></div></div><div className="sidebar-meta"><span className="eyebrow">ADMIN CONSOLE</span></div><nav className="sidebar-nav">{navItems.map(({ id, label, icon: Icon }) => <button key={id} className={activeView === id ? 'active' : ''} onClick={() => { setActiveView(id); setMobileNavOpen(false) }}><Icon size={18} /><span>{label}</span>{activeView === id && <ChevronRight size={15} className="nav-arrow" />}</button>)}</nav><div className="sidebar-bottom"><div className="admin-profile"><div className="avatar admin-avatar">A</div><div><strong>管理者</strong><small>{accessRole === 'it' ? 'IT 管理員' : accessRole === 'hr' ? '人資主管' : accessRole === 'manager' ? '部門主管' : '系統管理員'}</small></div></div><button className="sidebar-logout" onClick={logout}><LogOut size={17} />登出</button></div></aside><main className="admin-main"><div className="admin-heading"><div><p className="eyebrow">{activeView === 'dashboard' ? 'AT A GLANCE' : 'ADMIN CONSOLE'}</p><h1>{viewTitle}</h1><p className="muted">{formatTaipeiDate(now.toISOString())} · 最後成功更新 {lastSyncedAt ? formatTaipeiDateTime(lastSyncedAt) : '尚未成功更新'}</p></div><div className="heading-actions"><div className="network-summary"><span className="status-dot" />{data.network.mode === 'test' ? '未限制 IP' : 'IP 限制已啟用'}</div></div></div>{activeView === 'dashboard' && <AdminDashboard data={data} todayRecords={todayRecords} activeEmployees={activeEmployees} checkedEmployeeIds={checkedEmployeeIds} onNavigate={setActiveView} accessRole={accessRole} />}{activeView === 'clock' && employee && <EmployeeDashboard employee={employee} data={data} now={now} didCheckIn={personalDidCheckIn} didCheckOut={personalDidCheckOut} handlePunch={handlePunch} punchBusy={punchBusy} />}{activeView === 'personal' && employee && <PersonalRecords records={personalRecords.slice(0, 6)} allRecords={personalRecords} exportAttendance={exportAttendance} />}{activeView === 'attendance' && <AttendanceAdmin data={data} records={visibleRecords} allScopedRecords={scopedRecords} query={query} setQuery={setQuery} dateFilter={dateFilter} setDateFilter={setDateFilter} addAttendanceRecord={addAttendanceRecord} updateAttendanceRecord={updateAttendanceRecord} canEditAttendance={accessRole === 'admin'} accessRole={accessRole} scopeDepartmentCode={scopeDepartmentCode} exportAttendance={exportAttendance} toggleEmployeeActive={toggleEmployeeActive} importEmployees={importEmployees} busyAction={busyAction} />}{activeView === 'employees' && (accessRole === 'admin' || accessRole === 'hr') && <EmployeeAdmin data={data} accessRole={accessRole} updateEmployee={updateEmployee} toggleEmployeeActive={toggleEmployeeActive} importEmployees={importEmployees} addEmployee={addEmployee} updatePassword={updatePassword} busyAction={busyAction} />}{activeView === 'departments' && (accessRole === 'admin' || accessRole === 'hr') && <DepartmentAdmin data={data} addDepartment={addDepartment} updateDepartment={updateDepartment} busyAction={busyAction} />}{activeView === 'settings' && (accessRole === 'admin' || accessRole === 'hr') && <SettingsAdmin readOnly={accessRole === 'hr'} data={data} networkDraft={networkDraft} setNetworkDraft={setNetworkDraft} networkModeDraft={networkModeDraft} setNetworkModeDraft={setNetworkModeDraft} saveNetworkSettings={saveNetworkSettings} updatePassword={updatePassword} busyAction={busyAction} />}</main>{toast && <ToastMessage toast={toast} />}</div>
}

function AdminDashboard({ data, todayRecords, activeEmployees, checkedEmployeeIds, onNavigate, accessRole }: { data: DemoData; todayRecords: DemoData['records']; activeEmployees: Employee[]; checkedEmployeeIds: Set<string>; onNavigate: (view: View) => void; accessRole: UserRole }) {
  const checkIns = todayRecords.filter((record) => record.type === 'check_in').length
  const checkOuts = todayRecords.filter((record) => record.type === 'check_out').length
  return <><section className="admin-welcome"><div><span className="hero-kicker">TODAY · {new Intl.DateTimeFormat('zh-TW', { timeZone: TAIPEI_TIME_ZONE, month: '2-digit', day: '2-digit' }).format(new Date())}</span><h2>早安，管理者。</h2><p>這裡是團隊今天的出勤狀態。保持簡單，讓每個人準時開始。</p></div><div className="welcome-symbol"><Globe2 size={34} /></div></section><section className="metric-grid"><MetricCard label="在職員工" value={activeEmployees.length} detail="目前啟用帳號" icon={<UsersRound size={19} />} /><MetricCard label="今日已刷卡" value={checkedEmployeeIds.size} detail={`上班 ${checkIns} · 下班 ${checkOuts}`} icon={<Clock3 size={19} />} /><MetricCard label="待處理異常" value={data.records.filter((record) => record.status === 'rejected').length} detail="需要管理者確認" icon={<CircleAlert size={19} />} warning /><MetricCard label="網路模式" value={data.network.mode === 'test' ? '未限制 IP' : '正式' } detail={data.network.allowedIps.length ? `${data.network.allowedIps.length} 組允許 IP／網段` : '目前未設定限制'} icon={<Network size={19} />} /></section><div className="admin-columns"><section className="content-card dashboard-list-card"><div className="card-heading"><div><p className="eyebrow">TODAY'S TEAM</p><h2>團隊出勤</h2></div><button className="text-button" onClick={() => onNavigate('attendance')}>查看全部 <ChevronRight size={15} /></button></div><div className="team-list">{activeEmployees.slice(0, 5).map((employee) => { const employeeRecords = todayRecords.filter((record) => record.employeeId === employee.id); const checkedIn = employeeRecords.some((record) => record.type === 'check_in'); const checkedOut = employeeRecords.some((record) => record.type === 'check_out'); return <div className="team-row" key={employee.id}><div className="avatar">{employee.name.slice(0, 1)}</div><div className="team-person"><strong>{employee.name}</strong><small>{employee.department} · {employee.title}</small></div><div className="team-status"><span className={checkedIn ? 'tag success' : 'tag'}>{checkedIn ? '已上班' : '未刷卡'}</span><span className={checkedOut ? 'tag success pale' : 'tag muted-tag'}>{checkedOut ? '已下班' : '—'}</span></div></div> })}</div></section><section className="content-card quick-card"><div className="card-heading"><div><p className="eyebrow">QUICK ACTIONS</p><h2>常用操作</h2></div><SlidersHorizontal size={21} /></div>{(accessRole === 'admin' || accessRole === 'hr') && <button onClick={() => onNavigate('employees')}><span className="quick-icon"><UsersRound size={18} /></span><span><strong>管理員工資料</strong><small>新增、編輯或停用帳號</small></span><ChevronRight size={16} /></button>}{accessRole === 'admin' && <button onClick={() => onNavigate('settings')}><span className="quick-icon"><Wifi size={18} /></span><span><strong>設定公司 IP</strong><small>{data.network.mode === 'test' ? '目前未限制 IP' : '目前已啟用正式模式'}</small></span><ChevronRight size={16} /></button>}</section></div></>
}

function MetricCard({ label, value, detail, icon, warning = false }: { label: string; value: string | number; detail: string; icon: ReactNode; warning?: boolean }) { return <div className={`metric-card ${warning ? 'warning' : ''}`}><div className="metric-top"><span>{label}</span><span className="metric-icon">{icon}</span></div><strong>{value}</strong><small>{detail}</small></div> }

function AttendanceAdmin({ data, records, allScopedRecords, query, setQuery, dateFilter, setDateFilter, addAttendanceRecord, updateAttendanceRecord, canEditAttendance, accessRole, scopeDepartmentCode, exportAttendance, toggleEmployeeActive, importEmployees, busyAction }: { data: DemoData; records: DemoData['records']; allScopedRecords: DemoData['records']; query: string; setQuery: (value: string) => void; dateFilter: 'today' | 'all'; setDateFilter: (value: 'today' | 'all') => void; addAttendanceRecord: (input: { employeeId: string; type: AttendanceRecord['type']; punchedAt: string }) => Promise<boolean>; updateAttendanceRecord: (id: string, patch: { type: AttendanceRecord['type']; punchedAt: string }) => Promise<boolean>; canEditAttendance: boolean; accessRole: UserRole; scopeDepartmentCode?: string; exportAttendance: (records: DemoData['records']) => void; toggleEmployeeActive: (id: string) => Promise<boolean>; importEmployees: (rows: string[][]) => Promise<boolean>; busyAction: BusyAction }) {
  const [adding, setAdding] = useState(false)
  const [employeeId, setEmployeeId] = useState(data.employees.find((employee) => employee.active)?.id ?? '')
  const [type, setType] = useState<AttendanceRecord['type']>('check_in')
  const [punchedAt, setPunchedAt] = useState(() => isoToTaipeiInput(new Date().toISOString()))
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editType, setEditType] = useState<AttendanceRecord['type']>('check_in')
  const [editTime, setEditTime] = useState('')
  const [downloadScope, setDownloadScope] = useState<'all' | 'department' | 'employee'>(accessRole === 'manager' ? 'department' : 'all')
  const [downloadDepartment, setDownloadDepartment] = useState(scopeDepartmentCode ?? data.departments[0]?.code ?? '')
  const [downloadEmployee, setDownloadEmployee] = useState('')
  const [downloadStart, setDownloadStart] = useState('')
  const [downloadEnd, setDownloadEnd] = useState('')
  const [formError, setFormError] = useState('')
  const [downloadError, setDownloadError] = useState('')
  const allowedEmployees = data.employees.filter((employee) => accessRole !== 'manager' || employee.departmentCode === scopeDepartmentCode)
  const downloadableRecords = allScopedRecords.filter((record) => { const timestamp = new Date(record.punchedAt).getTime(); const employee = data.employees.find((item) => item.id === record.employeeId); if (downloadStart) { const start = taipeiInputToIso(downloadStart); if (!start || timestamp < new Date(start).getTime()) return false } if (downloadEnd) { const end = taipeiInputToIso(downloadEnd); if (!end || timestamp > new Date(end).getTime()) return false } if (downloadScope === 'employee') return record.employeeId === downloadEmployee; if (downloadScope === 'department') return employee?.departmentCode === (accessRole === 'manager' ? scopeDepartmentCode : downloadDepartment); return true })
  function submit(event: FormEvent) { event.preventDefault(); const iso = taipeiInputToIso(punchedAt); if (!iso) { setFormError('請輸入有效的台北日期時間。'); return } setFormError(''); void addAttendanceRecord({ employeeId, type, punchedAt: iso }).then((ok) => { if (ok) setAdding(false) }) }
  function beginEdit(record: AttendanceRecord) { setEditingId(record.id); setEditType(record.type); setEditTime(isoToTaipeiInput(record.punchedAt)); setFormError('') }
  function saveEdit(record: AttendanceRecord) { const iso = taipeiInputToIso(editTime); if (!iso) { setFormError('請輸入有效的台北日期時間。'); return } setFormError(''); void updateAttendanceRecord(record.id, { type: editType, punchedAt: iso }).then((ok) => { if (ok) setEditingId(null) }) }
  function download() { const start = downloadStart ? taipeiInputToIso(downloadStart) : null; const end = downloadEnd ? taipeiInputToIso(downloadEnd) : null; if ((downloadStart && !start) || (downloadEnd && !end)) { setDownloadError('請輸入有效的台北日期時間。'); return } if (start && end && new Date(start).getTime() > new Date(end).getTime()) { setDownloadError('開始時間不可晚於結束時間。'); return } if (downloadScope === 'employee' && !downloadEmployee) { setDownloadError('請選擇要下載的員工。'); return } setDownloadError(''); exportAttendance(downloadableRecords) }
  return <section className="content-card table-card"><div className="filter-bar"><div className="search-field"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜尋姓名、員工編號或部門" /></div><div className="filter-tabs"><button className={dateFilter === 'today' ? 'active' : ''} onClick={() => setDateFilter('today')}>今天</button><button className={dateFilter === 'all' ? 'active' : ''} onClick={() => setDateFilter('all')}>全部紀錄</button></div><select className="table-input table-select" value={downloadScope} onChange={(event) => setDownloadScope(event.target.value as typeof downloadScope)}><option value="all">下載：全部授權紀錄</option><option value="department">下載：部門</option><option value="employee">下載：個人</option></select>{downloadScope === 'department' && accessRole !== 'manager' && <select className="table-input table-select" value={downloadDepartment} onChange={(event) => setDownloadDepartment(event.target.value)}><option value="">選擇部門</option>{data.departments.filter((department) => department.active).map((department) => <option key={department.id} value={department.code}>{department.code}｜{department.name}</option>)}</select>}{downloadScope === 'employee' && <select className="table-input table-select" value={downloadEmployee} onChange={(event) => setDownloadEmployee(event.target.value)}><option value="">選擇人員</option>{allowedEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.employeeNo}｜{employee.name}</option>)}</select>}<label className="download-time-field">開始<input type="datetime-local" value={downloadStart} onChange={(event) => setDownloadStart(event.target.value)} /></label><label className="download-time-field">結束<input type="datetime-local" value={downloadEnd} onChange={(event) => setDownloadEnd(event.target.value)} /></label><button className="secondary-button" onClick={download} disabled={busyAction !== null}><Download size={16} />下載 TXT</button>{canEditAttendance && <button className="primary-button" onClick={() => setAdding((value) => !value)} disabled={busyAction !== null}>{adding ? <X size={16} /> : <Plus size={16} />}{adding ? '取消補登' : '新增刷卡時間'}</button>}</div>{downloadError && <p className="download-error">{downloadError}</p>}{formError && <p className="form-error">{formError}</p>}{accessRole === 'it' && <ITTools data={data} importEmployees={importEmployees} toggleEmployeeActive={toggleEmployeeActive} busyAction={busyAction} />}{canEditAttendance && adding && <form className="employee-add-form" onSubmit={submit}><label><span>員工</span><select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>{data.employees.filter((employee) => employee.active).map((employee) => <option key={employee.id} value={employee.id}>{employee.employeeNo}｜{employee.name}</option>)}</select></label><label><span>類型</span><select value={type} onChange={(event) => setType(event.target.value as AttendanceRecord['type'])}><option value="check_in">F1｜上班</option><option value="check_out">F2｜下班</option></select></label><label><span>刷卡時間</span><input type="datetime-local" value={punchedAt} onChange={(event) => setPunchedAt(event.target.value)} /></label><button className="primary-button form-submit" type="submit" disabled={busyAction !== null}><Check size={16} />儲存補登</button></form>}<div className="table-wrap"><table><thead><tr><th>員工</th><th>部門／職稱</th><th>刷卡類型</th><th>刷卡時間</th><th>來源網路</th><th>狀態</th>{canEditAttendance && <th>操作</th>}</tr></thead><tbody>{records.length === 0 ? <tr><td colSpan={canEditAttendance ? 7 : 6}><EmptyState title="找不到符合條件的紀錄" detail="換個關鍵字或日期範圍再試試。" /></td></tr> : records.map((record) => { const employee = data.employees.find((item) => item.id === record.employeeId); const editing = editingId === record.id; return <tr key={record.id}><td><div className="table-person"><div className="avatar tiny">{employee?.name.slice(0, 1)}</div><div><strong>{employee?.name}</strong><small>{employee?.employeeNo}</small></div></div></td><td><div className="cell-stack"><span>{employee?.department}</span><small>{employee?.title}</small></div></td><td>{canEditAttendance && editing ? <select className="table-input table-select" value={editType} onChange={(event) => setEditType(event.target.value as AttendanceRecord['type'])}><option value="check_in">F1｜上班</option><option value="check_out">F2｜下班</option></select> : <span className={`record-type ${record.type}`}>{record.type === 'check_in' ? 'F1｜上班' : 'F2｜下班'}</span>}</td><td>{canEditAttendance && editing ? <input className="table-input" type="datetime-local" value={editTime} onChange={(event) => setEditTime(event.target.value)} /> : formatTaipeiDateTime(record.punchedAt)}</td><td><div className="network-cell"><Wifi size={14} />{record.networkName}<small>{record.ip}</small></div></td><td><span className="tag success">正常</span></td>{canEditAttendance && <td>{editing ? <><button className="table-action-button" onClick={() => saveEdit(record)} disabled={busyAction !== null}><Check size={14} />儲存</button><button className="table-action-button" onClick={() => setEditingId(null)} disabled={busyAction !== null}><X size={14} />取消</button></> : <button className="table-action-button" onClick={() => beginEdit(record)} disabled={busyAction !== null}><Pencil size={14} />編輯</button>}</td>}</tr> })}</tbody></table></div><div className="table-footer"><span>共 {records.length} 筆畫面紀錄</span><span>下載範圍只依授權範圍、下載條件與時間區間，不受畫面今天／搜尋條件限制</span></div></section>
}

function ITTools({ data, importEmployees, toggleEmployeeActive, busyAction }: { data: DemoData; importEmployees: (rows: string[][]) => Promise<boolean>; toggleEmployeeActive: (id: string) => Promise<boolean>; busyAction: BusyAction }) {
  async function parseImportFile(event: ChangeEvent<HTMLInputElement>) { const file = event.target.files?.[0]; if (!file) return; const rows = parseCsvRows(await file.text()); const ok = await importEmployees(rows); if (ok) event.target.value = '' }
  return <section className="content-card it-tools-panel"><div className="card-heading"><div><p className="eyebrow">IT TOOLS</p><h2>批次匯入與帳號狀態</h2><p className="muted">IT 僅可匯入帳號並切換啟用狀態；不提供員工編輯、密碼或群組管理。</p></div><div className="heading-actions"><button className="secondary-button" onClick={() => downloadCsvTemplate(true)} disabled={busyAction !== null}><FileDown size={16} />下載 IT 匯入範本</button><label className="secondary-button file-upload-button"><Upload size={16} />匯入員工檔案<input type="file" accept=".csv,.txt" onChange={parseImportFile} hidden disabled={busyAction !== null} /></label></div></div><div className="it-account-table"><table><thead><tr><th>員工編號</th><th>姓名</th><th>啟用</th></tr></thead><tbody>{data.employees.map((employee) => <tr key={employee.id}><td><span className="code-label">{employee.employeeNo}</span></td><td>{employee.name}</td><td><button className="table-action-button" onClick={() => void toggleEmployeeActive(employee.id)} disabled={busyAction !== null}>{employee.active ? '啟用中' : '已停用'}</button></td></tr>)}</tbody></table></div></section>
}

function EmployeeAdmin({ data, accessRole, updateEmployee, toggleEmployeeActive, importEmployees, addEmployee, updatePassword, busyAction }: { data: DemoData; accessRole: UserRole; updateEmployee: (id: string, patch: EmployeePatch) => Promise<boolean>; toggleEmployeeActive: (id: string) => Promise<boolean>; importEmployees: (rows: string[][]) => Promise<boolean>; addEmployee: (input: NewEmployee) => Promise<boolean>; updatePassword: (accountId: string, password: string) => Promise<boolean>; busyAction: BusyAction }) {
  const [isAdding, setIsAdding] = useState(false)
  const [passwordEmployeeId, setPasswordEmployeeId] = useState<string | null>(null)
  const [passwordDraft, setPasswordDraft] = useState('')
  const [editingEmployeeId, setEditingEmployeeId] = useState<string | null>(null)
  const [editingEmployeeDraft, setEditingEmployeeDraft] = useState<Employee | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)
  const canBulkImport = ['admin', 'hr'].includes(accessRole)
  const canAssignAdmin = accessRole === 'admin'
  const [draft, setDraft] = useState<NewEmployee>({ employeeNo: '', name: '', departmentCode: data.departments[0]?.code ?? '', title: '', accessRole: 'employee' })
  const updateDraft = (field: keyof NewEmployee, value: string) => setDraft((current) => ({ ...current, [field]: value }))
  async function submitEmployee(event: FormEvent) { event.preventDefault(); const ok = await addEmployee(draft); if (ok) { setDraft({ employeeNo: '', name: '', departmentCode: data.departments[0]?.code ?? '', title: '', accessRole: 'employee' }); setIsAdding(false) } }
  function beginEmployeeEdit(employee: Employee) { setEditingEmployeeId(employee.id); setEditingEmployeeDraft({ ...employee }) }
  function cancelEmployeeEdit() { if (savingEdit) return; setEditingEmployeeId(null); setEditingEmployeeDraft(null) }
  async function saveEmployeeEdit() { if (!editingEmployeeDraft || !editingEmployeeDraft.employeeNo.trim() || !editingEmployeeDraft.name.trim() || !editingEmployeeDraft.departmentCode) return; setSavingEdit(true); const ok = await updateEmployee(editingEmployeeDraft.id, { employeeNo: editingEmployeeDraft.employeeNo, name: editingEmployeeDraft.name, departmentCode: editingEmployeeDraft.departmentCode, title: editingEmployeeDraft.title, accessRole: editingEmployeeDraft.accessRole ?? 'employee' }); setSavingEdit(false); if (ok) { setEditingEmployeeId(null); setEditingEmployeeDraft(null) } }
  async function parseImportFile(event: ChangeEvent<HTMLInputElement>) { const file = event.target.files?.[0]; if (!file) return; const ok = await importEmployees(parseCsvRows(await file.text())); if (ok) event.target.value = '' }
  return <section className="content-card employee-admin-card"><div className="card-heading"><div><p className="eyebrow">TEAM DIRECTORY</p><h2>員工資料與帳號</h2><p className="muted">可下載 BOM CSV 範本、批次匯入員工，或管理帳號啟用狀態。</p></div><div className="heading-actions">{canBulkImport && <><button className="secondary-button" onClick={() => downloadCsvTemplate(false)} disabled={busyAction !== null}><FileDown size={16} />下載匯入範本</button><label className="secondary-button file-upload-button"><Upload size={16} />匯入員工檔案<input type="file" accept=".csv,.txt" onChange={parseImportFile} hidden disabled={busyAction !== null} /></label></>}<button className="primary-button" onClick={() => setIsAdding((value) => !value)} disabled={busyAction !== null}>{isAdding ? <X size={16} /> : <Plus size={16} />}{isAdding ? '取消新增' : '新增員工'}</button></div></div>{isAdding && <form className="employee-add-form" onSubmit={submitEmployee}><label><span>員工編號 *</span><input value={draft.employeeNo} onChange={(event) => updateDraft('employeeNo', event.target.value)} placeholder="例如 DA006" /></label><label><span>姓名 *</span><input value={draft.name} onChange={(event) => updateDraft('name', event.target.value)} placeholder="請輸入姓名" /></label><label><span>部門 *</span><select value={draft.departmentCode} onChange={(event) => updateDraft('departmentCode', event.target.value)}><option value="">選擇部門</option>{data.departments.filter((department) => department.active).map((department) => <option key={department.id} value={department.code}>{department.code}｜{department.name}</option>)}</select></label><label><span>職稱</span><input value={draft.title} onChange={(event) => updateDraft('title', event.target.value)} placeholder="例如 前台接待" /></label><label><span>系統權限 *</span><select value={draft.accessRole} onChange={(event) => updateDraft('accessRole', event.target.value as UserRole)}><option value="employee">一般員工</option><option value="manager">部門主管</option><option value="hr">人資主管</option><option value="it">IT 管理員</option>{canAssignAdmin && <option value="admin">Admin</option>}</select></label><button className="primary-button form-submit" type="submit" disabled={busyAction !== null}><Check size={16} />儲存員工</button></form>}<div className="employee-table-wrap"><table><thead><tr><th>員工編號</th><th>姓名</th><th>部門</th><th>職稱</th><th>權限</th><th>狀態</th><th>帳號操作</th></tr></thead><tbody>{data.employees.map((employee) => { const editing = editingEmployeeId === employee.id && editingEmployeeDraft; const draftEmployee = editingEmployeeDraft; const canEditRole = canAssignAdmin || employee.accessRole !== 'admin'; return <tr key={employee.id}>{editing && draftEmployee ? <><td><input className="table-input code-input" value={draftEmployee.employeeNo} onChange={(event) => setEditingEmployeeDraft({ ...draftEmployee, employeeNo: event.target.value.toUpperCase() })} /></td><td><input className="table-input name-input" value={draftEmployee.name} onChange={(event) => setEditingEmployeeDraft({ ...draftEmployee, name: event.target.value })} /></td><td><select className="table-input table-select" value={draftEmployee.departmentCode ?? ''} onChange={(event) => setEditingEmployeeDraft({ ...draftEmployee, departmentCode: event.target.value, department: data.departments.find((department) => department.code === event.target.value)?.name ?? draftEmployee.department })}>{data.departments.filter((department) => department.active).map((department) => <option key={department.id} value={department.code}>{department.code}｜{department.name}</option>)}</select></td><td><input className="table-input" value={draftEmployee.title} onChange={(event) => setEditingEmployeeDraft({ ...draftEmployee, title: event.target.value })} /></td><td><select className="table-input table-select" value={draftEmployee.accessRole ?? 'employee'} disabled={!canEditRole} onChange={(event) => setEditingEmployeeDraft({ ...draftEmployee, accessRole: event.target.value as UserRole })}>{!canAssignAdmin && draftEmployee.accessRole === 'admin' && <option value="admin">Admin</option>}<option value="employee">一般員工</option><option value="manager">部門主管</option><option value="hr">人資主管</option><option value="it">IT 管理員</option>{canAssignAdmin && <option value="admin">Admin</option>}</select></td><td>{employee.active ? '啟用中' : '已停用'}</td><td><div className="row-actions"><button className="table-action-button save" onClick={() => void saveEmployeeEdit()} disabled={savingEdit || busyAction !== null}><Check size={14} />{savingEdit ? '儲存中…' : '儲存'}</button><button className="table-action-button" onClick={cancelEmployeeEdit} disabled={savingEdit || busyAction !== null}><X size={14} />取消</button></div></td></> : <><td><span className="code-label">{employee.employeeNo}</span></td><td><strong>{employee.name}</strong></td><td>{employee.department}</td><td>{employee.title}</td><td>{employee.accessRole === 'admin' ? 'Admin' : employee.accessRole === 'hr' ? '人資主管' : employee.accessRole === 'it' ? 'IT 管理員' : employee.accessRole === 'manager' ? '部門主管' : '一般員工'}</td><td><button className={`table-action-button ${employee.active ? '' : 'danger-button'}`} onClick={() => void toggleEmployeeActive(employee.id)} disabled={busyAction !== null}>{employee.active ? '啟用中' : '已停用'}</button></td><td><div className="row-actions"><button className="table-action-button" onClick={() => beginEmployeeEdit(employee)} disabled={busyAction !== null}><Pencil size={14} />修改</button>{accessRole === 'admin' && <button className="table-action-button" onClick={() => { setPasswordEmployeeId(passwordEmployeeId === employee.id ? null : employee.id); setPasswordDraft('') }} disabled={busyAction !== null}><KeyRound size={14} />重設密碼</button>}</div>{passwordEmployeeId === employee.id && accessRole === 'admin' && <div className="inline-password"><input type="password" value={passwordDraft} onChange={(event) => setPasswordDraft(event.target.value)} placeholder="至少 6 碼" /><button className="small-save" onClick={async () => { if (await updatePassword(employee.id, passwordDraft)) { setPasswordEmployeeId(null); setPasswordDraft('') } }} disabled={busyAction !== null}>儲存</button></div>}</td></>}</tr> })}</tbody></table></div></section>
}

function DepartmentAdmin({ data, addDepartment, updateDepartment, busyAction }: { data: DemoData; addDepartment: (input: DepartmentDraft) => Promise<boolean>; updateDepartment: (id: string, patch: DepartmentPatch) => Promise<boolean>; busyAction: BusyAction }) {
  const [isAdding, setIsAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingDraft, setEditingDraft] = useState<DepartmentDraft | null>(null)
  const [draft, setDraft] = useState<DepartmentDraft>({ code: '', name: '', managerId: '' })
  const updateDraft = (field: keyof DepartmentDraft, value: string) => setDraft((current) => ({ ...current, [field]: value }))
  async function submitDepartment(event: FormEvent) { event.preventDefault(); const ok = await addDepartment(draft); if (ok) { setDraft({ code: '', name: '', managerId: '' }); setIsAdding(false) } }
  async function saveDepartment(departmentId: string) {
    if (!editingDraft || !editingDraft.code.trim() || !editingDraft.name.trim()) return
    const patch: DepartmentPatch = { code: editingDraft.code, name: editingDraft.name }
    if (editingDraft.managerId !== '__legacy__') patch.manager = editingDraft.managerId
    const ok = await updateDepartment(departmentId, patch)
    if (ok) { setEditingId(null); setEditingDraft(null) }
  }
  return <section className="content-card employee-admin-card"><div className="card-heading"><div><p className="eyebrow">DEPARTMENT DIRECTORY</p><h2>部門設定</h2><p className="muted">部門主管可留白；下拉值使用員工 UUID，同名員工不會混淆。舊自由文字主管可選擇保留。</p></div><button className="primary-button" onClick={() => setIsAdding((value) => !value)} disabled={busyAction !== null}>{isAdding ? <X size={16} /> : <Plus size={16} />}{isAdding ? '取消新增' : '新增部門'}</button></div>{isAdding && <form className="employee-add-form department-add-form" onSubmit={submitDepartment}><label><span>部門代號 *</span><input value={draft.code} onChange={(event) => updateDraft('code', event.target.value)} placeholder="例如 FO" /></label><label><span>部門名稱 *</span><input value={draft.name} onChange={(event) => updateDraft('name', event.target.value)} placeholder="例如 客務部" /></label><label><span>部門主管（非必填）</span><select value={draft.managerId} onChange={(event) => updateDraft('managerId', event.target.value)}><option value="">暫不指定</option>{data.employees.filter((employee) => employee.active).map((employee) => <option key={employee.id} value={employee.id}>{employee.employeeNo}｜{employee.name}</option>)}</select></label><button className="primary-button form-submit" type="submit" disabled={busyAction !== null}><Check size={16} />儲存部門</button></form>}<div className="employee-table-wrap"><table><thead><tr><th>部門代號</th><th>部門名稱</th><th>部門主管</th><th>狀態</th><th>操作</th></tr></thead><tbody>{data.departments.map((department) => { const editing = editingId === department.id; const legacyManager = !department.managerId && Boolean(department.manager); return <tr key={department.id}>{editing && editingDraft ? <><td><input className="table-input code-input" value={editingDraft.code} onChange={(event) => setEditingDraft({ ...editingDraft, code: event.target.value.toUpperCase() })} /></td><td><input className="table-input name-input" value={editingDraft.name} onChange={(event) => setEditingDraft({ ...editingDraft, name: event.target.value })} /></td><td><select className="table-input table-select" value={editingDraft.managerId} onChange={(event) => setEditingDraft({ ...editingDraft, managerId: event.target.value })}><option value="">暫不指定</option>{legacyManager && <option value="__legacy__">保留原主管：{department.manager}（未對應員工）</option>}{data.employees.filter((employee) => employee.active || employee.id === department.managerId).map((employee) => <option key={employee.id} value={employee.id}>{employee.employeeNo}｜{employee.name}</option>)}</select></td><td><span className="tag success">編輯中</span></td><td><div className="row-actions"><button className="table-action-button save" onClick={() => void saveDepartment(department.id)} disabled={busyAction !== null}><Check size={14} />儲存</button><button className="table-action-button" onClick={() => { setEditingId(null); setEditingDraft(null) }} disabled={busyAction !== null}>取消</button></div></td></> : <><td><span className="code-label">{department.code}</span></td><td><strong>{department.name}</strong></td><td>{department.manager || '尚未指定'}</td><td><span className="tag success">啟用中</span></td><td><button className="table-action-button" onClick={() => { setEditingId(department.id); setEditingDraft({ code: department.code, name: department.name, managerId: department.managerId ?? (department.manager ? '__legacy__' : '') }) }} disabled={busyAction !== null}><Pencil size={14} />編輯</button></td></>}</tr> })}</tbody></table></div></section>
}

function SettingsAdmin({ data, readOnly, networkDraft, setNetworkDraft, networkModeDraft, setNetworkModeDraft, saveNetworkSettings, updatePassword, busyAction }: { data: DemoData; readOnly: boolean; networkDraft: string; setNetworkDraft: (value: string) => void; networkModeDraft: NetworkMode; setNetworkModeDraft: (value: NetworkMode) => void; saveNetworkSettings: () => Promise<boolean>; updatePassword: (accountId: string, password: string) => Promise<boolean>; busyAction: BusyAction }) {
  const [adminPasswordDraft, setAdminPasswordDraft] = useState('')
  return <div className="settings-grid"><section className="content-card settings-card"><div className="card-heading"><div><p className="eyebrow">NETWORK ACCESS</p><h2>公司網路限制</h2><p className="muted">正式串接後，打卡請求會由伺服器檢查來源公網 IP，支援 IP、CIDR 與 IPv6 網段。</p></div><div className={`large-status ${data.network.mode === 'test' ? 'test' : 'strict'}`}>{data.network.mode === 'test' ? <CircleAlert size={20} /> : <ShieldCheck size={20} />}<span>{data.network.mode === 'test' ? '未限制 IP' : 'IP 限制已啟用'}</span></div></div><div className="mode-choice"><button className={networkModeDraft === 'test' ? 'selected' : ''} disabled={readOnly || busyAction !== null} onClick={() => setNetworkModeDraft('test')}><div className="choice-radio" /><div><strong>未限制 IP</strong><small>暫不限制來源網路，方便流程調校。</small></div></button><button className={networkModeDraft === 'strict' ? 'selected' : ''} disabled={readOnly || busyAction !== null} onClick={() => setNetworkModeDraft('strict')}><div className="choice-radio" /><div><strong>正式 IP 模式</strong><small>只允許下方列出的 IP、CIDR 或 IPv6 網段打卡。</small></div></button></div><label className="settings-label"><span>允許的 IP／CIDR／IPv6 網段</span><textarea rows={4} value={networkDraft} disabled={readOnly || busyAction !== null} onChange={(event) => setNetworkDraft(event.target.value)} placeholder="例如：203.0.113.25\n2001:db8::/32\n每行一組，也可用逗號分隔" /></label><div className="settings-hint"><Globe2 size={17} /><div><strong>目前儲存狀態</strong><span>{data.network.allowedIps.length ? `已設定 ${data.network.allowedIps.length} 組 · 最近更新 ${formatTaipeiDateTime(data.network.updatedAt)}` : '目前未限制 IP。'}</span></div></div><div className="form-actions">{!readOnly && <button className="primary-button" onClick={() => void saveNetworkSettings()} disabled={busyAction !== null}><Check size={16} />儲存網路設定</button>}</div></section><section className="content-card settings-card secondary-settings"><div className="card-heading"><div><p className="eyebrow">ACCOUNT SECURITY</p><h2>管理者密碼</h2><p className="muted">只有 admin 可重設 admin 或指定員工的雲端密碼。</p></div><KeyRound size={21} /></div>{!readOnly && <><label className="settings-label"><span>設定 ADMIN 新密碼</span><input className="settings-password-input" type="password" value={adminPasswordDraft} onChange={(event) => setAdminPasswordDraft(event.target.value)} placeholder="至少 6 個字元" /></label><button className="primary-button settings-save-button" onClick={async () => { if (await updatePassword('admin', adminPasswordDraft)) setAdminPasswordDraft('') }} disabled={busyAction !== null}><KeyRound size={15} />儲存管理者密碼</button></>}<div className="card-heading connection-heading"><div><p className="eyebrow">SUPABASE CONNECTION</p><h2>資料服務狀態</h2></div><div className={`connection-dot ${supabaseReady ? 'ready' : ''}`} /></div><div className="connection-row"><span>前端連線</span><strong>{supabaseReady ? '已偵測環境變數' : '尚未設定 Supabase Key'}</strong></div><div className="connection-row"><span>目前資料層</span><strong>Supabase 雲端</strong></div><p className="settings-copy">正式登入、員工、部門、出勤與網路設定都使用 Supabase 雲端；本頁不提供本機預覽資料備份或重設。</p></section></div>
}

function EmptyState({ title, detail }: { title: string; detail: string }) { return <div className="empty-state"><div className="empty-icon"><FileSpreadsheet size={20} /></div><strong>{title}</strong><span>{detail}</span></div> }
function ToastMessage({ toast }: { toast: Toast }) { return <div className={`toast ${toast.tone}`}><span className="toast-icon">{toast.tone === 'success' ? <Check size={15} /> : toast.tone === 'error' ? <X size={15} /> : <CircleAlert size={15} />}</span>{toast.message}</div> }

export default App
