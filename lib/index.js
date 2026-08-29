/**
 * dsh-plugin-windows-guard — Windows 环境防坑插件（守则 + 主动防护）。
 *
 * 挂载于 profile 根层（全局层），两部分职责：
 *
 * A. 守则层（0.1.0 起）：把 skills/ 目录下的 windows-enc / windows-sys 技能注册为
 *    runtime skill，让每个会话的 agent 在 Windows 上执行命令、读写文件、处理
 *    编码/路径/进程/端口/乱码类任务时，按技能 description 自动加载防坑守则。
 *
 * B. 主动防护层（0.2.0 起，自 dsh-plugin-pwsh-guard 合并，该插件已删除）：
 *    - L2 tools/post-execute（postCheck=true）：pwsh 工具结果出现乱码特征时，
 *      自动在结果后附加模型可见的修复提示（不中断、不改写结果本体）；
 *    - L3 tools/pre-execute（preCheck=true）：拦截「确定会写坏文件的命令」
 *      （结构文件重定向写 / 无 -Encoding 的 Set-Content），给出正确写法；
 *    - L4 windows_encode_detect / windows_encode_fix 工具（detectTools=true）：
 *      文件编码诊断与修复（BOM 剥离、GBK→UTF-8、UTF-16→UTF-8），零依赖 Node 实现。
 *    （原 pwsh-guard 的 L1 系统提示词段由上面的守则技能取代，不再注入。）
 *
 * 守则内容来自本机 255 个会话归档的问题扫描（GBK 误解码 / BOM / UTF-16 /
 * 单引号转义 / 长路径 / EACCES / 端口占用 / stderr 误判 / 乱码当答案等），
 * 详见 skills/windows-enc.md 与 skills/windows-sys.md。
 *
 * 依赖纪律：本模块不 import 任何 @deepseek-ai/* 运行时包（插件以 link: 方式
 * 装入 profile，Node ESM 按 realpath 解析链接包，外部依赖从插件目录解析不到）；
 * 工具直接走 ctx.tools.register 的原始 definition 形状（标准 JSON Schema）。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detect as detectMojibake, blocksToText } from './mojibake.js'
import { diagnoseFile, fixToUtf8NoBom } from './encode.js'

export const name = 'dsh-plugin-windows-guard'
export const inject = ['skills', 'tools']

const PKG_DIR = dirname(fileURLToPath(import.meta.url))
const SKILLS_DIR = join(PKG_DIR, '..', 'skills')

const DEFAULT_CONFIG = {
  /** 总开关（false = 只保留守则技能，关闭全部主动防护）。 */
  enabled: true,
  /** L2：pwsh 工具结果乱码检测 + 自动附加修复提示。 */
  postCheck: true,
  /** L3：拦截确定会写坏结构化文本文件的命令。 */
  preCheck: true,
  /** L4：注册 windows_encode_detect / windows_encode_fix 工具。 */
  detectTools: true,
}

// ---------------------------------------------------------------------------
// 守则技能（0.1.0 起）
// ---------------------------------------------------------------------------

/** 极简 frontmatter 解析（name/description/whenToUse）。 */
function parseFrontmatter(md) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md)
  if (!match) return { name: undefined, description: undefined, whenToUse: undefined, body: md }
  const meta = {}
  for (const line of match[1].split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    const key = line.slice(0, i).trim()
    if (key) meta[key] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
  }
  return { ...meta, body: md.slice(match[0].length) }
}

/** 从 skills/ 目录加载技能定义（文件缺失/无 frontmatter 时跳过并警告，绝不让插件挂载失败）。 */
function loadSkills() {
  const out = []
  if (!existsSync(SKILLS_DIR)) {
    console.warn('[dsh-plugin-windows-guard] skills 目录缺失，技能未加载：' + SKILLS_DIR)
    return out
  }
  for (const file of readdirSync(SKILLS_DIR)) {
    if (!file.endsWith('.md')) continue
    try {
      const fm = parseFrontmatter(readFileSync(join(SKILLS_DIR, file), 'utf8'))
      if (!fm.name || !fm.description) {
        console.warn(`[dsh-plugin-windows-guard] 技能文件缺少 name/description frontmatter，已跳过：${file}`)
        continue
      }
      out.push({
        name: fm.name,
        description: fm.description,
        whenToUse: fm.whenToUse,
        body: fm.body
      })
    } catch (err) {
      console.warn(`[dsh-plugin-windows-guard] 技能文件读取失败，已跳过：${file}（${err?.message ?? err}）`)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// L2：post-execute 乱码检测（自 pwsh-guard 合并）
// ---------------------------------------------------------------------------

/** 后置检测附加提示（供 post-execute 追加）。 */
function buildPostHint(detection) {
  return [
    '',
    `[windows-guard] ${detection.summary}`,
    '处理建议：若输出来自文件内容 → 先 `windows_encode_detect` 确认该文件编码、`windows_encode_fix` 转成 UTF-8 无 BOM 后再读；',
    '若是 PowerShell 5.1 读 UTF-8 文件 → 改用 `Get-Content -Encoding UTF8`；',
    '若是管道/控制台输出 → 先执行 `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)` 再重跑命令。',
    '不要把以上乱码内容当作有效答案直接使用。',
  ].join('\n')
}

/** post-execute：pwsh 结果乱码检测 → 附加模型可见提示。 */
export async function postCheckHandler(exec, result, next) {
  if (exec?.name !== 'pwsh') return next()
  if (!result || result.isError) return next()
  const text = blocksToText(result.content ?? [])
  if (!text) return next()
  const detection = detectMojibake(text)
  if (detection.ok) return next()
  const hint = buildPostHint(detection)
  const content = [...(result.content ?? []), { type: 'text', text: hint }]
  return { kind: 'accept', content }
}

// ---------------------------------------------------------------------------
// L3：pre-execute 危险写拦截（自 pwsh-guard 合并）
// ---------------------------------------------------------------------------

/** 结构文件扩展名（写坏会直接炸解析）。 */
const STRUCTURED_EXT = /\.(json|ya?ml|toml|gd|lock)\b/i

/**
 * pre-execute 拦截：检测「确定会写坏文件」的 PowerShell 命令。
 * @param {string} command
 * @returns {string | undefined} 拒绝理由（含修正示例）；undefined = 放行。
 */
export function checkDangerousWrite(command) {
  if (!command || typeof command !== 'string') return undefined
  // 不带 -Encoding 的 Set-Content / Add-Content / Out-File 写结构化文件
  if (/\b(?:Set-Content|Add-Content|Out-File)\b/i.test(command)) {
    const hasEncoding = /-Encoding\b/i.test(command)
    const targetsStructured = STRUCTURED_EXT.test(command)
    if (targetsStructured && !hasEncoding) {
      return [
        `该命令会以 PowerShell 默认编码写入结构化文本文件（Windows PowerShell 5.1 默认 UTF-16LE，`,
        `或 UTF-8 带 BOM），JSON/YAML 将无法解析（历史上以此为根的启动事故）。`,
        `请改为：[System.IO.File]::WriteAllText(文件路径, $content, [System.Text.UTF8Encoding]::new($false))`,
        `或 pwsh 7 的 Out-File -Encoding utf8NoBOM。`,
      ].join('\n')
    }
  }
  // 裸重定向写结构化文件（> file.json 等）
  if (/>>?\s*["']?[^"'\s]+\.(json|ya?ml|toml|gd)(?:["']|$)/i.test(command)) {
    const leading = /^>>?\s*["']?[^"'\s]+\.(json|ya?ml|toml|gd)/i.exec(command)
    if (leading) {
      return [
        `PowerShell 的 > 重定向默认按 UTF-16LE（5.1）编码写入，会破坏结构化文件。`,
        `请改用 [System.IO.File]::WriteAllText(path, content, (New-Object System.Text.UTF8Encoding($false))) 或 Out-File -Encoding utf8NoBOM。`,
      ].join('\n')
    }
  }
  // Get-Content 读 UTF-8 文件不给 -Encoding（提示但放行：英文文件无害，交给 post-check）
  return undefined
}

/** pre-execute：拦截危险写命令。 */
export async function preCheckHandler(exec, next) {
  if (exec?.name !== 'pwsh') return next()
  const command = exec.arguments?.command
  const reason = checkDangerousWrite(command)
  if (reason) {
    return { kind: 'deny', reason: `[windows-guard] ${reason}` }
  }
  return next()
}

// ---------------------------------------------------------------------------
// L4：编码诊断/修复工具（自 pwsh-guard 合并；命名遵循「主题_动词」规范）
// ---------------------------------------------------------------------------

/** resolvePath：绝对路径原样，相对路径基于会话 cwd（兜底 process.cwd()）。 */
function resolveWorkPath(cwd, p) {
  if (isAbsolute(p)) return resolve(p)
  return resolve(cwd || process.cwd(), p)
}

function sessionCwd(exec) {
  return exec?.agent?.session?.header?.cwd || process.cwd()
}

/** windows_encode_detect 工具定义（原始 definition 形状）。 */
function encodeDetectTool() {
  return {
    name: 'windows_encode_detect',
    description:
      '零 token 本地文件编码诊断：检测 BOM（UTF-8/UTF-16/UTF-32）、是否合法 UTF-8、' +
      '是否 GBK(936) 编码（PowerShell 5.1 / 老工具常见）、疑似 GBK 误解码乱码等，' +
      '输出诊断结论与修复建议。遇到中文乱码（鈥?/鎻掍欢/锟斤拷/???）或 JSON/YAML 解析失败时先调用本工具。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: {
          type: 'string',
          description: '文件路径（相对当前工作区或绝对路径）。'
        }
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'encoding', 'diagnosis'],
        properties: {
          path: { type: 'string' },
          encoding: { type: 'string' },
          diagnosis: { type: 'string' }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.diagnosis }]
    },
    async execute(args, exec) {
      const cwd = sessionCwd(exec)
      const p = resolveWorkPath(cwd, args.path)
      if (!existsSync(p)) throw new Error(`文件不存在：${args.path}（已解析为 ${p}）`)
      const diag = diagnoseFile(p)
      if (diag.error) throw new Error(diag.error)
      const diagnosis = [
        `【文件编码诊断】${p}`,
        `大小：${diag.size} 字节 | BOM：${diag.bom ?? '无'} | 判定：${diag.encoding}（置信度 ${diag.confidence}）`,
        `合法 UTF-8：${diag.validUtf8 ? '是' : '否'} | UTF-8 中文占比：${(diag.utf8CjkRatio * 100).toFixed(1)}% | GBK 中文占比：${(diag.gbkCjkRatio * 100).toFixed(1)}%`,
        `诊断：${diag.note}`,
      ].join('\n')
      return { path: p, encoding: diag.encoding, diagnosis }
    }
  }
}

/** windows_encode_fix 工具定义。 */
function encodeFixTool() {
  return {
    name: 'windows_encode_fix',
    description:
      '零 token 本地编码修复：把文件转换为 UTF-8 无 BOM（剥离 BOM、GBK/UTF-16 → UTF-8），' +
      '自动备份原文件为 <path>.windowsguard.bak。诊断与修复一站式；dryRun 只诊断不写入。' +
      '修复后可用 windows_encode_detect 复查。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: {
          type: 'string',
          description: '文件路径（相对当前工作区或绝对路径）。'
        },
        dryRun: {
          type: 'boolean',
          description: '仅诊断并输出将要执行的转换，不写文件、不创建备份（默认 false）。'
        }
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'before', 'after', 'notice'],
        properties: {
          path: { type: 'string' },
          before: { type: 'string' },
          after: { type: 'string' },
          notice: { type: 'string' }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.notice }]
    },
    async execute(args, exec) {
      const cwd = sessionCwd(exec)
      const p = resolveWorkPath(cwd, args.path)
      if (!existsSync(p)) throw new Error(`文件不存在：${args.path}（已解析为 ${p}）`)
      const diag = diagnoseFile(p)
      if (diag.error) throw new Error(diag.error)
      if (args.dryRun) {
        return {
          path: p, before: diag.encoding, after: 'utf-8',
          notice: `【dryRun】${p}\n当前编码：${diag.encoding}（置信度 ${diag.confidence}）\n转换计划：→ UTF-8 无 BOM\n${diag.note}\n未写入任何文件。`
        }
      }
      if (diag.encoding === 'utf-8') {
        return {
          path: p, before: 'utf-8', after: 'utf-8',
          notice: `【无需修复】${p}\n已是合法 UTF-8 且无 BOM。`
        }
      }
      const fixed = fixToUtf8NoBom(p, { backup: true })
      return {
        path: p, before: fixed.before, after: fixed.after,
        notice: `【修复完成】${p}\n${fixed.note}`
      }
    }
  }
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  const cfg = { ...DEFAULT_CONFIG, ...(config ?? {}) }
  // 显式布尔归一（patch 配置可能是字符串）
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (typeof cfg[key] === 'string') cfg[key] = cfg[key] === 'true'
  }

  const disposers = []

  // A. 守则技能
  const skills = loadSkills()
  for (const skill of skills) {
    try {
      if (typeof ctx?.skills?.register !== 'function') {
        console.warn('[dsh-plugin-windows-guard] ctx.skills.register 不可用，跳过技能注册')
        break
      }
      // 契约（dsh-skill validateDefinition）：name/description/source/content 四字符串；
      // provider 缺省为 'runtime'；纯正文技能无资源目录，不声明 resourceBase。
      disposers.push(ctx.skills.register({
        name: skill.name,
        description: skill.description,
        ...(skill.whenToUse ? { whenToUse: skill.whenToUse } : {}),
        source: 'runtime',
        content: skill.body,
      }))
      console.log(`[dsh-plugin-windows-guard] 技能已注册：${skill.name}`)
    } catch (err) {
      console.warn(`[dsh-plugin-windows-guard] 技能注册失败：${skill.name}（${err?.message ?? err}）`)
    }
  }

  if (cfg.enabled) {
    // B1（L2）：post-execute 乱码检测
    if (cfg.postCheck) {
      if (typeof ctx?.on === 'function') {
        disposers.push(ctx.on('tools/post-execute', postCheckHandler))
      } else {
        console.warn('[dsh-plugin-windows-guard] ctx.on 不可用，postCheck 未注册')
      }
    }

    // B2（L3）：pre-execute 危险写拦截
    if (cfg.preCheck) {
      if (typeof ctx?.on === 'function') {
        disposers.push(ctx.on('tools/pre-execute', preCheckHandler))
      } else {
        console.warn('[dsh-plugin-windows-guard] ctx.on 不可用，preCheck 未注册')
      }
    }

    // B3（L4）：编码诊断/修复工具
    if (cfg.detectTools) {
      if (typeof ctx?.tools?.register === 'function') {
        disposers.push(ctx.tools.register(encodeDetectTool()))
        disposers.push(ctx.tools.register(encodeFixTool()))
      } else {
        console.warn('[dsh-plugin-windows-guard] ctx.tools.register 不可用，detectTools 未注册')
      }
    }

    console.log(
      `[dsh-plugin-windows-guard] 已挂载：${skills.length} 技能 + 主动防护` +
      `${cfg.postCheck ? ' [postCheck]' : ''}${cfg.preCheck ? ' [preCheck]' : ''}${cfg.detectTools ? ' [detectTools]' : ''}`
    )
  } else {
    console.log(`[dsh-plugin-windows-guard] 已挂载：${skills.length} 技能（主动防护已由配置关闭）`)
  }

  // 卸载清理（HMR 重载时避免重复注册）。
  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* ignore */ }
    }
  }
}
