import assert from 'node:assert/strict'
import { handleOwnPasswordChange, validateOwnPasswordChange } from '../netlify/lib/self-password.mjs'

const user = { id: 'self-user-id', email: 'self@example.invalid' }
const profile = { id: user.id, is_active: true, role: 'employee' }
const input = { action: 'password.change', currentPassword: 'old-secret', newPassword: 'New!Pass1' }
let assertions = 0
const expectError = async (fn, message, status = 400) => {
  await assert.rejects(fn, error => error.message.includes(message) && error.status === status)
  assertions++
}
for (const password of ['a', '1234567', '', '12345678\n']) {
  assert.throws(() => validateOwnPasswordChange({ ...input, newPassword: password }))
  assertions++
}
assert.equal(validateOwnPasswordChange(input).newPassword, input.newPassword)
assert.equal(validateOwnPasswordChange({ ...input, newPassword: ' leading-end! ' }).newPassword, ' leading-end! ')
assert.equal(validateOwnPasswordChange({ ...input, newPassword: 'A'.repeat(128) }).newPassword.length, 128)
assert.equal(Array.from(validateOwnPasswordChange({ ...input, newPassword: '𠀀'.repeat(8) }).newPassword).length, 8)
assert.throws(() => validateOwnPasswordChange({ ...input, newPassword: 'A'.repeat(129) }))
assert.throws(() => validateOwnPasswordChange({ ...input, newPassword: input.currentPassword }))
assert.throws(() => validateOwnPasswordChange({ ...input, id: 'other-user-id' }))
assert.throws(() => validateOwnPasswordChange({ ...input, email: 'other@example.invalid' }))
assertions += 8

function clientFactory({ signInError = null, verificationId = user.id, updateError = null, updateId = user.id } = {}) {
  const calls = []
  const client = { auth: {
    async signInWithPassword(credentials) { calls.push(['verify', credentials]); return { data: signInError ? {} : { user: { id: verificationId } }, error: signInError } },
    async updateUser(value) { calls.push(['update', value]); return { data: { user: { id: updateId } }, error: updateError } },
    async signOut(value) { calls.push(['signOut', value]); return { error: null } },
  } }
  return { client, calls }
}
for (const role of ['employee', 'manager', 'hr', 'it', 'admin']) {
  const { client, calls } = clientFactory()
  assert.deepEqual(await handleOwnPasswordChange(user, { ...profile, role }, input, () => client), { ok: true })
  assert.deepEqual(calls.map(call => call[0]), ['verify', 'update', 'signOut'])
  assert.equal(calls[0][1].email, user.email)
  assert.deepEqual(calls[1][1], { password: input.newPassword })
  assert.deepEqual(calls[2][1], { scope: 'local' })
  assertions += 5
}
{
  const { client, calls } = clientFactory({ signInError: { code: 'invalid_credentials', status: 400 } })
  await expectError(() => handleOwnPasswordChange(user, profile, input, () => client), '目前密碼不正確')
  assert.equal(calls.some(call => call[0] === 'update'), false); assertions++
}
{
  const { client, calls } = clientFactory({ verificationId: 'someone-else' })
  await expectError(() => handleOwnPasswordChange(user, profile, input, () => client), '驗證失敗', 403)
  assert.equal(calls.some(call => call[0] === 'update'), false); assertions++
}
{
  const { client } = clientFactory({ updateError: { code: 'weak_password', status: 422 } })
  await expectError(() => handleOwnPasswordChange(user, profile, input, () => client), '安全政策')
}
{
  const { client } = clientFactory({ updateError: { status: 500 } })
  await expectError(() => handleOwnPasswordChange(user, profile, input, () => client), '結果未確認', 502)
}
await expectError(() => handleOwnPasswordChange(user, { ...profile, is_active: false }, input), '停用', 403)
await expectError(() => handleOwnPasswordChange(user, { ...profile, id: 'other' }, input), '停用', 403)
console.log(JSON.stringify({ passed: true, assertions, scope: 'only mock Auth users; no production writes; no plaintext credentials in output' }))
