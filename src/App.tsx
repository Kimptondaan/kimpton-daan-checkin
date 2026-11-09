import { useEffect, useMemo, useState } from 'react'
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
  UserRound,
  UsersRound,
  Wifi,
  X,
} from 'lucide-react'
import type { AttendanceRecord, Department, Employee, NetworkMode, UserRole } from './lib/types'
import {
  createRecord,
  formatDate,
  formatDateTime,
  isSameDay,
  loadDemoData,
  resetDemoData,
  saveDemoData,
  toTxt,
  type DemoData,
} from './lib/demoStore'
import { supabaseReady } from './lib/supabase'

const DEFAULT_PASSWORD = '00000000'

type View = 'dashboard' | 'attendance' | 'employees' | 'departments' | 'settings'
type Session = { role: UserRole; employee?: Employee }
type NewEmployee = Pick<Employee, 'employeeNo' | 'name' | 'departmentCode' | 'title' | 'accessRole'>
type NewDepartment = Pick<Department, 'code' | 'name' | 'manager'>

type Toast = { tone: 'success' | 'error' | 'info'; message: string }

function App() {
  const [data, setData] = useState<DemoData>(() => loadDemoData())
  const [session, setSession] = useState<Session | null>(null)
  const [loginMode, setLoginMode] = useState<UserRole>('employee')
  const [employeeNo, setEmployeeNo] = useState('DA001')
  const [password, setPassword] = useState(DEFAULT_PASSWORD)
  const [activeView, setActiveView] = useState<View>('dashboard')
  const [toast, setToast] = useState<Toast | null>(null)
  const [now, setNow] = useState(() => new Date())
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [networkDraft, setNetworkDraft] = useState(data.network.allowedIps.join('\n'))
  const [networkModeDraft, setNetworkModeDraft] = useState<NetworkMode>(data.network.mode)

  useEffect(() => {
    saveDemoData(data)
  }, [data])

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

  function handleLogin(event: React.FormEvent) {
    event.preventDefault()
    const normalized = employeeNo.trim().toUpperCase()
    if (loginMode === 'admin') {
      if (normalized !== 'ADMIN') {
        notify('管理者帳號請輸入 ADMIN', 'error')
        return
      }
      if (password !== data.adminPassword) {
        notify('管理者密碼不正確', 'error')
        return
      }
      setSession({ role: 'admin' })
      setActiveView('dashboard')
      notify('管理者登入成功，歡迎回來', 'success')
      return
    }

    const employee = data.employees.find((item) => item.employeeNo === normalized && item.active)
    if (!employee) {
      notify('找不到這個員工編號，請確認後再試', 'error')
      return
    }
    if (password !== (employee.password ?? DEFAULT_PASSWORD)) {
      notify('員工密碼不正確，請洽管理者重設', 'error')
      return
    }
    setSession({ role: employee.accessRole ?? 'employee', employee })
    setActiveView('dashboard')
    notify(`早安，${employee.name}，今天也辛苦了`, 'success')
  }

  function logout() {
    setSession(null)
    setPassword(DEFAULT_PASSWORD)
    setMobileNavOpen(false)
  }

  function handlePunch(type: 'check_in' | 'check_out') {
    if (!session?.employee) return
    const record = createRecord(session.employee.id, type, data.network)
    setData((current) => ({ ...current, records: [record, ...current.records] }))
    notify(type === 'check_in' ? '上班刷卡完成，可再次刷卡補留時間' : '下班刷卡完成，可再次刷卡補留時間')
  }

  function exportAttendance(records: DemoData['records'] = filteredRecords) {
    const txt = toTxt(records, data.employees)
    const blob = new Blob([txt], { type: 'text/plain;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `大安金普頓出勤紀錄-${new Date().toISOString().slice(0, 10)}.txt`
    link.click()
    URL.revokeObjectURL(url)
    notify('已下載目前篩選的 TXT 刷卡資料')
  }

  function saveNetworkSettings() {
    const ips = networkDraft
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean)
    if (networkModeDraft === 'strict' && ips.length === 0) {
      notify('正式 IP 模式至少需要輸入一組固定公網 IP', 'error')
      return
    }
    setData((current) => ({
      ...current,
      network: { mode: networkModeDraft, allowedIps: ips, updatedAt: new Date().toISOString() },
    }))
    notify(networkModeDraft === 'test' ? '已保留測試模式，現在不會限制打卡網路' : '已儲存公司固定公網 IP 設定')
  }

  function resetDemo() {
    const fresh = resetDemoData()
    setData(fresh)
    setNetworkDraft('')
    setNetworkModeDraft('test')
    notify('預覽資料已重設')
  }

  function updateEmployee(id: string, field: keyof Employee, value: string) {
    setData((current) => ({
      ...current,
      employees: current.employees.map((employee) => {
        if (employee.id !== id) return employee
        if (field === 'departmentCode') {
          const department = current.departments.find((item) => item.code === value)
          return { ...employee, departmentCode: value, department: department?.name ?? employee.department }
        }
        return { ...employee, [field]: value }
      }),
    }))
  }

  function addEmployee(input: NewEmployee) {
    const department = data.departments.find((item) => item.code === input.departmentCode)
    const newEmployee: Employee = {
      id: `emp-${Date.now()}`,
      employeeNo: input.employeeNo.trim().toUpperCase(),
      name: input.name.trim(),
      department: department?.name ?? '待設定',
      departmentCode: input.departmentCode,
      title: input.title.trim(),
      password: DEFAULT_PASSWORD,
      accessRole: input.accessRole ?? 'employee',
      active: true,
    }
    if (!newEmployee.employeeNo || !newEmployee.name || !newEmployee.departmentCode) {
      notify('員工編號、姓名與部門都是必填欄位', 'error')
      return
    }
    if (data.employees.some((employee) => employee.employeeNo === newEmployee.employeeNo)) {
      notify('這個員工編號已經存在', 'error')
      return
    }
    setData((current) => ({ ...current, employees: [...current.employees, newEmployee] }))
    notify(`已新增 ${newEmployee.employeeNo}，請直接修改欄位內容`)
  }

  function toggleEmployeeActive(id: string) {
    setData((current) => ({ ...current, employees: current.employees.map((employee) => employee.id === id ? { ...employee, active: !employee.active } : employee) }))
    notify('帳號狀態已更新')
  }

  function addAttendanceRecord(input: { employeeId: string; type: AttendanceRecord['type']; punchedAt: string }) {
    if (!input.employeeId || !input.punchedAt) {
      notify('員工與刷卡時間都是必填欄位', 'error')
      return
    }
    const record: AttendanceRecord = { id: `rec-${Date.now()}`, employeeId: input.employeeId, type: input.type, punchedAt: new Date(input.punchedAt).toISOString(), ip: '管理者補登', networkName: '管理者補登', status: 'manual' }
    setData((current) => ({ ...current, records: [record, ...current.records] }))
    notify('已新增刷卡時間資料')
  }

  function updateAttendanceRecord(id: string, patch: Partial<Pick<AttendanceRecord, 'type' | 'punchedAt'>>) {
    setData((current) => ({ ...current, records: current.records.map((record) => record.id === id ? { ...record, ...patch } : record) }))
    notify('刷卡時間資料已更新')
  }

  function addDepartment(input: NewDepartment) {
    const code = input.code.trim().toUpperCase()
    const name = input.name.trim()
    const manager = input.manager.trim()
    if (!code || !name || !manager) {
      notify('部門代號、部門名稱與部門主管都是必填欄位', 'error')
      return
    }
    if (data.departments.some((department) => department.code === code || department.name === name)) {
      notify('部門代號或名稱已經存在', 'error')
      return
    }
    setData((current) => ({
      ...current,
      departments: [...current.departments, { id: `dept-${Date.now()}`, code, name, manager, active: true }],
    }))
    notify(`已新增 ${code}｜${name}`)
  }

  function updateDepartment(id: string, field: keyof Department, value: string) {
    setData((current) => {
      const existing = current.departments.find((department) => department.id === id)
      if (!existing) return current
      const nextValue = field === 'code' ? value.toUpperCase() : value
      const departments = current.departments.map((department) => department.id === id ? { ...department, [field]: nextValue } : department)
      const employees = field === 'name' || field === 'code'
        ? current.employees.map((employee) => employee.departmentCode === existing.code
          ? { ...employee, departmentCode: field === 'code' ? nextValue : employee.departmentCode, department: field === 'name' ? nextValue : employee.department }
          : employee)
        : current.employees
      return { ...current, departments, employees }
    })
  }

  function updatePassword(accountId: string, nextPassword: string) {
    const value = nextPassword.trim()
    if (value.length < 6) {
      notify('密碼至少需要 6 個字元', 'error')
      return false
    }
    if (accountId === 'admin') {
      setData((current) => ({ ...current, adminPassword: value }))
    } else {
      setData((current) => ({ ...current, employees: current.employees.map((employee) => employee.id === accountId ? { ...employee, password: value } : employee) }))
    }
    notify('密碼已更新，下次登入請使用新密碼')
    return true
  }

  const filteredRecords = useMemo(() => data.records, [data.records])

  if (!session) {
    return <LoginPage {...{ loginMode, setLoginMode, employeeNo, setEmployeeNo, password, setPassword, handleLogin, data }} />
  }

  if (session.role === 'employee' && session.employee) {
    return (
      <EmployeePortal
        employee={session.employee}
        data={data}
        now={now}
        activeView={activeView}
        setActiveView={setActiveView}
        handlePunch={handlePunch}
        exportAttendance={exportAttendance}
        logout={logout}
        toast={toast}
      />
    )
  }

  return (
    <AdminShell
      data={data}
      accessRole={session.role}
      scopeDepartmentCode={session.employee?.departmentCode}
      now={now}
      activeView={activeView}
      setActiveView={setActiveView}
      mobileNavOpen={mobileNavOpen}
      setMobileNavOpen={setMobileNavOpen}
      logout={logout}
      filteredRecords={filteredRecords}
      exportAttendance={exportAttendance}
      networkDraft={networkDraft}
      setNetworkDraft={setNetworkDraft}
      networkModeDraft={networkModeDraft}
      setNetworkModeDraft={setNetworkModeDraft}
      saveNetworkSettings={saveNetworkSettings}
      updateEmployee={updateEmployee}
      toggleEmployeeActive={toggleEmployeeActive}
      addAttendanceRecord={addAttendanceRecord}
      updateAttendanceRecord={updateAttendanceRecord}
      addEmployee={addEmployee}
      addDepartment={addDepartment}
      updateDepartment={updateDepartment}
      updatePassword={updatePassword}
      resetDemo={resetDemo}
      toast={toast}
    />
  )
}

function LoginPage(props: {
  loginMode: UserRole
  setLoginMode: (value: UserRole) => void
  employeeNo: string
  setEmployeeNo: (value: string) => void
  password: string
  setPassword: (value: string) => void
  handleLogin: (event: React.FormEvent) => void
  data: DemoData
}) {
  return (
    <main className="login-page">
      <div className="login-art" aria-hidden="true">
        <div className="art-topline"><span>DAAN DISTRICT</span><span>INTERNAL USE</span></div>
        <div className="art-wordmark"><span className="mark-line" />KIMPTON<span className="mark-line" /></div>
        <div className="art-caption">A softer way to start the day.</div>
        <div className="art-footer"><span>大安金普頓</span><span>TAIPEI · 2026</span></div>
      </div>
      <section className="login-panel">
        <div className="login-brand">
          <div className="brand-mark">K</div>
          <div>
            <p className="eyebrow">DAAN KIMPTON</p>
            <h1>員工刷卡系統</h1>
          </div>
        </div>
        <div className="login-intro">
          <p className="eyebrow">GOOD TO SEE YOU</p>
          <h2>準備開始今天的班次了嗎？</h2>
          <p>使用員工編號登入，簡單完成每一次上下班刷卡。</p>
        </div>
        <div className="mode-switch" role="tablist" aria-label="登入身分">
          <button className={props.loginMode === 'employee' ? 'active' : ''} onClick={() => props.setLoginMode('employee')} type="button"><UserRound size={16} />員工登入</button>
          <button className={props.loginMode === 'admin' ? 'active' : ''} onClick={() => props.setLoginMode('admin')} type="button"><ShieldCheck size={16} />管理者登入</button>
        </div>
        <form className="login-form" onSubmit={props.handleLogin}>
          <label>
            <span>{props.loginMode === 'admin' ? '管理者帳號' : '員工編號'}</span>
            <div className="input-wrap"><UserRound size={18} /><input value={props.employeeNo} onChange={(event) => props.setEmployeeNo(event.target.value)} placeholder={props.loginMode === 'admin' ? '例如 ADMIN' : '例如 DA001'} autoComplete="username" /></div>
          </label>
          <label>
            <span>登入密碼</span>
            <div className="input-wrap"><KeyRound size={18} /><input type="password" value={props.password} onChange={(event) => props.setPassword(event.target.value)} placeholder="預設為 8 個 0" autoComplete="current-password" /></div>
          </label>
          <button className="primary-button login-button" type="submit">進入系統 <ChevronRight size={18} /></button>
        </form>
        <div className="demo-note"><CircleAlert size={16} /><span>目前為預覽測試模式。員工可試用 {props.data.employees.slice(0, 3).map((item) => item.employeeNo).join('、')}；預設密碼：00000000</span></div>
        <p className="login-footnote">正式版本將連接 Supabase，並由伺服器驗證公司固定公網 IP。</p>
      </section>
    </main>
  )
}

function EmployeePortal({ employee, data, now, activeView, setActiveView, handlePunch, exportAttendance, logout, toast }: {
  employee: Employee
  data: DemoData
  now: Date
  activeView: View
  setActiveView: (value: View) => void
  handlePunch: (type: 'check_in' | 'check_out') => void
  exportAttendance: (records?: DemoData['records']) => void
  logout: () => void
  toast: Toast | null
}) {
  const todayRecords = data.records.filter((record) => record.employeeId === employee.id && isSameDay(record.punchedAt))
  const didCheckIn = todayRecords.some((record) => record.type === 'check_in')
  const didCheckOut = todayRecords.some((record) => record.type === 'check_out')
  const latestRecords = data.records.filter((record) => record.employeeId === employee.id).slice(0, 6)

  return (
    <div className="employee-app">
      <header className="mobile-topbar">
        <div className="brand-inline"><div className="brand-mark small">K</div><span>大安金普頓</span></div>
        <button className="icon-button" onClick={logout} aria-label="登出"><LogOut size={18} /></button>
      </header>
      <div className="employee-shell">
        <aside className="employee-rail">
          <div className="rail-brand"><div className="brand-mark">K</div><p>DAAN<br />KIMPTON</p></div>
          <div className="rail-person"><div className="avatar">{employee.name.slice(0, 1)}</div><div><strong>{employee.name}</strong><small>{employee.employeeNo} · {employee.department}</small></div></div>
          <nav className="rail-nav">
            <button className={activeView === 'dashboard' ? 'active' : ''} onClick={() => setActiveView('dashboard')}><Clock3 size={18} />今日刷卡</button>
            <button className={activeView === 'attendance' ? 'active' : ''} onClick={() => setActiveView('attendance')}><CalendarDays size={18} />我的紀錄</button>
          </nav>
          <button className="rail-logout" onClick={logout}><LogOut size={17} />登出</button>
        </aside>
        <main className="employee-main">
          <div className="page-heading"><div><p className="eyebrow">EMPLOYEE PORTAL</p><h1>{activeView === 'dashboard' ? '今天，從容開始。' : '我的刷卡紀錄'}</h1><p className="muted">{formatDate(now.toISOString())} · {now.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</p></div><div className="status-pill"><span className="status-dot" />測試模式</div></div>
          {activeView === 'dashboard' ? <EmployeeDashboard {...{ employee, data, now, didCheckIn, didCheckOut, handlePunch }} /> : <PersonalRecords records={latestRecords} exportAttendance={() => exportAttendance(data.records.filter((record) => record.employeeId === employee.id))} />}
        </main>
      </div>
      {toast && <ToastMessage toast={toast} />}
    </div>
  )
}

function EmployeeDashboard({ employee, data, now, didCheckIn, didCheckOut, handlePunch }: { employee: Employee; data: DemoData; now: Date; didCheckIn: boolean; didCheckOut: boolean; handlePunch: (type: 'check_in' | 'check_out') => void }) {
  const todayRecords = data.records.filter((record) => record.employeeId === employee.id && isSameDay(record.punchedAt))
  const checkIn = todayRecords.find((record) => record.type === 'check_in')
  const checkOut = todayRecords.find((record) => record.type === 'check_out')
  return (
    <>
      <section className="employee-hero">
        <div><span className="hero-kicker">{now.getHours() < 12 ? 'GOOD MORNING' : 'GOOD AFTERNOON'}</span><h2>{employee.name}，今天辛苦了。</h2><p>請在開始與結束班次時完成刷卡，系統會自動留下時間紀錄。</p></div>
        <div className="hero-date"><span>{now.toLocaleDateString('zh-TW', { month: 'long', day: 'numeric' })}</span><strong>{now.toLocaleDateString('zh-TW', { weekday: 'long' })}</strong></div>
      </section>
      <section className="punch-grid">
        <button className={`punch-card check-in ${didCheckIn ? 'done' : ''}`} onClick={() => handlePunch('check_in')}>
          <div className="punch-card-top"><span className="punch-index">01</span><span className="punch-state">{didCheckIn ? '已完成' : '尚未刷卡'}</span></div>
          <div className="punch-icon"><ArrowDownToLine size={25} /></div><h3>上班刷卡</h3><p>{checkIn ? `最近一次 ${formatDateTime(checkIn.punchedAt)}` : '記錄你的到班時間'}</p><span className="punch-action">再次刷卡 <ChevronRight size={17} /></span>
        </button>
        <button className={`punch-card check-out ${didCheckOut ? 'done' : ''}`} onClick={() => handlePunch('check_out')}>
          <div className="punch-card-top"><span className="punch-index">02</span><span className="punch-state">{didCheckOut ? '已完成' : '尚未刷卡'}</span></div>
          <div className="punch-icon"><ArrowLeft size={25} /></div><h3>下班刷卡</h3><p>{checkOut ? `最近一次 ${formatDateTime(checkOut.punchedAt)}` : '結束班次時記得刷卡'}</p><span className="punch-action">再次刷卡 <ChevronRight size={17} /></span>
        </button>
      </section>
      <section className="employee-status-row"><div className="section-label">TODAY AT A GLANCE</div><div className="status-list"><div><span className={didCheckIn ? 'mini-status done' : 'mini-status'}>{didCheckIn ? <Check size={14} /> : '—'}</span><span>上班時間</span><strong>{checkIn ? new Date(checkIn.punchedAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }) : '待刷卡'}</strong></div><div><span className={didCheckOut ? 'mini-status done' : 'mini-status'}>{didCheckOut ? <Check size={14} /> : '—'}</span><span>下班時間</span><strong>{checkOut ? new Date(checkOut.punchedAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }) : '待刷卡'}</strong></div><div><span className="mini-status location"><Wifi size={14} /></span><span>網路狀態</span><strong>測試模式</strong></div></div></section>
    </>
  )
}

function PersonalRecords({ records, exportAttendance }: { records: DemoData['records']; exportAttendance: () => void }) {
  return <section className="content-card personal-records"><div className="card-heading"><div><p className="eyebrow">MY ATTENDANCE</p><h2>最近刷卡</h2></div><div className="heading-actions"><button className="secondary-button" onClick={exportAttendance}><Download size={16} />下載我的 TXT</button><FileSpreadsheet size={22} /></div></div>{records.length === 0 ? <EmptyState title="還沒有刷卡紀錄" detail="完成第一次刷卡後，紀錄會出現在這裡。" /> : <div className="simple-list">{records.map((record) => <div className="simple-row" key={record.id}><div className={`record-badge ${record.type}`}>{record.type === 'check_in' ? <ArrowDownToLine size={16} /> : <ArrowLeft size={16} />}</div><div><strong>{record.type === 'check_in' ? '上班刷卡' : '下班刷卡'}</strong><small>{formatDate(record.punchedAt)} · {record.networkName}</small></div><time>{formatDateTime(record.punchedAt)}</time></div>)}</div>}</section>
}

function AdminShell(props: {
  data: DemoData; accessRole: UserRole; scopeDepartmentCode?: string; now: Date; activeView: View; setActiveView: (value: View) => void; mobileNavOpen: boolean; setMobileNavOpen: (value: boolean) => void; logout: () => void; filteredRecords: DemoData['records']; exportAttendance: (records?: DemoData['records']) => void; networkDraft: string; setNetworkDraft: (value: string) => void; networkModeDraft: NetworkMode; setNetworkModeDraft: (value: NetworkMode) => void; saveNetworkSettings: () => void; updateEmployee: (id: string, field: keyof Employee, value: string) => void; toggleEmployeeActive: (id: string) => void; addAttendanceRecord: (input: { employeeId: string; type: AttendanceRecord['type']; punchedAt: string }) => void; updateAttendanceRecord: (id: string, patch: Partial<Pick<AttendanceRecord, 'type' | 'punchedAt'>>) => void; addEmployee: (input: NewEmployee) => void; addDepartment: (input: NewDepartment) => void; updateDepartment: (id: string, field: keyof Department, value: string) => void; updatePassword: (accountId: string, password: string) => boolean; resetDemo: () => void; toast: Toast | null
}) {
  const { data, accessRole, scopeDepartmentCode, now, activeView, setActiveView, mobileNavOpen, setMobileNavOpen, logout, filteredRecords, exportAttendance, networkDraft, setNetworkDraft, networkModeDraft, setNetworkModeDraft, saveNetworkSettings, updateEmployee, toggleEmployeeActive, addAttendanceRecord, updateAttendanceRecord, addEmployee, addDepartment, updateDepartment, updatePassword, resetDemo, toast } = props
  const [query, setQuery] = useState('')
  const [dateFilter, setDateFilter] = useState<'today' | 'all'>('today')
  const scopedEmployees = data.employees.filter((employee) => accessRole !== 'manager' || employee.departmentCode === scopeDepartmentCode)
  const scopedEmployeeIds = new Set(scopedEmployees.map((employee) => employee.id))
  const todayRecords = data.records.filter((record) => isSameDay(record.punchedAt) && scopedEmployeeIds.has(record.employeeId))
  const scopedRecords = data.records.filter((record) => {
    if (accessRole === 'admin' || accessRole === 'hr') return true
    const employee = data.employees.find((item) => item.id === record.employeeId)
    return accessRole === 'manager' && employee?.departmentCode === scopeDepartmentCode
  })
  const visibleRecords = scopedRecords.filter((record) => {
    const employee = data.employees.find((item) => item.id === record.employeeId)
    const matchesQuery = !query || [employee?.employeeNo, employee?.name, employee?.department].some((value) => value?.toLowerCase().includes(query.toLowerCase()))
    const matchesDate = dateFilter === 'all' || isSameDay(record.punchedAt)
    return matchesQuery && matchesDate
  })
  const activeEmployees = scopedEmployees.filter((employee) => employee.active)
  const checkedEmployeeIds = new Set(todayRecords.map((record) => record.employeeId))
  const navItems = ([
    { id: 'dashboard', label: '總覽', icon: SlidersHorizontal },
    { id: 'attendance', label: '刷卡紀錄', icon: CalendarDays },
    { id: 'employees', label: '員工資料', icon: UsersRound },
    { id: 'departments', label: '部門設定', icon: Building2 },
    { id: 'settings', label: '系統設定', icon: Settings },
  ] as { id: View; label: string; icon: typeof Clock3 }[]).filter((item) => accessRole === 'admin' || accessRole === 'hr' || item.id === 'dashboard' || item.id === 'attendance')
  const viewTitle = navItems.find((item) => item.id === activeView)?.label ?? '總覽'

  return <div className="admin-app">
    <header className="admin-mobile-topbar"><button className="icon-button" onClick={() => setMobileNavOpen(!mobileNavOpen)} aria-label="開啟選單"><Menu size={20} /></button><div className="brand-inline"><div className="brand-mark small">K</div><span>管理者後台</span></div><button className="icon-button" onClick={logout} aria-label="登出"><LogOut size={18} /></button></header>
    <aside className={`admin-sidebar ${mobileNavOpen ? 'open' : ''}`}><div className="sidebar-brand"><div className="brand-mark">K</div><div><p>DAAN KIMPTON</p><strong>員工刷卡系統</strong></div></div><div className="sidebar-meta"><span className="eyebrow">ADMIN CONSOLE</span><span className="status-pill small-pill"><span className="status-dot" />{data.network.mode === 'test' ? '測試模式' : '正式模式'}</span></div><nav className="sidebar-nav">{navItems.map(({ id, label, icon: Icon }) => <button key={id} className={activeView === id ? 'active' : ''} onClick={() => { setActiveView(id); setMobileNavOpen(false) }}><Icon size={18} /><span>{label}</span>{activeView === id && <ChevronRight size={15} className="nav-arrow" />}</button>)}</nav><div className="sidebar-bottom"><div className="admin-profile"><div className="avatar admin-avatar">A</div><div><strong>管理者</strong><small>系統管理員</small></div></div><button className="sidebar-logout" onClick={logout}><LogOut size={17} />登出</button></div></aside>
    <main className="admin-main"><div className="admin-heading"><div><p className="eyebrow">{activeView === 'dashboard' ? 'AT A GLANCE' : 'ADMIN CONSOLE'}</p><h1>{viewTitle}</h1><p className="muted">{formatDate(now.toISOString())} · 最後更新 {now.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}</p></div><div className="heading-actions"><div className="network-summary"><span className="status-dot" />{data.network.mode === 'test' ? '測試模式' : 'IP 限制已啟用'}</div></div></div>
      {activeView === 'dashboard' && <AdminDashboard data={data} todayRecords={todayRecords} activeEmployees={activeEmployees} checkedEmployeeIds={checkedEmployeeIds} onNavigate={setActiveView} accessRole={accessRole} />}
      {activeView === 'attendance' && <AttendanceAdmin data={data} records={visibleRecords} query={query} setQuery={setQuery} dateFilter={dateFilter} setDateFilter={setDateFilter} addAttendanceRecord={addAttendanceRecord} updateAttendanceRecord={updateAttendanceRecord} canEditAttendance={accessRole === 'admin'} accessRole={accessRole} scopeDepartmentCode={scopeDepartmentCode} exportAttendance={exportAttendance} />}
      {activeView === 'employees' && <EmployeeAdmin data={data} updateEmployee={updateEmployee} toggleEmployeeActive={toggleEmployeeActive} addEmployee={addEmployee} updatePassword={updatePassword} />}
      {activeView === 'departments' && <DepartmentAdmin data={data} addDepartment={addDepartment} updateDepartment={updateDepartment} />}
      {activeView === 'settings' && accessRole === 'admin' && <SettingsAdmin data={data} networkDraft={networkDraft} setNetworkDraft={setNetworkDraft} networkModeDraft={networkModeDraft} setNetworkModeDraft={setNetworkModeDraft} saveNetworkSettings={saveNetworkSettings} updatePassword={updatePassword} resetDemo={resetDemo} />}
    </main>{toast && <ToastMessage toast={toast} />}</div>
}

function AdminDashboard({ data, todayRecords, activeEmployees, checkedEmployeeIds, onNavigate, accessRole }: { data: DemoData; todayRecords: DemoData['records']; activeEmployees: Employee[]; checkedEmployeeIds: Set<string>; onNavigate: (view: View) => void; accessRole: UserRole }) {
  const checkIns = todayRecords.filter((record) => record.type === 'check_in').length
  const checkOuts = todayRecords.filter((record) => record.type === 'check_out').length
  return <>
    <section className="admin-welcome"><div><span className="hero-kicker">TODAY · {new Date().toLocaleDateString('zh-TW', { month: '2-digit', day: '2-digit' })}</span><h2>早安，管理者。</h2><p>這裡是團隊今天的出勤狀態。保持簡單，讓每個人準時開始。</p></div><div className="welcome-symbol"><Globe2 size={34} /></div></section>
    <section className="metric-grid"><MetricCard label="在職員工" value={activeEmployees.length} detail="目前啟用帳號" icon={<UsersRound size={19} />} /><MetricCard label="今日已刷卡" value={checkedEmployeeIds.size} detail={`上班 ${checkIns} · 下班 ${checkOuts}`} icon={<Clock3 size={19} />} /><MetricCard label="待處理異常" value={data.records.filter((record) => record.status === 'rejected').length} detail="需要管理者確認" icon={<CircleAlert size={19} />} warning /><MetricCard label="網路模式" value={data.network.mode === 'test' ? '測試' : '正式'} detail={data.network.allowedIps.length ? `${data.network.allowedIps.length} 組允許 IP` : '尚未設定 IP'} icon={<Network size={19} />} /></section>
    <div className="admin-columns"><section className="content-card dashboard-list-card"><div className="card-heading"><div><p className="eyebrow">TODAY'S TEAM</p><h2>團隊出勤</h2></div><button className="text-button" onClick={() => onNavigate('attendance')}>查看全部 <ChevronRight size={15} /></button></div><div className="team-list">{activeEmployees.slice(0, 5).map((employee) => { const employeeRecords = todayRecords.filter((record) => record.employeeId === employee.id); const checkedIn = employeeRecords.some((record) => record.type === 'check_in'); const checkedOut = employeeRecords.some((record) => record.type === 'check_out'); return <div className="team-row" key={employee.id}><div className="avatar">{employee.name.slice(0, 1)}</div><div className="team-person"><strong>{employee.name}</strong><small>{employee.department} · {employee.title}</small></div><div className="team-status"><span className={checkedIn ? 'tag success' : 'tag'}>{checkedIn ? '已上班' : '未刷卡'}</span><span className={checkedOut ? 'tag success pale' : 'tag muted-tag'}>{checkedOut ? '已下班' : '—'}</span></div></div>})}</div></section><section className="content-card quick-card"><div className="card-heading"><div><p className="eyebrow">QUICK ACTIONS</p><h2>常用操作</h2></div><SlidersHorizontal size={21} /></div>{(accessRole === 'admin' || accessRole === 'hr') && <button onClick={() => onNavigate('employees')}><span className="quick-icon"><UsersRound size={18} /></span><span><strong>管理員工資料</strong><small>新增、編輯或停用帳號</small></span><ChevronRight size={16} /></button>}{accessRole === 'admin' && <button onClick={() => onNavigate('settings')}><span className="quick-icon"><Wifi size={18} /></span><span><strong>設定公司 IP</strong><small>{data.network.mode === 'test' ? '目前仍在測試模式' : '目前已啟用正式模式'}</small></span><ChevronRight size={16} /></button>}</section></div>
  </>
}

function MetricCard({ label, value, detail, icon, warning = false }: { label: string; value: string | number; detail: string; icon: React.ReactNode; warning?: boolean }) { return <div className={`metric-card ${warning ? 'warning' : ''}`}><div className="metric-top"><span>{label}</span><span className="metric-icon">{icon}</span></div><strong>{value}</strong><small>{detail}</small></div> }

function AttendanceAdmin({ data, records, query, setQuery, dateFilter, setDateFilter, addAttendanceRecord, updateAttendanceRecord, canEditAttendance, accessRole, scopeDepartmentCode, exportAttendance }: { data: DemoData; records: DemoData['records']; query: string; setQuery: (value: string) => void; dateFilter: 'today' | 'all'; setDateFilter: (value: 'today' | 'all') => void; addAttendanceRecord: (input: { employeeId: string; type: AttendanceRecord['type']; punchedAt: string }) => void; updateAttendanceRecord: (id: string, patch: Partial<Pick<AttendanceRecord, 'type' | 'punchedAt'>>) => void; canEditAttendance: boolean; accessRole: UserRole; scopeDepartmentCode?: string; exportAttendance: (records?: DemoData['records']) => void }) {
  const [adding, setAdding] = useState(false)
  const [employeeId, setEmployeeId] = useState(data.employees.find((employee) => employee.active)?.id ?? '')
  const [type, setType] = useState<AttendanceRecord['type']>('check_in')
  const [punchedAt, setPunchedAt] = useState(() => new Date().toISOString().slice(0, 16))
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editType, setEditType] = useState<AttendanceRecord['type']>('check_in')
  const [editTime, setEditTime] = useState('')
  const [downloadScope, setDownloadScope] = useState<'all' | 'department' | 'employee'>(accessRole === 'manager' ? 'department' : 'all')
  const [downloadDepartment, setDownloadDepartment] = useState(scopeDepartmentCode ?? data.departments[0]?.code ?? '')
  const [downloadEmployee, setDownloadEmployee] = useState('')
  const allowedEmployees = data.employees.filter((employee) => accessRole !== 'manager' || employee.departmentCode === scopeDepartmentCode)
  const downloadableRecords = records.filter((record) => {
    const employee = data.employees.find((item) => item.id === record.employeeId)
    if (downloadScope === 'employee') return record.employeeId === downloadEmployee
    if (downloadScope === 'department') return employee?.departmentCode === (accessRole === 'manager' ? scopeDepartmentCode : downloadDepartment)
    return true
  })
  const localTime = (value: string) => { const date = new Date(value); const offset = date.getTimezoneOffset() * 60000; return new Date(date.getTime() - offset).toISOString().slice(0, 16) }
  function submit(event: React.FormEvent) { event.preventDefault(); addAttendanceRecord({ employeeId, type, punchedAt }); setAdding(false) }
  function beginEdit(record: AttendanceRecord) { setEditingId(record.id); setEditType(record.type); setEditTime(localTime(record.punchedAt)) }
  function saveEdit(record: AttendanceRecord) { updateAttendanceRecord(record.id, { type: editType, punchedAt: new Date(editTime).toISOString() }); setEditingId(null) }
  return <section className="content-card table-card">
    <div className="filter-bar"><div className="search-field"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜尋姓名、員工編號或部門" /></div><div className="filter-tabs"><button className={dateFilter === 'today' ? 'active' : ''} onClick={() => setDateFilter('today')}>今天</button><button className={dateFilter === 'all' ? 'active' : ''} onClick={() => setDateFilter('all')}>全部紀錄</button></div><select className="table-input table-select" value={downloadScope} onChange={(event) => setDownloadScope(event.target.value as typeof downloadScope)}><option value="all">下載：全部</option><option value="department">下載：部門</option><option value="employee">下載：個人</option></select>{downloadScope === 'department' && accessRole !== 'manager' && <select className="table-input table-select" value={downloadDepartment} onChange={(event) => setDownloadDepartment(event.target.value)}>{data.departments.filter((department) => department.active).map((department) => <option key={department.id} value={department.code}>{department.code}｜{department.name}</option>)}</select>}{downloadScope === 'employee' && <select className="table-input table-select" value={downloadEmployee} onChange={(event) => setDownloadEmployee(event.target.value)}><option value="">選擇人員</option>{allowedEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.employeeNo}｜{employee.name}</option>)}</select>}<button className="secondary-button" onClick={() => exportAttendance(downloadableRecords)}><Download size={16} />下載 TXT</button>{canEditAttendance && <button className="primary-button" onClick={() => setAdding((value) => !value)}>{adding ? <X size={16} /> : <Plus size={16} />}{adding ? '取消補登' : '新增刷卡時間'}</button>}</div>
    {canEditAttendance && adding && <form className="employee-add-form" onSubmit={submit}><label><span>員工</span><select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>{data.employees.filter((employee) => employee.active).map((employee) => <option key={employee.id} value={employee.id}>{employee.employeeNo}｜{employee.name}</option>)}</select></label><label><span>類型</span><select value={type} onChange={(event) => setType(event.target.value as AttendanceRecord['type'])}><option value="check_in">F2｜上班</option><option value="check_out">F3｜下班</option></select></label><label><span>刷卡時間</span><input type="datetime-local" value={punchedAt} onChange={(event) => setPunchedAt(event.target.value)} /></label><button className="primary-button form-submit" type="submit"><Check size={16} />儲存補登</button></form>}
    <div className="table-wrap"><table><thead><tr><th>員工</th><th>部門／職稱</th><th>刷卡類型</th><th>刷卡時間</th><th>來源網路</th><th>狀態</th>{canEditAttendance && <th>操作</th>}</tr></thead><tbody>{records.length === 0 ? <tr><td colSpan={canEditAttendance ? 7 : 6}><EmptyState title="找不到符合條件的紀錄" detail="換個關鍵字或日期範圍再試試。" /></td></tr> : records.map((record) => { const employee = data.employees.find((item) => item.id === record.employeeId); const editing = editingId === record.id; return <tr key={record.id}><td><div className="table-person"><div className="avatar tiny">{employee?.name.slice(0, 1)}</div><div><strong>{employee?.name}</strong><small>{employee?.employeeNo}</small></div></div></td><td><div className="cell-stack"><span>{employee?.department}</span><small>{employee?.title}</small></div></td><td>{canEditAttendance && editing ? <select className="table-input table-select" value={editType} onChange={(event) => setEditType(event.target.value as AttendanceRecord['type'])}><option value="check_in">F2｜上班</option><option value="check_out">F3｜下班</option></select> : <span className={`record-type ${record.type}`}>{record.type === 'check_in' ? 'F2｜上班' : 'F3｜下班'}</span>}</td><td>{canEditAttendance && editing ? <input className="table-input" type="datetime-local" value={editTime} onChange={(event) => setEditTime(event.target.value)} /> : formatDateTime(record.punchedAt)}</td><td><div className="network-cell"><Wifi size={14} />{record.networkName}<small>{record.ip}</small></div></td><td><span className="tag success">{record.status === 'accepted' ? '正常' : '人工補登'}</span></td>{canEditAttendance && <td>{editing ? <><button className="table-action-button" onClick={() => saveEdit(record)}><Check size={14} />儲存</button><button className="table-action-button" onClick={() => setEditingId(null)}><X size={14} />取消</button></> : <button className="table-action-button" onClick={() => beginEdit(record)}><Pencil size={14} />編輯</button>}</td>}</tr>})}</tbody></table></div><div className="table-footer"><span>共 {records.length} 筆刷卡紀錄</span><span>下載範圍依目前查詢結果與所選部門／個人套用</span></div>
  </section>
}

function EmployeeAdmin({ data, updateEmployee, toggleEmployeeActive, addEmployee, updatePassword }: { data: DemoData; updateEmployee: (id: string, field: keyof Employee, value: string) => void; toggleEmployeeActive: (id: string) => void; addEmployee: (input: NewEmployee) => void; updatePassword: (accountId: string, password: string) => boolean }) {
  const [isAdding, setIsAdding] = useState(false)
  const [passwordEmployeeId, setPasswordEmployeeId] = useState<string | null>(null)
  const [passwordDraft, setPasswordDraft] = useState('')
  const [draft, setDraft] = useState<NewEmployee>({ employeeNo: '', name: '', departmentCode: data.departments[0]?.code ?? '', title: '', accessRole: 'employee' })
  const updateDraft = (field: keyof NewEmployee, value: string) => setDraft((current) => ({ ...current, [field]: value }))
  function submitEmployee(event: React.FormEvent) { event.preventDefault(); addEmployee(draft); if (draft.employeeNo && draft.name && draft.departmentCode) { setDraft({ employeeNo: '', name: '', departmentCode: data.departments[0]?.code ?? '', title: '', accessRole: 'employee' }); setIsAdding(false) } }
  return <section className="content-card employee-admin-card"><div className="card-heading"><div><p className="eyebrow">TEAM DIRECTORY</p><h2>員工資料與帳號</h2><p className="muted">Admin 可新增、異動人員資料、重設密碼及啟用／停用帳號。</p></div><button className="primary-button" onClick={() => setIsAdding((value) => !value)}>{isAdding ? <X size={16} /> : <Plus size={16} />}{isAdding ? '取消新增' : '新增員工'}</button></div>{isAdding && <form className="employee-add-form" onSubmit={submitEmployee}><label><span>員工編號 *</span><input value={draft.employeeNo} onChange={(event) => updateDraft('employeeNo', event.target.value)} placeholder="例如 DA006" /></label><label><span>姓名 *</span><input value={draft.name} onChange={(event) => updateDraft('name', event.target.value)} placeholder="請輸入姓名" /></label><label><span>部門 *</span><select value={draft.departmentCode} onChange={(event) => updateDraft('departmentCode', event.target.value)}>{data.departments.filter((department) => department.active).map((department) => <option key={department.id} value={department.code}>{department.code}｜{department.name}</option>)}</select></label><label><span>職稱</span><input value={draft.title} onChange={(event) => updateDraft('title', event.target.value)} placeholder="例如 前台接待" /></label><label><span>系統權限 *</span><select value={draft.accessRole} onChange={(event) => updateDraft('accessRole', event.target.value as UserRole)}><option value="employee">一般員工</option><option value="manager">部門主管</option><option value="hr">人資主管</option><option value="admin">Admin</option></select></label><button className="primary-button form-submit" type="submit"><Check size={16} />儲存員工</button></form>}<div className="employee-table-wrap"><table><thead><tr><th>員工編號</th><th>姓名</th><th>部門</th><th>職稱</th><th>權限</th><th>狀態</th><th>帳號操作</th></tr></thead><tbody>{data.employees.map((employee) => <tr key={employee.id}><td><span className="code-label">{employee.employeeNo}</span></td><td><input className="table-input name-input" value={employee.name} onChange={(event) => updateEmployee(employee.id, 'name', event.target.value)} /></td><td><select className="table-input table-select" value={employee.departmentCode ?? ''} onChange={(event) => updateEmployee(employee.id, 'departmentCode', event.target.value)}>{data.departments.filter((department) => department.active).map((department) => <option key={department.id} value={department.code}>{department.code}｜{department.name}</option>)}</select></td><td><input className="table-input" value={employee.title} onChange={(event) => updateEmployee(employee.id, 'title', event.target.value)} /></td><td><select className="table-input table-select" value={employee.accessRole ?? 'employee'} onChange={(event) => updateEmployee(employee.id, 'accessRole', event.target.value)}><option value="employee">一般員工</option><option value="manager">部門主管</option><option value="hr">人資主管</option><option value="admin">Admin</option></select></td><td><button className={`table-action-button ${employee.active ? '' : 'danger-button'}`} onClick={() => toggleEmployeeActive(employee.id)}>{employee.active ? '啟用中' : '已停用'}</button></td><td><button className="table-action-button" onClick={() => { setPasswordEmployeeId(passwordEmployeeId === employee.id ? null : employee.id); setPasswordDraft('') }}><KeyRound size={14} />重設密碼</button>{passwordEmployeeId === employee.id && <div className="inline-password"><input type="password" value={passwordDraft} onChange={(event) => setPasswordDraft(event.target.value)} placeholder="至少 6 碼" /><button className="small-save" onClick={() => { if (updatePassword(employee.id, passwordDraft)) { setPasswordEmployeeId(null); setPasswordDraft('') } }}>儲存</button></div>}</td></tr>)}</tbody></table></div></section>
}

function DepartmentAdmin({ data, addDepartment, updateDepartment }: { data: DemoData; addDepartment: (input: NewDepartment) => void; updateDepartment: (id: string, field: keyof Department, value: string) => void }) {
  const [isAdding, setIsAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingDraft, setEditingDraft] = useState<NewDepartment | null>(null)
  const [draft, setDraft] = useState<NewDepartment>({ code: '', name: '', manager: '' })
  const updateDraft = (field: keyof NewDepartment, value: string) => setDraft((current) => ({ ...current, [field]: value }))
  function submitDepartment(event: React.FormEvent) {
    event.preventDefault()
    addDepartment(draft)
    if (draft.code && draft.name && draft.manager) {
      setDraft({ code: '', name: '', manager: '' })
      setIsAdding(false)
    }
  }
  return <section className="content-card employee-admin-card"><div className="card-heading"><div><p className="eyebrow">DEPARTMENT DIRECTORY</p><h2>部門設定</h2><p className="muted">點擊「編輯」後修改，完成後按「儲存」；取消則保留原資料。</p></div><button className="primary-button" onClick={() => setIsAdding((value) => !value)}>{isAdding ? <X size={16} /> : <Plus size={16} />}{isAdding ? '取消新增' : '新增部門'}</button></div>{isAdding && <form className="employee-add-form department-add-form" onSubmit={submitDepartment}><label><span>部門代號 *</span><input value={draft.code} onChange={(event) => updateDraft('code', event.target.value)} placeholder="例如 FO" /></label><label><span>部門名稱 *</span><input value={draft.name} onChange={(event) => updateDraft('name', event.target.value)} placeholder="例如 客務部" /></label><label><span>部門主管 *</span><input value={draft.manager} onChange={(event) => updateDraft('manager', event.target.value)} placeholder="例如 王經理" /></label><button className="primary-button form-submit" type="submit"><Check size={16} />儲存部門</button></form>}<div className="employee-table-wrap"><table><thead><tr><th>部門代號</th><th>部門名稱</th><th>部門主管</th><th>狀態</th><th>操作</th></tr></thead><tbody>{data.departments.map((department) => { const editing = editingId === department.id; return <tr key={department.id}>{editing && editingDraft ? <><td><input className="table-input code-input" value={editingDraft.code} onChange={(event) => setEditingDraft({ ...editingDraft, code: event.target.value.toUpperCase() })} /></td><td><input className="table-input name-input" value={editingDraft.name} onChange={(event) => setEditingDraft({ ...editingDraft, name: event.target.value })} /></td><td><input className="table-input" value={editingDraft.manager} onChange={(event) => setEditingDraft({ ...editingDraft, manager: event.target.value })} /></td><td><span className="tag success">編輯中</span></td><td><div className="row-actions"><button className="table-action-button save" onClick={() => { if (editingDraft.code && editingDraft.name && editingDraft.manager) { updateDepartment(department.id, 'code', editingDraft.code); updateDepartment(department.id, 'name', editingDraft.name); updateDepartment(department.id, 'manager', editingDraft.manager); setEditingId(null); setEditingDraft(null) } }}><Check size={14} />儲存</button><button className="table-action-button" onClick={() => { setEditingId(null); setEditingDraft(null) }}>取消</button></div></td></> : <><td><span className="code-label">{department.code}</span></td><td><strong>{department.name}</strong></td><td>{department.manager}</td><td><span className="tag success">啟用中</span></td><td><button className="table-action-button" onClick={() => { setEditingId(department.id); setEditingDraft({ code: department.code, name: department.name, manager: department.manager }) }}><Pencil size={14} />編輯</button></td></>}</tr> })}</tbody></table></div></section>
}

function SettingsAdmin({ data, networkDraft, setNetworkDraft, networkModeDraft, setNetworkModeDraft, saveNetworkSettings, updatePassword, resetDemo }: { data: DemoData; networkDraft: string; setNetworkDraft: (value: string) => void; networkModeDraft: NetworkMode; setNetworkModeDraft: (value: NetworkMode) => void; saveNetworkSettings: () => void; updatePassword: (accountId: string, password: string) => boolean; resetDemo: () => void }) {
  const [adminPassword, setAdminPassword] = useState('')
  return <div className="settings-grid"><section className="content-card settings-card"><div className="card-heading"><div><p className="eyebrow">NETWORK ACCESS</p><h2>公司網路限制</h2><p className="muted">正式串接後，打卡請求會由伺服器檢查來源公網 IP，不信任瀏覽器自行傳入的 IP。</p></div><div className={`large-status ${networkModeDraft === 'test' ? 'test' : 'strict'}`}>{networkModeDraft === 'test' ? <CircleAlert size={20} /> : <ShieldCheck size={20} />}<span>{networkModeDraft === 'test' ? '測試模式' : '正式模式'}</span></div></div><div className="mode-choice"><button className={networkModeDraft === 'test' ? 'selected' : ''} onClick={() => setNetworkModeDraft('test')}><div className="choice-radio" /><div><strong>測試模式</strong><small>暫不限制 IP，方便目前畫面與流程調校。</small></div></button><button className={networkModeDraft === 'strict' ? 'selected' : ''} onClick={() => setNetworkModeDraft('strict')}><div className="choice-radio" /><div><strong>正式 IP 模式</strong><small>只允許下方列出的公司固定公網 IP 打卡。</small></div></button></div><label className="settings-label"><span>允許的固定公網 IP</span><textarea rows={4} value={networkDraft} onChange={(event) => setNetworkDraft(event.target.value)} placeholder="例如：203.0.113.25\n每行一組 IP，也可用逗號分隔" /></label><div className="settings-hint"><Globe2 size={17} /><div><strong>目前儲存狀態</strong><span>{data.network.allowedIps.length ? `已設定 ${data.network.allowedIps.length} 組 IP · 最近更新 ${formatDateTime(data.network.updatedAt)}` : '尚未設定正式 IP。系統目前不會擋下預覽刷卡。'}</span></div></div><div className="form-actions"><button className="primary-button" onClick={saveNetworkSettings}><Check size={16} />儲存網路設定</button></div></section><section className="content-card settings-card secondary-settings"><div className="card-heading"><div><p className="eyebrow">ACCOUNT SECURITY</p><h2>管理者密碼</h2><p className="muted">目前預覽帳號為 ADMIN。修改後請使用新密碼登入。</p></div><KeyRound size={21} /></div><label className="settings-label"><span>設定 ADMIN 新密碼</span><input className="settings-password-input" type="password" value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} placeholder="至少 6 個字元" /></label><button className="primary-button settings-save-button" onClick={() => { if (updatePassword('admin', adminPassword)) setAdminPassword('') }}><KeyRound size={15} />儲存管理者密碼</button><div className="card-heading connection-heading"><div><p className="eyebrow">SUPABASE CONNECTION</p><h2>資料服務狀態</h2></div><div className={`connection-dot ${supabaseReady ? 'ready' : ''}`} /></div><div className="connection-row"><span>前端連線</span><strong>{supabaseReady ? '已偵測環境變數' : '尚未設定 Supabase Key'}</strong></div><div className="connection-row"><span>目前資料層</span><strong>{supabaseReady ? 'Supabase client' : '瀏覽器預覽資料'}</strong></div><p className="settings-copy">此預覽版本先用瀏覽器儲存資料。正式上線前，密碼必須交由 Supabase Auth 與管理者 Edge Function 安全處理。</p><button className="danger-button" onClick={resetDemo}><X size={15} />重設預覽資料</button></section></div>
}

function EmptyState({ title, detail }: { title: string; detail: string }) { return <div className="empty-state"><div className="empty-icon"><FileSpreadsheet size={20} /></div><strong>{title}</strong><span>{detail}</span></div> }

function ToastMessage({ toast }: { toast: Toast }) { return <div className={`toast ${toast.tone}`}><span className="toast-icon">{toast.tone === 'success' ? <Check size={15} /> : toast.tone === 'error' ? <X size={15} /> : <CircleAlert size={15} />}</span>{toast.message}</div> }

export default App
