/**
 * dsh-plugin-windows-guard — 文件编码检测与修复（零依赖纯函数）。
 *
 * 自 0.2.0 起自 dsh-plugin-pwsh-guard 合并（该插件已删除）。
 * 检测逻辑对齐历史会话中实际用过的字节嗅探诊断（`前3字节: 35 32 229 ---GBK解码---`）：
 *  1. BOM 探测（UTF-8 / UTF-16LE / UTF-16BE / UTF-32）；
 *  2. 严格 UTF-8 解码（TextDecoder fatal）判断是否合法 UTF-8；
 *  3. GBK(936) 备选解码 + CJK 占比启发式（判断「更像 GBK 还是 UTF-8」）；
 *  4. 修复：任意源编码 → UTF-8 无 BOM（先备份原文件）。
 *
 * 依赖：Node 内置 TextDecoder（需 full-icu，Node 官方构建默认满足）。
 */

import { readFileSync, writeFileSync, copyFileSync, statSync } from 'node:fs'

export const GBK_LABEL = 'gbk'
export const UTF8_LABEL = 'utf-8'

/** 读文件前 N 字节做 BOM 探测。 */
export function detectBom(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8-bom'
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le'
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'utf-16be'
  if (buf.length >= 4 && buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0xfe && buf[3] === 0xff) return 'utf-32be'
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xfe && buf[2] === 0x00 && buf[3] === 0x00) return 'utf-32le'
  return null
}

/** 严格 UTF-8 解码（fatal）；失败返回 null。 */
export function strictUtf8(buf) {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), ok: true }
  } catch {
    return { text: null, ok: false }
  }
}

/** GBK 解码（宽松）；失败返回 null。 */
export function decodeGbk(buf) {
  try {
    return { text: new TextDecoder('gbk').decode(buf), ok: true }
  } catch {
    return { text: null, ok: false }
  }
}

/** CJK 字符占比（0~1）。 */
export function cjkRatio(text) {
  if (!text || text.length === 0) return 0
  let cjk = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if (cp >= 0x4e00 && cp <= 0x9fff) cjk++
  }
  return cjk / text.length
}

/** 可控字符比例（排除替换字符/怪异字节残片）。 */
function printableRatio(text) {
  if (!text || text.length === 0) return 0
  let ok = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if (ch === '\uFFFD') continue
    if (cp === 9 || cp === 10 || cp === 13 || (cp >= 0x20 && cp !== 0x7f && cp < 0x10000)) ok++
  }
  return ok / text.length
}

/**
 * 诊断一个文件/字节缓冲的编码。
 * @param {Buffer} buf
 * @param {string} [fileName] 用于报告
 * @returns {{ encoding: string, confidence: 'high'|'medium'|'low', bom: string|null,
 *             validUtf8: boolean, utf8CjkRatio: number, gbkCjkRatio: number, gbkPrintable: number,
 *             replaceChars: number, note: string }}
 */
export function detectEncoding(buf) {
  const bom = detectBom(buf)
  if (bom === 'utf-16le' || bom === 'utf-16be' || bom === 'utf-32le' || bom === 'utf-32be') {
    const enc = new TextDecoder(bom === 'utf-16le' ? 'utf-16le' : bom === 'utf-16be' ? 'utf-16be' : bom === 'utf-32le' ? 'utf-32le' : 'utf-32be')
    let text = ''
    try { text = enc.decode(buf) } catch { /* keep */ }
    return {
      encoding: bom, confidence: 'high', bom,
      validUtf8: false,
      utf8CjkRatio: 0,
      gbkCjkRatio: cjkRatio(text),
      gbkPrintable: printableRatio(text),
      replaceChars: (text.match(/\uFFFD/g) ?? []).length,
      note: `检测到 BOM（${bom}）——这是脚本/配置不该有的编码；建议转换为 UTF-8 无 BOM。`,
    }
  }
  if (bom === 'utf-8-bom') {
    const body = strictUtf8(buf.subarray(3))
    return {
      encoding: 'utf-8-bom', confidence: 'high', bom,
      validUtf8: body.ok,
      utf8CjkRatio: body.ok ? cjkRatio(body.text) : 0,
      gbkCjkRatio: body.ok ? 0 : cjkRatio(decodeGbk(buf.subarray(3)).text ?? ''),
      gbkPrintable: body.ok ? 1 : printableRatio(decodeGbk(buf.subarray(3)).text ?? ''),
      replaceChars: body.ok ? 0 : (buf.length ? (buf.toString('utf8').match(/\uFFFD/g) ?? []).length : 0),
      note: '检测到 UTF-8 BOM——写入 BOM 的文件（如 PowerShell 5.1 `Out-File -Encoding utf8`/记事本 早期版本）可能导致 JSON/YAML 解析失败；建议剥离 BOM。',
    }
  }
  // 无 BOM：先验证严格 UTF-8
  const utf8 = strictUtf8(buf)
  if (utf8.ok) {
    // UTF-8 合法。若文本几乎无 CJK 又有大量 FFFD？FFFD 不会在 fatal 模式出现。
    const ratio = cjkRatio(utf8.text)
    return {
      encoding: 'utf-8', confidence: 'high', bom: null,
      validUtf8: true,
      utf8CjkRatio: ratio,
      gbkCjkRatio: decodeGbk(buf).ok ? cjkRatio(decodeGbk(buf).text) : 0,
      gbkPrintable: 1,
      replaceChars: 0,
      note: ratio > 0.05 ? '合法 UTF-8（含中文）。' : '合法 UTF-8（纯 ASCII/英文为主）。',
    }
  }
  // UTF-8 失败 → 尝试 GBK
  const gbk = decodeGbk(buf)
  if (gbk.ok) {
    const print = printableRatio(gbk.text)
    const cjk = cjkRatio(gbk.text)
    if (print > 0.9 && cjk > 0.05) {
      return {
        encoding: 'gbk', confidence: 'high', bom: null,
        validUtf8: false,
        utf8CjkRatio: 0,
        gbkCjkRatio: cjk, gbkPrintable: print,
        replaceChars: (gbk.text.match(/\uFFFD/g) ?? []).length,
        note: '不是合法 UTF-8；按 GBK(936) 解码后为正常中文——文件由 GBK 编码工具生成（如老脚本/老编辑器）。',
      }
    }
    if (print > 0.8) {
      return {
        encoding: 'gbk', confidence: 'medium', bom: null,
        validUtf8: false,
        utf8CjkRatio: 0,
        gbkCjkRatio: cjk, gbkPrintable: print,
        replaceChars: (gbk.text.match(/\uFFFD/g) ?? []).length,
        note: '不是合法 UTF-8；GBK 解码基本可读（但中文占比低）。',
      }
    }
    return {
      encoding: 'unknown-binary', confidence: 'low', bom: null,
      validUtf8: false,
      utf8CjkRatio: 0, gbkCjkRatio: cjk, gbkPrintable: print,
      replaceChars: (gbk.text.match(/\uFFFD/g) ?? []).length,
      note: '不是合法 UTF-8，GBK 解码也多为不可读字符——疑似二进制文件。',
    }
  }
  return {
    encoding: 'unknown', confidence: 'low', bom: null,
    validUtf8: false,
    utf8CjkRatio: 0, gbkCjkRatio: 0, gbkPrintable: 0,
    replaceChars: 0,
    note: '无法识别编码（既非 UTF-8 也非 GBK，可能是二进制或损坏文件）。',
  }
}

/** 诊断磁盘上的文件。 */
export function diagnoseFile(path) {
  const st = statSync(path)
  if (st.size > 8 * 1024 * 1024) {
    return { error: `文件过大（${st.size} 字节 > 8MB），跳过检测。` }
  }
  const buf = readFileSync(path)
  const enc = detectEncoding(buf)
  return { size: st.size, ...enc }
}

/**
 * 修复为 UTF-8 无 BOM：先备份（.windowsguard.bak），再写回。
 * @param {string} path
 * @param {{ backup?: boolean }} [opts]
 * @returns {{ written: boolean, before: string, after: string, backupPath?: string, note: string }}
 */
export function fixToUtf8NoBom(path, opts = {}) {
  const { backup = true } = opts
  const buf = readFileSync(path)
  const diag = detectEncoding(buf)
  let text
  switch (diag.encoding) {
    case 'utf-8-bom': {
      // BOM 主体若不是合法 UTF-8，无法判定编码——明确报错，不写文件不备份。
      const body = strictUtf8(buf.subarray(3))
      if (!body.ok) throw new Error(`无法判定编码（有 UTF-8 BOM 但主体不是合法 UTF-8），不执行写入：${path}`)
      text = body.text
      break
    }
    case 'utf-16le':
    case 'utf-16be':
    case 'utf-32le':
    case 'utf-32be':
      text = new TextDecoder(
        diag.encoding === 'utf-16le' ? 'utf-16le'
          : diag.encoding === 'utf-16be' ? 'utf-16be'
          : diag.encoding === 'utf-32le' ? 'utf-32le'
          : 'utf-32be'
      ).decode(buf)
      break
    case 'gbk':
      text = decodeGbk(buf).text ?? ''
      break
    default:
      if (diag.validUtf8) text = strictUtf8(buf).text ?? ''
      else throw new Error(`无法确定编码（${diag.encoding}），不执行写入：${path}`)
  }
  let backupPath
  if (backup) {
    backupPath = `${path}.windowsguard.bak`
    copyFileSync(path, backupPath)
  }
  writeFileSync(path, text, { encoding: 'utf8' }) // Node 默认 utf8 = 无 BOM
  return {
    written: true,
    before: diag.encoding,
    after: 'utf-8',
    backupPath,
    note: `已转换为 UTF-8 无 BOM（源编码：${diag.encoding}${backupPath ? `；备份：${backupPath}` : ''}）。`,
  }
}
