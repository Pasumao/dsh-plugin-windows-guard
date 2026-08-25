// dsh-plugin-windows-guard 服务端冒烟：假 ctx 走注册全链路（纯数据插件）。
import assert from 'node:assert'
import * as mod from '../lib/index.js'

// 假 ctx：收集注册与日志
const registered = []
const logs = []
const ctx = {
  skills: {
    register: (def) => {
      registered.push(def)
      return () => {} // disposer
    }
  },
}
const origLog = console.log
console.log = (...args) => { logs.push(args.join(' ')) }

mod.apply(ctx)

console.log = origLog

// 断言：拆分后的两个技能
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

console.log(`smoke: 全部通过（注册 ${registered.length} 个技能：${registered.map((s) => s.name).join(', ')}）`)
