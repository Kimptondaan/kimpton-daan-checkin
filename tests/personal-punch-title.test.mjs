import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as icons from 'lucide-react'

// Render only the real portal shells. Child views and date helpers are stubbed;
// no network requests, Auth changes, attendance writes or production data reads.
const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const names = ['EmployeePortal', 'AdminShell']
const shells = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text))
assert.equal(shells.length, 2)
const compiled = ts.transpileModule(shells.map(node => node.getText(parsed)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
}).outputText
const noop = () => null
const context = {
  React, useState: React.useState, ...icons, require: createRequire(import.meta.url),
  isSameTaipeiDay: () => true, formatTaipeiDate: () => '2026/11/25',
  formatTaipeiTime: () => '09:00', formatTaipeiDateTime: () => '2026/11/25 09:00',
  EmployeeDashboard: noop, PersonalRecords: noop, ChangePasswordPanel: noop,
  AnnouncementPanel: noop, AdminDashboard: noop, AttendanceAdmin: noop,
  EmployeeAdmin: noop, DepartmentAdmin: noop, SettingsAdmin: noop, ToastMessage: noop,
}
vm.createContext(context)
vm.runInContext(compiled, context)
const escaped = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#x27;')
let renders = 0
for (const role of ['employee', 'manager', 'hr', 'it', 'admin']) {
  for (const name of ['Tony.Chou', '王小明', '<script>alert("name")</script>']) {
    const employee = { id: 'signed-in-user', employeeNo: '240428', name, department: 'IT', departmentCode: 'IT', title: '', active: true, accessRole: role }
    const data = { employees: [employee, { ...employee, id: 'other-user', name: 'Other.User', departmentCode: 'OTHER' }], departments: [], records: [], network: { mode: 'strict' }, announcement: {} }
    const props = { employee, data, now: new Date('2026-11-25T01:00:00Z'), lastSyncedAt: null, accessRole: role, scopeDepartmentCode: 'IT', activeView: role === 'employee' ? 'dashboard' : 'clock', setActiveView: noop, setMobileNavOpen: noop, mobileNavOpen: false, logout: noop }
    const Shell = role === 'employee' ? context.EmployeePortal : context.AdminShell
    const markup = renderToStaticMarkup(React.createElement(Shell, props))
    const title = escaped(`${name}的刷卡`)
    assert.ok(markup.includes(`<h1>${title}</h1>`), `${role}: personalized main heading`)
    assert.equal(markup.split(title).length - 1, 3, `${role}: main heading and both navigation entries`)
    assert.ok(!markup.includes('Other.User的刷卡'), `${role}: never use another employee's name`)
    assert.ok(!markup.includes('我的刷卡'), `${role}: no old punch label`)
    assert.ok(!markup.includes('<script>'), `${role}: employee name stays plain text`)
    if (role === 'employee') {
      const records = renderToStaticMarkup(React.createElement(Shell, { ...props, activeView: 'attendance' }))
      assert.ok(records.includes(`<h1>${title}紀錄</h1>`))
    }
    renders++
  }
}
const fallback = renderToStaticMarkup(React.createElement(context.AdminShell, {
  data: { employees: [], departments: [], records: [], network: { mode: 'strict' } },
  accessRole: 'admin', activeView: 'clock', now: new Date(), setActiveView: noop,
}))
assert.ok(fallback.includes('<h1>個人刷卡</h1>'))
assert.ok(!fallback.includes('undefined的刷卡'))
console.log(JSON.stringify({ passed: true, roleNameCombinations: renders, scope: 'SSR portal shells only; no production reads or writes' }))
