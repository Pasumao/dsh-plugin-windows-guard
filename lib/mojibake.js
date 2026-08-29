/**
 * dsh-plugin-windows-guard — 乱码模式检测（零依赖纯函数）。
 *
 * 自 0.2.0 起自 dsh-plugin-pwsh-guard 合并（该插件已删除）。
 *
 * 检测 PowerShell / dsh 运行中最常见的两类编码损坏：
 *   1. UTF-8 字节被按 GBK/ANSI(936) 解码产生的「误解码乱码」
 *      （经典：`鎻掍欢鏋勮瑙勮寖` = `插件构建规范`、`鈥?` = `—`、`锟斤拷` = U+FFFD 对）；
 *   2. 替换字符 U+FFFD 洪水 / 连续问号（UTF-8 → ASCII 转换丢失，`??OK??` 案例）。
 *
 * 词表基于历史会话归档中实际出现的误读对（见 README「历史案例」），
 * 全部为正常中文中几乎不出现的生僻字形，误报率极低。
 */

const GBK_MISREAD_CHARS =
  '鎻鏋瑙鍚鏁璁锟斤拷鈥鍒鍩銆鎺鍛婵鑻娿浣剧鏇鏈浠杩鍙鏄鐨涓鑱氭' +
  '涔勭璇ヨ寮勩缁撻噸妫娉ㄥご鍏鍐呭澶ф槸鏇撮闀扮畝鐜暣浠庢潵鍒樹笅鐪嬪潶' +
  '涓嶆槸寰堝ソ搴旇杩囷紝锛岃繖鍙椾笉寰楄繍鐢ㄧ殑鍦板疄銆備功椤磋兘'

function isCjk(ch) {
  return ch >= '\u4e00' && ch <= '\u9fff'
}

/**
 * 检测一段文本是否为「UTF-8 被 GBK 误解码」乱码。
 * @param {string} text - 待检测文本。
 * @returns {{ misread: boolean, chars?: string[], confidence: 'high'|'medium'|'low', note?: string }}
 */
export function detectGbkMisread(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { misread: false, confidence: 'low' }
  }
  const found = new Set()
  for (const ch of text) {
    if (isCjk(ch) && GBK_MISREAD_CHARS.includes(ch)) found.add(ch)
  }

  // 误解码标点怪串（强特征，单独加权）
  let punctPieces = 0
  const punctPatterns = [
    /鈥[？\?\uFFFD]/g,   // em-dash 误读（鈥? / 鈥？ / 鈥�）
    /锛[？\?\uFFFD]/g,   // 全角逗号/括号误读
    /锛堝/g,             // 左括号误读
    /銆[？\?\uFFFD]/g,   // 句号误读
    /锘[？\?\uFFFD]/g,   // U+FEFF 误读
  ]
  for (const re of punctPatterns) {
    const m = text.match(re)
    if (m) punctPieces += m.length
  }

  // U+FFFD 洪水（≥5 个）
  const substCount = (text.match(/\uFFFD/g) ?? []).length
  const hasSubstFlood = substCount >= 5

  if (found.size >= 6) {
    return { misread: true, chars: [...found].slice(0, 16), confidence: 'high' }
  }
  if (found.size >= 5 && punctPieces > 0) {
    return { misread: true, chars: [...found].slice(0, 16), confidence: 'high' }
  }
  if (found.size >= 3) {
    return { misread: true, chars: [...found].slice(0, 16), confidence: 'medium' }
  }
  if (found.size >= 1 && punctPieces >= 1) {
    return { misread: true, chars: [...found].slice(0, 16), confidence: 'medium', note: '含误解码标点组合' }
  }
  if (hasSubstFlood) {
    return { misread: true, confidence: 'medium', note: '大量 U+FFFD 替换字符——原文在某个环节被按错误编码解码' }
  }
  return { misread: false, confidence: 'low' }
}

/**
 * 检测「内容被替换为问号」的 ASCII 化损坏（`??OK??`、`??? skill ????` 案例）。
 * @param {string} text
 * @returns {{ asciiLoss: boolean, score: number }}
 */
export function detectAsciiLoss(text) {
  if (typeof text !== 'string' || text.length < 12) {
    return { asciiLoss: false, score: 0 }
  }
  const runs = text.match(/\?{2,}/g) ?? []
  if (runs.length === 0) return { asciiLoss: false, score: 0 }
  let score = 0
  for (const run of runs) {
    score += run.length >= 4 ? 2 : 1
  }
  const density = (text.match(/\?/g) ?? []).length / Math.max(1, text.length)
  if (density > 0.03) score += 2
  return { asciiLoss: score >= 2, score }
}

/**
 * 一键检测：给定文本返回规范化的结果摘要（供 post-execute 附加提示）。
 * @param {string} text
 * @returns {{ ok: boolean, kind?: 'gbk-misread'|'ascii-loss', summary: string }}
 */
export function detect(text) {
  const gbk = detectGbkMisread(text)
  if (gbk.misread) {
    return {
      ok: false,
      kind: 'gbk-misread',
      summary: `疑似 GBK/ANSI 误解码乱码（特征字形：${(gbk.chars ?? []).slice(0, 6).join(' ')}${gbk.note ? `；${gbk.note}` : ''}）。`,
    }
  }
  const asc = detectAsciiLoss(text)
  if (asc.asciiLoss) {
    return {
      ok: false,
      kind: 'ascii-loss',
      summary: '疑似编码丢失（中文被替换为问号，常见于 UTF-8→ANSI 转换）。',
    }
  }
  return { ok: true }
}

/** 把 ContentBlock[] 展平为纯文本（用于 post-execute 扫描）。 */
export function blocksToText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && typeof block.text === 'string') parts.push(block.text)
    else if (typeof block === 'string') parts.push(block)
  }
  return parts.join('\n')
}
