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

/* ---------- 4. client.js 真实 SSR 渲染（抓运行时作用域错误） ---------- */
// 只有真实渲染才能发现"函数内引用了不存在的变量"这类错误（静态分析不可靠）。
// 需要 react/react-dom：优先用项目 node_modules，其次 /tmp/rr（开发机环境）。
console.log('\n===== 4. client.js 真实 SSR 渲染 =====')
{
  const { createRequire } = await import('node:module')
  const { existsSync } = await import('node:fs')
  const candidates = [join(DIR, '..'), '/tmp/rr/']
  let React = null, renderToString = null, reqPath = null
  for (const base of candidates) {
    try {
      const rq = createRequire(base.endsWith('/') ? base : base + '/')
      React = rq('react'); renderToString = rq('react-dom/server').renderToString
      reqPath = base
      break
    } catch (e) { /* 换下一个 */ }
  }
  if (!React || !renderToString) {
    console.log('  ⚠ 跳过（未找到 react/react-dom，无法做 SSR；建议 npm i -D react react-dom）')
  } else {
    good('使用 React 环境：' + reqPath)
    // 造最小可渲染数据（覆盖所有页面关键路径）
    const mkCand = (id, name, stage, extra) => Object.assign({
      id, name, stage, pid: 'P1', source: 'BOSS直聘', score: 75, grade: 'A', conf: 0.9, route: 'A 级 · 基本胜任',
      resume: '测试简历', skills: ['Java'], daysAgo: 2, availability: null, mail: null,
      deep: { grade: 'A', score: 75, engine: 'bars', alignment: [{ dim: '技能深度', level: 'L2', requirement: 'x', candidate: 'y' }], conclusion: 'ok' },
      gateResults: [{ gate: '统招本科', verdict: 'pass', reason: '本科' }], doubts: [], undetermined: [], evidence: {},
    }, extra || {})
    const seed = {
      generatedAt: new Date().toISOString(),
      candidates: [
        mkCand('C1', '张三', '待评估'), mkCand('C2', '李四', '待初试'), mkCand('C3', '王五', '初试中', { lastInvite: { round: '初试', at: '2026-11-25T14:00', token: 'iv1', url: 'http://x/y' }, availability: [{ interviewer: '张总', round: '初试', windows: [{ from: '2026-11-25T14:00', to: '2026-11-25T18:00' }] }] }),
        mkCand('C4', '赵六', '已淘汰'), mkCand('C5', '钱七', '待复试'), mkCand('C6', '孙八', '待背调'),
      ],
      positions: [{ id: 'P1', title: 'Java开发工程师', dept: '技术部', city: '杭州', hc: 2, band: [20, 30], status: '在招', gates: ['统招本科'], abilities: ['技能深度'], scorecard: { softDims: [{ name: '技能深度', weight: 100, levels: [] }], hardGates: ['统招本科'] } }],
      inbox: [], alerts: [], trend: [], dashboard: { kpis: [], kpisMinor: [], pipeline: [], sourceFunnel: [], hiring: [], stageTime: [], aiPerf: { gradeDist: {}, corrections: 0 }, overdue: [], arrivals: [], offerAccept: {}, cycle: {} },
      detail: { candidate: mkCand('C3', '王五', '初试中'), position: { id: 'P1', title: 'Java开发工程师' }, timeline: [], currentStandard: {} },
      aiStatus: { pendingCandidates: 0, hint: '' }, talentPool: [],
    }
    // 加载 client.js，替换 Workbench 的初始 state 为 seed，逐页渲染
    let clientSrc = readFileSync(join(DIR, '..', 'client.js'), 'utf8')
    clientSrc = clientSrc.replace('const [data, setData] = React.useState(null)', 'const [data, setData] = React.useState(globalThis.__SEED__||null)')
    clientSrc = clientSrc.replace("const [nav, setNav] = React.useState('overview')", "const [nav, setNav] = React.useState(globalThis.__NAV__||'overview')")
    clientSrc = clientSrc.replace("const [sel, setSel] = React.useState(null)", "const [sel, setSel] = React.useState(globalThis.__SEL__||null)")
    globalThis.__SEED__ = seed
    try { Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true }) } catch (e) {}
    globalThis.window = { __ModuleLoader__: { load: (r) => { globalThis.__reg = r } }, location: { origin: 'http://127.0.0.1:1' }, addEventListener: () => {}, confirm: () => true }
    globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })
    globalThis.setInterval = () => 0; globalThis.clearInterval = () => {}; globalThis.setTimeout = () => 0; globalThis.clearTimeout = () => {}
    globalThis.localStorage = { getItem: () => null, setItem: () => {} }
    globalThis.__reg = null
    // 静音渲染期的 console.error（组件内的 Safe 错误捕获会刷屏，干扰结果判读）
    const origErr = console.error
    console.error = () => {}
    try {
      new Function('require', 'module', clientSrc)((p) => { if (p === 'react') return React; throw new Error('unknown ' + p) }, { exports: {} })
      if (!globalThis.__reg || typeof globalThis.__reg.factory !== 'function') {
        bad('未捕获到模块注册（window.__ModuleLoader__.load 未被调用）')
        throw new Error('skip')
      }
      const mod = globalThis.__reg.factory((p) => { if (p === 'react') return React; throw new Error('unknown ' + p) })
      if (!mod || typeof mod.apply !== 'function') { bad('模块未返回 apply()'); throw new Error('skip') }
      // 收集 slots.register 注册的组件
      const regs = {}
      const fakeCtx = {
        slots: {
          register: (opts, fn) => { const key = (opts && (opts.key || opts.id || opts.name)) || 'main'; regs[key] = fn; return () => {} },
          inject: (name, fn) => { try { fn() } catch (e) {} },
        },
        layout: {}, get: () => null, webServer: { register: () => () => {} },
      }
      try { mod.apply(fakeCtx) } catch (e) { bad('模块 apply() 抛错：' + String(e.message || e).slice(0, 150)) }
      const root = regs['ai-recruiting'] || regs.main || Object.values(regs)[0]
      if (!root) { bad('未拿到组件注册（无法渲染）') }
      else {
        // 逐页渲染：任何未定义变量都会在这里抛出
        const pages = [['概览', 'overview'], ['候选人流程-看板', 'process'], ['候选人流程-列表', 'process'], ['人才库', 'talent'], ['AI 能力', 'ai'], ['简历管理', 'intake'], ['工作日志', 'log']]
        for (const [label, nav] of pages) {
          globalThis.__NAV__ = nav
          globalThis.__SEL__ = nav === 'process' ? 'C3' : null
          try {
            const html = renderToString(React.createElement(root, { ctx: { slots: { register: () => () => {}, inject: () => {} }, layout: {}, get: () => null } }))
            if (!html || html.length < 100) bad(label + ' 渲染结果异常（' + (html || '').length + ' 字符）')
            else good(label + ' 渲染通过（' + html.length + ' 字符）')
          } catch (e) {
            bad(label + ' 渲染抛错：' + String(e.message || e).slice(0, 200))
          }
        }
      }
    } catch (e) {
      bad('client.js 加载失败：' + String(e.message || e).slice(0, 200))
    } finally {
      console.error = origErr
    }
  }
}

console.log('')
if (fail) { console.log('❌ 内嵌代码校验失败：' + fail + ' 项'); process.exit(1) }
console.log('✅ 内嵌代码校验通过')
