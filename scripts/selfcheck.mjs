// dsh-plugin-windows-guard 纯函数自检（离线、零依赖）：node scripts/selfcheck.mjs
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { detectGbkMisread, detectAsciiLoss, detect, blocksToText } from '../lib/mojibake.js'
import { detectEncoding, fixToUtf8NoBom } from '../lib/encode.js'
import { checkDangerousWrite } from '../lib/index.js'

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
t('package.json name/main/patch 一致 + 版本号合法', () => {
  assert.equal(pkg.name, 'dsh-plugin-windows-guard')
  assert.equal(pkg.main, 'lib/index.js')
  assert.ok(pkg.dsh?.bundle?.patch, '应有 bundle patch')
  assert.ok(typeof pkg.version === 'string' && /^\d+\.\d+\.\d+$/.test(pkg.version), `版本号应为非空 semver：${pkg.version}`)
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
t('windows-enc 提及配套工具 windows_encode_detect/fix', () => {
  const md = fs.readFileSync(path.join(SKILLS_DIR, 'windows-enc.md'), 'utf8')
  for (const needle of ['windows_encode_detect', 'windows_encode_fix', 'windowsguard.bak']) {
    assert.ok(md.includes(needle), `windows-enc 缺少工具指引: ${needle}`)
  }
})
t('windows-sys 覆盖路径/进程/跨平台', () => {
  const md = fs.readFileSync(path.join(SKILLS_DIR, 'windows-sys.md'), 'utf8')
  for (const needle of ['MAX_PATH', 'Stop-Process', 'netstat', 'autocrlf']) {
    assert.ok(md.includes(needle), `windows-sys 缺少: ${needle}`)
  }
})

// ---- lib 可加载且导出一致 ----
t('lib/index.js 导出 name/inject/apply + 合并层导出', async () => {
  const mod = await import(pathToFileURL(path.join(PKG_DIR, '..', 'lib', 'index.js')).href)
  assert.equal(mod.name, 'dsh-plugin-windows-guard')
  assert.ok(Array.isArray(mod.inject) && mod.inject.includes('skills'), 'inject 应含 skills')
  assert.ok(mod.inject.includes('tools'), 'inject 应含 tools')
  assert.equal(typeof mod.apply, 'function')
  assert.equal(typeof mod.checkDangerousWrite, 'function')
  assert.equal(typeof mod.postCheckHandler, 'function')
  assert.equal(typeof mod.preCheckHandler, 'function')
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

// ==== 以下为 0.2.0 自 pwsh-guard 合并的主动防护层测试 ====

// ---- mojibake ----
t('gbk misread 真实样本', () => {
  assert.equal(detectGbkMisread('鎻掍欢鏋勮瑙勮寖锛堢煡璇嗗簱锛?').misread, true)
  assert.equal(detectGbkMisread('# check-profile.mjs 鈥?profile 鑷€妫€閫氳繃鍚庨噸鍚?').misread, true)
})
t('正常文本不误报', () => {
  assert.equal(detectGbkMisread('插件构建规范，启动故障记录。').misread, false)
  assert.equal(detectGbkMisread('PowerShell 读取 Get-Content 文件没有问题。').misread, false)
})
t('ascii loss 检测', () => {
  assert.equal(detectAsciiLoss('??? skill ???? novel-format-rules ??,????:???????????????').asciiLoss, true)
  assert.equal(detect('插件构建规范，重启前必跑自检。').ok, true)
})
t('blocksToText', () => {
  const blocks = [{ type: 'text', text: 'hello' }, { type: 'tool-use', text: 'x' }]
  assert.equal(blocksToText(blocks).includes('hello'), true)
})

// ---- encode ----
t('utf8 无 BOM 检出', () => {
  const d = detectEncoding(Buffer.from('插件规范,正常内容。', 'utf8'))
  assert.equal(d.encoding, 'utf-8')
  assert.equal(d.validUtf8, true)
})
t('utf8 BOM 检出', () => {
  const d = detectEncoding(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}', 'utf8')]))
  assert.equal(d.encoding, 'utf-8-bom')
})
t('utf16le BOM 检出', () => {
  const d = detectEncoding(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文测试', 'utf16le')]))
  assert.equal(d.encoding, 'utf-16le')
})
t('gbk 检出', () => {
  // "插件规范" GBK 字节
  const gbk = Buffer.from([0xb2, 0xe5, 0xbc, 0xfe, 0xb9, 0xe6, 0xb7, 0xb6])
  const d = detectEncoding(gbk)
  assert.equal(d.encoding, 'gbk')
})

// ---- pre-execute 危险写拦截 ----
t('拦截无编码 Set-Content 写 json', () => {
  const reason = checkDangerousWrite('Set-Content -Path config.json -Value $x')
  assert.ok(reason && reason.includes('WriteAllText'), '应给出 WriteAllText 修正')
})
t('拦截 Out-File 写 yaml（无编码）', () => {
  const reason = checkDangerousWrite('$list | Out-File list.yaml')
  assert.ok(reason && reason.includes('WriteAllText'), reason)
})
t('放行带编码 Out-File', () => {
  assert.equal(checkDangerousWrite('Out-File -Path x.json -Encoding utf8NoBOM -Value $x'), undefined)
})
t('放行读操作', () => {
  assert.equal(checkDangerousWrite('Get-Content -Path readme.md'), undefined)
  assert.equal(checkDangerousWrite("Get-ChildItem | Measure-Object"), undefined)
})

// ---- fix 往返（临时目录，零残留风险）----
t('fixToUtf8NoBom：GBK → UTF-8 无 BOM + .windowsguard.bak 备份', () => {
  const tmp = path.join(PKG_DIR, '..', '.selfcheck-tmp')
  fs.mkdirSync(tmp, { recursive: true })
  const f = path.join(tmp, 'sample.gbk.txt')
  try {
    fs.writeFileSync(f, Buffer.from([0xb2, 0xe5, 0xbc, 0xfe, 0xb9, 0xe6, 0xb7, 0xb6])) // GBK「插件规范」
    const fixed = fixToUtf8NoBom(f, { backup: true })
    assert.equal(fixed.before, 'gbk')
    assert.equal(fixed.after, 'utf-8')
    assert.ok(fs.existsSync(`${f}.windowsguard.bak`), '备份应存在')
    assert.ok(fs.readFileSync(f, 'utf8').includes('插件'), '修复后应为 UTF-8 中文')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

if (!process.exitCode) console.log(`\n${passed} 项全部通过`)
else console.log(`\n${passed} 项通过，存在失败项`)
