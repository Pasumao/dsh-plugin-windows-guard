// dsh-plugin-windows-guard 纯函数自检（离线、零依赖）：node scripts/selfcheck.mjs
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const pkg = require('../package.json')
const PKG_DIR = path.dirname(fileURLToPath(import.meta.url))
const SKILLS_DIR = path.join(PKG_DIR, '..', 'skills')

let passed = 0
function t(name, fn) {
  try {
    fn()
    passed++
    console.log(`PASS ${name}`)
  } catch (e) {
    console.error(`FAIL ${name}: ${e.message}`)
    process.exitCode = 1
  }
}

// ---- package 完整性 ----
t('package.json name/main/patch 一致', () => {
  assert.equal(pkg.name, 'dsh-plugin-windows-guard')
  assert.equal(pkg.main, 'lib/index.js')
  assert.ok(pkg.dsh?.bundle?.patch, '应有 bundle patch')
})

// ---- 技能文件：拆分后的两个技能 ----
t('存在 windows-enc.md 与 windows-sys.md，且旧合并文件已移除', () => {
  assert.ok(fs.existsSync(path.join(SKILLS_DIR, 'windows-enc.md')), '缺 windows-enc.md')
  assert.ok(fs.existsSync(path.join(SKILLS_DIR, 'windows-sys.md')), '缺 windows-sys.md')
  assert.ok(!fs.existsSync(path.join(SKILLS_DIR, 'windows-guard.md')), '旧合并文件应已移除')
})

t('frontmatter 完整（name/description/whenToUse）+ 正文足够长', () => {
  for (const file of ['windows-enc.md', 'windows-sys.md']) {
    const md = fs.readFileSync(path.join(SKILLS_DIR, file), 'utf8')
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)
    assert.ok(fm, `${file} 应有 frontmatter`)
    const meta = fm[1]
    for (const key of ['name:', 'description:', 'whenToUse:']) {
      assert.ok(meta.includes(key), `${file} frontmatter 缺 ${key}`)
    }
    assert.ok(md.length > 2000, `${file} 正文过短: ${md.length} 字符`)
  }
})

// ---- 正文关键内容抽查（防坑要点真实存在）----
t('windows-enc 覆盖编码/转义/乱码', () => {
  const md = fs.readFileSync(path.join(SKILLS_DIR, 'windows-enc.md'), 'utf8')
  for (const needle of ['Get-Content -Encoding UTF8', 'WriteAllText', '三不原则']) {
    assert.ok(md.includes(needle), `windows-enc 缺少: ${needle}`)
  }
})
t('windows-sys 覆盖路径/进程/跨平台', () => {
  const md = fs.readFileSync(path.join(SKILLS_DIR, 'windows-sys.md'), 'utf8')
  for (const needle of ['MAX_PATH', 'Stop-Process', 'netstat', 'autocrlf']) {
    assert.ok(md.includes(needle), `windows-sys 缺少: ${needle}`)
  }
})

// ---- lib 可加载且导出一致 ----
t('lib/index.js 导出 name/inject/apply', async () => {
  const mod = await import(pathToFileURL(path.join(PKG_DIR, '..', 'lib', 'index.js')).href)
  assert.equal(mod.name, 'dsh-plugin-windows-guard')
  assert.ok(Array.isArray(mod.inject) && mod.inject.includes('skills'))
  assert.equal(typeof mod.apply, 'function')
})

// ---- frontmatter 解析一致性（用 index.js 相同的解析逻辑）----
t('frontmatter name 正确且 description 足够触发词化', () => {
  for (const [file, expectName] of [['windows-enc.md', 'windows-enc'], ['windows-sys.md', 'windows-sys']]) {
    const md = fs.readFileSync(path.join(SKILLS_DIR, file), 'utf8')
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md)
    const meta = {}
    for (const line of m[1].split(/\r?\n/)) {
      const i = line.indexOf(':')
      if (i <= 0) continue
      const key = line.slice(0, i).trim()
      if (key) meta[key] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
    }
    assert.equal(meta.name, expectName, `${file} name 应为 ${expectName}`)
    assert.ok(meta.description.length > 40, `${file} description 不足`)
  }
})

// ---- loadSkills 一致性：插件能发现且仅发现这两个技能 ----
t('lib 只能发现拆分的两个技能', async () => {
  const mod = await import(pathToFileURL(path.join(PKG_DIR, '..', 'lib', 'index.js')).href)
  const registered = []
  mod.apply({ skills: { register: (def) => { registered.push(def.name); return () => {} } } })
  assert.deepEqual(registered.sort(), ['windows-enc', 'windows-sys'])
})

if (!process.exitCode) console.log(`\n${passed} 项全部通过`)
else console.log(`\n${passed} 项通过，存在失败项`)
