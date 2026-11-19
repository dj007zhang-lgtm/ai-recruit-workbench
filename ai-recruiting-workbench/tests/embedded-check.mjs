#!/usr/bin/env node
/**
 * 内嵌代码校验（第 0 层防线）—— 真实渲染法
 *
 * 存在理由：插件里有"JS 字符串拼 HTML + 内嵌 <script>"的页面（面试官页、批量评审页）。
 * 外层 node --check 只验证外层文件；字符串里的 JS 括号不平衡、语法错误一律发现不了，
 * 结果就是页面按钮全部失效，却通过所有现有测试（真实踩过）。
 *
 * 做法（不靠正则猜，直接跑真实代码）：
 *   1. 从 index.js 里提取页面生成函数（interviewerPageHtml / interviewerBatchHtml 等）
 *   2. 用 mock 的 esc 等依赖，真实调用函数 → 得到完整 HTML
 *   3. 从 HTML 里提取 <script> 内容 → vm.Script 编译校验（真实语法检查）
 *   4. 校验 HTML 标签配对
 *
 * 用法：node tests/embedded-check.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const DIR = dirname(fileURLToPath(import.meta.url))
const SRC = join(DIR, '..', 'index.js')
const src = readFileSync(SRC, 'utf8')

let fail = 0
const bad = (m) => { fail++; console.log('  ❌ ' + m) }
const good = (m) => console.log('  ✅ ' + m)

/* 提取顶层 function 定义（按大括号配对，跳过字符串与注释） */
function extractFunction(source, name) {
  const key = 'function ' + name + '('
  const start = source.indexOf(key)
  if (start < 0) return null
  // 从 function 关键字后的第一个 { 开始配对
  let i = source.indexOf('{', start)
  if (i < 0) return null
  let depth = 0
  let inStr = null, inTpl = false, inLineComment = false, inBlockComment = false
  for (let j = i; j < source.length; j++) {
    const c = source[j], n = source[j + 1]
    if (inLineComment) { if (c === '\n') inLineComment = false; continue }
    if (inBlockComment) { if (c === '*' && n === '/') { inBlockComment = false; j++ } continue }
    if (inStr) {
      if (c === '\\') { j++; continue }
      if (c === inStr) inStr = null
      continue
    }
    if (inTpl) {
      if (c === '\\') { j++; continue }
      if (c === '`') inTpl = false
      continue
    }
    if (c === '/' && n === '/') { inLineComment = true; j++; continue }
    if (c === '/' && n === '*') { inBlockComment = true; j++; continue }
    if (c === "'" || c === '"') { inStr = c; continue }
    if (c === '`') { inTpl = true; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return source.slice(start, j + 1) }
  }
  return null
}

/* 从 HTML 中提取 <script> 内容并编译校验 */
function checkScripts(html, label) {
  const re = /<script[^>]*>([\s\S]*?)<\/script>/gi
  let m, n = 0
  while ((m = re.exec(html)) !== null) {
    n++
    const code = m[1]
    if (!code.trim()) continue
    try {
      new vm.Script(code, { filename: label + '-script-' + n + '.js' })
      good(label + ' 内嵌 script #' + n + ' 语法正确（' + code.length + ' 字符）')
    } catch (e) {
      bad(label + ' 内嵌 script #' + n + ' 语法错误：' + String(e.message || e))
      // 打印出错位置上下文，便于定位
      const mm = String(e.stack || '').match(/:(\d+)/)
      if (mm) {
        const ln = Number(mm[1])
        const lines = code.split('\n')
        for (let k = Math.max(0, ln - 2); k < Math.min(lines.length, ln + 1); k++) {
          console.log('       ' + (k + 1) + ': ' + lines[k].slice(0, 160))
        }
      }
    }
  }
  if (!n) console.log('  （' + label + ' 无内嵌 script）')
}

/* HTML 标签配对（忽略 script/style 内容与 void 标签） */
function checkHtml(html, label) {
  const VOID = new Set(['input', 'br', 'hr', 'img', 'meta', 'link', 'source', 'area', 'base', 'col', 'embed', 'param', 'track', 'wbr', '!doctype'])
  // 去掉 script/style 内容，避免其中的 < > 干扰
  const cleaned = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '<script></script>')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '<style></style>')
  const stack = []
  const re = /<\/?([a-zA-Z!][a-zA-Z0-9-]*)\b[^>]*?(\/)?>/g
  let m, err = null
  while ((m = re.exec(cleaned)) !== null) {
    const raw = m[0], name = m[1].toLowerCase(), selfClose = m[2] === '/'
    if (VOID.has(name) || selfClose) continue
    if (raw.startsWith('</')) {
      const top = stack.pop()
      if (top !== name) { err = '闭合 </' + name + '> 与开标签 <' + (top || '无') + '> 不匹配'; break }
    } else stack.push(name)
  }
  if (!err && stack.length) err = '未闭合标签：' + stack.slice(-4).join(', ')
  if (err) bad(label + ' HTML 结构：' + err)
  else good(label + ' HTML 标签配对正确')
}

/* ---------- 构建沙箱，真实渲染页面 ---------- */
console.log('===== 内嵌代码校验（真实渲染）=====')

const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const wanted = ['interviewerPageCss', 'interviewBriefHtml', 'interviewerPageHtml', 'interviewerBatchHtml']
const fnSrcs = {}
for (const name of wanted) {
  const f = extractFunction(src, name)
  if (!f) { bad('未找到函数 ' + name); continue }
  fnSrcs[name] = f
}

// 在沙箱里定义这些函数（互相引用靠同一作用域）
const sandboxCode = Object.values(fnSrcs).join('\n\n') + '\n;({ interviewerPageCss, interviewBriefHtml, interviewerPageHtml, interviewerBatchHtml })'
let fns = null
try {
  fns = vm.runInNewContext(sandboxCode, { console })
} catch (e) {
  bad('页面函数无法加载：' + String(e.message || e))
}

if (fns) {
  const brief = {
    name: '测试候选人', stage: '待初试', pos: 'Java开发工程师', round: '初试', at: '', place: '腾讯会议', interviewer: '测试面试官',
    resume: '测试简历内容\n电话：138******78', grade: 'A', score: 73, summary: 'A 级 · 基本胜任',
    alignment: [{ dim: '技能深度', level: 'L2' }, { dim: '过往战绩', level: 'L2' }], doubts: ['项目真实性待核实'], already: false,
  }
  // ① 单人页
  try {
    const html = fns.interviewerPageHtml('tok_test', brief, '', esc)
    checkScripts(html, '单人页')
    checkHtml(html, '单人页')
  } catch (e) { bad('单人页渲染抛错：' + String(e.message || e)) }

  // ② 批量页
  try {
    const list = [brief, { ...brief, name: '候选人B', grade: 'B', score: 59, summary: 'B 级 · 勉强匹配' }]
    const html = fns.interviewerBatchHtml('bt_test', { round: '初试', interviewer: '测试面试官', place: '腾讯会议' }, list, esc)
    checkScripts(html, '批量页')
    checkHtml(html, '批量页')
    // 关键元素存在性（交互能跑的前提）
    const need = [['通过/不通过按钮', /data-v="1"/], ['确认下一位按钮', /确认并看下一位/], ['最终区块', /id="finalStep"/], ['时间区间输入', /winFrom/], ['提交全部按钮', /id="submitAll"/]]
    for (const [label, re] of need) {
      if (re.test(html)) good('批量页含「' + label + '」')
      else bad('批量页缺少「' + label + '」')
    }
  } catch (e) { bad('批量页渲染抛错：' + String(e.message || e)) }
}

console.log('')
if (fail) { console.log('❌ 内嵌代码校验失败：' + fail + ' 项'); process.exit(1) }
console.log('✅ 内嵌代码校验通过')
