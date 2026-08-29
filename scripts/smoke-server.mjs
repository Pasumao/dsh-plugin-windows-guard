// dsh-plugin-windows-guard 服务端冒烟：假 ctx 走全链路
// （技能注册 → 工具注册 → pre/post hook 决策 → 工具执行 → 修复往返 → 清理）。零依赖。
import assert from 'node:assert'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as mod from '../lib/index.js'

// ---- 构造假 ctx ----
const registered = []
const registrations = {}
const listeners = {}
const logs = []

const ctx = {
  skills: {
    register: (def) => {
      registered.push(def)
      return () => {} // disposer
    }
  },
  tools: { register: (def) => { registrations[def.name] = def; return () => {} } },
  on: (event, fn) => { listeners[event] = fn; return () => {} },
}
const origLog = console.log
console.log = (...args) => { logs.push(args.join(' ')) }

const dispose = mod.apply(ctx)

console.log = origLog

// ---- 断言：拆分后的两个技能 ----
const names = registered.map((s) => s.name).sort()
assert.deepEqual(names, ['windows-enc', 'windows-sys'], '应注册 windows-enc 与 windows-sys')
for (const skill of registered) {
  assert.ok(skill.description.includes('Windows'), `${skill.name} description 含触发词`)
  assert.ok(skill.source === 'runtime', `${skill.name} source= runtime`)
}
const enc = registered.find((s) => s.name === 'windows-enc')
assert.ok(enc.content.includes('[System.IO.File]::WriteAllText'), 'windows-enc 正文含编码守则')
assert.ok(enc.content.includes('三不原则'), 'windows-enc 正文含乱码三不')
const sys = registered.find((s) => s.name === 'windows-sys')
assert.ok(sys.content.includes('Stop-Process'), 'windows-sys 正文含进程守则')
assert.ok(logs.some((l) => l.includes('技能已注册：windows-enc')), '日志有注册记录')

// ---- 断言：合并的主动防护层（0.2.0）----
assert.ok(registrations.windows_encode_detect, '注册 windows_encode_detect')
assert.ok(registrations.windows_encode_fix, '注册 windows_encode_fix')
assert.ok(listeners['tools/pre-execute'] && listeners['tools/post-execute'], '注册 hooks')

// ---- pre-execute 决策 ----
const denyExec = { name: 'pwsh', arguments: { command: 'Set-Content -Path a.json -Value $x' } }
const preDeny = await listeners['tools/pre-execute'](denyExec, async () => ({ kind: 'allow' }))
assert.equal(preDeny.kind, 'deny', '危险写命令被拒')
assert.ok(preDeny.reason.includes('[windows-guard]'), '拒绝理由带 [windows-guard] 标签')
const preAllow = await listeners['tools/pre-execute']({ name: 'pwsh', arguments: { command: 'Get-Content x.md' } }, async () => ({ kind: 'allow' }))
assert.equal(preAllow.kind, 'allow', '读命令放行')

// ---- post-execute 决策（乱码 → 附加提示）----
const postHit = await listeners['tools/post-execute'](
  { name: 'pwsh' },
  { isError: false, content: [{ type: 'text', text: '# DSH 鍚姩鏁呴殰璁板綍锛堜簨鏁呭洓鎺樼栵?' }] },
  async () => ({ kind: 'accept', content: [{ type: 'text', text: 'fallback' }] })
)
assert.equal(postHit.kind, 'accept')
assert.ok(postHit.content.some((c) => typeof c.text === 'string' && c.text.includes('[windows-guard]')), '附加 windows-guard 提示')
assert.ok(postHit.content.some((c) => typeof c.text === 'string' && c.text.includes('windows_encode_detect')), '提示引导到新工具名')

const postClean = await listeners['tools/post-execute'](
  { name: 'pwsh' },
  { isError: false, content: [{ type: 'text', text: 'all good here' }] },
  async () => ({ kind: 'accept', content: [{ type: 'text', text: 'fallback' }] })
)
assert.equal(postClean.kind, 'accept')
assert.ok(!postClean.content.some((c) => typeof c.text === 'string' && c.text.includes('[windows-guard]')), '正常输出不附加')

// ---- 非 pwsh 工具不受影响 ----
const postOther = await listeners['tools/post-execute'](
  { name: 'read' },
  { isError: false, content: [{ type: 'text', text: '鎻掍欢鏋勮瑙勮寖' }] },
  async () => ({ kind: 'accept', content: [{ type: 'text', text: 'fallback' }] })
)
assert.equal(postOther.kind, 'accept')
assert.ok(!postOther.content.some((c) => typeof c.text === 'string' && c.text.includes('[windows-guard]')), '非 pwsh 工具不附加')

// ---- 工具执行 ----
const tmp = join(tmpdir(), 'windowsguard-smoke')
fs.mkdirSync(tmp, { recursive: true })
const f = join(tmp, 'sample.gbk.txt')
fs.writeFileSync(f, Buffer.from([0xb2, 0xe5, 0xbc, 0xfe, 0xb9, 0xe6, 0xb7, 0xb6])) // GBK 插件规范(近似)
const fakeExec = { agent: { session: { header: { cwd: tmp } } } }
const detectResult = await registrations.windows_encode_detect.execute({ path: 'sample.gbk.txt' }, fakeExec)
assert.equal(detectResult.encoding, 'gbk', 'GBK 文件被正确检出')
const dryRun = await registrations.windows_encode_fix.execute({ path: 'sample.gbk.txt', dryRun: true }, fakeExec)
assert.ok(dryRun.notice.includes('dryRun'), 'dryRun 不写文件')
assert.ok(!fs.existsSync(`${f}.windowsguard.bak`), 'dryRun 无备份')
const fixResult = await registrations.windows_encode_fix.execute({ path: 'sample.gbk.txt' }, fakeExec)
assert.equal(fixResult.before, 'gbk')
assert.equal(fixResult.after, 'utf-8')
const reread = fs.readFileSync(f, 'utf8')
assert.ok(reread.includes('插件'), '修复后为 UTF-8 中文')
assert.ok(fs.existsSync(`${f}.windowsguard.bak`), '备份存在（.windowsguard.bak）')

// ---- 清理函数可调用（HMR 幂等）----
dispose()

fs.rmSync(tmp, { recursive: true, force: true })

console.log(`smoke: 全部通过（技能 ${registered.length} + 工具 ${Object.keys(registrations).length} + hooks ${Object.keys(listeners).length}，修复往返 OK）`)
