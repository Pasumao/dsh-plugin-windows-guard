/**
 * dsh-plugin-windows-guard — 主机插件（纯技能载体，无工具/命令/修复逻辑）。
 *
 * 挂载于 profile 根层（全局层），唯一职责：把 skills/ 目录下的 windows-guard
 * 技能注册为 runtime skill，让每个会话的 agent 在 Windows 上执行命令、读写
 * 文件、处理编码/路径/进程/端口/乱码类任务时，按技能 description 自动加载
 * 防坑守则——预防性规则，不提供修复工具（AI 按守则自行修复）。
 *
 * 守则内容来自本机 255 个会话归档的问题扫描（GBK 误解码 / BOM / UTF-16 /
 * 单引号转义 / 长路径 / EACCES / 端口占用 / stderr 误判 / 乱码当答案等），
 * 详见 skills/windows-guard/SKILL.md。
 *
 * 依赖纪律：本模块不 import 任何 @deepseek-ai/* 运行时包（插件以 link: 方式
 * 装入 profile，Node ESM 按 realpath 解析链接包，外部依赖从插件目录解析不到）。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-plugin-windows-guard'
export const inject = ['skills']

const PKG_DIR = dirname(fileURLToPath(import.meta.url))
const SKILLS_DIR = join(PKG_DIR, '..', 'skills')

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

export function apply(ctx, config) {
  const disposers = []
  const skills = loadSkills()

  for (const skill of skills) {
    try {
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

  console.log(`[dsh-plugin-windows-guard] 已挂载：${skills.length} 技能（守则在 skills/ 目录）`)

  // 卸载清理（HMR 重载时避免重复注册）。
  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* ignore */ }
    }
  }
}
