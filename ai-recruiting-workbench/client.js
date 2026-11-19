// 全局错误陷阱：任何渲染崩溃不再白屏，直接把错误显示在屏幕上（原生 DOM，React 死了也能显示）
;(function () {
  if (window.__REC_ERR_TRAP__) return
  window.__REC_ERR_TRAP__ = true
  const CLIENT_BUILD = 'v20261118-3'
  // 良性浏览器警告/错误白名单（含 ResizeObserver 循环噪音）——在 show 入口统一拦截
  const BENIGN = ['ResizeObserver', 'Script error.', 'Non-Error promise rejection', 'The play() request was interrupted', 'WebSocket connection', 'Failed to load resource', 'Measurement of', 'Passive event listener']
  const isBenign = (msg) => { const m = String(msg == null ? '' : msg); return BENIGN.some(b => m.indexOf(b) >= 0) }
      const show = (msg, stack) => {
    if (isBenign(msg)) return   // 最上游拦截：良性噪音永不显示
    try {
      let el = document.getElementById('__rec_err_trap__')
      if (!el) { el = document.createElement('div'); el.id = '__rec_err_trap__'; el.setAttribute('style', 'position:fixed;inset:auto 12px 12px 12px;z-index:99999;background:#d64545;color:#fff;padding:10px 14px;border-radius:10px;font:11px/1.5 ui-monospace,monospace;max-height:60vh;overflow:auto;box-shadow:0 6px 24px rgba(0,0,0,.25);white-space:pre-wrap'); document.body && document.body.appendChild(el) }
      let st = ''
      try {
        const lines = String(stack || '').split('\n').filter(l => l.indexOf('<anonymous>') >= 0 || l.indexOf('client.js') >= 0).slice(0, 4)
        st = lines.map(l => '  at ' + l.trim().replace(/^at /, '')).join('\n')
      } catch (_) {}
      el.textContent = '【招聘工作台 ' + CLIENT_BUILD + '】' + msg + (st ? '\n' + st : '')
      // 自动消失：错误横幅不该永久挂着（15s 后可点关闭，30s 自动淡出）
      if (!el.__autoDismiss) {
        el.__autoDismiss = true
        el.style.cursor = 'pointer'
        el.title = '点击关闭'
        el.addEventListener('click', () => { try { el.remove() } catch (_) {} })
        setTimeout(() => { try { if (el && el.parentNode) el.remove() } catch (_) {} }, 30000)
      }
    } catch (e) { console.error(msg) }
  }
  window.addEventListener('error', e => { const m = (e && e.message) || (e && e.error && e.error.message) || ''; if (isBenign(m)) return; if (e && (e.message || e.error)) show('运行错误：' + m, e.error && e.error.stack) })
  window.addEventListener('unhandledrejection', e => { const r = e && e.reason; const m = (r && r.message) || r; if (isBenign(m)) return; if (r) show('Promise: ' + m, r && r.stack) })
  const origCe = console.error.bind(console)
  console.error = function () {
    try {
      const args = Array.prototype.slice.call(arguments)
      const err = args.find(a => a instanceof Error)
      const msg = args.map(a => (a instanceof Error) ? a.message : (typeof a === 'string' ? a : JSON.stringify(a).slice(0, 200))).join(' | ')
      if (msg.indexOf('Warning') < 0 && !isBenign(msg)) show('console.error: ' + msg.slice(0, 600), err && err.stack)
    } catch (e) {}
    origCe.apply(null, arguments)
  }
})()

window.__ModuleLoader__.load({
  id: '@local/ai-recruiting-workbench',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const API = '/api/ai-recruiting/workbench'
    const ACTION = '/api/ai-recruiting/action'
    const UPLOAD = '/api/ai-recruiting/upload'
    const AUTO = '/api/ai-recruiting/auto-assess'
    const BOARD = '/api/ai-recruiting/board'
    // 来源渠道：与 ledger.SOURCES 同一口径（规范渠道 + 自定义选项）
    const SRC = ['BOSS直聘', '猎聘', '智联招聘', '内推', '猎头', '自搜', '其他']
    const STAGES = ['待评估', '待初试', '初试中', '待复试', '复试中', '待背调', '待发 Offer', 'Offer已发', 'Offer已接受', '待入职', '已入职', 'Offer拒绝', '已淘汰', '人才库']
    const REASONS = ['技能被低估', '证据不足', '岗位特殊要求', '模型误判', '其他']

    const C = {
      surface: 'var(--dsw-alias-surface-1, rgba(127,143,170,.06))',
      card: 'var(--dsw-alias-surface-2, rgba(127,143,170,.10))',
      border: 'var(--dsh-border-subtle, rgba(127,143,170,.26))',
      muted: 'var(--dsh-text-secondary, rgba(127,143,170,.95))',
      accent: 'var(--dsh-accent, #2f6bff)',
      good: '#12a06a', warn: '#d98a0b', bad: '#d64545', flat: '#8894aa',
      text: 'var(--dsh-text-primary, inherit)', info: '#3b82f6', purple: '#7c3aed', onAccent: 'var(--dsh-text-on-accent, #fff)',
    }
    const tint = (hex, a) => { const m = String(hex).match(/^#([0-9a-fA-F]{6})$/); if (!m) return hex; const n = parseInt(m[1], 16); return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')' }
    const card = { background: C.card, border: '1px solid ' + C.border, borderRadius: 12, padding: '11px 13px', minWidth: 0, boxShadow: '0 1px 3px rgba(0,0,0,.14)' }
    const clk = (fn) => ({ onClick: fn, role: 'button', tabIndex: 0, onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(e) } }, className: 'rec-row' })
    // ===== AI 数据分析 Bot（悬浮、点击才分析、带缓存、可对话追问）=====
    function AIDataBot({ data, dark }) {
      const [open, setOpen] = React.useState(false)
      const [msgs, setMsgs] = React.useState([])      // {role:'ai'|'me', ...}
      const [loading, setLoading] = React.useState(false)
      const [input, setInput] = React.useState('')
      const cacheRef = React.useRef({ key: '', payload: null })
      const gen = (data.dashboard || {}).generatedAt || ''
      const DIMM = { '管理者': C.purple, '招聘执行': C.accent, 'AI能力': C.info, '流程效率': C.accent, '渠道策略': C.info, '岗位组合': C.purple, '人才质量': C.good, '数据治理': C.warn }
      // 首次打开：跑一次分析（同数据缓存，不重复烧 token）
      const runAnalyze = async (force) => {
        if (!force && cacheRef.current.key === gen && cacheRef.current.payload) { setMsgs([{ role: 'ai', insights: cacheRef.current.payload }]); return }
        setLoading(true); setMsgs([{ role: 'ai', loading: true }])
        try {
          const j = await api('/api/ai-recruiting/insights')
          if (j && j.ok && Array.isArray(j.insights) && j.insights.length) {
            cacheRef.current = { key: gen, payload: j.insights }
            setMsgs([{ role: 'ai', insights: j.insights }])
          } else setMsgs([{ role: 'ai', text: '暂时无法生成洞察（数据不足或分析失败），可稍后重试。' }])
        } catch (e) { setMsgs([{ role: 'ai', text: '分析失败：' + String(e.message || e) }]) }
        finally { setLoading(false) }
      }
      const openPanel = () => { setOpen(true); if (!msgs.length) runAnalyze(false) }
      // 追问：带上历史 + 问题，让 AI 针对数据回答
      const ask = async () => {
        const q = input.trim(); if (!q || loading) return
        setInput(''); setMsgs(m => [...m, { role: 'me', text: q }]); setLoading(true)
        try {
          const j = await api('/api/ai-recruiting/insights', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q }) })
          const ans = j && j.ok ? (j.answer || (j.insights ? j.insights : null)) : null
          setMsgs(m => [...m, { role: 'ai', text: typeof ans === 'string' ? ans : (j && j.answer) || (j && j.error) || '（无回复）' }])
        } catch (e) { setMsgs(m => [...m, { role: 'ai', text: '失败：' + String(e.message || e) }]) }
        finally { setLoading(false) }
      }
      const bubble = (it, i) => h('div', { key: i, style: { padding: '9px 12px', background: dark ? 'rgba(255,255,255,.04)' : 'rgba(127,143,170,.08)', borderRadius: 9, borderLeft: '3px solid ' + (DIMM[it.dim] || C.accent), marginBottom: 8 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 4 } },
          h('span', { style: { fontSize: 10, padding: '0 6px', borderRadius: 5, background: tint(DIMM[it.dim] || C.accent, .14), color: DIMM[it.dim] || C.accent, fontWeight: 600 } }, it.dim || '洞察'),
          it.impact ? h('span', { style: { fontSize: 9.5, color: C.muted } }, '影响' + it.impact) : null,
          it.confidence ? h('span', { style: { fontSize: 9.5, color: C.muted } }, '· 信心' + it.confidence) : null),
        h('div', { style: { fontSize: 12.5, fontWeight: 600, lineHeight: 1.5 } }, it.headline || ''),
        it.reasoning ? h('div', { style: { fontSize: 11, color: C.muted, marginTop: 3, lineHeight: 1.55 } }, it.reasoning) : null,
        it.action ? h('div', { style: { fontSize: 11.5, color: C.accent, marginTop: 3 } }, '→ ' + it.action) : null)
      const BG = dark ? '#161c2a' : '#fff'
      return h('div', null,
        // 悬浮按钮
        h('button', { type: 'button', onClick: open ? () => setOpen(false) : openPanel, title: 'AI 招聘分析助手',
          style: { position: 'fixed', right: 20, bottom: 20, zIndex: 9990, width: 44, height: 44, borderRadius: 15, border: 'none', cursor: 'pointer',
            background: 'linear-gradient(135deg,#5b8cff,#8b5cf6)', color: '#fff', fontSize: 19, boxShadow: '0 4px 16px rgba(91,140,255,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'transform .15s', animation: 'recBotFloat 3s ease-in-out infinite' },
          onMouseEnter: e => { e.currentTarget.style.transform = 'scale(1.08) translateY(-2px)' }, onMouseLeave: e => { e.currentTarget.style.transform = '' } }, open ? '✕' : '✦'),
        open ? h('div', { style: { position: 'fixed', right: 22, bottom: 84, zIndex: 9991, width: 400, maxWidth: '92vw', height: 540, maxHeight: '78vh', background: BG, border: '1px solid ' + C.border, borderRadius: 14, boxShadow: '0 16px 50px rgba(0,0,0,.4)', display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: '1px solid ' + C.border, background: 'linear-gradient(120deg,rgba(79,124,255,.10),rgba(124,58,237,.08))' } },
            h('span', { style: { fontSize: 16 } }, '✦'), h('b', { style: { fontSize: 13 } }, 'AI 招聘分析助手'),
            h('span', { style: { fontSize: 10, color: C.muted } }, '基于实时数据 · 可追问'),
            h('button', { type: 'button', style: { ...btn, marginLeft: 'auto', border: 'none', background: 'transparent', fontSize: 13, padding: '2px 6px' }, title: '重新分析', onClick: () => runAnalyze(true) }, '↻')),
          h('div', { style: { flex: 1, overflowY: 'auto', padding: '12px 14px' } },
            ...msgs.map((m, i) => {
              if (m.role === 'me') return h('div', { key: i, style: { display: 'flex', justifyContent: 'flex-end', marginBottom: 8 } }, h('div', { style: { maxWidth: '80%', padding: '7px 11px', borderRadius: 10, background: C.accent, color: '#fff', fontSize: 12 } }, m.text))
              if (m.loading) return h('div', { key: i, style: { fontSize: 11.5, color: C.muted, padding: '8px 0' } }, '正在分析数据、推理洞察…')
              if (m.insights) return h('div', { key: i }, h('div', { style: { fontSize: 11, color: C.muted, marginBottom: 6 } }, '基于当前数据，我发现这些问题：'), ...m.insights.slice(0, 5).map(bubble))
              return h('div', { key: i, style: { fontSize: 12, color: C.text, lineHeight: 1.6, padding: '6px 0', whiteSpace: 'pre-wrap' } }, m.text)
            })),
          h('div', { style: { display: 'flex', gap: 6, padding: '10px 12px', borderTop: '1px solid ' + C.border } },
            h('input', { style: { flex: 1, border: '1px solid ' + C.border, background: 'transparent', color: 'inherit', borderRadius: 8, padding: '8px 10px', fontSize: 12, boxSizing: 'border-box' }, placeholder: '追问：比如"渠道我该怎么做"', value: input, onChange: e => setInput(e.target.value), onKeyDown: e => { if (e.key === 'Enter') ask() } }),
            h('button', { type: 'button', style: { ...primary, padding: '8px 14px', fontSize: 12 }, disabled: loading, onClick: ask }, '发送')))
          : null)
    }

    // ===== AI 数据洞察：读全局数据 → 生成 HR 可执行建议（规则驱动，稳/快/可解释；LLM 可后续增强）=====
    // 每条洞察 = { level: 'warn'|'info'|'good', dim: '管理者'|'招聘执行'|'AI能力', title, action }
    function deriveInsights(dash, data) {
      const out = []
      const hiring = dash.hiring || []
      const sf = dash.sourceFunnel || []
      const gd = (dash.aiPerf || {}).gradeDist || {}
      const alerts = (data.alerts || [])
      const overdueN = (dash.overdue || []).length
      // ① 缺口无人跟：有缺口但在途为 0 → 断层风险（管理者/执行）
      const dry = hiring.filter(h => (h.gap || 0) > 0 && (h.inFlow || 0) === 0)
      if (dry.length) out.push({ level: 'warn', dim: '招聘执行', title: dry.map(h => h.title).join('、') + ' 有缺口但无人在途', action: '立即启动 sourcing，否则缺口将持续空置' })
      // ② 在途不足以覆盖缺口：在途 < 缺口 → 产能不足（管理者）
      const thin = hiring.filter(h => (h.gap || 0) > 0 && (h.inFlow || 0) > 0 && (h.inFlow || 0) < (h.gap || 0))
      if (thin.length) out.push({ level: 'info', dim: '管理者', title: thin.map(h => h.title + '(在途' + h.inFlow + '/缺' + h.gap + ')').join('、'), action: '在途不足以覆盖缺口，按当前转化率需扩大漏斗上游' })
      // ③ 超时/积压（执行）
      if (alerts.length || overdueN) {
        const items = alerts.slice(0, 3).map(a => a.name + '(' + a.days + '天)').join('、')
        out.push({ level: 'warn', dim: '招聘执行', title: '有 ' + (alerts.length + overdueN) + ' 人跟进超时' + (items ? '：' + items : ''), action: '今天优先跟进，避免候选人流失' })
      }
      // ④ 渠道异常：投了但 0 进面（执行/管理者）
      const badSrc = sf.filter(x => (x.total || 0) >= 2 && (x.interview || 0) === 0)
      if (badSrc.length) out.push({ level: 'info', dim: '招聘执行', title: badSrc.map(x => x.source + ' 投' + x.total + '人 0 进面').join('、'), action: '渠道质量存疑，核对简历匹配度或渠道定位' })
      // ⑤ AI 质量：C 占比过高 → 岗位门槛/简历池偏差（AI能力）
      const gTotal = (gd.S || 0) + (gd.A || 0) + (gd.B || 0) + (gd.C || 0)
      if (gTotal >= 5) {
        const cRate = Math.round((gd.C || 0) / gTotal * 100)
        if (cRate >= 60) out.push({ level: 'info', dim: 'AI能力', title: 'AI 初筛 C 档占 ' + cRate + '%（' + gd.C + '/' + gTotal + '）', action: '比例偏高，说明简历池与岗位门槛偏差大，建议复核评分卡或渠道' })
      }
      // ⑥ 无待办时的正反馈（执行）
      if (!out.length) out.push({ level: 'good', dim: '招聘执行', title: '当前无阻塞：无超时、缺口均有在途覆盖', action: '保持节奏即可；可提前储备人才库' })
      return out
    }

    // ===== 轻量 SVG 图表库（零依赖，数据大屏用）=====
    // 环形图：segments=[{label,value,color}]，中心显示总数
    function DonutChart({ segments, size, thickness, centerTop, centerSub }) {
      const S = size || 130, R = S / 2, r = R - (thickness || 16), cx = R, cy = R
      const total = segments.reduce((a, x) => a + (x.value || 0), 0) || 1
      let acc = 0
      const arcs = segments.filter(x => x.value > 0).map((seg, i) => {
        const frac = seg.value / total
        const a0 = acc * 2 * Math.PI - Math.PI / 2, a1 = (acc + frac) * 2 * Math.PI - Math.PI / 2
        acc += frac
        const x0 = cx + R * Math.cos(a0), y0 = cy + R * Math.sin(a0), x1 = cx + R * Math.cos(a1), y1 = cy + R * Math.sin(a1)
        const xi1 = cx + r * Math.cos(a1), yi1 = cy + r * Math.sin(a1), xi0 = cx + r * Math.cos(a0), yi0 = cy + r * Math.sin(a0)
        const large = frac > 0.5 ? 1 : 0
        return h('path', { key: 'a' + i, d: 'M' + x0 + ' ' + y0 + ' A' + R + ' ' + R + ' 0 ' + large + ' 1 ' + x1 + ' ' + y1 + ' L' + xi1 + ' ' + yi1 + ' A' + r + ' ' + r + ' 0 ' + large + ' 0 ' + xi0 + ' ' + yi0 + ' Z', fill: seg.color })
      })
      return h('svg', { width: S, height: S, viewBox: '0 0 ' + S + ' ' + S },
        h('g', null, ...arcs),
        centerTop != null ? h('text', { x: cx, y: cy - 1, textAnchor: 'middle', fill: C.text, fontSize: 20, fontWeight: 800 }, String(centerTop)) : null,
        centerSub ? h('text', { x: cx, y: cy + 15, textAnchor: 'middle', fill: C.muted, fontSize: 10.5 }, centerSub) : null)
    }
    // 迷你折线（sparkline）：values=[数]
    function Sparkline({ values, width, height, color }) {
      const W = width || 160, H = height || 36, pad = 2
      const vs = (values || []).map(v => Number(v) || 0)
      if (!vs.length) return h('div', { style: { height: H } })
      const max = Math.max(...vs, 1), min = Math.min(...vs, 0)
      const span = (max - min) || 1
      const step = (W - pad * 2) / Math.max(1, vs.length - 1)
      const pts = vs.map((v, i) => [pad + i * step, H - pad - ((v - min) / span) * (H - pad * 2)])
      const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ')
      const area = d + ' L' + pts[pts.length - 1][0].toFixed(1) + ' ' + (H - pad) + ' L' + pts[0][0].toFixed(1) + ' ' + (H - pad) + ' Z'
      const gid = 'sg' + (color || '').replace(/[^a-z0-9]/gi, '') + W
      return h('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, style: { display: 'block' } },
        h('defs', null, h('linearGradient', { id: gid, x1: '0', y1: '0', x2: '0', y2: '1' },
          h('stop', { offset: '0%', stopColor: color || C.accent, stopOpacity: .35 }), h('stop', { offset: '100%', stopColor: color || C.accent, stopOpacity: 0 }))),
        h('path', { d: area, fill: 'url(#' + gid + ')' }),
        h('path', { d: d, fill: 'none', stroke: color || C.accent, strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }
    // 水平条形图：items=[{label,value,color}]，按最大值比例
    function BarList({ items, max, barH, labelW }) {
      const mx = max || Math.max(...items.map(x => x.value || 0), 1)
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        ...items.map((it, i) => h('div', { key: i, style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5 } },
          h('span', { style: { width: labelW || 76, flex: 'none', color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, it.label),
          h('div', { style: { flex: 1, height: barH || 14, background: 'rgba(127,143,170,.10)', borderRadius: 4, overflow: 'hidden' } },
            h('div', { style: { width: Math.max(2, (it.value || 0) / mx * 100) + '%', height: '100%', background: it.color || C.accent, borderRadius: 4, transition: 'width .3s' } })),
          h('span', { style: { width: 34, flex: 'none', textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' } }, String(it.value || 0)))))
    }
    // 渐变漏斗：stages=[{label,value}]，逐级收窄 + 转化率
    function FunnelViz({ stages, width }) {
      const W = width || 999, n = stages.length, gap = 6, bh = 34, step = (W - gap * (n - 1)) / n
      const mx = Math.max(...stages.map(s => s.value || 0), 1)
      return h('div', { style: { display: 'flex', alignItems: 'stretch' } },
        ...stages.map((st, i) => {
          const conv = i > 0 && stages[i - 1].value > 0 ? Math.round((st.value / stages[i - 1].value) * 100) + '%' : null
          const hue = ['#4f7cff', '#22d3ee', '#34d399', '#a78bfa', '#f0ad4e', '#f472b6'][i % 6]
          return h('div', { key: i, style: { display: 'flex', alignItems: 'center', flex: 1, minWidth: 0, opacity: (st.value||0) > 0 ? 1 : .45 } },
            h('div', { style: { flex: 1, background: 'linear-gradient(180deg,' + tint(hue, .16) + ',' + tint(hue, .04) + ')', border: '1px solid ' + tint(hue, .3), borderTop: '3px solid ' + hue, borderRadius: 10, padding: '9px 6px', textAlign: 'center', minWidth: 0 } },
              h('div', { style: { fontSize: 10, color: C.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, st.label),
              h('div', { style: { fontSize: 21, fontWeight: 800, marginTop: 3 } }, String(st.value || 0))),
            i < n - 1 ? h('div', { style: { width: 40, flex: 'none', textAlign: 'center', fontSize: 10, fontWeight: 700, color: conv ? C.accent : C.muted } }, conv ? conv : '') : null)
        }))
    }

    function EmptyState({ icon, title, hint, action }) {
      return h('div', { style: { padding: '32px 20px', textAlign: 'center' } },
        icon ? h('div', { style: { fontSize: 28, opacity: .5, marginBottom: 8 } }, icon) : null,
        title ? h('div', { style: { fontSize: 12.5, fontWeight: 600, marginBottom: 4 } }, title) : null,
        hint ? h('div', { style: { fontSize: 11.5, color: C.muted, lineHeight: 1.6 } }, hint) : null,
        action ? h('div', { style: { marginTop: 12 } }, action) : null)
    }
    function Loading({ text }) {
      return h('div', { style: { padding: '28px 0', textAlign: 'center', fontSize: 11.5, color: C.muted } },
        h('span', { style: { display: 'inline-block', width: 14, height: 14, border: '2px solid ' + C.border, borderTopColor: C.accent, borderRadius: '50%', animation: 'recSpin .7s linear infinite', verticalAlign: 'middle', marginRight: 8 } }),
        text || '加载中…')
    }
    // 弹层动画（注入一次）
    if (typeof document !== 'undefined' && document.head && !window.__REC_KF__) { window.__REC_KF__ = 1; const st = document.createElement('style'); st.textContent = '@keyframes recPop{from{opacity:0;transform:translateY(10px) scale(.97)}to{opacity:1;transform:none}}@keyframes recFade{from{opacity:0}to{opacity:1}}' + 'input[type=datetime-local]::-webkit-calendar-picker-indicator,input[type=date]::-webkit-calendar-picker-indicator{filter:invert(.75);cursor:pointer;opacity:.85}input:focus,select:focus,textarea:focus{border-color:var(--dsh-accent,#2f6bff)!important;box-shadow:0 0 0 2px rgba(47,107,255,.18)}' + '@keyframes recSpin{to{transform:rotate(360deg)}}@keyframes recBotFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}.rec-btn:hover{filter:brightness(1.08)}.rec-btn:active{transform:translateY(1px)}.rec-btn:disabled{opacity:.45;cursor:not-allowed;filter:none}.rec-row{transition:background .12s}.rec-row:hover{background:var(--dsw-alias-surface-2,rgba(127,143,170,.10))}@media(max-width:820px){.rec-2col{grid-template-columns:1fr!important}.rec-2col>*{min-width:0!important}.rec-detail-drawer{width:100%!important}}'; document.head.appendChild(st) }
    const sec = { margin: '0 0 8px', fontSize: 12.5, fontWeight: 700, opacity: .92 }
    const btn = { border: '1px solid ' + C.border, background: 'rgba(127,143,170,.08)', color: 'inherit', borderRadius: 8, padding: '5px 12px', fontSize: 11.5, cursor: 'pointer', transition: 'background .15s, border-color .15s' }
    const primary = { ...btn, background: 'var(--dsh-accent, #2f6bff)', borderColor: 'transparent', color: '#fff', fontWeight: 600, boxShadow: '0 2px 10px rgba(47,107,255,.35)' }
    const danger = { ...btn, borderColor: C.bad, color: C.bad }
    const input = { width: '100%', border: '1px solid ' + C.border, background: 'rgba(127,143,170,.10)', color: 'inherit', borderRadius: 8, padding: '7px 10px', fontSize: 12.5, boxSizing: 'border-box', outline: 'none' }

    const token = (color) => ({ fontSize: 11.5, padding: '1px 7px', borderRadius: 10, background: C.surface, border: '1px solid ' + C.border, color })
    // 「待你判断」统一口径：所有需要人工决策的收件箱类别（概览待办 / 侧栏角标 / 流程页共用）
    const HUMAN_KINDS = ['待发 Offer', '待决策', '需拍板·推荐', '建议淘汰·待确认', '需面试排雷', '低置信待复核', '疑似投错岗位', '待分配岗位', '待补录']
    const GRADE_HUE = { S: '#7c3aed', A: '#12a06a', B: '#d98a0b', C: '#d64545' }
    // 环形评分（纯 SVG，无外部库）
    function ScoreRing({ grade, score, size }) {
      size = size || 64
      const hue = GRADE_HUE[grade] || C.muted
      const pct = Math.max(0, Math.min(100, score == null ? 0 : score))
      const r = size / 2 - 5, cx = size / 2, cy = size / 2, circ = 2 * Math.PI * r
      const dash = circ * pct / 100
      return h('svg', { width: size, height: size, viewBox: '0 0 ' + size + ' ' + size, style: { flex: 'none' } },
        h('circle', { cx, cy, r, fill: 'none', stroke: C.border, strokeWidth: 5 }),
        h('circle', { cx, cy, r, fill: 'none', stroke: hue, strokeWidth: 5, strokeLinecap: 'round',
          strokeDasharray: dash + ' ' + (circ - dash), transform: 'rotate(-90 ' + cx + ' ' + cy + ')' }),
        h('text', { x: cx, y: cy - 1, textAnchor: 'middle', fontSize: 17, fontWeight: 800, fill: hue }, (grade || '?')),
        h('text', { x: cx, y: cy + 13, textAnchor: 'middle', fontSize: 10.5, fill: C.muted }, (score == null ? '未评' : score + '分')))
    }

    function Delta({ k }) {
      if (!k || k.deltaLabel == null) return null
      const color = k.trend === 'up' ? C.good : (k.trend === 'down' ? C.warn : C.flat)
      return h('span', { style: { color, fontSize: 11.5, fontWeight: 600, marginLeft: 4 } },
        (k.trend === 'up' ? '▲' : (k.trend === 'down' ? '▼' : '·')) + (k.deltaLabel || ''))
    }

    function BarRow({ name, count, delta, max, color }) {
      const w = max > 0 ? Math.max(3, Math.round(count / max * 100)) : 0
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 11.5 } },
        h('span', { style: { width: 76, flex: 'none', color: C.muted } }, name),
        h('span', { style: { flex: 1, height: 8, background: C.surface, borderRadius: 5, overflow: 'hidden' } },
          h('span', { style: { display: 'block', width: w + '%', height: '100%', background: color || C.accent, borderRadius: 5 } })),
        h('span', { style: { width: 30, textAlign: 'right', fontWeight: 700 } }, String(count)),
        h(Delta, { k: delta }))
    }

    async function api(url, opt) {
      const r = await fetch(url, opt)
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status))
      return j
    }
    const postAction = (body) => api(ACTION, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

    function useWorkbench(sel, period) {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const load = () => {
        setBusy(true)
        const qp = period && period !== 'all' ? '&period=' + encodeURIComponent(period) : ''
        const q = (sel ? '?candidateId=' + encodeURIComponent(sel) : '?') + qp
        api(API + q).then(j => { setData(j); setError('') }).catch(e => setError(String(e.message || e))).finally(() => setBusy(false))
      }
      React.useEffect(() => { load(); const id = setInterval(load, 25000); return () => clearInterval(id) }, [sel, period])
      return { data, error, busy, reload: load }
    }

    // 安全包裹：DSH 客户端 React 只保证 createElement/useState/useEffect，
    // 没有 class 组件与 useCallback/useRef。这里用函数 + try/catch 兜底，
    // 任何子组件抛错都显示错误文本，绝不让整个前端白屏。
    function Safe({ render }) {
      try {
        return render()
      } catch (e) {
        try { console.error('[ai-recruiting] render error', e) } catch (_) {}
        return h('div', { style: { padding: 24, fontSize: 13, color: '#d64545' } },
          h('b', null, '工作台渲染出错'),
          h('div', { style: { marginTop: 8, fontSize: 11.5, whiteSpace: 'pre-wrap', color: '#888' } },
            String((e && (e.stack || e.message)) || e)))
      }
    }

    function PanelIcon({ size, active }) {
      const s = size || 20, stroke = active ? C.accent : 'currentColor'
      return h('svg', { width: s, height: s, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, style: { display: 'block', opacity: active ? 1 : .72 } },
        h('circle', { cx: 9, cy: 8, r: 3.2, stroke, strokeWidth: 1.7 }),
        h('path', { d: 'M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5', stroke, strokeWidth: 1.7, strokeLinecap: 'round' }),
        h('path', { d: 'M16 7l1.6 1.6L21 5.2', stroke, strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    /* ============ 顶部：工具条 ============ */
    /* ============ 阶段漏斗（可点筛选，ATS 习惯） ============ */
    function Funnel({ counts, stage, setStage }) {
      // 只显示有人的阶段（去掉一片 0 的噪音）；无筛选时显示"全部"
      const visible = STAGES.filter(s => s !== '人才库' && (counts[s] || 0) > 0)
      const total = visible.reduce((a, s) => a + (counts[s] || 0), 0)
      const chip = (key, label, n, active, onClick) => h('button', {
        key, type: 'button', onClick,
        style: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 9, fontSize: 12.5, cursor: 'pointer',
          border: '1px solid ' + (active ? C.accent : C.border), background: active ? C.accent : 'transparent',
          color: active ? '#fff' : C.text, fontWeight: active ? 700 : 500 },
      }, label, h('span', { style: { fontSize: 12, fontWeight: 800, color: active ? '#fff' : (n ? C.text : C.muted), fontVariantNumeric: 'tabular-nums', opacity: active ? .9 : 1 } }, String(n)))
      return h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 } },
        chip('__all', '全部', total, !stage, () => setStage('')),
        ...visible.map(s => chip(s, s, counts[s] || 0, stage === s, () => setStage(stage === s ? '' : s))),
        !visible.length ? h('span', { style: { fontSize: 12, color: C.muted, padding: '5px 0' } }, '暂无候选人（去简历管理上传）') : null)
    }

    /* ============ 看板：阶段列 + 紧凑卡（每列最多 5 张，超出去列表看） ============ */
    function Kanban({ data, sel, setSel, onOpen, onMore, onAdopt }) {
      const cands = data.candidates || []
      // 看板按招聘环节分组（7 组，列内按子阶段分组）
      const GROUPS = [
        { key: '待评估', label: '待评估', stages: ['待评估'], hue: C.flat },
        { key: '初试', label: '初试', stages: ['待初试', '初试中'], hue: C.accent },
        { key: '复试', label: '复试', stages: ['待复试', '复试中'], hue: C.warn },
        { key: '待背调', label: '背调', stages: ['待背调'], hue: C.info },
        { key: '待发Offer', label: '待发 Offer', stages: ['待发 Offer'], hue: C.good },
        { key: 'Offer入职', label: 'Offer / 入职', stages: ['Offer已发', 'Offer已接受', '待入职'], hue: C.purple },
        { key: '已入职', label: '已入职', stages: ['已入职'], hue: C.good },
      ]
      const cardEl = (c) => h('div', {
        key: c.id, ...clk(() => setSel(c.id)),
        style: { background: C.surface, border: '1px solid ' + (c.id === sel ? C.accent : C.border), borderRadius: 8, padding: '7px 9px', cursor: 'pointer' },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 5 } },
          h('b', { style: { fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 } }, c.name || c.id),
          c.score != null ? h('span', { style: { fontSize: 13, fontWeight: 800, color: c.score >= 75 ? C.good : c.score >= 60 ? C.warn : C.bad, fontVariantNumeric: 'tabular-nums' } }, c.score) : null),
        h('div', { style: { display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap', alignItems: 'center' } },
          c.grade ? h('span', { style: { fontSize: 10, padding: '1px 5px', borderRadius: 5, background: tint(C.accent,.10), color: C.accent, fontWeight: 600 } }, c.grade + ' 级') : null,
          c.lastInvite ? h('span', { style: { fontSize: 10, padding: '1px 5px', borderRadius: 5, background: tint(C.purple,.12), color: C.purple } }, '📨已邀约') : null,
          c.daysAgo != null && c.daysAgo > 3 ? h('span', { style: { fontSize: 10, color: C.bad } }, c.daysAgo + 'd') : null,
          c.stage === '待评估' ? h('button', { type: 'button', onClick: (e) => { e.stopPropagation(); onAdopt && onAdopt(c.id) }, style: { fontSize: 10, padding: '1px 7px', borderRadius: 5, border: '1px solid ' + C.good, color: C.good, background: 'transparent', cursor: 'pointer', marginLeft: 'auto', fontWeight: 600 } }, '✓ 采纳') : null))
      return h('div', { style: { display: 'flex', gap: 9, overflowX: 'auto', paddingBottom: 10, alignItems: 'flex-start' } },
        ...GROUPS.map(g => {
          const col = cands.filter(c => g.stages.indexOf(c.stage) >= 0)
          const colW = col.length ? 208 : 156
          return h('div', { key: g.key, style: { flex: '0 0 ' + colW + 'px', width: colW, background: C.card, borderRadius: 12, padding: 9, border: '1px solid ' + C.border, opacity: col.length ? 1 : .62, transition: 'width .2s' } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 5, marginBottom: 7, paddingBottom: 5, borderBottom: '2px solid ' + g.hue } },
              h('span', { style: { fontSize: 12.5, fontWeight: 700 } }, g.label),
              h('span', { style: { fontSize: 11, color: C.muted, marginLeft: 'auto', background: C.surface, borderRadius: 8, padding: '1px 6px', fontWeight: 600 } }, col.length)),
            g.stages.length === 1
              ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
                  col.length === 0 ? h('div', { style: { fontSize: 11, color: C.muted, textAlign: 'center', padding: '14px 0' } }, '空') : null,
                  ...col.slice(0, 6).map(cardEl),
                  col.length > 6 ? h('button', { type: 'button', onClick: () => onMore && onMore(g.stages[0]), style: { fontSize: 10.5, padding: '2px 0', borderRadius: 6, border: '1px dashed ' + C.border, color: C.muted, background: 'transparent', cursor: 'pointer' } }, '还有 ' + (col.length - 6) + ' 人 · 列表') : null)
              : h('div', null,
                  ...g.stages.map(st => {
                    const ss = col.filter(c => c.stage === st)
                    if (!ss.length) return null
                    return h('div', { key: st, style: { marginBottom: 6 } },
                      h('div', { style: { fontSize: 10.5, color: C.muted, marginBottom: 3, fontWeight: 600 } }, st + ' ' + ss.length),
                      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } }, ...ss.slice(0, 4).map(cardEl),
                        ss.length > 4 ? h('button', { type: 'button', key: 'm' + st, onClick: () => onMore && onMore(st), style: { fontSize: 10.5, padding: '1px 0', borderRadius: 6, border: '1px dashed ' + C.border, color: C.muted, background: 'transparent', cursor: 'pointer' } }, '还有 ' + (ss.length - 4) + ' 人') : null))
                  }).filter(Boolean),
                  col.length === 0 ? h('div', { style: { fontSize: 11, color: C.muted, textAlign: 'center', padding: '14px 0' } }, '空') : null))
        }))
    }

    /* ============ 候选人表格（千级可用：排序 / 筛选 / 多选批量） ============ */
    function CandidateList({ data, sel, setSel, stage, setStage, onAction }) {
      const all = data.candidates || []
      const [q, setQ] = React.useState('')
      const [sortKey, setSortKey] = React.useState('score')
      const [checked, setChecked] = React.useState({})
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState('')
      let rows = stage ? all.filter(c => c.stage === stage) : all
      if (q.trim()) {
        const k = q.trim().toLowerCase()
        rows = rows.filter(c => String(c.name || '').toLowerCase().indexOf(k) >= 0 || (c.skills || []).some(sk => sk.toLowerCase().indexOf(k) >= 0))
      }
      rows = rows.slice().sort((a, b) => {
        if (sortKey === 'score') return (b.score || 0) - (a.score || 0)
        if (sortKey === 'days') return (b.daysAgo || 0) - (a.daysAgo || 0)
        return 0
      })
      const ids = rows.map(c => c.id)
      const selCount = Object.keys(checked).filter(id => checked[id]).length
      const toggle = (id) => setChecked(o => ({ ...o, [id]: !o[id] }))
      const toggleAll = () => { const on = selCount < rows.length; const m = {}; if (on) for (const id of ids) m[id] = true; setChecked(m) }
      const picked = rows.filter(c => checked[c.id])
      const batch = async (fn) => {
        if (!picked.length) return
        setBusy(true); setMsg('')
        let ok = 0, fail = 0
        for (const c of picked) {
          try { await fn(c); ok++ } catch (e) { fail++ }
        }
        setChecked({}); setBusy(false)
        setMsg('批量完成：成功 ' + ok + (fail ? ' · 失败 ' + fail : ''))
        onAction && onAction()
      }
      const TH = ({ k, label, w }) => h('th', { style: { textAlign: 'left', fontSize: 11.5, color: C.muted, fontWeight: 600, padding: '5px 6px', cursor: k ? 'pointer' : 'default', width: w, whiteSpace: 'nowrap' }, onClick: k ? () => setSortKey(k) : undefined }, label + (k && sortKey === k ? ' ↓' : ''))
      const quick = (c) => {
        if (c.stage === '待初试') return [['flow:invite', '发邀约'], ['elim', '淘汰']]
        if (c.stage === '待复试') return [['flow:interview', '排复试'], ['elim', '淘汰']]
        if (c.stage === '待背调') return [['flow:backcheck', '录背调'], ['elim', '淘汰']]
        if (c.stage === '待发 Offer') return [['flow:offer', '发 Offer'], ['elim', '淘汰']]
        if (c.stage === 'Offer已发') return [['flow:accept', '已接受'], ['flow:decline', '被拒/放弃']]
        if (c.stage === 'Offer已接受') return [['flow:onboard', '安排入职']]
        if (c.stage === '待入职') return [['flow:hire', '确认入职']]
        if (c.stage === '已淘汰' || c.stage === '人才库') return [['activate', '激活']]
        return []
      }
      return h('div', { style: { ...card, padding: 0, overflow: 'hidden' } },
        // 工具条：搜索 + 排序说明 + 批量栏
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid ' + C.border, flexWrap: 'wrap' } },
          h('b', { style: { fontSize: 12.5 } }, '候选人 ' + rows.length),
          h('input', { style: { ...input, width: 150, padding: '4px 8px', fontSize: 11.5 }, value: q, placeholder: '姓名 / 技能搜索', onChange: e => setQ(e.target.value) }),
          selCount ? h('span', { style: { fontSize: 11.5, color: C.accent, fontWeight: 700 } }, '已选 ' + selCount + ' 人') : h('span', { style: { fontSize: 11.5, color: C.muted } }, '点表头可排序 · 勾选可批量'),
          selCount ? h('button', { type: 'button', style: { ...primary, padding: '2px 10px', fontSize: 11.5 }, disabled: busy, onClick: () => batch(c => api('/api/ai-recruiting/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'adopt', candidateId: c.id }) })) }, '批量进初试') : null,
          selCount ? h('button', { type: 'button', style: { ...danger, padding: '2px 10px', fontSize: 11.5 }, disabled: busy, onClick: () => batch(c => api('/api/ai-recruiting/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'eliminate', candidateId: c.id, reason: '批量淘汰' }) })) }, '批量淘汰') : null,
          selCount ? h('button', { type: 'button', style: { ...btn, padding: '2px 10px', fontSize: 11.5 }, disabled: busy, onClick: () => { setChecked({}); setMsg('') } }, '取消选择') : null,
          stage ? h('button', { type: 'button', style: { ...btn, padding: '2px 8px', fontSize: 11.5 }, onClick: () => setStage('') }, '× ' + stage) : null,
          msg ? h('span', { style: { fontSize: 11.5, color: C.muted } }, msg) : null),
        h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 11.5 } },
          h('thead', { style: { position: 'sticky', top: 0, background: 'var(--dsw-alias-surface-2, rgba(127,143,170,.10))', zIndex: 2 } },
            h('tr', null,
              h('th', { style: { width: 26, padding: '5px 4px' } }, h('input', { type: 'checkbox', checked: rows.length > 0 && selCount === rows.length, onChange: toggleAll, style: { cursor: 'pointer' } })),
              TH({ label: '姓名', w: 90 }),
              TH({ label: '阶段', w: 64 }),
              TH({ label: '评级', w: 48 }),
              TH({ k: 'score', label: '评分', w: 46 }),
              TH({ label: '已邀约', w: 90 }),
              TH({ k: 'days', label: '天龄', w: 40 }),
              TH({ label: '操作', w: 120 }))),
          h('tbody', null, ...rows.map(c => h('tr', { key: c.id, style: { borderBottom: '1px solid ' + C.border, background: c.id === sel ? 'var(--dsh-accent-soft, rgba(47,107,255,.08))' : 'transparent' } },
            h('td', { style: { padding: '4px 4px', width: 26 } }, h('input', { type: 'checkbox', checked: !!checked[c.id], onChange: () => toggle(c.id), style: { cursor: 'pointer' } })),
            h('td', { style: { padding: '4px 6px', cursor: 'pointer' }, onClick: () => setSel(c.id) }, h('b', { style: { fontSize: 11.5 } }, c.name || c.id), c.unlinked ? h('span', { style: { fontSize: 8.5, color: '#fff', background: C.bad, borderRadius: 6, padding: '0 4px', marginLeft: 4 } }, '未关联') : null),
            h('td', { style: { padding: '4px 6px', color: C.muted, fontSize: 11.5 } }, c.stage),
            h('td', { style: { padding: '4px 6px' } }, c.grade ? h('span', { style: { fontSize: 11.5, fontWeight: 700, color: GRADE_HUE[c.grade] || C.muted } }, c.grade) : h('span', { style: { color: C.muted } }, '—')),
            h('td', { style: { padding: '4px 6px', fontWeight: 700, color: c.score >= 75 ? C.good : c.score >= 60 ? C.warn : c.score != null ? C.bad : C.muted } }, c.score != null ? String(c.score) : '—'),
            h('td', { style: { padding: '4px 6px', fontSize: 11.5, color: c.lastInvite ? '#a78bfa' : C.muted } }, c.lastInvite ? (c.lastInvite.at ? fmtAt(c.lastInvite.at) : '待确认') : '—'),
            h('td', { style: { padding: '4px 6px', fontSize: 11.5, color: (c.daysAgo || 0) > 3 ? C.bad : C.muted } }, c.daysAgo != null ? c.daysAgo + 'd' : '—'),
            h('td', { style: { padding: '4px 6px' } }, h('div', { style: { display: 'flex', gap: 4 } },
              ...quick(c).map(([k, label]) => h('button', { key: k, type: 'button',
                onClick: async (e) => {
                  e.stopPropagation()
                  if (k === 'elim') {
                    try { await api('/api/ai-recruiting/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'eliminate', candidateId: c.id, reason: '列表快速淘汰' }) }); onAction && onAction() } catch (err) { setMsg('失败：' + String(err.message || err)) }
                    return
                  }
                  if (k === 'activate') { try { await api('/api/ai-recruiting/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'activate', candidateId: c.id, reason: '列表激活' }) }); onAction && onAction() } catch (err) { setMsg('失败：' + String(err.message || err)) } return }
                  setSel(c.id)
                },
                style: { fontSize: 10.5, padding: '1px 7px', borderRadius: 6, border: '1px solid ' + (k === 'elim' ? C.bad : C.accent), color: k === 'elim' ? C.bad : C.accent, background: 'transparent', cursor: 'pointer' } }, label)))))))),
        !rows.length ? h('div', { style: { padding: 24, textAlign: 'center', fontSize: 11.5, color: C.muted } }, all.length ? '该筛选下暂无候选人' : '还没有候选人，去「简历管理」批量上传解析') : null)
    }

    /* ============ 候选人文案块 ============ */
    function Block({ title, children, extra }) {
      // children 可能是 undefined / 单个元素 / 数组，统一归一化为数组再展开
      const kids = children == null ? [] : (Array.isArray(children) ? children : [children])
      return h('div', { style: { ...card, marginBottom: 9 } },
        title ? h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 7 } },
          h('div', { style: sec }, title), extra || null) : null,
        ...kids)
    }

    // ===== 简历结构化（统一解析：展示与AI共用同一份事实）=====
    // 产出结构：{ head, contact, sections:[{title, entries:[{time, title, org, body:[]}]}] }
    function structureResumeView(text) {
      const SEC_RE = /^\s*(教育经历|教育背景|工作经历|工作经验|相关技能|专业技能|技能清单|技能|项目经历|项目经验|实习经历|自我评价|个人优势|求职意向|附加信息)\s*[:：]?\s*$/
      const TIME_RE = /^\s*((?:19|20)\d{2}\s*[.\-/年]\s*\d{0,2}\s*月?\s*[-–~至到]\s*(?:(?:19|20)\d{2}\s*[.\-/年]?\s*\d{0,2}\s*月?|至今|今))\s*(.*)$/
      const lines = String(text || '').split(/\r?\n/)
      const head = []; const sections = []; let cur = null
      for (const raw of lines) {
        const ln = raw.replace(/\u3000/g, ' ').replace(/\s+$/, '')
        if (SEC_RE.test(ln)) { cur = { title: ln.trim().replace(/[:：]$/, ''), entries: [] }; sections.push(cur); continue }
        if (!cur) { head.push(ln); continue }
        // 时间开头 → 新条目；否则归入当前条目 body 或作为纯文本块
        const m = ln.match(TIME_RE)
        if (m && m[1]) {
          const rest = (m[2] || '').trim()
          // 拆「职位 公司」：通常空格分隔
          let job = '', org = ''
          if (/大学|学院|学校|中学/.test(rest)) { org = rest }
          else { const parts = rest.split(/\s{2,}|\s+/).filter(Boolean); job = parts[0] || ''; org = parts.slice(1).join(' ') }
          cur.entries.push({ time: m[1].replace(/\s+/g, ''), title: job, org, body: [] })
        } else if (cur.entries.length) {
          cur.entries[cur.entries.length - 1].body.push(ln)
        } else {
          // 分区内无时间条目的纯文本（如技能列表）
          if (!cur._plain) cur._plain = []
          cur._plain.push(ln)
        }
      }
      const allHead = head.join('\n')
      const contact = {
        phone: (allHead.match(/1[3-9]\d{9}/) || [])[0] || '',
        email: (allHead.match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [])[0] || '',
        wechat: (allHead.match(/微信[：:]\s*([\w-]+)/) || [])[1] || '',
        years: (allHead.match(/(\d+)\s*年(?:经验|工作)/) || [])[1] || '',
      }
      const nameLine = head.map(x => x.trim()).find(x => x && !/电话|邮箱|微信|求职|工作年限/.test(x)) || ''
      return { head, contact, name: nameLine, sections }
    }
    function ResumeView({ text, maxH }) {
      const raw = String(text || '')
      if (!raw.trim()) return h('div', { style: { fontSize: 11.5, color: C.muted, padding: '12px 0' } }, '(无文本，可能是扫描件)')
      const r = structureResumeView(raw)
      const ct = r.contact
      const chip = (t) => h('span', { key: t, style: { fontSize: 11.5, padding: '2px 9px', borderRadius: 8, background: C.surface, border: '1px solid ' + C.border, color: C.muted } }, t)
      const hasStruct = r.sections.length > 0
      // 合并被换行切断的句子：上一行未以句末标点/常见分隔结尾、且下一行非新条目开头 → 视作同一段
      const mergeWrapped = (arr) => {
        const res = []
        for (const raw of arr) {
          const t = raw.trim(); if (!t) continue
          const prev = res[res.length - 1]
          const prevEndsOpen = prev && !/[。；;：:!?！？、）)]$/.test(prev) && /[\u4e00-\u9fa5A-Za-z]$/.test(prev)
          const curStartsCont = /^[\u4e00-\u9fa5A-Za-z(（]/.test(t) && !/^(熟练|熟悉|掌握|精通|负责|主导|参与|具备|基于|使用|了解|有)/.test(t)
          if (prevEndsOpen && curStartsCont) { res[res.length - 1] = prev + t }
          else res.push(t)
        }
        return res
      }
      const renderBodyLines = (bodyArr) => mergeWrapped(bodyArr).map((ln, i) => {
        const t = ln.trim(); if (!t) return null
        return h('div', { key: i, style: { fontSize: 12, lineHeight: 1.9, color: C.muted, marginTop: 2, letterSpacing: '.1px' } }, t)
      }).filter(Boolean)
      return h('div', { style: { width: '100%', boxSizing: 'border-box', maxHeight: maxH || 460, overflow: 'auto', padding: '2px 2px 2px 0' } },
        // 头部：姓名 + 联系方式 chips
        r.name ? h('div', { style: { fontSize: 15, fontWeight: 700, marginBottom: 6 } }, r.name) : null,
        (ct.phone || ct.email || ct.wechat || ct.years) ? h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 } },
          ct.years ? chip('工作 ' + ct.years + ' 年') : null,
          ct.phone ? chip('📱 ' + ct.phone) : null,
          ct.email ? chip('✉ ' + ct.email) : null,
          ct.wechat ? chip('微信 ' + ct.wechat) : null) : null,
        hasStruct
          ? h('div', null, ...r.sections.map((sec, si) => h('div', { key: si, style: { marginBottom: 14 } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 } },
                h('span', { style: { fontSize: 12, fontWeight: 700, color: C.accent } }, sec.title),
                h('div', { style: { flex: 1, height: 1, background: C.border } })),
              // 条目：时间左、职位/单位，下面是原文叙述（不切碎）
              ...sec.entries.map((en, ei) => h('div', { key: ei, style: { marginBottom: 8, paddingLeft: 2 } },
                h('div', { style: { display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' } },
                  en.time ? h('span', { style: { fontSize: 11.5, color: C.accent, fontVariantNumeric: 'tabular-nums', flex: 'none', fontWeight: 600 } }, en.time) : null,
                  en.title ? h('b', { style: { fontSize: 12 } }, en.title) : null,
                  en.org ? h('span', { style: { fontSize: 11.5, color: C.text } }, en.org) : null),
                en.body.length ? h('div', { style: { marginTop: 3, paddingLeft: 2 } }, ...renderBodyLines(en.body)) : null)),
              // 无时间条目的纯文本分区（技能等）：原文整段保留
              sec._plain && sec._plain.length ? h('div', null, ...renderBodyLines(sec._plain)) : null)))
          : h('div', { style: { fontSize: 11.5, lineHeight: 1.85, whiteSpace: 'pre-wrap', color: C.muted } }, raw))
    }
    function DeepAssessView({ deep }) {
      if (!deep) return null
      const gradeColor = { S: C.good, A: C.good, B: C.warn, C: C.bad }[deep.grade] || C.flat
      const sec = (t) => h('div', { style: { fontWeight: 700, fontSize: 11.5, marginTop: 10, marginBottom: 4 } }, t)
      return h(Block, { title: '深度适配性诊断' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 22, fontWeight: 800, color: gradeColor } }, deep.grade + ' 级'),
          deep.score != null ? h('span', { style: { fontSize: 13 } }, '适配度 ' + deep.score + ' 分') : null,
          h('span', { style: { fontSize: 11.5, color: C.muted } }, deep.conclusion || '')),
        deep.stageFit ? h('div', { style: { fontSize: 11.5, color: C.muted, lineHeight: 1.6 } }, h('b', null, '场景对齐：'), deep.stageFit) : null,
        (deep.alignment || []).length ? h('div', null, sec('维度对齐'),
          ...deep.alignment.map((a, i) => {
            const vc = a.verdict === '匹配' ? C.good : a.verdict === '缺失' ? C.bad : C.warn
            return h('div', { key: i, style: { fontSize: 11.5, marginBottom: 3 } },
              h('span', { style: { fontWeight: 600 } }, a.dim), ' ',
              h('span', { style: { color: vc, fontSize: 11.5 } }, '[' + (a.verdict || '') + (a.score != null ? ' ' + a.score : '') + ']'),
              h('span', { style: { color: C.muted } }, ' ' + (a.candidate || '').slice(0, 60)))
          })) : null,
        (deep.strengths || []).length ? h('div', null, sec('核心优势证据链'),
          ...deep.strengths.map((s2, i) => h('div', { key: i, style: { fontSize: 11.5, marginBottom: 3, paddingLeft: 6, borderLeft: '2px solid ' + C.good } },
            h('b', null, s2.point), h('div', { style: { color: C.muted, fontSize: 11.5 } }, '依据：' + (s2.evidence || '').slice(0, 80))))) : null,
        (deep.redFlags || []).length ? h('div', null, sec('⚠ 风险与排雷（Red Flags）'),
          ...deep.redFlags.map((f2, i) => h('div', { key: i, style: { fontSize: 11.5, marginBottom: 3, paddingLeft: 6, borderLeft: '2px solid ' + C.bad } },
            h('b', { style: { color: C.bad } }, f2.type), '：', h('span', { style: { color: C.muted } }, f2.detail)))) : null,
        (deep.interviewQuestions || []).length ? h('div', null, sec('面试验证问题（刺穿包装）'),
          ...deep.interviewQuestions.map((q, i) => h('div', { key: i, style: { fontSize: 11.5, marginBottom: 3 } }, (i + 1) + '. ' + q))) : null)
    }

    function AssessmentView({ detail }) {
      const c = detail.candidate
      const dims = Object.keys(c.scores || {})
      if (!dims.length) return null
      // 评分卡维度要求（levels 描述）与权重，用于「按 JD 写理由」
      const scDims = (detail.position && detail.position.scorecard && detail.position.scorecard.softDims) || []
      const dimInfo = {}
      scDims.forEach(d => { dimInfo[d.name] = d })
      const gradeOf = (v) => v == null ? '' : v >= 84 ? '突出（规模化/强量化）' : v >= 68 ? '良好（有量化成果）' : v >= 50 ? '一般（有动作缺量化）' : '较弱（仅提及）'
      return h(Block, { title: 'AI 评估 · 逐维理由（JD 要求 → 简历证据 → 得分）' },
        ...dims.map(d => {
          const v = (c.scores || {})[d]
          const scored = v != null
          const info = dimInfo[d]
          const reqDesc = info ? ('权重 ' + info.weight + '%，' + ((info.levels && info.levels[0] && info.levels[0].desc) || '')) : ''
          const ev = (c.evidence || {})[d]
          const gc = !scored ? C.flat : v >= 68 ? C.good : v >= 50 ? C.warn : C.bad
          return h('div', { key: d, style: { marginBottom: 10, paddingBottom: 8, borderBottom: '1px dashed ' + C.border } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 } },
              h('b', { style: { fontSize: 12.5 } }, d),
              reqDesc ? h('span', { style: { fontSize: 10.5, color: C.muted } }, '（' + reqDesc + '）') : null,
              h('span', { style: { flex: 1 } }),
              h('b', { style: { fontSize: 13, color: gc } }, scored ? v + ' 分' : '未判定'),
              scored ? h('span', { style: { fontSize: 10.5, color: C.muted } }, gradeOf(v)) : null),
            h('div', { style: { fontSize: 11.5, background: C.surface, borderRadius: 6, padding: '5px 8px', color: C.muted } },
              scored ? ('简历依据：「' + (ev || '') + '」') : '简历未找到可引用证据 → 判未判定'))
        }))
    }

    function CalibrateForm({ candidateId, dims, alignment, aiGrade, onDone, onCancel }) {
      // 人改判 = 对 AI 判断做修正，必须记录「AI 原判 X → 人认为 Y」成对数据
      const LV = ['L0', 'L1', 'L2', 'L3']
      const aiLevelOf = (dim) => { const a = (alignment || []).find(x => x.dim === dim); return a ? a.level : '' }
      const [kind, setKind] = React.useState('档位改判')
      const [f, setF] = React.useState({ reasonCode: REASONS[0], dimension: dims[0] || '专业能力', toLevel: '', toDecision: '进初试', note: '' })
      const set = (k, v) => setF(o => ({ ...o, [k]: v }))
      const [err, setErr] = React.useState('')
      const submit = async () => {
        try {
          const payload = { action: 'override', candidateId, reasonCode: f.reasonCode, dimension: f.dimension, note: f.note, overrideKind: kind }
          if (kind === '档位改判') {
            const from = aiLevelOf(f.dimension)
            if (!from) { setErr('该维度没有 AI 判档，无法做档位改判（可改用结论改判）'); return }
            if (!f.toLevel) { setErr('请选择改成的档位'); return }
            if (f.toLevel === from) { setErr('改成与原判相同，不算改判'); return }
            payload.from = from; payload.to = f.toLevel
          } else if (kind === '结论改判') {
            payload.from = aiGrade ? (aiGrade + ' 级') : ''; payload.to = f.toDecision
          } else { // 硬门槛推翻
            payload.from = 'fail'; payload.to = 'pass'
          }
          const j = await postAction(payload)
          onDone(j)
        } catch (e) { setErr(String(e.message || e)) }
      }
      const aiLv = aiLevelOf(f.dimension)
      return h(Block, { title: '人改判 · 修正 AI 判断（写入校准池，驱动模型迭代）' },
        h('div', { style: { fontSize: 11.5, color: C.muted, marginBottom: 8, lineHeight: 1.6 } },
          '记录「AI 原判 → 你认为」，只有不一致才算改判。同一维度同类改判满 3 次会自动生成规范修订建议。'),
        h('div', { style: { display: 'flex', gap: 6, marginBottom: 8 } },
          ...['档位改判', '结论改判', '硬门槛推翻'].map(k => h('button', { key: k, type: 'button',
            onClick: () => setKind(k),
            style: { ...btn, padding: '4px 12px', fontSize: 11, background: kind === k ? C.accent : 'transparent', color: kind === k ? '#fff' : 'inherit', borderColor: kind === k ? C.accent : C.border } }, k))),
        // 原因码
        h('label', { style: { fontSize: 11.5, color: C.muted, display: 'block', marginBottom: 4 } }, '原因码',
          h('select', { style: { ...input, width: '100%' }, value: f.reasonCode, onChange: e => set('reasonCode', e.target.value) }, ...REASONS.map(x => h('option', { key: x, value: x }, x)))),
        kind === '档位改判' ? h('div', { style: { marginTop: 8 } },
          h('label', { style: { fontSize: 11.5, color: C.muted, display: 'block', marginBottom: 4 } }, '维度',
            h('select', { style: { ...input, width: '100%' }, value: f.dimension, onChange: e => set('dimension', e.target.value) }, ...(dims.length ? dims : ['专业能力']).map(x => h('option', { key: x, value: x }, x)))),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, fontSize: 12 } },
            h('span', { style: { color: C.muted, fontSize: 11.5 } }, 'AI 判：'),
            h('b', { style: { color: aiLv ? C.warn : C.muted } }, aiLv || '无档位'),
            h('span', { style: { color: C.accent, margin: '0 4px' } }, '→'),
            h('span', { style: { color: C.muted, fontSize: 11.5 } }, '你改为：'),
            h('select', { style: { ...input, width: 90 }, value: f.toLevel, onChange: e => set('toLevel', e.target.value) },
              h('option', { value: '' }, '— 选档 —'), ...LV.filter(x => x !== aiLv).map(x => h('option', { key: x, value: x }, x)))))
          : kind === '结论改判' ? h('div', { style: { marginTop: 8 } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, fontSize: 12 } },
              h('span', { style: { color: C.muted, fontSize: 11.5 } }, 'AI 结论：'), h('b', { style: { color: C.warn } }, aiGrade ? aiGrade + ' 级' : '—'),
              h('span', { style: { color: C.accent, margin: '0 4px' } }, '→'), h('span', { style: { color: C.muted, fontSize: 11.5 } }, '你改为：')),
            h('select', { style: { ...input, width: '100%' }, value: f.toDecision, onChange: e => set('toDecision', e.target.value) }, ...['进初试', '进复试', '淘汰', '人才库'].map(x => h('option', { key: x, value: x }, x))))
          : h('div', { style: { marginTop: 8, fontSize: 11.5, color: C.warn, padding: '6px 10px', background: tint(C.warn, .08), borderRadius: 7 } },
              'AI 判硬门槛「未通过」，你认定应「通过」（破格）。请在下方面写清依据。'),
        h('input', { style: { ...input, marginTop: 8, width: '100%', boxSizing: 'border-box' }, placeholder: kind === '硬门槛推翻' ? '破格依据（必填）' : '补充说明（可选）', value: f.note, onChange: e => set('note', e.target.value) }),
        err ? h('div', { style: { fontSize: 11.5, color: C.bad, marginTop: 5 } }, err) : null,
        h('div', { style: { display: 'flex', gap: 8, marginTop: 8 } },
          h('button', { type: 'button', style: primary, onClick: submit }, '提交改判'),
          h('button', { type: 'button', style: btn, onClick: onCancel }, '取消')))
    }

    function fmtTime(ts) {
      try { const d = new Date(ts); const p = (n) => String(n).padStart(2, '0'); return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) } catch (e) { return '' }
    }
    const ACTOR = { human: '人工', agent: 'AI', system: '系统' }
    function eventToHuman(e) {
      const p = e.payload || {}
      const who = ACTOR[e.actor] || e.actor || ''
      switch (e.type) {
        case 'resume.received': return { icon: '📥', color: C.accent, text: '简历接入' + (p.source ? '（' + p.source + '）' : '') + (p.name ? ' · ' + p.name : '') }
        case 'resume.backfilled': return { icon: '✎', color: C.warn, text: '补录简历文本' }
        case 'assessment.recorded': {
          if (p.deep) return { icon: '🔎', color: C.accent, text: 'AI 深度诊断：' + (p.deep.grade || '') + ' 级' + (p.deep.score != null ? ' · ' + p.deep.score + ' 分' : '') + (p.deep.conclusion ? ' · ' + p.deep.conclusion.slice(0, 40) : '') }
          return { icon: '📊', color: C.accent, text: 'AI 初筛：' + (p.route || '未评估') + (p.weighted != null ? ' · ' + p.weighted + ' 分' : '') }
        }
        case 'decision.made': return { icon: '⚖', color: C.good, text: '人工决定：' + (p.decision || '') + (p.reason ? '（' + p.reason.slice(0, 30) + '）' : '') + (p.from ? '　' + p.from + ' → ' + (p.to || '') : '') }
        case 'stage.advanced': return { icon: '→', color: C.muted, text: '进入「' + (p.to || '') + '」' + (p.reason ? ' · ' + p.reason : '') }
        case 'correction.made': return { icon: '🛠', color: C.warn, text: '纠偏：' + (p.dimension || '') + ' / ' + (p.reasonCode || '') }
        case 'invite.sent': return { icon: '✉', color: C.muted, text: '发送' + (p.round || '') + '邀约' + (p.channel ? '（' + p.channel + '）' : '') }
        case 'interview.scheduled': return { icon: '📅', color: C.muted, text: '安排' + (p.round || '') + '：' + (p.at || '') + (p.interviewer ? ' · 面试官 ' + p.interviewer : '') }
        case 'feedback.submitted': return { icon: '📝', color: p.pass === false ? C.bad : C.good, text: (p.round || '') + '面评：' + (p.pass === false ? '未通过' : '通过') + (p.score != null ? ' · ' + p.score + '分' : '') + ((p.dims && p.dims.length) ? ' · ' + p.dims.map(x => x.dim.slice(0, 4) + ':' + x.level).join(' ') : '') + (p.note ? ' · ' + p.note.slice(0, 24) : '') }
        case 'offer.sent': return { icon: '📄', color: C.good, text: '发 Offer 草案' + (p.salary ? ' · ' + p.salary : '') }
        case 'name.fixed': return { icon: '✎', color: C.muted, text: '更名：' + (p.from || '') + ' → ' + (p.name || '') }
        default: return { icon: '·', color: C.muted, text: e.type }
      }
    }
    function renderTimeline(chain, limit) {
      // 折叠连续重复的"AI初筛"（同一结论只留最后一次，标注重评次数）
      const items = []
      for (const e of chain) {
        const h2 = eventToHuman(e)
        const last = items[items.length - 1]
        if (last && last.e.type === e.type && e.type === 'assessment.recorded' && !((e.payload || {}).deep)) {
          last.repeat = (last.repeat || 1) + 1; last.e = e; last.h = h2
        } else {
          items.push({ e, h: h2, repeat: 1 })
        }
      }
      // 倒序展示（最近在上）
      const shown = limit ? items.slice(-limit) : items
      return shown.reverse().map((it, i) => h('div', { key: it.e.seq || i, style: { display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 11.5, padding: '4px 0', borderBottom: '1px solid ' + C.border } },
        h('span', { style: { width: 66, flex: 'none', color: C.muted, fontSize: 11.5 } }, fmtTime(it.e.ts)),
        h('span', { style: { flex: 'none' } }, it.h.icon),
        h('span', { style: { flex: 'none', fontSize: 11.5, color: C.muted, width: 26 } }, ACTOR[it.e.actor] || ''),
        h('span', { style: { color: it.h.color } }, it.h.text + (it.repeat > 1 ? '（重评 ' + it.repeat + ' 次）' : ''))))
    }

    // 流程动作表单：发邀约/排面试/录面评/Offer/入职
    // 时间显示格式化：datetime-local 值 → 「3月5日 14:00」
    function fmtAt(v) {
      const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
      if (!m) return v || ''
      return parseInt(m[2], 10) + '月' + parseInt(m[3], 10) + '日 ' + m[4] + ':' + m[5]
    }
    function fmtDate(v) {
      const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
      if (!m) return v || ''
      return parseInt(m[1], 10) + '年' + parseInt(m[2], 10) + '月' + parseInt(m[3], 10) + '日'
    }

    // 面试 Copilot：面试官的副驾——准备卡（验证清单/问题/红旗）+ 记录转写 + 面评草稿
    // 定位：人是面试官，AI 只给参考；草稿入库必经人确认
    function InterviewCopilot({ candidate, position, onCancel, onDone }) {
      const [prep, setPrep] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [err, setErr] = React.useState('')
      const [notes, setNotes] = React.useState('')
      const [draft, setDraft] = React.useState(null)
      const [drafting, setDrafting] = React.useState(false)
      const [recState, setRecState] = React.useState('idle')
      const [busy, setBusy] = React.useState(false)
      const load = async () => {
        setLoading(true); setErr('')
        try {
          const j = await api('/api/ai-recruiting/interview-prep', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ candidateId: candidate.id }) })
          if (j && j.ok) setPrep(j.prep)
          else setErr((j && j.reason) || '准备卡生成失败')
        } catch (e) { setErr('准备卡生成失败：' + String(e.message || e)) } finally { setLoading(false) }
      }
      React.useEffect(() => { load() }, [])
      const transcribe = async (file) => {
        try {
          const rd = new FileReader()
          rd.onload = async () => {
            try {
              const b64 = String(rd.result || '').split(',')[1] || ''
              const j = await api('/api/ai-recruiting/stt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: file.name, contentBase64: b64 }) })
              if (j && j.ok && j.text) setNotes(v => (v ? v + '\n' : '') + j.text)
              else setErr('转写失败：' + ((j && j.reason) || '未识别'))
            } catch (e) { setErr('转写失败：' + String(e.message || e)) }
          }
          rd.readAsDataURL(file)
        } catch (e) { setErr('读取失败：' + String(e.message || e)) }
      }
      const startRec = async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
          const chunkList = []
          const mr = new (window.MediaRecorder || window.webkitMediaRecorder)(stream)
          mr.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunkList.push(ev.data) }
          mr.onstop = async () => {
            setRecState('converting')
            try {
              stream.getTracks().forEach(t => t.stop())
              const blob = new Blob(chunkList, { type: 'audio/webm' })
              const ab = await blob.arrayBuffer()
              const AC = window.AudioContext || window.webkitAudioContext
              const ac = new AC()
              const audioBuf = await ac.decodeAudioData(ab)
              const wav = audioBufferToWav(audioBuf)
              const b64 = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(String(fr.result || '').split(',')[1] || ''); fr.readAsDataURL(wav) })
              const j = await api('/api/ai-recruiting/stt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: 'notes.wav', contentBase64: b64 }) })
              if (j && j.ok && j.text) setNotes(v => (v ? v + '\n' : '') + j.text)
              else setErr('转写失败：' + ((j && j.reason) || '未识别'))
            } catch (e) { setErr('录音处理失败：' + String(e.message || e)) } finally { setRecState('idle') }
          }
          window.__recMR2 = mr
          mr.start()
          setRecState('recording')
        } catch (e) { setErr('无法访问麦克风：' + String(e.message || e)) }
      }
      const stopRec = () => { try { if (window.__recMR2 && window.__recMR2.state === 'recording') window.__recMR2.stop() } catch (e) {} }
      const makeDraft = async () => {
        if (!notes.trim()) { setErr('请先记录面试内容'); return }
        setDrafting(true); setErr('')
        try {
          const j = await api('/api/ai-recruiting/interview-prep', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ candidateId: candidate.id, mode: 'draft', notes }) })
          if (j && j.ok && j.draft) setDraft(j.draft)
          else setErr((j && j.reason) || '草稿生成失败')
        } catch (e) { setErr('草稿生成失败：' + String(e.message || e)) } finally { setDrafting(false) }
      }
      const submitDraft = async () => {
        if (!draft) return
        setBusy(true); setErr('')
        try {
          const j = await postAction({ action: 'feedback', candidateId: candidate.id, round: '初试', pass: true, notes: notes.slice(0, 500), dims: (draft.dims || []).map(x => ({ dim: x.dim, level: x.level, evidence: x.evidence })) })
          onDone && onDone(j)
        } catch (e) { setErr('入库失败：' + String(e.message || e)) } finally { setBusy(false) }
      }
      const sec = (title, color) => h('div', { style: { fontSize: 11.5, fontWeight: 700, color, marginBottom: 4 } }, title)
      return h('div', { style: { ...card, borderColor: C.accent, marginBottom: 9 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
          h('b', { style: { fontSize: 12.5 } }, '🎯 面试 Copilot · ' + (candidate.name || '')),
          h('span', { style: { fontSize: 11.5, color: C.muted } }, (position && position.title) || ''),
          h('div', { style: { flex: 1 } }),
          h('button', { type: 'button', style: { ...btn, padding: '1px 8px', fontSize: 11.5 }, onClick: load }, '↻ 重新生成')),
        
        loading ? h('div', { style: { fontSize: 11.5, color: C.muted, padding: 10 } }, '正在生成面试准备卡…') : null,
        err ? h('div', { style: { fontSize: 11.5, color: C.bad, marginBottom: 6 } }, err) : null,
        prep ? h('div', null,
          (prep.mustVerify || []).length ? h('div', { style: { marginBottom: 8 } },
            sec('① 必须当面验证', C.bad),
            ...prep.mustVerify.map((x, i) => h('div', { key: i, style: { fontSize: 11.5, padding: '3px 0', lineHeight: 1.5 } }, '· ' + x))) : null,
          (prep.questions || []).length ? h('div', { style: { marginBottom: 8 } },
            sec('② 建议追问', C.accent),
            ...prep.questions.map((q, i) => h('div', { key: i, style: { background: C.surface, borderRadius: 8, padding: '6px 9px', marginBottom: 4 } },
              h('div', { style: { display: 'flex', gap: 6 } },
                h('span', { style: { fontSize: 10.5, color: '#fff', background: C.accent, borderRadius: 6, padding: '0 5px', flex: 'none', alignSelf: 'flex-start', marginTop: 1 } }, q.dim || '通用'),
                h('span', { style: { fontSize: 11.5, lineHeight: 1.55 } }, q.q)),
              q.why ? h('div', { style: { fontSize: 10.5, color: C.muted, marginTop: 2, paddingLeft: 2 } }, '为什么问：' + q.why) : null))) : null,
          (prep.redFlags || []).length ? h('div', { style: { marginBottom: 8 } },
            sec('③ 需要警惕的信号', C.warn),
            ...prep.redFlags.map((x, i) => h('div', { key: i, style: { fontSize: 11.5, color: C.warn, padding: '2px 0' } }, '⚠ ' + x))) : null) : null,
        h('div', { style: { borderTop: '1px solid ' + C.border, marginTop: 6, paddingTop: 8 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 } },
            sec('④ 面试记录（转写/手记）', C.good),
            h('div', { style: { flex: 1 } }),
            h('button', { type: 'button', style: { ...btn, padding: '2px 9px', fontSize: 11.5, color: recState === 'recording' ? '#fff' : C.bad, background: recState === 'recording' ? C.bad : 'transparent', borderColor: C.bad }, disabled: recState === 'converting', onClick: () => { if (recState === 'recording') stopRec(); else if (recState === 'idle') startRec() } },
              recState === 'recording' ? '■ 停止转写' : recState === 'converting' ? '转写中…' : '● 录音转写'),
            h('label', { style: { ...btn, padding: '2px 9px', fontSize: 11.5 } }, '🎤 传音频',
              h('input', { type: 'file', accept: 'audio/*,.m4a,.mp3,.wav,.aiff,.amr', style: { display: 'none' }, onChange: e => { const f2 = e.target.files && e.target.files[0]; if (f2) transcribe(f2) } }))),
          h('textarea', { style: { ...input, minHeight: 90, fontFamily: 'inherit' }, value: notes, placeholder: '面试中记录要点（可录音转写），用于生成面评草稿…', onChange: e => setNotes(e.target.value) }),
          h('div', { style: { display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' } },
            h('button', { type: 'button', style: primary, disabled: drafting, onClick: makeDraft }, drafting ? '生成中…' : '✨ 生成面评草稿'),
            draft ? h('button', { type: 'button', style: { ...primary, background: 'rgba(18,160,106,.9)' }, disabled: busy, onClick: submitDraft }, busy ? '入库中…' : '✓ 确认并入库面评') : null,
            h('button', { type: 'button', style: btn, onClick: onCancel }, '关闭'))),
        draft ? h('div', { style: { marginTop: 8, background: 'rgba(18,160,106,.06)', border: '1px solid rgba(18,160,106,.3)', borderRadius: 9, padding: '9px 11px' } },
          h('div', { style: { fontSize: 11.5, fontWeight: 700, color: C.good, marginBottom: 5 } }, '面评草稿 · 待你确认'),
          ...(draft.dims || []).map((x, i) => h('div', { key: i, style: { fontSize: 11.5, marginBottom: 3, lineHeight: 1.5 } },
            h('b', null, x.dim + '：'), h('span', { style: { color: C.accent, fontWeight: 700 } }, ' ' + x.level + ' '), h('span', { style: { color: C.muted } }, x.evidence ? '（' + x.evidence + '）' : ''))),
          draft.summary ? h('div', { style: { fontSize: 11.5, color: C.muted, marginTop: 4 } }, '总结：' + draft.summary) : null,
          (draft.doubts || []).length ? h('div', { style: { fontSize: 11.5, color: C.warn, marginTop: 3 } }, '疑点：' + draft.doubts.join(' / ')) : null) : null)
    }

    // 音频 → WAV（16bit PCM）：浏览器录音是 webm/ogg，Speech 只吃 wav，纯 JS 转码
    function audioBufferToWav(buf) {
      const numCh = buf.numberOfChannels, sr = buf.sampleRate
      const len = buf.length * numCh * 2 + 44
      const ab = new ArrayBuffer(len), view = new DataView(ab)
      const ws = (o, str) => { for (let i = 0; i < str.length; i++) view.setUint8(o + i, str.charCodeAt(i)) }
      ws(0, 'RIFF'); view.setUint32(4, len - 8, true); ws(8, 'WAVE')
      ws(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, numCh, true)
      view.setUint32(24, sr, true); view.setUint32(28, sr * numCh * 2, true); view.setUint16(32, numCh * 2, true); view.setUint16(34, 16, true)
      ws(36, 'data'); view.setUint32(40, len - 44, true)
      const chans = []
      for (let i = 0; i < numCh; i++) chans.push(buf.getChannelData(i))
      let off = 44
      for (let i = 0; i < buf.length; i++) {
        for (let ch = 0; ch < numCh; ch++) {
          let s2 = Math.max(-1, Math.min(1, chans[ch][i]))
          view.setInt16(off, s2 < 0 ? s2 * 0x8000 : s2 * 0x7FFF, true); off += 2
        }
      }
      return new Blob([ab], { type: 'audio/wav' })
    }

    // 面试 Copilot：面试官的副驾——准备卡（验证清单/问题/红旗）+ 记录转写 + 面评草稿
    // 定位：人是面试官，AI 只给参考；草稿入库必经人确认
    function FlowForm({ kind, candidate, round, position, onCancel, onDone }) {
      const [flowToast, setFlowToast] = React.useState('')
      const EMPTY = { channel: '微信', at: '', place: '', placeType: '现场面试', interviewer: '', score: '', note: '', pass: true, salary: '', reason: '', salaryBase: '', salaryMonths: '', startDate: '', position: '', reasonCode: '', reportTo: '', currentSalary: '', salaryNote: '' }
      const [f, setF] = React.useState(EMPTY)
      const set = (k, v) => setF(o => ({ ...o, [k]: v }))
      const [genText, setGenText] = React.useState('')
      const [dv, setDv] = React.useState({})
      const [copied, setCopied] = React.useState(false)
      const input2 = { border: '1px solid ' + C.border, background: 'transparent', color: 'inherit', borderRadius: 6, padding: '5px 8px', fontSize: 11.5, boxSizing: 'border-box', width: '100%' }
      const fld = (label, k, ph, type) => h('label', { key: 'f_' + k, style: { fontSize: 11.5, color: C.muted, display: 'block', marginBottom: 6 } }, label,
        h('input', { style: input2, type: type || 'text', value: f[k] || '', placeholder: ph || '', onChange: e => set(k, e.target.value) }))
      // 日期+时间组合控件（date/time 原生控件分别触发 onChange，Electron 兼容性最好）
      const nowStr = () => { const d0 = new Date(); const p = (n) => String(n).padStart(2, '0'); return d0.getFullYear() + '-' + p(d0.getMonth() + 1) + '-' + p(d0.getDate()) }
      const quick = (days, hhmm) => { const d0 = new Date(); d0.setDate(d0.getDate() + days); const p = (n) => String(n).padStart(2, '0'); set('at', d0.getFullYear() + '-' + p(d0.getMonth() + 1) + '-' + p(d0.getDate()) + 'T' + hhmm) }
      const DateTimeField = () => {
        const dv = String(f.at || '').split('T')
        const datePart = dv[0] || '', timePart = dv[1] || ''
        return h('div', null,
          h('div', { style: { display: 'flex', gap: 6 } },
            h('input', { style: { ...input2, flex: 1 }, type: 'date', value: datePart, onChange: e => set('at', (e.target.value || '') + 'T' + (timePart || '14:00')) }),
            h('input', { style: { ...input2, width: 110, flex: 'none' }, type: 'time', value: timePart, onChange: e => set('at', (datePart || nowStr()) + 'T' + (e.target.value || '14:00')) })),
          h('div', { style: { display: 'flex', gap: 4, marginTop: 5, flexWrap: 'wrap' } },
            ...[['今天 14:00', 0, '14:00'], ['明天 10:00', 1, '10:00'], ['明天 14:00', 1, '14:00'], ['后天 14:00', 2, '14:00']].map(([lbl, dd, hh]) =>
              h('button', { key: lbl, type: 'button', style: { ...btn, padding: '2px 8px', fontSize: 10.5 }, onClick: () => quick(dd, hh) }, lbl)),
            f.at ? h('span', { style: { fontSize: 10.5, color: C.accent, alignSelf: 'center' } }, '✓ ' + fmtAt(f.at)) : null))
      }
      const selFld = (label, k, opts) => h('label', { key: 's_' + k, style: { fontSize: 11.5, color: C.muted, display: 'block', marginBottom: 6 } }, label,
        h('select', { style: input2, value: f[k], onChange: e => set(k, e.target.value) }, ...opts.map(o => h('option', { key: o, value: o }, o))))
      const titles = { invite: '发' + round + '邀约', interview: '安排' + round, feedback: '录' + round + '面评', send_offer: '发 Offer', hire: '确认入职', activate: '重新激活', eliminate: '淘汰候选人', accept: '记录 Offer 接受', decline: '记录 Offer 拒绝', onboard: '安排入职', backcheck: '录入背调结论' }
      const body = []
      if (kind === 'invite') {
        body.push(h('div', { style: { fontSize: 11, color: C.muted, marginBottom: 8, lineHeight: 1.5 } }, '填写面试时间后发送，邀约即完成排期，时间会自动同步到「面试日程」。'))
        body.push(h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 } },
          h('label', { style: { fontSize: 11.5, color: C.muted } }, '渠道',
            h('select', { style: input2, value: f.channel, onChange: e => set('channel', e.target.value) }, ...['微信', '邮件', '短信', '电话'].map(x => h('option', { key: x, value: x }, x)))),
          h('div', null, h('div', { style: { fontSize: 11.5, color: C.muted, marginBottom: 6 } }, '时间'), h(DateTimeField, null))))
        body.push(h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 } },
          h('label', { style: { fontSize: 11.5, color: C.muted } }, '面试形式',
            h('select', { style: input2, value: f.placeType, onChange: e => set('placeType', e.target.value) }, ...['现场面试', '在线面试'].map(x => h('option', { key: x, value: x }, x)))),
          fld(f.placeType === '在线面试' ? '会议链接（选填）' : '详细地址（选填）', 'place', f.placeType === '在线面试' ? '腾讯会议链接 / 号码' : '如 XX大厦 12 层会议室')))
        body.push(h('button', { type: 'button', style: { ...btn, marginTop: 2 }, onClick: () => {
          const posTitle = (position && position.title) || candidate.__posTitle || '本岗位'
          const dept = (position && position.dept) || ''
          const city = (position && position.city) || ''
          const interviewer = f.interviewer || ''
          const when = fmtAt(f.at) || '（待与您确认）'
          const form = f.placeType || '现场面试'
          const where = f.place ? ('（' + f.place + '）') : (form === '在线面试' ? '（会议链接稍后发送）' : '')
          const L = []
          L.push(candidate.name + ' 您好：')
          L.push('')
          L.push('    感谢您应聘「' + posTitle + '」' + (dept ? '（' + dept + '）' : '') + '，我们已认真阅读您的简历，认为您的经历与岗位较为契合，诚邀您参加' + round + '。')
          L.push('')
          L.push('面试时间：' + when)
          L.push('面试形式：' + form + where)
          if (interviewer) L.push('面  试  官：' + interviewer)
          L.push('')
          L.push('如时间不便，请回复本消息告知可安排的时段，我们会为您协调改期；确认参加也请回复一下，便于我们提前准备。')
          L.push('')
          L.push('期待与您交流，祝好！')
          L.push('—— ' + (city ? city + '·' : '') + (dept || '招聘团队'))
          setGenText(L.join('\n'))
        } }, '生成邀约文案'))
        if (genText) body.push(h('div', { style: { border: '1px solid rgba(47,107,255,.4)', background: 'rgba(47,107,255,.07)', borderRadius: 10, marginTop: 6, overflow: 'hidden' } },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', borderBottom: '1px solid rgba(47,107,255,.25)' } },
            h('span', { style: { fontSize: 11.5, color: C.accent, fontWeight: 700 } }, '📋 邀约预览'),
            h('button', { type: 'button', style: { ...btn, padding: '2px 10px', fontSize: 11.5, background: copied ? 'rgba(18,160,106,.2)' : 'transparent', color: copied ? C.good : C.accent, borderColor: copied ? 'transparent' : C.accent }, onClick: () => { try { navigator.clipboard.writeText(genText); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch (e) {} } }, copied ? '✓ 已复制' : '复制')),
          h('pre', { style: { fontSize: 11.5, lineHeight: 1.8, whiteSpace: 'pre-wrap', padding: '10px 12px', margin: 0 } }, genText),
          (function () {
            const dt = String(f.at || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
            if (!dt) return null
            const start = dt[1] + dt[2] + dt[3] + 'T' + dt[4] + dt[5] + '00'
            const endH = (parseInt(dt[4], 10) + 1) % 24
            const end = dt[1] + dt[2] + dt[3] + 'T' + String(endH).padStart(2, '0') + dt[5] + '00'
            const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//RecruitWorkbench//CN', 'BEGIN:VEVENT',
              'SUMMARY:' + (candidate.name || '') + ' ' + round + '面', 'DTSTART:' + start, 'DTEND:' + end,
              'LOCATION:' + ((f.placeType||'') + (f.place ? ' ' + f.place : '') || f.channel || ''), 'DESCRIPTION:' + genText.replace(/\n/g, '\\n'),
              'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
            return h('div', { style: { display: 'flex', justifyContent: 'flex-end', padding: '0 10px 8px' } },
              h('button', { type: 'button', style: { ...btn, fontSize: 11.5, padding: '2px 10px' }, onClick: () => {
                try {
                  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' })
                  const url = URL.createObjectURL(blob)
                  const aEl = document.createElement('a')
                  aEl.href = url; aEl.download = (candidate.name || 'interview') + '-' + round + '.ics'
                  document.body.appendChild(aEl); aEl.click(); document.body.removeChild(aEl)
                  setTimeout(() => URL.revokeObjectURL(url), 2000)
                } catch (e2) {}
              } }, '📅 下载日历 .ics'))
          })()))
      } else if (kind === 'interview') {
        body.push(h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 } },
          h('div', null, h('div', { style: { fontSize: 11.5, color: C.muted, marginBottom: 6 } }, '时间'), h(DateTimeField, null)), fld('面试官', 'interviewer', '姓名')))
        body.push(h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 6 } },
          h('label', { style: { fontSize: 11.5, color: C.muted } }, '面试形式',
            h('select', { style: input2, value: f.placeType, onChange: e => set('placeType', e.target.value) }, ...['现场面试', '在线面试'].map(x => h('option', { key: x, value: x }, x)))),
          fld(f.placeType === '在线面试' ? '会议链接（选填）' : '详细地址（选填）', 'place', f.placeType === '在线面试' ? '腾讯会议链接' : 'XX大厦 12 层')))
      } else if (kind === 'feedback') {
        // 结构化面评：面试官按同一张 BARS 评分卡逐维判档，与 AI 初筛同尺度可比
        const dims = (position && position.scorecard && position.scorecard.softDims) || []
        const anchors = (dim, lv) => ((dim.levels || []).find(x => x.level === lv) || {}).anchor || ''
        const levelOpts = ['L0', 'L1', 'L2', 'L3']
        var computed = (() => {
          let got = 0, wsum = 0
          for (const d of dims) { const w = Number(d.weight) || 0; wsum += w; const lv = (d.levels || []).find(x => x.level === dv[d.name]); if (lv) got += (lv.score || 0) / 100 * w }
          return wsum ? Math.round(got / wsum * 100) : null
        })()
        body.push(h('div', { style: { fontSize: 11.5, color: C.muted, marginBottom: 8, lineHeight: 1.5 } },
          '按「' + ((position && position.title) || '岗位') + '」评分卡逐维判档（与 AI 初筛同一标尺）。当前合成：' + (computed != null ? computed + ' 分' : '—')))
        for (const d of dims) {
          body.push(h('div', { key: d.name, style: { marginBottom: 8, background: C.surface, borderRadius: 8, padding: '7px 9px' } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 } },
              h('b', { style: { fontSize: 11.5, flex: 1 } }, d.name),
              h('span', { style: { fontSize: 10.5, color: C.muted } }, '权重 ' + d.weight + '%'),
              h('select', { style: { ...input2, width: 150 }, value: dv[d.name] || '', onChange: e => setDv(o => ({ ...o, [d.name]: e.target.value })) },
                h('option', { value: '' }, '— 判档 —'),
                ...levelOpts.filter(lv => (d.levels || []).some(x => x.level === lv)).map(lv => h('option', { key: lv, value: lv }, lv + ' · ' + ((d.levels || []).find(x => x.level === lv) || {}).score + '分')))),
            dv[d.name] ? h('div', { style: { fontSize: 11.5, color: C.muted } }, '锚点：' + anchors(d, dv[d.name])) : null))
        }
        body.push(h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 } },
          h('label', { style: { fontSize: 11.5, color: C.muted } }, '合成面评分',
            h('input', { style: input2, value: computed != null ? computed : '', readOnly: true })),
          h('label', { style: { fontSize: 11.5, color: C.muted } }, '结论',
            h('select', { style: input2, value: f.pass ? '1' : '0', onChange: e => set('pass', e.target.value === '1') }, h('option', { value: '1' }, '通过'), h('option', { value: '0' }, '不通过')))))
        body.push(h('div', { style: { background: 'rgba(47,107,255,.06)', borderRadius: 8, padding: '7px 9px', marginBottom: 8 } },
          h('div', { style: { fontSize: 11.5, color: C.muted, marginBottom: 4 } }, '💰 薪资证据'),
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 } },
            fld('现薪/期望月薪 (K)', 'currentSalary', '如 20'),
            fld('备注（现司/职级）', 'salaryNote', '如 现司 18K·14薪'))))
        body.push(fld('综合面评（关键表现/疑点）', 'note', '补充说明'))
      } else if (kind === 'send_offer') {
        body.push(h('div', { style: { fontSize: 11.5, color: C.muted, marginBottom: 8, lineHeight: 1.5 } }, '给 ' + candidate.name + ' 发录用 Offer。请填写薪资结构与入职安排。'))
        body.push(h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 } },
          fld('月薪 Base (K)', 'salaryBase', '如 25'),
          fld('薪数 (×月)', 'salaryMonths', '如 14')))
        body.push(h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 6 } },
          fld('入职日期', 'startDate', '', 'date'),
          fld('入职岗位', 'position', '默认当前岗位')))
        body.push(fld('Offer 说明 / 其他福利', 'note', '期权/补贴/备注'))
      } else if (kind === 'hire') {
        body.push(h('div', { style: { fontSize: 11.5, color: C.muted, marginBottom: 8, lineHeight: 1.5 } }, '确认 ' + candidate.name + ' 已入职。此为流程终点，请核对入职信息。'))
        body.push(h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 } },
          fld('实际入职日期', 'startDate', '', 'date'),
          fld('入职岗位', 'position', '默认当前岗位')))
        body.push(h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 6 } },
          fld('汇报对象/直属上级', 'reportTo', '如 技术总监'),
          fld('最终薪资 (K×月)', 'salary', '如 25×14')))
        body.push(fld('入职确认备注', 'reason', '报到方式/材料/其他'))
      } else if (kind === 'backcheck') {
        body.push(h('div', { style: { fontSize: 11.5, color: C.muted, marginBottom: 8, lineHeight: 1.5 } }, '录入 ' + candidate.name + ' 的背景调查结论。核实前雇主、工作表现、离职原因等。'))
        body.push(selFld('背调结论', 'bcResult', ['通过（pass）', '不通过（fail）', '免背调（skip）']))
        body.push(fld('背调说明', 'note', '证明人核实情况/离职原因/异常点'))
      } else if (kind === 'accept') {
        body.push(h('div', { style: { fontSize: 11.5, color: C.muted, marginBottom: 8, lineHeight: 1.5 } }, candidate.name + ' 已接受 Offer。可记录接受薪资（如与 Offer 不同）。'))
        body.push(fld('接受薪资（可留空沿用 Offer）', 'salary', '如 25K×14'))
        body.push(fld('备注', 'note', '如 已签回执'))
      } else if (kind === 'decline') {
        body.push(h('div', { style: { fontSize: 11.5, color: C.muted, marginBottom: 8, lineHeight: 1.5 } }, candidate.name + ' 拒绝 Offer / 放弃入职。这是招聘最大的流失，请务必记录原因。'))
        body.push(selFld('原因分类', 'reasonCode', ['接受了更高薪的竞品', '薪资不达预期', '通勤/异地', '家庭原因', '背景不符预期', '入职前反悔', '其他']))
        body.push(fld('补充说明', 'reason', '具体情况（用于改进 Offer 竞争力）'))
      } else if (kind === 'onboard') {
        body.push(h('div', { style: { fontSize: 11.5, color: C.muted, marginBottom: 8, lineHeight: 1.5 } }, '为 ' + candidate.name + ' 安排入职报到。'))
        body.push(fld('入职报到日期', 'startDate', '', 'date'))
        body.push(fld('报到通知/材料说明', 'note', '报到地点/需带材料'))
      } else if (kind === 'eliminate') {
        body.push(h('div', { style: { fontSize: 11.5, color: C.muted, marginBottom: 8, lineHeight: 1.5 } }, '淘汰 ' + candidate.name + '。请选择淘汰原因分类并说明（可进人才库，之后可激活召回）。'))
        body.push(selFld('淘汰原因', 'reasonCode', ['技能/技术栈不符', '经验不达标', '学历/硬门槛不符', '面试表现不通过', '薪资不匹配', '稳定性/职业轨迹', '文化不匹配', '候选人主动放弃', '其他']))
        body.push(fld('具体说明', 'reason', '补充说明'))
      } else if (kind === 'activate') {
        body.push(fld('重新激活原因', 'reason', '如 误淘汰激活/新岗位召回'))
      }
      const submit = () => {
        if (kind === 'feedback') {
          var dims = (position && position.scorecard && position.scorecard.softDims) || []
          const missing = dims.filter(d => !dv[d.name])
          if (dims.length && missing.length) { setFlowToast('还有维度未判档：' + missing.map(x => x.name).join('、')); return }
        }
        // 组装结构化说明
        let reason = f.reason || ''
        let salary = f.salary || ''
        if (kind === 'backcheck') { const rmap = { '通过（pass）': 'pass', '不通过（fail）': 'fail', '免背调（skip）': 'skip' }; onDone({ action: 'background_check', candidateId: candidate.id, result: rmap[f.bcResult] || 'pass', note: f.note || '' }); return }
        if (kind === 'decline') { const rc = f.reasonCode || ''; onDone({ action: 'offer_decline', candidateId: candidate.id, reason: (rc ? '[' + rc + '] ' : '') + (f.reason || ''), note: f.note || '' }); return }
        if (kind === 'accept') { onDone({ action: 'offer_accept', candidateId: candidate.id, salary: f.salary || '', note: f.note || '' }); return }
        if (kind === 'onboard') { onDone({ action: 'schedule_onboarding', candidateId: candidate.id, startDate: f.startDate || '', note: f.note || '' }); return }
        if (kind === 'invite' && !f.at) { setFlowToast('请先填写面试时间（邀约后会自动排进面试日程）'); return }
        if (kind === 'eliminate') reason = (f.reasonCode ? '[' + f.reasonCode + '] ' : '') + (f.reason || '')
        if (kind === 'send_offer') salary = (f.salaryBase ? f.salaryBase + 'K' : '') + (f.salaryMonths ? '×' + f.salaryMonths : '')
        if (kind === 'send_offer' && !reason) reason = (f.startDate ? '预计 ' + fmtDate(f.startDate) + ' 入职；' : '') + (f.note || 'Offer')
        if (kind === 'hire') { salary = f.salary || salary; reason = [f.startDate ? '入职:' + fmtDate(f.startDate) : '', f.position ? '岗位:' + f.position : '', f.reportTo ? '汇报:' + f.reportTo : '', f.reason].filter(Boolean).join('｜') }
        onDone({ action: kind, candidateId: candidate.id, currentSalary: f.currentSalary, salaryNote: f.salaryNote, channel: f.channel, at: f.at, place: f.place, placeType: f.placeType, interviewer: f.interviewer, score: kind === 'feedback' ? computed : (f.score === '' ? null : Number(f.score)), note: f.note, pass: f.pass, salary, reason, dims: kind === 'feedback' ? dims.map(d => ({ dim: d.name, level: dv[d.name] })) : null })
      }
      return h(Block, { title: titles[kind] || '流程动作' },
        ...body,
        flowToast ? h('div', { style: { fontSize: 11, color: C.warn, marginTop: 6, padding: '5px 9px', background: tint(C.warn,.10), borderRadius: 7 } }, '⚠ ' + flowToast) : null,
        h('div', { style: { display: 'flex', gap: 8, marginTop: 12 } },
          h('button', { type: 'button', style: { ...primary, padding: '7px 18px', fontSize: 12.5 }, onClick: submit }, kind === 'invite' ? '✓ 记录已发邀约' : '确认'),
          h('button', { type: 'button', style: { ...btn, padding: '7px 16px' }, onClick: onCancel }, '取消')))
    }

    function Detail(props) {
      try { return DetailImpl(props) }
      catch (e) { try { console.error('[ai-recruiting] Detail crash', e) } catch (_) {}
        return h('div', { style: { ...card, borderColor: C.bad } },
          h('b', { style: { color: C.bad } }, '详情页渲染出错（已捕获，不白屏）'),
          h('pre', { style: { fontSize: 11.5, whiteSpace: 'pre-wrap', color: C.muted, marginTop: 6 } }, String((e && (e.stack || e.message)) || e)))
      }
    }
    function DetailImpl({ detail, onAction, lastSeq, onOpenLog, positions, panelHint }) {
      const c = detail.candidate
      const [panel, setPanel] = React.useState(null)
      React.useEffect(() => { if (panelHint && panelHint.key) setPanel(panelHint.key) }, [panelHint && panelHint.nonce])
      const [showResume, setShowResume] = React.useState(false)
      const [toast, setToast] = React.useState('')
      const [renaming, setRenaming] = React.useState(false)
      const [binding, setBinding] = React.useState(false)
      const [bindPid, setBindPid] = React.useState('')
      const [why, setWhy] = React.useState(false)
      const dims = Object.keys(c.scores || {})
      const run = async (body) => {
        try { const j = await postAction(body); setToast(j.message || '完成'); setPanel(null); onAction(j); return j }
        catch (e) { setToast('失败：' + String(e.message || e)); return null }
      }
      const out = []
      // 分段隔离：任何区块崩溃只显示该区块的错误卡，其余照常渲染
      const seg = (name, fn) => {
        try { fn() }
        catch (e) {
          try { console.error('[ai-recruiting] Detail 区块「' + name + '」崩溃', e) } catch (_) {}
          out.push(h('div', { style: { ...card, borderColor: C.bad } },
            h('b', { style: { color: C.bad, fontSize: 11.5 } }, '⚠ 区块「' + name + '」渲染失败'),
            h('pre', { style: { fontSize: 10.5, color: C.muted, whiteSpace: 'pre-wrap', marginTop: 4 } }, String((e && e.message) || e) + '\n' + String((e && e.stack) || '').split('\n').filter(l => l.indexOf('<anonymous>') >= 0).slice(0, 2).map(l => l.trim()).join('\n'))))
        }
      }
      seg('头部', () => out.push(h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 9 } },
        h('b', { style: { fontSize: 16 } }, c.name || c.id),
        h('button', { type: 'button', style: { ...btn, padding: '1px 7px', fontSize: 11.5 }, onClick: () => setRenaming(v => !v) }, '更名'),
        renaming ? h('input', { style: { ...input, width: 120, display: 'inline-block' }, defaultValue: c.name, autoFocus: true,
          onKeyDown: e => { if (e.key === 'Enter') { run({ action: 'fix_name', candidateId: c.id, name: e.target.value }).then(() => setRenaming(false)) } },
          placeholder: '回车确认' }) : null,
        h('span', { style: token(C.muted) }, c.stage),
        c.lastInvite ? h('span', { style: { fontSize: 11.5, padding: '1px 7px', borderRadius: 9, background: 'rgba(124,58,237,.14)', color: '#a78bfa', border: '1px solid rgba(124,58,237,.3)' } }, '📨 ' + (c.lastInvite.round || '初试') + '已邀约' + (c.lastInvite.at ? ' · ' + (fmtAt(c.lastInvite.at) || c.lastInvite.at) : '') + (c.lastInvite.channel ? ' · ' + c.lastInvite.channel : '')) : null,
        (c.lastInvite && c.lastInvite.token) ? h('button', { type: 'button', style: { fontSize: 10, padding: '1px 8px', borderRadius: 9, background: tint(C.purple, .12), color: C.purple, border: '1px solid ' + tint(C.purple, .4), cursor: 'pointer' }, title: '复制给面试官的免登录面试/面评链接', onClick: () => {
          const url = window.location.origin + '/api/ai-recruiting/interview?token=' + encodeURIComponent(c.lastInvite.token)
          try { navigator.clipboard.writeText(url); setToast('已复制面试官链接，可直接发给面试官') } catch (e) { setToast('链接：' + url) }
        } }, '🔗 面试官链接') : null,
        (() => {
          const m = c.mail || {}
          const viaMail = m.from || m.subject
          const reason = m.sourceReason ? ('归因' + m.sourceReason + (m.sourceConf ? '（' + m.sourceConf + '置信）' : '')) : ''
          return h('span', { style: token(C.muted), title: viaMail ? ('邮件载体：' + String(m.from || '').slice(0, 40) + (reason ? ' · ' + reason : '')) : '' },
            (c.source || '未标来源') + (viaMail ? ' 📧' : ''))
        })(),
        c.unlinked
          ? h('span', { style: { fontSize: 11.5, padding: '1px 8px', borderRadius: 9, background: C.bad, color: '#fff', fontWeight: 700, cursor: 'pointer' }, onClick: () => setBinding(v => !v) }, '⚠ 未关联岗位 · 点此绑定')
          : h('span', { style: token(C.muted) }, (detail.position && detail.position.title) || '未关联岗位'),
        c.conf != null ? h('span', { style: token(c.conf >= 0.72 ? C.good : C.warn) }, '置信 ' + c.conf) : null)))
      // 校验链：硬门槛 → 技术栈 → 技能匹配 → JD 合规（机器校验可见化）
      seg('AI 建议', () => {
        const gr = c.gateResults || []
        const deep = c.deep || {}
        const grade = (c.route || '').match(/^([SABC])\s*级/)?.[1] || deep.grade || ''
        const GRADE_HINT = { S: { t: '强烈推荐', c: C.good }, A: { t: '推荐', c: C.good }, B: { t: '需面试排雷', c: C.warn }, C: { t: '不建议推进', c: C.bad } }
        const gh = GRADE_HINT[grade] || { t: '', c: C.muted }
        const und = c.undetermined || []
        const isInsufficient = und.length > 0 || /待补充|缺.*证据|未判定|证据不足/.test(c.route || '')
        const nextAction = (function () {
          if (isInsufficient) return '简历缺「' + (und.join('、') || '关键维度') + '」的可引用证据 → 向候选人索取该维度的具体经历/量化结果，或安排面试当面核实'
          if (grade === 'S' || grade === 'A') return '进入初试：发初试邀约'
          if (grade === 'C') return '建议淘汰并存入人才库（后续可激活复捞）'
          if (grade === 'B') return '安排面试重点排雷（' + (c.doubts && c.doubts[0] ? '先核实：' + c.doubts[0] : '仍需当面验证') + '）'
          return c.action || ''
        })()
        out.push(h(Block, { title: 'AI 建议' },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 } },
            grade ? h('span', { style: { fontSize: 13, fontWeight: 800, color: '#fff', background: gh.c, borderRadius: 8, padding: '2px 12px' } }, grade + ' 级') : null,
            h('div', { style: { flex: 1 } },
              h('div', { style: { fontSize: 13, fontWeight: 700, color: gh.c } }, gh.t || (c.route || '未评估')),
              detail.rank ? h('div', { style: { fontSize: 11.5, color: C.muted, marginTop: 1 } }, '本批同岗位第 ' + detail.rank.pos + '/' + detail.rank.total + ' 名（前 ' + detail.rank.pct + '%）') : null)),
          nextAction ? h('div', { style: { fontSize: 12.5, marginBottom: 6, padding: '8px 11px', background: isInsufficient ? tint(C.warn,.12) : tint(C.accent,.07), borderRadius: 8, border: '1px solid ' + (isInsufficient ? tint(C.warn,.4) : 'transparent'), color: isInsufficient ? C.warn : 'inherit' } }, h('b', null, isInsufficient ? '⚠ 需你复核（缺证据） ' : '下一步 '), nextAction) : null,
          h('div', { style: { background: C.surface, borderRadius: 8, padding: '9px 11px', marginBottom: 6 } },
            (function () {
              const ev = c.evidence || {}
              const evKeys = Object.keys(ev).filter(k2 => ev[k2])
              const und = c.undetermined || []
              const std = detail.currentStandard || {}
              return [
                h('div', { style: { fontSize: 11.5, marginBottom: 5 } }, h('b', null, '判定依据')),
                evKeys.length
                  ? h('div', { style: { marginBottom: 4 } }, ...evKeys.slice(0, 4).map(k2 => h('div', { key: k2, style: { fontSize: 11.5, color: C.muted, marginTop: 2, lineHeight: 1.5 } }, '· ' + k2 + '：' + String(ev[k2]).slice(0, 70))))
                  : h('div', { style: { fontSize: 11.5, color: C.muted, marginBottom: 4 } }, '· 依据各维度 BARS 档位判定'),
                und.length ? h('div', { style: { fontSize: 11.5, color: C.warn, marginTop: 3, lineHeight: 1.6 } }, '⚠ 这些维度简历里没有可引用的事实，无法判断：' + und.join('、') + '。请向候选人索取对应经历或安排面试核实后再判断。') : null,
                h('div', { style: { fontSize: 10.5, color: C.muted, marginTop: 5, paddingTop: 4, borderTop: '1px solid ' + C.border } }, '可追溯、可复现'),
              ]
            })()),
          gr.length ? h('div', { style: { marginTop: 4, fontSize: 11.5 } },
            h('div', { style: { fontWeight: 600, marginBottom: 3, fontSize: 11.5 } }, '硬门槛判定'),
            ...gr.map((g, i) => {
              const vc = g.verdict === 'pass' ? C.good : (g.verdict === 'fail' ? C.bad : C.warn)
              const vt = g.verdict === 'pass' ? '通过' : (g.verdict === 'fail' ? '不通过' : '待核')
              return h('div', { key: i, style: { display: 'flex', gap: 6, alignItems: 'baseline', marginBottom: 2 } },
                h('span', { style: { fontSize: 11.5, color: '#fff', background: vc, borderRadius: 8, padding: '0 6px', fontWeight: 700, flex: 'none' } }, vt),
                h('span', null, g.gate + '：'), h('span', { style: { color: C.muted } }, g.reason))
            })) : null,
          (c.doubts || []).length ? h('div', { style: { fontSize: 11.5, color: C.warn, marginTop: 5 } }, '疑点（建议面试核实）：' + c.doubts.join(' / ')) : null,
          h('button', { type: 'button', style: { ...btn, padding: '1px 8px', fontSize: 11.5, marginTop: 8 }, onClick: () => setWhy(v => !v) }, why ? '收起流转记录' : '查看流转记录'),
          why ? (function () {
            const TYPE_CN = { 'assessment.recorded': 'AI 完成评估', 'decision.made': '人工做出判断', 'stage.advanced': '推进阶段', 'invite.sent': '发送邀约', 'feedback.submitted': '提交面评', 'candidate.bound': '绑定岗位', 'salary.advised': '生成薪酬建议', 'background.check': '背景调查', 'offer.sent': '发出 Offer', 'offer.accepted': 'Offer 接受', 'offer.declined': 'Offer 拒绝', 'hire.confirmed': '确认入职' }
            const tl = (detail.timeline || []).filter(e2 => TYPE_CN[e2.type]).slice(-8)
            return h('div', { style: { background: C.surface, borderRadius: 8, padding: '8px 10px', marginTop: 6, fontSize: 11.5, lineHeight: 1.8 } },
              ...tl.map(e2 => h('div', { key: e2.seq, style: { display: 'flex', gap: 6 } },
                h('span', { style: { color: C.muted, flex: 'none', width: 60 } }, e2.ts ? new Date(e2.ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : ''),
                h('span', { style: { color: e2.actor === 'agent' ? C.accent : C.good, flex: 'none', width: 28 } }, e2.actor === 'agent' ? 'AI' : '人工'),
                h('span', null, TYPE_CN[e2.type] || e2.type))),
              null)
          })() : null))
      })
      seg('成绩卡', () => {
        const deep = c.deep || {}
        const grade = deep.grade || (c.route ? (c.route.match(/^([SABC]) 级/) || [])[1] : null)
        const score = deep.score != null ? deep.score : c.weighted
        const gates = c.gateResults || []
        const gatePass = gates.filter(g => g.verdict === 'pass').length
        const gateFail = gates.filter(g => g.verdict === 'fail').length
        const redFlags = (deep.redFlags || []).length
        const metric = (label, val, color, titleHint) => h('div', { style: { flex: '1 1 0', minWidth: 70, textAlign: 'center', background: C.surface, borderRadius: 8, padding: '7px 6px' }, title: titleHint },
          h('div', { style: { fontSize: 15, fontWeight: 800, color: color || 'inherit' } }, val),
          h('div', { style: { fontSize: 10.5, color: C.muted, marginTop: 2 } }, label))
        out.push(h('div', { style: { ...card, marginBottom: 9, display: 'flex', gap: 14, alignItems: 'center' } },
          h(ScoreRing, { grade, score }),
          h('div', { style: { flex: 1, display: 'flex', gap: 8, flexWrap: 'wrap' } },
            metric('置信度', c.conf != null ? c.conf : '—', c.conf >= 0.72 ? C.good : C.warn, '三档采样一致性50% + 证据覆盖度30% + 硬门槛确定性20% 的加权，越低越需人工复核'),
            metric('硬门槛', gateFail ? (gateFail + ' 项未过') : (gatePass ? (gatePass + '/' + gates.length + ' 通过') : '—'), gateFail ? C.bad : (gatePass ? C.good : C.muted)),
            metric('红牌', redFlags || '0', redFlags ? C.bad : C.muted),
            metric('适配分', score != null ? score : '—', grade ? GRADE_HUE[grade] : C.muted, '各维度 L0-L3 档位分 × 权重 的加权综合分（0-100），每分可追到维度/档位/原文'))))
      })
      seg('校验链', () => {
        const gr2 = c.gateResults || []
        const sf = detail.stackFit
        const gap2 = detail.skillGap || {}
        const comp = detail.compliance
        const item = (label, ok, detailTxt) => h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '5px 9px', borderRadius: 8, background: C.surface, flex: '1 1 150px', minWidth: 130 } },
          h('span', { style: { width: 16, height: 16, borderRadius: 99, flex: 'none', background: ok === true ? tint(C.good, .18) : ok === false ? tint(C.bad, .18) : 'rgba(127,143,170,.18)', color: ok === true ? C.good : ok === false ? C.bad : C.muted, fontSize: 11.5, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800 } }, ok === true ? '✓' : ok === false ? '✕' : '–'),
          h('div', { style: { minWidth: 0 } },
            h('div', { style: { fontSize: 11.5, fontWeight: 700 } }, label),
            h('div', { style: { fontSize: 10.5, color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, detailTxt || '—')))
        const gateFail = gr2.filter(x => x.verdict === 'fail')
        const gatePend = gr2.filter(x => x.verdict !== 'pass' && x.verdict !== 'fail')
        const passN = (gr2.filter(g => g.verdict === 'pass').length) + (sf && sf.fit === 'match' ? 1 : 0) + ((gap2.rate || 0) >= 50 ? 1 : 0)
        out.push(h('details', { style: { ...card, marginBottom: 9, padding: '9px 13px' } },
          h('summary', { style: { cursor: 'pointer', fontSize: 11.5, color: C.muted, userSelect: 'none' } }, '▸ 校验链 · ' + passN + '/4 通过'),
          h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 } },
            item('硬门槛', gr2.length ? (gateFail.length ? false : gatePend.length ? null : true) : null,
              gr2.length ? (gateFail.length ? '未过：' + gateFail.map(x => x.gate).join('、') : gatePend.length ? '待核 ' + gatePend.length + ' 项' : '全部通过') : '无门槛'),
            item('技术栈对口', sf ? (sf.fit === 'match' ? true : sf.fit === 'mismatch' ? false : null) : null,
              sf ? (sf.fit === 'mismatch' ? '不对口：' + (sf.candStacks || []).join('/') : (sf.jobStack || '') + (sf.stackRate != null ? ' · 覆盖 ' + sf.stackRate + '%' : '')) : '未判定'),
            item('技能匹配', gap2.rate == null ? null : gap2.rate >= 50, gap2.rate == null ? '无岗位需求' : gap2.rate + '% · 缺 ' + ((gap2.missing || []).length) + ' 项'),
            item('JD 合规', comp ? comp.score >= 85 : null, comp ? comp.score + ' 分 · ' + comp.summary : '未评估'))))
      })
      const calBtn = h('button', { type: 'button', style: btn, onClick: () => setPanel(panel === 'cal' ? null : 'cal') }, '改判')
      const elimBtn = h('button', { type: 'button', style: danger, onClick: () => setPanel(panel === 'elim' ? null : 'elim') }, '淘汰')
      const offerBtn = h('button', { type: 'button', style: danger, onClick: () => setPanel(panel === 'offer' ? null : 'offer') }, 'Offer')
      if (c.unlinked && binding) seg('绑定岗位', () => out.push(h('div', { style: { ...card, borderColor: C.accent, marginBottom: 9, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
        h('span', { style: { fontSize: 11.5 } }, '绑定到岗位：'),
        h('select', { style: { ...input, width: 200, display: 'inline-block' }, value: bindPid, onChange: e => setBindPid(e.target.value) },
          h('option', { value: '' }, '— 选择岗位 —'),
          ...(positions || []).map(p => h('option', { key: p.id, value: p.id }, p.title))),
        h('button', { type: 'button', style: primary, onClick: async () => {
          if (!bindPid) { setToast('请先选择岗位'); return }
          try {
            const j = await postAction({ action: 'bind_position', candidateId: c.id, positionId: bindPid })
            if (j && j.mismatch) {
              if (window.confirm(j.message + '\n\n仍要绑定请点确定。')) {
                const j2 = await postAction({ action: 'bind_position', candidateId: c.id, positionId: bindPid, force: true })
                setToast(j2.message || '已强制绑定'); setBinding(false); setBindPid(''); onAction(j2)
              } else { setToast('已取消绑定') }
              return
            }
            setToast(j.message || '已绑定'); setBinding(false); setBindPid(''); onAction(j)
          } catch (e) { setToast('绑定失败：' + String(e.message || e)) }
        } }, '确认绑定'),
        h('span', { style: { fontSize: 11.5, color: C.muted } }, '绑定后自动重置为待评估，可重新 AI 初筛'))))
      if (c.stage === '待发 Offer') seg('终面决策', () => out.push(h(Block, { title: '终面决策 · 录用拍板' },
        h('div', { style: { fontSize: 11.5, color: C.muted, marginBottom: 6 } }, '候选人已走完面试流程，请定最终去向：发 Offer / 淘汰 / 进人才库'),
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
          offerBtn,
          h('button', { type: 'button', style: btn, onClick: async () => {
            try {
              const j = await api('/api/ai-recruiting/offer-docx', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ candidateId: c.id }) })
              if (!j || !j.ok) { setToast('生成失败：' + ((j && j.error) || '')); return }
              const bin = atob(j.base64 || '')
              const bytes = new Uint8Array(bin.length)
              for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
              const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
              const url = URL.createObjectURL(blob)
              const aEl = document.createElement('a')
              aEl.href = url; aEl.download = j.filename || 'offer.docx'
              document.body.appendChild(aEl); aEl.click(); document.body.removeChild(aEl)
              setTimeout(() => URL.revokeObjectURL(url), 2000)
              setToast('已生成录用通知书')
            } catch (e) { setToast('生成失败：' + String(e.message || e)) }
          } }, '📄 导出录用通知书'),
          h('button', { type: 'button', style: btn, onClick: () => run({ action: 'decide', candidateId: c.id, decision: '人才库', reason: '终面后存入人才库' }) }, '进人才库'),
          elimBtn, calBtn))))
      if (panel === 'elim') out.push(h(FlowForm, { kind: 'eliminate', candidate: c, round: '初试', onCancel: () => setPanel(null), onDone: (body) => run({ action: 'eliminate', candidateId: c.id, reason: body.reason }) }))
      if (panel === 'offer') out.push(h(FlowForm, { kind: 'send_offer', candidate: c, round: '初试', onCancel: () => setPanel(null), onDone: (body) => run({ action: 'offer', candidateId: c.id, reason: body.reason, salary: body.salary }) }))
      if (panel === 'cal') out.push(h(CalibrateForm, { candidateId: c.id, dims, alignment: (c.deep && c.deep.alignment) || [], aiGrade: (c.deep && c.deep.grade) || '', onDone: onAction, onCancel: () => setPanel(null) }))
      // 每个在流程中的环节都可淘汰（任何阶段都可能不合适）；终态（已入职/已淘汰/人才库）不出现
      const ELIM = ['elim', '淘汰']
      const flow = {
        '待评估': [['adopt', '✓ 采纳 AI 建议 · 进初试'], ELIM],
        '已评估': [['adopt', '✓ 采纳 · 进初试'], ELIM],
        '待初试': [['invite', '发初试邀约'], ELIM],
        '初试中': [['copilot', '🎯 面试准备'], ['feedback', '录初试面评'], ELIM],
        '待复试': [['interview', '安排复试'], ELIM],
        '复试中': [['copilot', '🎯 面试准备'], ['feedback', '录复试面评'], ELIM],
        '待背调': [['flow:backcheck', '录入背调结论'], ELIM],
        'Offer已发': [['flow:accept', '候选人已接受'], ['flow:decline', '被拒 / 放弃'], ELIM],
        'Offer已接受': [['flow:onboard', '安排入职'], ELIM],
        '待入职': [['flow:hire', '确认入职'], ELIM],
        '人才库': [['activate', '重新激活']], '已淘汰': [['activate', '重新激活']],
      }[c.stage] || []
      if (flow.length) seg('流程动作', () => out.push(h(Block, { title: '流程动作' },
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
          ...flow.map(([k, label]) => h('button', { key: k, type: k === 'invite' || k === 'interview' || k === 'assess' ? 'button' : 'button', style: k === 'elim' ? { ...btn, color: C.bad, borderColor: tint(C.bad, .4) } : ((k === 'invite' || k === 'interview' || k === 'assess') ? primary : btn), onClick: () => {
            if (k === 'assess') { run({ action: 'auto_assess', candidateId: c.id }); return }
            if (k === 'adopt') { run({ action: 'adopt', candidateId: c.id }); return }
            if (k === 'activate') { run({ action: 'activate', candidateId: c.id, reason: '重新激活' }); return }
            if (k === 'elim') { setPanel('elim'); return }
            setPanel('flow:' + k)
          } }, label))))))
      if (panel && panel.indexOf('flow:') === 0) {
        const k = panel.slice(5)
        if (k === 'copilot' || k === 'ai_interview') {
          out.push(h(InterviewCopilot, { candidate: c, position: detail.position, onCancel: () => setPanel(null), onDone: (j) => { setPanel(null); onAction(j) } }))
        } else out.push(h(FlowForm, { kind: k, candidate: c, position: detail.position, round: c.stage === '待复试' || c.stage === '复试中' ? '复试' : '初试',
          onCancel: () => setPanel(null), onDone: (body) => run(body) }))
      }
      if (lastSeq) out.push(h('button', { type: 'button', style: { ...btn, marginTop: 4 }, onClick: () => run({ action: 'rollback', candidateId: c.id, seq: lastSeq }) }, '↩ 撤销上一个动作'))
      if (toast) out.push(h('div', { style: { ...card, marginTop: 8, fontSize: 11.5, color: /^(失败|出错|错误)/.test(toast) ? C.bad : C.good, borderColor: /^(失败|出错|错误)/.test(toast) ? C.bad : C.good } }, toast))
      seg('证据视图', () => {
        if (c.deep) out.push(h(DeepAssessView, { deep: c.deep }))
        if (dims.length) out.push(h(AssessmentView, { detail }))
      })
      seg('技能对齐', () => {
        const sk = detail.skills || []
        const gap = detail.skillGap || { matched: [], missing: [], rate: null }
        const rd = (detail.candidate.parse || {}).readability || null
        const ocrFlag = !!(detail.candidate.parse || {}).ocr
        if (!sk.length && !rd) return
        const chip = (txt, color, bg) => h('span', { style: { fontSize: 11.5, padding: '2px 8px', borderRadius: 8, background: bg, color, border: '1px solid ' + C.border, marginRight: 4, marginBottom: 4, display: 'inline-block' } }, txt)
        out.push(h(Block, { title: '技能对齐 · 岗位要求 vs 简历技能' },
          h('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 } },
            gap.rate != null ? h('b', { style: { fontSize: 13, color: gap.rate >= 60 ? C.good : gap.rate >= 30 ? C.warn : C.bad } }, '岗位技能匹配 ' + gap.rate + '%') : null,
            rd ? h('span', { style: { fontSize: 11.5, color: rd.score >= 80 ? C.good : rd.score >= 60 ? C.warn : C.bad } }, 'ATS 可读性 ' + rd.score + ' 分') : null,
            ocrFlag ? h('span', { style: { fontSize: 11.5, padding: '1px 7px', borderRadius: 9, background: 'rgba(168,85,247,.14)', color: '#c084fc' } }, '⚡ Vision OCR 文本化') : null),
          sk.length ? h('div', { style: { marginBottom: 4 } },
            h('div', { style: { fontSize: 11.5, color: C.muted, marginBottom: 3 } }, '候选人技能 · ' + sk.length),
            ...sk.slice(0, 14).map(x => chip(x.name, C.good, 'rgba(18,160,106,.10)'))) : null,
          (gap.missing || []).length ? h('div', { style: { marginTop: 4 } },
            h('div', { style: { fontSize: 11.5, color: C.muted, marginBottom: 3 } }, '待补技能 · ' + gap.missing.length),
            ...gap.missing.slice(0, 10).map(x => chip(x.name, C.warn, 'rgba(217,138,11,.10)'))) : null,
          rd && rd.issues && rd.issues.length ? h('div', { style: { fontSize: 11.5, color: C.muted, marginTop: 4 } }, '排版提示：' + rd.issues.slice(0, 3).join('；')) : null))
      })
      seg('简历原文', () => out.push(h(Block, { title: '简历原文' },
        h('button', { type: 'button', style: { ...btn, width: '100%' }, onClick: () => setShowResume(v => !v) }, showResume ? '收起' : '展开'),
        showResume ? h('div', { style: { marginTop: 7 } }, h(ResumeView, { text: c.resume, maxH: 420 })) : null)))
      seg('影响面', () => out.push(h(Block, { title: '影响面' }, h('div', { style: { fontSize: 11.5, color: C.muted } }, detail.impact ? detail.impact.summary : '—'))))
      out.push(h('button', { type: 'button', style: { ...btn, marginTop: 8, width: '100%' }, onClick: () => onOpenLog && onOpenLog() }, '查看完整工作日志 →'))
      return h('div', null, ...out)
    }

    /* ============ 表单：建岗 / 邮箱 / 上传 ============ */
    function Field({ label, value, onChange, placeholder, type }) {
      return h('label', { style: { fontSize: 11.5, color: C.muted, display: 'block' } }, label,
        h('input', { style: input, type: type || 'text', value, placeholder: placeholder || '', onChange: e => onChange(e.target.value) }))
    }

    // 职位管理：职位列表 + 新建（AI 生成结构化 JD，可迭代）
    function ScorecardView({ sc, markdown }) {
      if (!sc && !markdown) return h('div', { style: { fontSize: 11.5, color: C.muted } }, '尚未生成评分卡')
      if (!sc || ((!sc.hardGates || !sc.hardGates.length) && (!sc.softDims || !sc.softDims.length))) {
        return h('pre', { style: { fontSize: 11.5, whiteSpace: 'pre-wrap', lineHeight: 1.7, margin: 0, fontFamily: 'ui-monospace, monospace' } }, markdown || '')
      }
      const sec = (t, col) => h('div', { style: { fontWeight: 700, fontSize: 11.5, marginTop: 10, marginBottom: 4, color: col || 'inherit' } }, t)
      return h('div', { style: { fontSize: 11.5, lineHeight: 1.7 } },
        sc.businessFocus ? h('div', { style: { fontSize: 11.5, color: C.muted } }, '业务重点对齐：' + sc.businessFocus) : null,
        sec('第一轨 · 硬性门槛（一票否决）', C.bad),
        h('div', null, ...(sc.hardGates || []).map((g, i) => h('div', { key: i, style: { marginLeft: 4, marginBottom: 3 } },
          h('b', null, '• ' + g.item), h('span', { style: { fontSize: 11.5, color: C.muted } }, '（' + (g.rule || '') + (g.rejectIf ? '；' + g.rejectIf : '') + '）')))),
        sec('第二轨 · 业务价值与能力匹配（加权得分）', C.accent),
        h('div', null, ...(sc.softDims || []).map((dm, i) => h('div', { key: i, style: { marginBottom: 6, paddingLeft: 4, borderLeft: '2px solid ' + C.accent } },
          h('b', null, dm.name + '（' + dm.weight + '%）'),
          ...(dm.levels || []).map((lv, j) => h('div', { key: j, style: { fontSize: 11.5, color: C.muted, marginTop: 1 } }, '· ' + lv.desc + '：' + lv.min + '–' + lv.max + ' 分'))))),
        h('div', { style: { fontSize: 11.5, color: C.muted, marginTop: 8 } },
          '反伪相关黑名单：' + (sc.antiBias || []).join('、') + '　|　生成：' + (sc.meta ? sc.meta.generatedBy : '—')))
    }

    function JDView({ jd, markdown }) {
      if (!jd && !markdown) return h('div', { style: { fontSize: 11.5, color: C.muted } }, '尚未生成 JD')
      // 优先渲染结构化对象；无结构则退化为 Markdown 原文
      if (!jd || (!jd.corePurpose && !(jd.responsibilities || []).length)) {
        return h('pre', { style: { fontSize: 11.5, whiteSpace: 'pre-wrap', lineHeight: 1.7, margin: 0, fontFamily: 'ui-monospace, monospace' } }, markdown || '')
      }
      const q = jd.qualifications || {}
      const sec = (t) => h('div', { style: { fontWeight: 700, fontSize: 11.5, marginTop: 10, marginBottom: 4 } }, t)
      return h('div', { style: { fontSize: 11.5, lineHeight: 1.7 } },
        sec('1. 职务核心目的'), h('div', null, jd.corePurpose || '—'),
        sec('2. 组织定位与协作网络'), h('div', null, jd.orgPosition || '—'),
        sec('3. 核心职责与 KPI'),
        h('div', null, ...(jd.responsibilities || []).map((r, i) => h('div', { key: i, style: { marginBottom: 6, paddingLeft: 8, borderLeft: '2px solid ' + C.accent } },
          h('div', null, h('b', null, (i + 1) + '. '), (r.action ? h('b', null, r.action + ' ') : null), (r.content || '')),
          (r.kpi || r.businessGoal) ? h('div', { style: { fontSize: 11.5, color: C.muted, marginTop: 2 } }, [r.kpi ? r.kpi : '', r.businessGoal ? '（目的：' + r.businessGoal + '）' : ''].filter(Boolean).join(' ')) : null))),
        sec('4. 任用门槛'),
        h('div', null, '技能：' + ((q.skills || []).join('、') || '—')),
        h('div', null, '经验：' + (q.experience || '—')),
        h('div', null, '复杂度：' + (q.complexity || '—')),
        jd.iterationDiff ? h('div', null, sec('5. 迭代对照说明'), h('div', null, jd.iterationDiff)) : null,
        h('div', { style: { fontSize: 11.5, color: C.muted, marginTop: 8 } }, '生成来源：' + (jd.meta ? jd.meta.generatedBy : '—'))
      )
    }

    // JD 合规与质量质检卡（纯规则：歧视词 + 结构质量）
    function JDQualityCard({ text }) {
      const [state, setState] = React.useState({ loading: false, result: null })
      React.useEffect(() => {
        let alive = true
        if (!text || text.length < 20) { setState({ loading: false, result: null }); return }
        setState({ loading: true, result: null })
        api('/api/ai-recruiting/compliance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
          .then(j => { if (alive) setState({ loading: false, result: (j && j.result) || null }) })
          .catch(() => { if (alive) setState({ loading: false, result: null }) })
        return () => { alive = false }
      }, [text])
      const r = state.result
      if (state.loading) return h('div', { style: { ...card, marginTop: 8, fontSize: 11.5, color: C.muted } }, 'JD 合规质检中…')
      if (!r) return null
      const lvlColor = (l) => l === 'high' ? C.bad : l === 'mid' ? C.warn : C.muted
      return h('div', { style: { ...card, marginTop: 8 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 } },
          h('b', { style: { fontSize: 11.5 } }, 'JD 合规与质量质检'),
          h('span', { style: { fontSize: 12.5, fontWeight: 800, color: r.score >= 85 ? C.good : r.score >= 60 ? C.warn : C.bad } }, r.score + ' 分'),
          h('span', { style: { fontSize: 11.5, color: C.muted } }, r.summary)),
        (r.risks || []).length ? h('div', { style: { marginBottom: 4 } },
          ...r.risks.slice(0, 6).map((x, i) => h('div', { key: i, style: { fontSize: 11.5, color: lvlColor(x.level), marginTop: 2 } },
            '⚠ ' + x.word + '（' + x.category + '）：' + x.advice))) : null,
        (r.suggestions || []).length ? h('div', { style: { fontSize: 11.5, color: C.muted, marginTop: 4 } }, '建议：' + r.suggestions.slice(0, 3).join('；')) : null,
        h('div', { style: { fontSize: 10.5, color: C.muted, marginTop: 4 } },
          '结构：硬性要求 ' + ((r.structure || {}).must || 0) + ' 条 · 加分项 ' + ((r.structure || {}).nice || 0) + ' 条 · 职责 ' + ((r.structure || {}).duties || 0) + ' 条 · ' + ((r.structure || {}).hasSalary ? '含薪资区间' : '缺薪资区间')))
    }

    // 关岗去向弹窗（有在途候选人时必须选去向）
    function ClosePositionModal({ ctx, onCancel, onChoose }) {
      if (!ctx) return null
      return h('div', { style: { position: 'fixed', inset: 0, background: 'rgba(8,12,22,.55)', backdropFilter: 'blur(3px)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }, onClick: (e) => { if (e.target === e.currentTarget) onCancel() } },
        h('div', { style: { width: 480, maxWidth: '94vw', maxHeight: '86vh', overflowY: 'auto', background: 'var(--dsw-alias-surface-1,#161c2a)', border: '1px solid ' + C.border, borderRadius: 14, padding: 16 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
            h('b', { style: { fontSize: 13 } }, '关闭「' + ctx.title + '」'),
            h('span', { style: { fontSize: 10, padding: '1px 7px', borderRadius: 8, background: tint(C.warn,.14), color: C.warn } }, '有 ' + ctx.count + ' 人在途')),
          h('div', { style: { fontSize: 11, color: C.muted, marginBottom: 8, lineHeight: 1.6 } }, ctx.message),
          h('div', { style: { background: C.surface, borderRadius: 8, padding: '7px 10px', marginBottom: 10, maxHeight: 140, overflowY: 'auto' } },
            ...(ctx.candidates || []).map(c => h('div', { key: c.id, style: { display: 'flex', gap: 8, fontSize: 11, padding: '2px 0' } }, h('b', { style: { flex: 1 } }, c.name), h('span', { style: { color: C.muted } }, c.stage)))),
          h('div', { style: { fontSize: 11.5, fontWeight: 600, marginBottom: 6 } }, '这些候选人怎么处理？'),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            ...[['talent', '转入人才库', '保留人才，可随时激活召回'], ['eliminate', '淘汰终止', '流程终止（可回溯）'], ['keep', '保留跟随', '仍挂此岗，之后单独处理']].map(([d, t, hint]) =>
              h('button', { type: 'button', key: d, style: { ...btn, textAlign: 'left', padding: '8px 12px' }, onClick: () => onChoose(d) },
                h('div', { style: { fontWeight: 600 } }, t), h('div', { style: { fontSize: 10.5, color: C.muted } }, hint)))),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 10 } }, h('button', { type: 'button', style: { ...btn }, onClick: onCancel }, '取消'))))
    }

    function PositionForm({ positions, hiring, salaryAccuracy, salaryCal, onDone, onCancel }) {
      const [view, setView] = React.useState('list') // list | new | edit
      const [importOpen, setImportOpen] = React.useState(false)
      const [importText, setImportText] = React.useState('')
      const [importBusy, setImportBusy] = React.useState(false)
      const [importMsg, setImportMsg] = React.useState('')
      const [closeCtx, setCloseCtx] = React.useState(null)
      const [importFailUrl, setImportFailUrl] = React.useState('')
      const [needPerm, setNeedPerm] = React.useState(false)
      const [editingId, setEditingId] = React.useState(null)
      const EMPTY = { title: '', dept: '', city: '', bandMin: '', bandMax: '', headcount: '', gates: '', abilities: '', businessContext: '', expYears: '' }
      const [f, setF] = React.useState(EMPTY)
      const set = (k, v) => setF(o => ({ ...o, [k]: v }))
      const [msg, setMsg] = React.useState('')
      const [genBusy, setGenBusy] = React.useState(false)
      const [jdObj, setJdObj] = React.useState(null)
      const [jdRaw, setJdRaw] = React.useState('')
      const [rawView, setRawView] = React.useState(false)
      const [scObj, setScObj] = React.useState(null)
      const [scMd, setScMd] = React.useState('')
      const [scBusy, setScBusy] = React.useState(false)
      const [jdMd, setJdMd] = React.useState('')
      const [editRaw, setEditRaw] = React.useState(false)
      const [salary, setSalary] = React.useState(null)
      const [salBusy, setSalBusy] = React.useState(false)
      const genSalary = async () => {
        setSalBusy(true)
        try {
          const q = new URLSearchParams({ title: f.title || '', dept: f.dept || '', city: f.city || '', abilities: f.abilities || '', expYears: f.expYears || '', bandMin: f.bandMin || '', bandMax: f.bandMax || '', positionId: editingId || '' })
          const j = await api('/api/ai-recruiting/salary-benchmark?' + q.toString())
          setSalary(j)
          // 记录建议（有 P50 时）用于「建议 vs 实招」自校准
          if (editingId && j && j.P50 != null) {
            try { await api('/api/ai-recruiting/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'salary_advised', positionId: editingId, P25: j.P25, P50: j.P50, P75: j.P75, source: j.source, aiEstimate: !!j.aiEstimate, bandMin: f.bandMin, bandMax: f.bandMax }) }); onDone && onDone() } catch (e) {}
          }
        } catch (e) { setMsg('获取薪酬参考失败：' + e.message) }
        setSalBusy(false)
      }

      const genJD = async () => {
        if (!f.title.trim()) { setMsg('先生成 JD 需要填职位名称'); return }
        setGenBusy(true); setMsg('')
        try {
          // 走 LLM 端点（可用模型则真调模型，失败降级规则版）
          const j = await api('/api/ai-recruiting/generate-jd', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...f, sourceText: jdRaw || '' }) })
          setJdObj(j.jd || null)
          setJdMd(j.markdown || '')
          setMsg(j.source === 'llm' ? '已由 AI 生成 JD，可编辑或保存' : 'AI 暂不可用，已用规则引擎生成草稿' + (j.llmError ? '（' + j.llmError + '）' : ''))
        } catch (e) { setMsg('生成失败：' + e.message) }
        setGenBusy(false)
      }
      const genScorecard = async () => {
        if (!f.title.trim()) { setMsg('先生成评分卡需要填职位名称'); return }
        setScBusy(true); setMsg('')
        try {
          const j = await api('/api/ai-recruiting/generate-scorecard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...f, jdObj: jdObj || null }) })
          setScObj(j.scorecard || null)
          setScMd(j.markdown || '')
          setMsg(j.source === 'llm' ? '已由 AI 按 JD 生成评分卡' : '已用规则引擎生成评分卡' + (j.llmError ? '（' + j.llmError + '）' : ''))
        } catch (e) { setMsg('生成评分卡失败：' + e.message) }
        setScBusy(false)
      }
      const submit = async () => {
        if (!f.title.trim()) { setMsg('职位名称必填'); return }
        try {
          const common = { ...f, jd: jdMd || '', jdRaw: jdRaw || '', jdObj: jdObj || null, scorecard: scObj || null, scorecardMarkdown: scMd || '' }
          const payload = editingId ? { action: 'update_position', positionId: editingId, ...common } : { action: 'create_position', ...common }
          const j = await postAction(payload)
          setMsg(editingId ? '已保存修改：' + j.title : '已建立 ' + j.title)
          setF(EMPTY); setJdObj(null); setJdMd(''); setScObj(null); setScMd(''); setEditingId(null)
          setView('list'); onDone()
        } catch (e) { setMsg('失败：' + e.message) }
      }
      // 载入某职位到表单进行编辑
      const editPosition = (p) => {
        setEditingId(p.id)
        setF({ title: p.title || '', dept: p.dept || '', city: p.city || '', bandMin: (p.band && p.band[0]) || '', bandMax: (p.band && p.band[1]) || '', headcount: p.hc || '', gates: (p.gates || []).join('、'), abilities: (p.abilities || []).join('、'), businessContext: '', expYears: p.expYears || '', standard: p.standard || '' })
        setJdObj(p.jdObj || null); setJdMd(p.jd || ''); setJdRaw(p.jdRaw || ''); setScObj(p.scorecard || null); setScMd(p.scorecardMarkdown || ''); setSalary(null); setMsg('')
        setView('new')
      }
      const list = positions || []
      const stats = {}
      for (const hr of (hiring || [])) stats[hr.id] = hr
      const actPos = async (body) => {
        try {
          const j = await api(ACTION, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
          if (j && j.needDisposition) { setCloseCtx({ positionId: body.positionId, title: (positions || []).find(x => x.id === body.positionId)?.title || '', candidates: j.candidates || [], count: j.inFlightCount, message: j.message }); return }
          setMsg(j.message || '完成'); onDone && onDone()
        } catch (e) { setMsg('失败：' + String(e.message || e)) }
      }
      const doImport = async (file) => {
        setImportBusy(true); setImportMsg('')
        try {
          let body = {}
          if (file) {
            const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(file) })
            body = { filename: file.name, contentBase64: b64 }
          } else {
            if (!importText.trim()) { setImportMsg('请粘贴 JD 文本或选择文件'); setImportBusy(false); return }
            body = { text: importText }
          }
          const j = await api('/api/ai-recruiting/position-import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
          if (!j || !j.ok) {
            setImportMsg('解析失败：' + ((j && j.reason) || '未知'))
            setImportFailUrl(/^https?:\/\//i.test(importText.trim()) ? importText.trim() : '')
            setNeedPerm(!!(j && (j.needBrowserPerm || j.reason && j.reason.indexOf('登录') >= 0)))
            return
          }
          setNeedPerm(false)
          setImportFailUrl('')
          const fl = j.fields || {}
          setF({ title: fl.title || '', dept: fl.dept || '', city: fl.city || '', bandMin: fl.bandMin != null ? String(fl.bandMin) : '', bandMax: fl.bandMax != null ? String(fl.bandMax) : '', headcount: fl.headcount != null ? String(fl.headcount) : '', gates: (fl.gates || []).join('、'), abilities: (fl.abilities || []).join('、'), businessContext: fl.summary || '', expYears: fl.expYears != null ? String(fl.expYears) : '' })
          setJdObj(null); setJdMd(''); setJdRaw(String(j.text || ''))
          setEditingId(null); setView('new'); setImportOpen(false)
          setMsg('已导入 JD 原文（' + String(j.text || '').length + ' 字）并预填字段，请核对后保存；如需结构化职责说明书可再点「把原文结构化」')
        } catch (e) { setImportMsg('解析失败：' + String(e.message || e)) } finally { setImportBusy(false) }
      }
      const posRow = (p) => {
        const hr = stats[p.id] || {}
        const closed = (p.status || '在招') !== '在招'
        return h('div', { key: p.id, style: { padding: '9px 12px', borderBottom: '1px solid ' + C.border } },
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h('b', { style: { fontSize: 12.5 } }, p.title),
            h('span', { style: { fontSize: 11.5, color: C.muted } }, [p.dept, p.city].filter(Boolean).join(' / ') || '未填部门'),
            p.band && (p.band[0] || p.band[1]) ? h('span', { style: { fontSize: 11.5, color: C.muted } }, p.band[0] + '–' + p.band[1] + 'K') : null,
            h('span', { style: { fontSize: 11.5, padding: '1px 7px', borderRadius: 8, background: closed ? C.surface : 'rgba(18,160,106,.12)', color: closed ? C.muted : C.good, fontWeight: 600 } }, p.status || '在招'),
            hr.round > 1 ? h('span', { style: { fontSize: 10.5, padding: '0 6px', borderRadius: 7, background: 'rgba(124,58,237,.12)', color: '#a78bfa' } }, '第 ' + hr.round + ' 轮') : (p.parentId ? h('span', { style: { fontSize: 10.5, padding: '0 6px', borderRadius: 7, background: 'rgba(124,58,237,.12)', color: '#a78bfa' } }, '复开') : null),
            hr.canClose ? h('span', { style: { fontSize: 10.5, padding: '0 6px', borderRadius: 7, background: 'rgba(18,160,106,.14)', color: C.good, fontWeight: 600 } }, '✓ 已满编 · 可关闭') : null,
            p.jd ? h('span', { style: { fontSize: 10.5, padding: '0 6px', borderRadius: 7, background: C.surface, border: '1px solid ' + C.border, color: C.muted } }, 'JD') : null,
            p.scorecard ? h('span', { style: { fontSize: 10.5, padding: '0 6px', borderRadius: 7, background: C.surface, border: '1px solid ' + C.border, color: C.muted } }, '评分卡') : null,
            h('div', { style: { flex: 1 } }),
            closed
              ? h('button', { type: 'button', style: { ...primary, padding: '1px 9px', fontSize: 11.5 }, onClick: () => actPos({ action: 'reopen_position', positionId: p.id }) }, '♻ 重新开放')
              : h('button', { type: 'button', style: { ...btn, padding: '1px 8px', fontSize: 11.5 }, onClick: () => actPos({ action: 'close_position', positionId: p.id }) }, '关闭'),
            h('button', { type: 'button', style: { ...btn, padding: '1px 8px', fontSize: 11.5 }, onClick: () => editPosition(p) }, '编辑')),
          (hr.hc || p.hc) ? h('div', { style: { display: 'flex', gap: 12, fontSize: 11.5, color: C.muted, marginTop: 3 } },
            h('span', null, '需求 ' + (hr.hc || p.hc) + ' 人'),
            h('span', null, '已入职 ' + (hr.hired || 0)),
            h('span', null, '在途 ' + (hr.inFlow || 0)),
            h('span', { style: { color: (hr.gap || 0) > 0 ? C.warn : C.good } }, '缺口 ' + (hr.gap != null ? hr.gap : (p.hc || 1))),
            hr.avgDays != null ? h('span', null, '本轮到岗 ' + hr.avgDays + 'd' + (hr.prevAvgDays != null ? '（上轮 ' + hr.prevAvgDays + 'd）' : '')) : null) : null)
      }
      const groupTitle = (t, n) => h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, marginBottom: 4 } },
        h('b', { style: { fontSize: 11.5, color: C.muted } }, t), h('span', { style: { fontSize: 11.5, color: C.muted } }, n + ' 个'))
      const openList = list.filter(p => (p.status || '在招') === '在招')
      const closedList = list.filter(p => (p.status || '在招') !== '在招')
      const listView = h('div', null,
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 8 } },
          h('b', null, '职位库 · ' + list.length),
          h('div', { style: { display: 'flex', gap: 6 } },
            h('button', { type: 'button', style: primary, onClick: () => { setEditingId(null); setF(EMPTY); setJdObj(null); setJdMd(''); setScObj(null); setScMd(''); setView('new'); setMsg('') } }, '＋ 新建职位'),
            h('button', { type: 'button', style: { ...btn }, onClick: () => { setImportOpen(v => !v); setImportMsg('') } }, '📄 导入 JD'))),
        msg ? h('div', { style: { fontSize: 11.5, color: C.muted, marginBottom: 6 } }, msg) : null,
        (function () {
          const closable = (hiring || []).filter(x => x.canClose).length
          return closable ? h('div', { style: { fontSize: 11.5, color: C.good, marginBottom: 6 } }, '✓ 有 ' + closable + ' 个职位已满编且无在途，建议关闭（关闭后可随时重新开放）') : null
        })(),
        importOpen ? h('div', { style: { ...card, borderColor: C.accent, marginBottom: 9 } },
          h('div', { style: { fontSize: 11.5, fontWeight: 700, marginBottom: 5 } }, '导入 JD'),
          h('div', { style: { fontSize: 11.5, color: C.muted, marginBottom: 6 } }, '三种方式：① 上传文件（PDF/Word/图片扫描件自动识别）② 粘贴 JD 文字 ③ 粘贴职位链接（招聘网站详情页自动渲染）→ AI 抽取字段并清洗出职责与要求 → 你核对后保存'),
          h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
            h('label', { style: { ...primary, padding: '4px 12px', fontSize: 11.5, display: 'inline-block', cursor: 'pointer' } }, importBusy ? '解析中…' : '选择文件',
              h('input', { type: 'file', accept: '.pdf,.docx,.doc,.txt,.md,.png,.jpg,.jpeg,.webp', style: { display: 'none' }, disabled: importBusy,
                onChange: e => { const f2 = e.target.files && e.target.files[0]; if (f2) doImport(f2); e.target.value = '' } })),
            h('span', { style: { fontSize: 11.5, color: C.muted } }, '或粘贴文本：')),
          h('textarea', { style: { ...input, minHeight: 70, marginTop: 6, fontFamily: 'inherit' }, value: importText, placeholder: '粘贴 JD 原文，或直接粘贴职位链接（https://…）', onChange: e => setImportText(e.target.value) }),
          h('div', { style: { display: 'flex', gap: 6, marginTop: 6 } },
            h('button', { type: 'button', style: primary, disabled: importBusy, onClick: () => doImport(null) }, importBusy ? '解析中…' : '✨ 解析并预填'),
            h('button', { type: 'button', style: btn, onClick: () => { setImportOpen(false); setImportMsg('') } }, '取消')),
          importMsg ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 5, flexWrap: 'wrap' } },
            h('span', { style: { fontSize: 11.5, color: C.muted } }, importMsg),
            importFailUrl ? h('button', { type: 'button', style: { ...btn, padding: '2px 9px', fontSize: 11.5 }, onClick: async () => {
              try { const j2 = await api('/api/ai-recruiting/open-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: importFailUrl }) }); setImportMsg(j2.message || '已打开') } catch (e) { setImportMsg('打开失败：' + String(e.message || e)) }
            } }, '↗ 在浏览器打开') : null) : null,
          needPerm ? h('div', { style: { fontSize: 11.5, color: C.warn, lineHeight: 1.7, marginTop: 4, background: 'rgba(245,158,11,.08)', borderRadius: 7, padding: '6px 9px' } },
            h('b', null, '该页面需要登录或未能渲染出正文'),
            h('div', null, '已自动尝试：直接抓取 → 后台静默浏览器渲染。仍失败通常意味着页面要求登录（如招聘网站详情页）。'),
            h('div', null, '最稳方式：在浏览器打开该链接，复制 JD 文字后粘贴到上方输入框。')) : null) : null,
        list.length ? h('div', null,
          openList.length ? h('div', null, groupTitle('在招', openList.length),
            h('div', { style: { border: '1px solid ' + C.border, borderRadius: 9, overflow: 'hidden' } }, ...openList.map(posRow))) : null,
          closedList.length ? h('div', null, groupTitle('已关闭 / 已满编', closedList.length),
            h('div', { style: { border: '1px solid ' + C.border, borderRadius: 9, overflow: 'hidden' } }, ...closedList.map(posRow))) : null)
        : h('div', { style: { padding: 16, fontSize: 11.5, color: C.muted, textAlign: 'center', border: '1px dashed ' + C.border, borderRadius: 9 } }, '还没有职位：可以 ＋新建、📄导入 JD（文件/文字/链接），或从已关闭职位「重新开放」'))

      const newView = h('div', null,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
          h('button', { type: 'button', style: btn, onClick: () => { setView('list'); setMsg(''); setEditingId(null) } }, '← 返回列表'),
          h('b', null, editingId ? '编辑职位' : '新建职位')),
        h('div', { style: { marginBottom: 8 } },
          h('label', { style: { fontSize: 11.5, color: C.muted, display: 'block', marginBottom: 3 } }, '参考已有职位'),
          h('select', { style: { ...input, width: 320 }, defaultValue: '', onChange: e => {
            const src3 = (positions || []).find(x => x.id === e.target.value)
            if (!src3) return
            setF(o => ({ ...o, title: o.title || src3.title, dept: o.dept || src3.dept || '', city: o.city || src3.city || '', bandMin: src3.band && src3.band[0] ? String(src3.band[0]) : o.bandMin, bandMax: src3.band && src3.band[1] ? String(src3.band[1]) : o.bandMax, headcount: o.headcount || String(src3.hc || ''), gates: o.gates || (src3.gates || []).join('、'), abilities: o.abilities || (src3.abilities || []).join('、') }))
            setMsg('已参考「' + src3.title + '」预填，可修改后保存')
          } },
            h('option', { value: '' }, '— 不参考 —'),
            ...(positions || []).map(p => h('option', { key: p.id, value: p.id }, p.title + '（' + [p.dept, p.city].filter(Boolean).join('/') + '）')))),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: 8 } },
          h(Field, { label: '职位名称*', value: f.title, onChange: v => set('title', v) }),
          h(Field, { label: '部门', value: f.dept, onChange: v => set('dept', v) }),
          h(Field, { label: '城市', value: f.city, onChange: v => set('city', v) }),
          h(Field, { label: '招聘人数', value: f.headcount, onChange: v => set('headcount', v) }),
          h(Field, { label: '经验要求(年)', value: f.expYears, onChange: v => set('expYears', v) }),
          h(Field, { label: '薪资下限K', value: f.bandMin, onChange: v => set('bandMin', v) }),
          h(Field, { label: '薪资上限K', value: f.bandMax, onChange: v => set('bandMax', v) }),
          h(Field, { label: '硬门槛(顿号分隔)', value: f.gates, onChange: v => set('gates', v) }),
          h(Field, { label: '能力项(顿号分隔,按优先级)', value: f.abilities, onChange: v => set('abilities', v) })),
        // 薪酬区间：分位值 + AI 建议（数据来源：本年度薪酬报告）
        h('div', { style: { marginTop: 10, border: '1px solid ' + C.border, borderRadius: 9, padding: 10 } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 } },
            h('b', { style: { fontSize: 12.5 } }, '薪酬区间 · 市场分位值与 AI 建议'),
            salaryCal && salaryCal.correction ? h('span', { style: { fontSize: 10.5, padding: '1px 7px', borderRadius: 8, background: 'rgba(18,160,106,.14)', color: C.good, marginLeft: 6 } }, '✓ 已用实招校准（' + salaryCal.note + '）') : null,
            h('button', { type: 'button', style: primary, disabled: salBusy, onClick: genSalary }, salBusy ? '查询中…' : '⚡ 生成薪酬建议')),
          salary && salary.noData ? h('div', { style: { fontSize: 11.5, lineHeight: 1.7, color: C.warn, padding: '6px 0' } },
            h('b', null, '暂无该岗位薪酬基准'),
            h('div', { style: { color: C.muted, marginTop: 3, fontSize: 11.5 } }, '未命中报告且 AI 不可用；以你的招聘实招数据为准。'))
          : salary ? h('div', { style: { fontSize: 11.5, lineHeight: 1.7 } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 5 } },
              salary.blended ? h('span', { style: { fontSize: 10.5, padding: '1px 7px', borderRadius: 8, background: 'rgba(124,58,237,.16)', color: '#a78bfa', fontWeight: 700 } }, '综合加权 · 置信' + (salary.confidence === 'high' ? '高' : salary.confidence === 'mid' ? '中' : '低')) : null,
              salary.calibrated ? h('span', { style: { fontSize: 10.5, padding: '1px 7px', borderRadius: 8, background: 'rgba(18,160,106,.16)', color: C.good, fontWeight: 700 } }, '✓ 已按实招校准 ×' + salary.calibFactor) : null,
              salary.aiEstimate
                ? h('span', { style: { fontSize: 10.5, padding: '1px 7px', borderRadius: 8, background: 'rgba(245,158,11,.14)', color: C.warn, fontWeight: 600 } }, 'AI 市场估算（非报告数据，供参考）')
                : h('span', { style: { fontSize: 10.5, padding: '1px 7px', borderRadius: 8, background: 'rgba(18,160,106,.14)', color: C.good, fontWeight: 600 } }, '真实薪酬报告数据'),
              h('span', { style: { fontSize: 11.5, color: C.muted } }, (salary.role ? '岗位：' + salary.role + '　' : '') + '城市等级：' + (salary.cityTier || '') + (salary.expFactor ? '　经验系数 ' + salary.expFactor : ''))),
            (salary.currentSalaries && salary.currentSalaries.length) ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(124,58,237,.08)', border: '1px solid rgba(124,58,237,.35)', borderRadius: 8, padding: '6px 10px', marginBottom: 6 } },
              h('span', { style: { fontSize: 10.5, fontWeight: 700, color: '#a78bfa', flex: 'none' } }, '候选人现薪'),
              h('span', { style: { fontSize: 11.5 } }, salary.currentSalaries.length + ' 人复试现薪：' + salary.currentSalaries.slice().sort((a, b) => a - b).join('/') + 'K'),
              h('span', { style: { fontSize: 11.5, color: C.muted, marginLeft: 'auto' } }, '你至少得出到这个数')) : null,
            (salary.actual && salary.actual.count) ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(18,160,106,.08)', border: '1px solid rgba(18,160,106,.35)', borderRadius: 8, padding: '6px 10px', marginBottom: 6 } },
              h('span', { style: { fontSize: 10.5, fontWeight: 700, color: C.good, flex: 'none' } }, '✓ 本岗位实招'),
              h('span', { style: { fontSize: 11.5 } }, '已发 ' + salary.actual.count + ' 个 Offer：' + salary.actual.min + 'K ~ ' + salary.actual.max + 'K，中位 ' + salary.actual.median + 'K'),
              h('span', { style: { fontSize: 11.5, color: C.muted, marginLeft: 'auto' } }, '建议以此为锚点')) : null,
            h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6 } },
              ...[['P25', salary.P25], ['P50', salary.P50], ['P75', salary.P75]].map(([k, v]) => h('div', { key: k, style: { flex: '1 1 80px', background: C.surface, borderRadius: 8, padding: '6px 10px', textAlign: 'center', border: '1px solid ' + C.border } },
                h('div', { style: { fontSize: 11.5, color: C.muted } }, k), h('div', { style: { fontSize: 17, fontWeight: 800 } }, v + 'K')))),
            h('div', { style: { background: 'rgba(47,107,255,.08)', border: '1px solid ' + C.accent, borderRadius: 8, padding: '7px 10px' } },
              h('b', null, 'AI 建议区间：' + salary.suggest.min + '–' + salary.suggest.max + 'K'),
              h('span', { style: { fontSize: 11.5, color: C.muted } }, '（中位 ' + salary.suggest.mid + 'K）'),
              h('div', { style: { fontSize: 11.5, color: C.muted, marginTop: 3 } }, salary.positioning || '')),
            h('div', { style: { fontSize: 11.5, color: C.muted, marginTop: 5 } }, salary.reason))
            : h('div', { style: { fontSize: 11.5, color: C.muted, padding: '10px 0', lineHeight: 1.7 } },
                h('div', null, '填好职位/城市/经验后点「⚡ 生成薪酬建议」。'),
                h('div', { style: { fontSize: 11.5, marginTop: 4 } }, editingId ? '本次岗位的实招价与候选人现薪（同口径）会自动纳入参考并按优先级加权。' : '提示：新建职位尚未保存，暂无本岗位的实招/现薪数据；保存后再次生成可纳入同岗位口径的成交价与候选人现薪。'))),
        // 业务背景 / 迭代输入
        h('label', { style: { fontSize: 11.5, color: C.muted, display: 'block', marginTop: 10 } }, '业务背景 / 变更点',
          h('textarea', { style: { width: '100%', minHeight: 50, border: '1px solid ' + C.border, borderRadius: 7, padding: 7, fontSize: 11.5, boxSizing: 'border-box', background: 'transparent', color: 'inherit' },
            placeholder: '如：新开门店扩张、要求加强损耗管控、新增线上直播职责……（首次制定可留空）',
            value: f.businessContext, onChange: e => set('businessContext', e.target.value) })),
        // JD 区
        h('div', { style: { marginTop: 10, border: '1px solid ' + C.border, borderRadius: 9, padding: 10 } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, flexWrap: 'wrap', gap: 8 } },
            h('b', { style: { fontSize: 12.5, whiteSpace: 'nowrap' } }, '岗位 JD'),
            h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', flexShrink: 0 } },
              (!jdObj && jdRaw) ? h('span', { style: { fontSize: 10.5, padding: '1px 7px', borderRadius: 8, background: 'rgba(18,160,106,.12)', color: C.good } }, '已导入原文') : null,
              (jdObj && jdRaw) ? h('button', { type: 'button', style: btn, onClick: () => setRawView(v => !v) }, rawView ? '看结构化' : '看原文') : null,
              (jdObj || jdMd) ? h('button', { type: 'button', style: btn, onClick: () => setEditRaw(v => !v) }, editRaw ? '收起编辑' : '编辑') : null,
              h('button', { type: 'button', style: { ...primary, whiteSpace: 'nowrap' }, disabled: genBusy, onClick: genJD }, genBusy ? '生成中…' : (jdObj ? '⚡ 重新生成/迭代' : (jdRaw ? '⚡ 结构化为 JD' : '⚡ AI 生成岗位 JD')))),
          rawView && jdRaw
            ? h('textarea', { style: { width: '100%', minHeight: 240, maxHeight: 400, border: '1px solid ' + C.border, borderRadius: 7, padding: '8px 10px', fontSize: 11.5, boxSizing: 'border-box', background: 'transparent', color: 'inherit', fontFamily: 'inherit', lineHeight: 1.7, resize: 'vertical' }, value: jdRaw, onChange: e => setJdRaw(e.target.value) })
            : (jdObj || jdMd)
              ? (editRaw
                ? h('textarea', { style: { width: '100%', minHeight: 260, border: '1px solid ' + C.border, borderRadius: 7, padding: 8, fontSize: 11.5, boxSizing: 'border-box', background: 'transparent', color: 'inherit', fontFamily: 'ui-monospace, monospace', lineHeight: 1.6 }, value: jdMd, onChange: e => setJdMd(e.target.value) })
                : h('div', { style: { border: '1px solid ' + C.border, borderRadius: 7, padding: '4px 10px', maxHeight: 340, overflow: 'auto' } }, h(JDView, { jd: jdObj, markdown: jdMd })))
              : (jdRaw
                ? h('textarea', { style: { width: '100%', minHeight: 240, maxHeight: 400, border: '1px solid ' + C.border, borderRadius: 7, padding: '8px 10px', fontSize: 11.5, boxSizing: 'border-box', background: 'transparent', color: 'inherit', fontFamily: 'inherit', lineHeight: 1.7, resize: 'vertical' }, value: jdRaw, onChange: e => setJdRaw(e.target.value) })
                : h('div', { style: { fontSize: 11.5, color: C.muted, padding: '14px 0' } }, '三种来源：① 填好字段后点「⚡ AI 生成岗位 JD」② 上方「导入 JD」自动解析（文件/文字/链接）③ 导入后可「把原文结构化」生成 OD 规范版本。')),
          h(JDQualityCard, { text: rawView && jdRaw ? jdRaw : (jdObj ? jdMd : (jdRaw || jdMd)) })),
        // 评分卡区（由 JD 派生）
        h('div', { style: { marginTop: 10, border: '1px solid ' + C.border, borderRadius: 9, padding: 10 } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 } },
            h('b', { style: { fontSize: 12.5 } }, '初筛评分卡'),
            h('div', { style: { display: 'flex', gap: 6 } },
              h('button', { type: 'button', style: primary, disabled: scBusy, onClick: genScorecard }, scBusy ? '生成中…' : (scObj ? '⚡ 重新生成评分卡' : '⚡ 由 JD 生成评分卡')))),
          (scObj || scMd)
            ? h('div', { style: { border: '1px solid ' + C.border, borderRadius: 7, padding: '4px 10px', maxHeight: 320, overflow: 'auto' } }, h(ScorecardView, { sc: scObj, markdown: scMd }))
            : h('div', { style: { fontSize: 11.5, color: C.muted, padding: '12px 0' } }, '先有 JD，再点「⚡ 由 JD 生成评分卡」：按硬门槛（一票否决）+ 业务价值权重（量化成果/技能深度/行业匹配/稳定性）双轨生成 100 分制评分卡，用于 AI 初筛。')),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' } },
          h('button', { type: 'button', style: primary, onClick: submit }, editingId ? '保存修改' : '保存职位'),
          h('button', { type: 'button', style: btn, onClick: onCancel }, '关闭'),
          msg ? h('span', { style: { fontSize: 11.5, color: C.muted } }, msg) : null)))
      return h(Block, null, view === 'list' ? listView : newView,
        h(ClosePositionModal, { ctx: closeCtx, onCancel: () => setCloseCtx(null), onChoose: (d) => { const ctx = closeCtx; setCloseCtx(null); actPos({ action: 'close_position', positionId: ctx.positionId, disposition: d }) } }))
    }

    function UploadForm({ positions, onDone, onCancel, hideClose }) {
      const [uploadRef] = React.useState(() => ({ current: null }))
      const ref = uploadRef
      const [source, setSource] = React.useState('BOSS直聘')
      const [customSrc, setCustomSrc] = React.useState(false)
      const [pid, setPid] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const go = async (files) => {
        const list = Array.from(files || []); if (!list.length) return
        setBusy(true); let ok = 0, ocr = 0, fail = 0
        const auto = []
        for (const file of list) {
          try {
            const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(file) })
            const j = await api(UPLOAD, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: file.name, contentBase64: b64, source, positionId: pid }) })
            if (j.needsOcr) ocr++
            else {
              ok++
              if (j.autoScreen && j.autoScreen.to) auto.push((j.name || '') + '→' + j.autoScreen.to)
            }
          } catch (e) { fail++ }
        }
        setBusy(false); setMsg(ok + ' 份已接入并自动初筛' + (auto.length ? '（' + auto.slice(0, 4).join('，') + (auto.length > 4 ? ' 等' : '') + '）' : '') + (ocr ? '，' + ocr + ' 待补录' : '') + (fail ? '，' + fail + ' 失败' : '')); onDone()
      }
      return h(Block, { title: '批量上传解析' },
        h('input', { type: 'file', ref, multiple: true, style: { display: 'none' }, accept: '.pdf,.docx,.doc,.rtf,.txt,.html,.htm,.md,.csv,.png,.jpg,.jpeg,.webp,.tiff,.bmp', onChange: e => { go(e.target.files); e.target.value = '' } }),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' } },
          h('div', { style: { width: customSrc ? 130 : 150 } }, h('label', { style: { fontSize: 11.5, color: C.muted, display: 'block' } }, '来源渠道',
            h('select', { style: input, value: customSrc ? '__custom' : source, onChange: e => { const v = e.target.value; if (v === '__custom') { setCustomSrc(true); setSource('') } else { setCustomSrc(false); setSource(v) } } },
              ...SRC.map(x => h('option', { key: x, value: x }, x)),
              h('option', { value: '__custom' }, '自定义…')))),
          customSrc ? h('div', { style: { width: 130 } }, h(Field, { label: '自定义渠道', value: source, onChange: setSource, placeholder: '如 拉勾' })) : null,
          h('div', { style: { width: 170 } }, h('label', { style: { fontSize: 11.5, color: C.muted, display: 'block' } }, '关联岗位',
            h('select', { style: input, value: pid, onChange: e => setPid(e.target.value) }, h('option', { value: '' }, '不指定'), ...(positions || []).map(p => h('option', { key: p.id, value: p.id }, p.title))))),
          h('button', { type: 'button', style: primary, disabled: busy, onClick: () => ref.current && ref.current.click() }, busy ? '接入中…' : '选择文件'),
          hideClose ? null : h('button', { type: 'button', style: btn, onClick: onCancel }, '关闭')),
        msg ? h('div', { style: { fontSize: 11.5, color: C.muted, marginTop: 6 } }, msg) : null)
    }

    // 简历管理：独立模块（与候选人流程/职位管理同级），含批量上传解析
    function IntakePage({ data, onDone, onGoto, onOpen }) {
      const cs = data.candidates || []
      const bPending = cs.filter(c => c.stage === '待评估')          // 需人判断（B级/低置信）
      const unlinked = cs.filter(c => !c.pid && c.stage !== '已淘汰')  // 待分配岗位
      const saFlow = cs.filter(c => ['待初试', '初试中', '待复试', '复试中', '待背调'].indexOf(c.stage) >= 0)
      const rejected = cs.filter(c => ['已淘汰', 'Offer拒绝'].indexOf(c.stage) >= 0)
      const statRow = (label, n, color, hint) => h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid ' + C.border } },
        h('span', { style: { width: 8, height: 8, borderRadius: 99, background: color, flex: 'none' } }),
        h('span', { style: { fontSize: 11.5, fontWeight: 600, flex: 1 } }, label),
        h('b', { style: { fontSize: 16, color } }, String(n)),
        h('span', { style: { fontSize: 10.5, color: C.muted, width: 92, textAlign: 'right' } }, hint))
      return h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 320px', gap: 12, alignItems: 'start' } },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          h('div', { style: { fontSize: 13, fontWeight: 700 } }, '📥 简历管理'),
          h(UploadForm, { positions: data.positions, onDone, hideClose: true }),
          h('div', { style: { ...card, fontSize: 11.5, color: C.muted, lineHeight: 1.75 } },
            h('b', { style: { fontSize: 11.5, color: 'inherit' } }, '接入即分流（无需手动初筛）'),
            h('div', { style: { marginTop: 4 } }, '每份简历进入后自动完成：脱敏 → 三键去重 → 技术栈预检 → 自动匹配岗位 → AI 初筛，并按结论直接归位：'),
            h('div', { style: { marginTop: 4, paddingLeft: 4 } },
              h('div', null, '· S/A → 直接进初试流程'),
              h('div', null, '· B（需面试排雷 / 低置信）→ 留待你判断'),
              h('div', null, '· C → 自动淘汰进人才库（可随时激活）')),
            h('div', { style: { marginTop: 6 } }, '支持 PDF / Word / 图片（扫描件自动 OCR）/ 纯文本，可多选。批量收邮件简历：',
              h('button', { type: 'button', style: { ...btn, padding: '1px 8px', fontSize: 10, marginLeft: 4 }, onClick: () => onGoto('settings') }, '去设置邮箱接入')))),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          h('div', { style: card },
            h('div', { style: { fontSize: 11.5, fontWeight: 700, marginBottom: 4 } }, '分流结果'),
            statRow('SA · 在初试流程', saFlow.length, C.accent, '当前在途'),
            statRow('B · 待你判断', bPending.length, C.warn, '需你看一眼'),
            statRow('C · 已淘汰入库', rejected.length, C.muted, '可激活复捞'),
            h('div', { style: { fontSize: 10.5, color: C.muted, marginTop: 6 } }, '上传后的简历已自动归位，不在这里堆积。'),
            bPending.length ? h('button', { type: 'button', style: { ...primary, padding: '6px 0', fontSize: 11.5, width: '100%', marginTop: 8 }, onClick: () => onGoto('process') }, '⚡ 去判断 ' + bPending.length + ' 份 B 级') : null),
          h('div', { style: card },
            h('div', { style: { fontSize: 11.5, fontWeight: 700, marginBottom: 4 } }, '待分配岗位 · ' + unlinked.length),
            h('div', { style: { fontSize: 10, color: C.muted, lineHeight: 1.6, marginBottom: 7 } }, '这些简历未匹配到明确岗位。你只需为它们选一个岗位，选完 AI 会自动初筛并分流。'),
            !unlinked.length
              ? h('div', { style: { fontSize: 11.5, color: C.muted } }, '暂无待分配简历')
              : h('div', null, ...unlinked.slice(0, 8).map(c => h('div', { key: c.id, style: { display: 'flex', alignItems: 'center', gap: 6, padding: '5px 0', borderBottom: '1px solid ' + C.border } },
                  h('span', { style: { fontSize: 11, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, c.name || c.id),
                  h('button', { type: 'button', style: { ...primary, padding: '1px 8px', fontSize: 10.5 }, onClick: () => { onOpen && onOpen(c.id); onGoto('process') } }, '选岗位')))),
              unlinked.length > 8 ? h('div', { style: { fontSize: 10.5, color: C.muted, marginTop: 4 } }, '还有 ' + (unlinked.length - 8) + ' 份') : null),
            h('button', { type: 'button', style: { ...btn, padding: '6px 0', fontSize: 11.5, width: '100%', marginTop: 8 }, onClick: () => onGoto('positions') }, '＋ 新建职位')))
    }

    function MailForm({ onDone, onCancel }) {
      const [c, setC] = React.useState({ protocol: 'imap', host: '', port: '993', user: '', password: '', folder: 'INBOX', source: '其他' })
      const set = (k, v) => setC(o => ({ ...o, [k]: v }))
      const [msg, setMsg] = React.useState(''); const [busy, setBusy] = React.useState(false)
      React.useEffect(() => { api('/api/ai-recruiting/mail-config').then(j => { if (j.config && Object.keys(j.config).length) setC(o => ({ ...o, ...j.config, password: '', port: String(j.config.port || 993) })) }).catch(() => {}) }, [])
      const call = async (url, body) => {
        setBusy(true)
        try { const j = await api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); setMsg(j.message || (j.attachments ? '抓到 ' + j.attachments.length + ' 份附件' : '完成')); onDone() }
        catch (e) { setMsg('失败：' + e.message) }
        setBusy(false)
      }
      return h(Block, { title: '邮箱接入' },
        h('div', { style: { fontSize: 10.5, color: C.muted, marginBottom: 8, lineHeight: 1.6 } }, '邮箱只是载体：收信时按发件人/主题/文件名自动归因真实渠道（BOSS直聘/猎聘/智联等），未识别的用下方默认来源。'),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))', gap: 8 } },
          h('label', { style: { fontSize: 11.5, color: C.muted } }, '协议',
            h('select', { style: input, value: c.protocol, onChange: e => set('protocol', e.target.value) }, h('option', { value: 'imap' }, 'IMAP'), h('option', { value: 'pop3' }, 'POP3'))),
          h(Field, { label: '服务器', value: c.host, onChange: v => set('host', v), placeholder: 'imap.qq.com' }),
          h(Field, { label: '端口', value: c.port, onChange: v => set('port', v) }),
          h(Field, { label: '邮箱账号', value: c.user, onChange: v => set('user', v) }),
          h(Field, { label: '应用专用密码', value: c.password, onChange: v => set('password', v), type: 'password' }),
          h(Field, { label: '文件夹', value: c.folder, onChange: v => set('folder', v) }),
          h('label', { style: { fontSize: 10.5, color: C.muted } }, '默认来源',
            h('select', { style: input, value: SRC.indexOf(c.source) >= 0 ? c.source : '__custom', onChange: e => { const v = e.target.value; set('source', v === '__custom' ? '' : v) } },
              ...SRC.map(x => h('option', { key: x, value: x }, x)),
              h('option', { value: '__custom' }, '自定义…')),
            SRC.indexOf(c.source) < 0 ? h('input', { style: { ...input, marginTop: 4 }, placeholder: '自定义渠道名', value: c.source || '', onChange: e => set('source', e.target.value) }) : null)),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('button', { type: 'button', style: btn, disabled: busy, onClick: () => call('/api/ai-recruiting/mail-config', c) }, '保存配置'),
          h('button', { type: 'button', style: primary, disabled: busy, onClick: () => call('/api/ai-recruiting/fetch-mail', { guiUrl: window.location.origin }) }, '立即收信'),
          h('button', { type: 'button', style: btn, onClick: onCancel }, '关闭'),
          msg ? h('span', { style: { fontSize: 11.5, color: C.muted } }, msg) : null))
    }

    /* ============ 左导航 + 主区独立滚动 的布局骨架 ============ */
    const NAV = [
      { id: 'overview', label: '概览', icon: '◈' },
      { id: 'process', label: '候选人流程', icon: '☰' },
      { id: 'positions', label: '职位管理', icon: '▤' },
      { id: 'talent', label: '人才库', icon: '◈' },
      { id: 'intake', label: '简历管理', icon: '📥' },
      { id: 'interviews', label: '面试日程', icon: '📅' },
      { id: 'settings', label: '设置', icon: '⚙' },
      { id: 'ai', label: 'AI 能力', icon: '✦' },
      { id: 'log', label: '工作日志', icon: '◷' },
    ]

    function NavRail({ nav, active, setActive, counts, data }) {
      const item = (n) => {
        const on = active === n.id
        // 角标只统计「待你判断」的异常项（AI 能自动处理的不打扰）
        const badge = n.id === 'process' ? (data.inbox || []).filter(x => HUMAN_KINDS.indexOf(x.kind) >= 0).length : 0
        return h('div', {
          key: n.id, onClick: () => setActive(n.id),
          style: {
            display: 'flex', alignItems: 'center', gap: 9, padding: '9px 12px', borderRadius: 9, cursor: 'pointer', marginBottom: 3,
            background: on ? 'var(--dsh-accent-soft, rgba(47,107,255,.12))' : 'transparent',
            borderLeft: '3px solid ' + (on ? C.accent : 'transparent'),
            color: on ? C.accent : 'inherit', fontWeight: on ? 700 : 400, fontSize: 12.5,
          },
        },
          h('span', { style: { width: 16, textAlign: 'center', opacity: .9 } }, n.icon),
          h('span', { style: { flex: 1 } }, n.label),
          badge ? h('span', { title: '待你判断 ' + badge + ' 项（拍板/排雷/复核）', style: { fontSize: 11.5, padding: '0 6px', borderRadius: 9, background: C.bad, color: '#fff', fontWeight: 700 } }, badge) : null)
      }
      return h('div', { style: { width: 168, flex: 'none', borderRight: '1px solid ' + C.border, padding: '12px 10px', height: '100%', boxSizing: 'border-box', overflow: 'hidden' } },
        h('div', { style: { fontSize: 13, fontWeight: 700, padding: '0 8px 12px' } }, '✦ 招聘工作台'),
        ...nav.map(item))
    }

    // 概览页：今日待办高亮 + KPI 大数字卡 + 流程漏斗
    const STEP_HUE = ['#3b82f6', '#3b82f6', '#10b981', '#8b5cf6', '#a855f7', '#059669']
    function OverviewPage(props) {
      try { return OverviewImpl(props) }
      catch (e) { try { console.error('[ai-recruiting] Overview crash', e) } catch (_) {}
        return h('div', { style: { ...card, borderColor: C.bad } },
          h('b', { style: { color: C.bad } }, '概览渲染出错（已捕获，不白屏）'),
          h('pre', { style: { fontSize: 11.5, whiteSpace: 'pre-wrap', color: C.muted, marginTop: 6 } }, String((e && (e.stack || e.message)) || e)))
      }
    }
    function OverviewImpl({ data, counts, onGoto, setSel, onOpen }) {
      const dash = data.dashboard || { kpis: [], funnel: [], sources: [], pipeline: [] }
      const k = dash.kpis || []
      const humanItems = data.inbox.filter(x => HUMAN_KINDS.indexOf(x.kind) >= 0)
      const pending = humanItems.length
      const alerts = data.alerts || []
      const out = []
      const hr = new Date().getHours()
      const greet = hr < 6 ? '凌晨好' : hr < 12 ? '早上好' : hr < 14 ? '中午好' : hr < 18 ? '下午好' : '晚上好'
      const today = new Date()
      const week = ['日', '一', '二', '三', '四', '五', '六'][today.getDay()]
      const dateStr = today.getFullYear() + '年' + (today.getMonth() + 1) + '月' + today.getDate() + '日 周' + week
      const hiring = (data.positions || []).filter(p => p.status === '在招').length
      // 指挥台口径：还差几人、几人在途
      const hiringRows0 = dash.hiring || []
      const totalGap = hiringRows0.reduce((a, x) => a + (x.gap || 0), 0)
      const totalInFlow = hiringRows0.reduce((a, x) => a + (x.inFlow || 0), 0)
      // Hero 渐变横幅：问候 + 内联关键数字（参考主流工作台首屏）
      // Hero：数据大屏横幅 —— 深渐变 + 光晕 + 渐变数字
      out.push(h('div', { style: { position: 'relative', overflow: 'hidden', background: 'linear-gradient(115deg, #152244 0%, #1e2a52 45%, #2a1f4d 100%)', border: '1px solid #2f3a5c', borderRadius: 16, padding: '22px 26px', marginBottom: 16, color: C.onAccent, boxShadow: '0 10px 34px rgba(30,42,82,.45)' } },
        h('div', { style: { position: 'absolute', top: -60, right: 40, width: 260, height: 260, borderRadius: '50%', background: 'radial-gradient(circle, rgba(122,162,255,.28), transparent 70%)', pointerEvents: 'none' } }),
        h('div', { style: { position: 'relative', display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'center', justifyContent: 'space-between' } },
          h('div', { style: { flex: '1 1 260px' } },
            h('div', { style: { fontSize: 24, fontWeight: 800, letterSpacing: '-.5px' } }, greet + '，Andy'),
            h('div', { style: { fontSize: 12, color: '#8b9bc4', marginTop: 6 } }, dateStr + ' · 招聘驾驶舱')),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 30, alignItems: 'center' } },
            ...[{ label: '在招职位', v: hiring, u: '个' }, { label: '还差', v: totalGap, u: '人' }, { label: '在途', v: totalInFlow, u: '人' },
              { label: '本周新增', v: (k.find(x => x.key === 'intake') || {}).value != null ? (k.find(x => x.key === 'intake') || {}).value : '—', u: '份' },
              { label: '待你判断', v: pending, u: '项' }].map(st => h('div', { key: st.label },
              h('div', { style: { fontSize: 28, fontWeight: 800, lineHeight: 1, letterSpacing: '-.5px', background: 'linear-gradient(90deg,#9db8ff,#c4b5fd)', WebkitBackgroundClip: 'text', backgroundClip: 'text', WebkitTextFillColor: 'transparent', display: 'inline-block' } }, String(st.v), h('span', { style: { fontSize: 12, fontWeight: 500, marginLeft: 2, WebkitTextFillColor: '#8b9bc4' } }, st.u)),
              h('div', { style: { fontSize: 11, color: '#8b9bc4', marginTop: 6 } }, st.label)))))))
      // ===== 需要你处理（指挥台核心：待办 + 超时预警 合并，最该看的放最上）=====
      if (pending || alerts.length) {
        const actRows = []
        for (const it of humanItems.slice(0, 6)) {
          actRows.push(h('div', { key: 'todo_' + it.id, onClick: () => { setSel(it.id); onGoto('process') },
            style: { display: 'flex', gap: 8, alignItems: 'center', padding: '5px 0', borderTop: '1px solid ' + C.border, cursor: 'pointer', fontSize: 11.5 } },
            h('span', { style: { fontSize: 10.5, fontWeight: 700, color: '#fff', background: it.risk >= 4 ? C.bad : C.warn, borderRadius: 6, padding: '1px 7px', whiteSpace: 'nowrap' } }, it.kind),
            h('b', null, it.name),
            h('span', { style: { color: C.muted, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, it.reason || ''),
            h('span', { style: { color: C.accent } }, '处理 →')))
        }
        for (const a of alerts.slice(0, 4)) {
          actRows.push(h('div', { key: 'alert_' + a.candidateId, onClick: () => { setSel(a.candidateId); onGoto('process') },
            style: { display: 'flex', gap: 8, alignItems: 'center', padding: '5px 0', borderTop: '1px solid ' + C.border, cursor: 'pointer', fontSize: 11.5 } },
            h('span', { style: { fontSize: 10.5, fontWeight: 700, color: '#fff', background: '#b45309', borderRadius: 6, padding: '1px 7px', whiteSpace: 'nowrap' } }, '超时 ' + a.days + '天'),
            h('b', null, a.name),
            h('span', { style: { color: C.muted, flex: 1 } }, a.kind),
            h('span', { style: { color: C.accent } }, '→ ' + a.act)))
        }
        out.push(h('div', { style: { ...card, borderColor: tint(C.bad, .5), background: 'rgba(239,68,68,.06)', marginBottom: 10, padding: '11px 14px' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: actRows.length ? 6 : 0 } },
            h('span', { style: { fontSize: 15 } }, '⚑'),
            h('b', { style: { fontSize: 13 } }, '需要你处理 ' + (pending + alerts.length) + ' 项'),
            h('span', { style: { fontSize: 11.5, color: C.muted } }, pending ? ('待判断 ' + pending) : '' + (alerts.length ? (pending ? ' · ' : '') + '超时 ' + alerts.length : '')),
            h('div', { style: { flex: 1 } }),
            h('button', { type: 'button', style: primary, onClick: () => onGoto('process') }, '去处理 →')),
          ...actRows))
      }
      // 核心 KPI：图标 + 大数字 + 一条洞察（▲ 环比并入，不再重复）
      const ICONS = { active: '▣', intake: '📄', passed: '✅', cycle: '⏱' }
      // KPI 卡：数据大屏风格 —— 顶部强调色条 + 发光状态点 + 大数字 + 进度条 + 趋势
      const KPI_HUE = { done: '#4f7cff', convert: '#22d3ee', cycle: '#a78bfa', offerRate: '#f0ad4e' }
      const kpiCards = k.map(x => {
        const dLabel = x.deltaLabel && x.deltaLabel !== '暂无上期' && x.deltaLabel !== '持平' ? x.deltaLabel : null
        const hue = KPI_HUE[x.key] || C.accent
        // 进度条：完成度类用 value/max 比例
        let pct = null
        if (x.key === 'done') { const m = String(x.value).match(/(\d+)\s*\/\s*(\d+)/); if (m) pct = Number(m[2]) > 0 ? (Number(m[1]) / Number(m[2]) * 100) : 0 }
        else if (x.unit === '%' && typeof x.value === 'number') pct = Math.max(0, Math.min(100, x.value))
        return h('div', { key: x.key, style: { position: 'relative', overflow: 'hidden', background: 'linear-gradient(160deg, rgba(255,255,255,.035), rgba(255,255,255,.01))', border: '1px solid ' + C.border, borderRadius: 13, padding: '15px 17px', minWidth: 0, boxShadow: '0 2px 10px rgba(0,0,0,.18)' } },
          h('div', { style: { position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: 'linear-gradient(90deg,' + hue + ',' + tint(hue, .1) + ')' } }),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 7 } },
            h('span', { style: { width: 7, height: 7, borderRadius: '50%', background: hue, boxShadow: '0 0 8px ' + hue } }),
            h('span', { style: { fontSize: 12, color: C.muted } }, x.label)),
          h('div', { style: { display: 'flex', alignItems: 'baseline', marginTop: 9 } },
            h('span', { style: { fontSize: 34, fontWeight: 800, letterSpacing: '-1px', lineHeight: 1 } }, String(x.value)),
            h('span', { style: { fontSize: 12.5, marginLeft: 4, color: C.muted, fontWeight: 500 } }, x.unit)),
          pct != null ? h('div', { style: { height: 4, borderRadius: 2, background: 'rgba(127,143,170,.15)', marginTop: 10, overflow: 'hidden' } },
            h('div', { style: { width: Math.round(pct) + '%', height: '100%', borderRadius: 2, background: hue } })) : null,
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 9, fontSize: 11.5, lineHeight: 1.4 } },
            h('span', { style: { color: C.muted } }, x.insight || x.note || ''),
            dLabel ? h('span', { style: { color: x.trend === 'up' ? '#34d399' : x.trend === 'down' ? '#fbbf24' : C.muted, fontWeight: 700, flex: 'none', marginLeft: 6 } }, (x.trend === 'up' ? '▲' : x.trend === 'down' ? '▼' : '') + dLabel) : null))
      })
      out.push(h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: 12, marginBottom: 10 } }, ...kpiCards))
      // 次要指标 chips
      const minor = dash.kpisMinor || []
      if (minor.length) out.push(h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 } },
        ...minor.map(x => h('span', { key: x.key, style: { fontSize: 11.5, padding: '3px 10px', borderRadius: 9, background: C.surface, border: '1px solid ' + C.border, color: C.muted } },
          x.label + ' ' + x.value + (x.unit || '')))))
      // 6 环节累计管道 + 转化箭头流
      // ===== 数据大屏：图表矩阵 =====
      const pl = (dash.pipeline || []).slice(0, 6)   // 漏斗全环节：0 是真实状态（尚无人到达），砍掉反而看不出断在哪
      const gdViz = (dash.aiPerf || {}).gradeDist || {}
      // ① 招聘漏斗（渐变）——占整行
      if (pl.length >= 2) out.push(h('div', { style: { ...card, marginBottom: 12, padding: '14px 16px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 } },
          h('div', { style: { fontSize: 13, fontWeight: 700 } }, '招聘漏斗'),
          h('span', { style: { fontSize: 11, color: C.muted } }, '环节间转化率 · 累计到达')),
        h(FunnelViz, { stages: pl.map(p => ({ label: p.label, value: p.count })) }),
        h('div', { style: { fontSize: 11.5, color: C.muted, marginTop: 10 } },
          '定局均 ' + ((dash.cycle || {}).resolvedAvgDays != null ? dash.cycle.resolvedAvgDays + ' 天' : '—') +
          ' · 进面试均 ' + ((dash.cycle || {}).toInterviewAvgDays != null ? dash.cycle.toInterviewAvgDays + ' 天' : '—'))))
      // ② 三个图表并排：SABC环形 + 渠道条形 + 14天趋势
      const srcF = dash.sourceFunnel || []
      const chartCard = (title, sub, body) => h('div', { style: { ...card, padding: '14px 16px', minWidth: 0 } },
        h('div', { style: { fontSize: 12.5, fontWeight: 700, marginBottom: 10 } }, title, sub ? h('span', { style: { fontSize: 10, color: C.muted, marginLeft: 6, fontWeight: 400 } }, sub) : null), body)
      const gTotalViz = (gdViz.S || 0) + (gdViz.A || 0) + (gdViz.B || 0) + (gdViz.C || 0)
      const donut = gTotalViz ? chartCard('AI 初筛分布', '', h('div', { style: { display: 'flex', alignItems: 'center', gap: 14 } },
        h(DonutChart, { segments: [{ label: 'S', value: gdViz.S || 0, color: C.good }, { label: 'A', value: gdViz.A || 0, color: '#22d3ee' }, { label: 'B', value: gdViz.B || 0, color: C.warn }, { label: 'C', value: gdViz.C || 0, color: C.bad }], centerTop: gTotalViz, centerSub: '已评估' }),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 7, fontSize: 11.5 } },
          ...[['S', gdViz.S || 0, C.good], ['A', gdViz.A || 0, '#22d3ee'], ['B', gdViz.B || 0, C.warn], ['C', gdViz.C || 0, C.bad]].map(([lv, n, c]) => h('div', { key: lv, style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h('span', { style: { width: 8, height: 8, borderRadius: 2, background: c } }),
            h('span', { style: { color: C.muted } }, lv + ' 级'), h('b', { style: { marginLeft: 'auto' } }, String(n)), h('span', { style: { color: C.muted, fontSize: 10 } }, gTotalViz ? Math.round(n / gTotalViz * 100) + '%' : ''))))))
        : null
      const srcBar = srcF.length ? chartCard('渠道转化', '简历→面试', h(BarList, { items: srcF.map(x => ({ label: x.source, value: x.total, color: C.accent })), labelW: 60 })) : null
      // 近14天趋势：累计曲线无决策价值，已移除；metrics 积累≥7天后可上「每日新增」流量版
      const trio = [donut, srcBar].filter(Boolean)
      if (trio.length) out.push(h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 12, marginBottom: 12 } }, ...trio))
      // 职位招聘进度 · 岗位漏斗矩阵（简历→评估→面试→Offer→入职 + 需求缺口 + 周期）
      const hiringRows = dash.hiring || []
      if (hiringRows.length) out.push(h('div', { style: { ...card, marginBottom: 10, padding: '13px 16px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 } },
          h('div', { style: { fontSize: 12.5, fontWeight: 700 } }, '▍岗位招聘漏斗'),
          h('span', { style: { fontSize: 10.5, color: C.muted } }, '每岗位 · 简历 → 评估 → 面试 → Offer → 入职')),
        h('div', { style: { overflowX: 'auto' } },
          h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 11.5 } },
            h('thead', null, h('tr', null,
              h('th', { style: { textAlign: 'left', fontSize: 10.5, color: C.muted, fontWeight: 600, padding: '3px 4px', whiteSpace: 'nowrap' } }, '岗位'),
              ...['简历', '评估', '面试', 'Offer', '入职'].map(h2 => h('th', { key: h2, style: { textAlign: 'center', fontSize: 10.5, color: C.muted, fontWeight: 600, padding: '3px 6px', whiteSpace: 'nowrap' } }, h2)),
              h('th', { style: { textAlign: 'center', fontSize: 10.5, color: C.muted, fontWeight: 600, padding: '3px 6px' } }, '需求'),
              h('th', { style: { textAlign: 'center', fontSize: 10.5, color: C.muted, fontWeight: 600, padding: '3px 6px' } }, '缺口'),
              h('th', { style: { textAlign: 'center', fontSize: 10.5, color: C.muted, fontWeight: 600, padding: '3px 6px', whiteSpace: 'nowrap' } }, '周期'))),
            h('tbody', null, ...hiringRows.map(x => {
              const fn = x.funnel || {}
              const CELLS = [['简历', fn.resume, C.text], ['评估', fn.screened, C.accent], ['面试', fn.interview, C.info], ['Offer', fn.offer, C.purple], ['入职', fn.hired, C.good]]
              return h('tr', { key: x.id, style: { borderTop: '1px solid ' + C.border } },
                h('td', { style: { padding: '6px 4px', whiteSpace: 'nowrap' } },
                  h('b', { style: { fontSize: 11.5 } }, x.title),
                  h('div', { style: { height: 3, background: C.surface, borderRadius: 2, marginTop: 3, overflow: 'hidden', maxWidth: 160 } },
                    h('div', { style: { width: x.progress + '%', height: '100%', background: x.progress >= 100 ? C.good : C.accent } }))),
                ...CELLS.map(([lb, v, c]) => h('td', { key: lb, style: { textAlign: 'center', padding: '6px 6px', fontWeight: v > 0 ? 700 : 400, color: v > 0 ? c : C.muted, fontVariantNumeric: 'tabular-nums' } }, String(v == null ? '—' : v))),
                h('td', { style: { textAlign: 'center', padding: '6px 6px' } }, String(x.hc)),
                h('td', { style: { textAlign: 'center', padding: '6px 6px', fontWeight: 800, color: x.gap ? C.bad : C.good } }, String(x.gap)),
                h('td', { style: { textAlign: 'center', padding: '6px 6px', fontSize: 10.5, whiteSpace: 'nowrap' } },
                  x.avgDays != null ? h('span', { style: { color: C.good } }, '到岗 ' + x.avgDays + ' 天')
                  : x.inflowAvgDays != null ? h('span', { style: { color: C.warn } }, '在途 ' + x.inflowAvgDays + ' 天')
                  : h('span', { style: { color: C.muted } }, '—')) )
          })),
        h('div', { style: { fontSize: 10, color: C.muted, marginTop: 8 } },
          '周期：已入职岗位显示平均到岗天数；在途岗位显示在途者平均停留天数')))))
      // AI 初筛分布（S/A/B/C）+ 改判率
      const aiP = dash.aiPerf || {}
      const gd = aiP.gradeDist || {}
      const gTotal = (gd.S || 0) + (gd.A || 0) + (gd.B || 0) + (gd.C || 0)
      if (gTotal) out.push(h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 } },
        ...[['S 级', gd.S || 0, C.good], ['A 级', gd.A || 0, C.accent], ['B 级', gd.B || 0, C.warn], ['C 级', gd.C || 0, C.bad]].map(([lb, n, col]) => h('div', { key: lb, style: { flex: '1 1 100px', background: C.surface, borderRadius: 9, padding: '7px 10px' } },
          h('div', { style: { fontSize: 11.5, color: C.muted } }, 'AI 初筛 ' + lb),
          h('div', { style: { fontSize: 18, fontWeight: 800, color: col } }, String(n), h('span', { style: { fontSize: 10.5, color: C.muted, fontWeight: 400, marginLeft: 4 } }, gd && gTotal ? Math.round(n / gTotal * 100) + '%' : '')))),
        h('div', { style: { flex: '1 1 120px', background: C.surface, borderRadius: 9, padding: '7px 10px' } },
          h('div', { style: { fontSize: 11.5, color: C.muted } }, '人工改判率'),
          h('div', { style: { fontSize: 18, fontWeight: 800, color: (aiP.correctionRate || 0) > 15 ? C.warn : C.good } }, (aiP.correctionRate != null ? aiP.correctionRate : 0) + '%', h('span', { style: { fontSize: 10.5, color: C.muted, fontWeight: 400, marginLeft: 4 } }, (aiP.corrections || 0) + ' 次纠偏')))))
      // 超时未动（流失风险）
      const od = (dash.overdue || [])
      if (od.length) out.push(h('div', { style: { ...card, borderColor: C.warn, background: 'rgba(245,158,11,.06)', marginBottom: 10, padding: '9px 12px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 } },
          h('b', { style: { fontSize: 12.5, color: C.warn } }, '⏰ 超时未动 · ' + od.length + ' 人'),
          h('span', { style: { fontSize: 11.5, color: C.muted } }, '按业务等待上限判定：待初试>3天 / 待发Offer>2天 / 面试中>5天')),
        ...od.slice(0, 5).map(o => h('div', { key: o.id, onClick: () => { setSel(o.id); onGoto('process') }, style: { display: 'flex', gap: 8, fontSize: 11.5, padding: '3px 0', cursor: 'pointer' } },
          h('span', { style: { fontWeight: 700 } }, o.name),
          h('span', { style: { color: C.muted } }, o.stage),
          h('span', { style: { color: C.bad, marginLeft: 'auto' } }, o.days + ' 天 · ' + o.reason)))))
      // 概览聚焦数据与分析：候选人明细在看板/列表（候选人流程），这里不重复
      // ==== 更多数据分析（折叠）====
      const analysisParts = []
      ;(function(){
      // 渠道质量 + 漏斗
      const maxF = Math.max.apply(null, dash.funnel.map(x => x.count).concat([1]))
      const sq = dash.sourceQuality || []
      const maxSq = Math.max.apply(null, sq.map(x => x.total).concat([1]))
      const bar = (name, count, delta2, max, color) => h(BarRow, { key: name, name, count, delta: delta2, max, color })
      analysisParts.push(h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 10, marginTop: 12 } },
        h('div', { style: card }, h('div', { style: sec }, '渠道端到端转化'),
          h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 11.5 } },
            h('thead', null, h('tr', null,
              h('th', { style: { textAlign: 'left', fontSize: 10.5, color: C.muted, fontWeight: 600, padding: '2px 4px' } }, '渠道'),
              ...['简历', '初筛', '初面', 'Offer', '入职'].map(lb => h('th', { key: lb, style: { textAlign: 'right', fontSize: 10.5, color: C.muted, fontWeight: 600, padding: '2px 4px', width: 38 } }, lb)),
              h('th', { style: { textAlign: 'right', fontSize: 10.5, color: C.muted, fontWeight: 600, padding: '2px 4px', width: 54 } }, '面率'))),
            h('tbody', null, ...(dash.sourceFunnel || []).map(x => h('tr', { key: x.source, style: { borderTop: '1px solid ' + C.border } },
              h('td', { style: { padding: '5px 4px', fontWeight: 600 } }, x.source),
              h('td', { style: { textAlign: 'right', padding: '5px 4px' } }, String(x.total)),
              h('td', { style: { textAlign: 'right', padding: '5px 4px', color: C.muted } }, String(x.screened)),
              h('td', { style: { textAlign: 'right', padding: '5px 4px', color: C.accent } }, String(x.interview)),
              h('td', { style: { textAlign: 'right', padding: '5px 4px', color: C.good } }, String(x.offer)),
              h('td', { style: { textAlign: 'right', padding: '5px 4px', fontWeight: 700, color: x.hired ? C.good : C.muted } }, String(x.hired)),
              h('td', { style: { textAlign: 'right', padding: '5px 4px', fontSize: 11.5, color: (x.toInterview || 0) >= 20 ? C.good : C.warn } }, (x.toInterview != null ? x.toInterview + '%' : '—'))))))),
        h('div', { style: card }, h('div', { style: sec }, '招聘漏斗 · 当前停留'),
          ...dash.funnel.filter(x => x.count > 0).map(x => bar(x.stage, x.count, x, maxF)))))
      // 即将入职（招聘兑现信号：Offer 已发、待报到）
      if ((dash.arrivals || []).length) analysisParts.push(h('div', { style: { ...card, marginTop: 10, padding: '10px 13px' } },
        h('div', { style: { fontSize: 12.5, fontWeight: 700, marginBottom: 5 } }, '▍即将入职 · ' + dash.arrivals.length),
        ...dash.arrivals.map(a => h('div', { key: a.id, onClick: () => { setSel(a.id); onGoto('process') }, style: { display: 'flex', gap: 8, fontSize: 11.5, padding: '3px 0', cursor: 'pointer' } },
          h('b', null, a.name),
          h('span', { style: { color: C.muted } }, a.stage),
          h('span', { style: { marginLeft: 'auto', fontSize: 11.5, color: C.good } }, '待报到')))))
      // 近 14 天趋势（metrics 按日快照）
      const trend = data.trend || []
      if (trend.length >= 1) {
        const W = 560, H = 110, pad = 8
        const maxV = Math.max.apply(null, trend.map(t => Math.max(t.candidates || 0, t.evaluated || 0)).concat([1]))
        const px = (i) => pad + i * (W - pad * 2) / Math.max(1, trend.length - 1)
        const py = (v) => H - 14 - (v / maxV) * (H - 30)
        const line = (key, color) => {
          const pts = trend.map((t, i) => px(i) + ',' + py(t[key] || 0)).join(' ')
          return h('polyline', { points: pts, fill: 'none', stroke: color, strokeWidth: 2, strokeLinejoin: 'round' })
        }
        analysisParts.push(h('div', { style: { ...card, marginTop: 10, padding: '12px 14px' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 } },
            h('div', { style: { fontSize: 12.5, fontWeight: 700 } }, '▍近 14 天趋势'),
            h('span', { style: { fontSize: 11.5, color: '#60a5fa' } }, '● 候选人总量'),
            h('span', { style: { fontSize: 11.5, color: '#34d399' } }, '● 评估完成'),
            h('span', { style: { fontSize: 11.5, color: C.muted } }, '按日快照累积')),
          h('svg', { width: '100%', height: H, viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none' },
            line('candidates', '#60a5fa'), line('evaluated', '#34d399'),
            ...trend.map((t, i) => h('g', { key: t.date },
              h('circle', { cx: px(i), cy: py(t.candidates || 0), r: 2.5, fill: '#60a5fa' }),
              h('circle', { cx: px(i), cy: py(t.evaluated || 0), r: 2.5, fill: '#34d399' }))))))
      }
      })()
      if (analysisParts.length) out.push(h('details', { style: { marginTop: 12 } },
        h('summary', { style: { cursor: 'pointer', fontSize: 12.5, fontWeight: 600, color: C.muted, padding: '6px 0', userSelect: 'none' } }, '▸ 更多数据分析'),
        h('div', { style: { marginTop: 8 } }, ...analysisParts)))
      return h('div', null, ...out)
    }

    function AiCapPage({ data }) {
      const ai = data.dashboard.ai
      const st = data.standards
      const ex = data.aiExtra || {}
      const out = []
      // ===== Hero：AI 基座定位 =====
      out.push(h('div', { style: { background: 'linear-gradient(120deg,#1e1b4b 0%,#312e81 40%,#4c1d95 100%)', borderRadius: 16, padding: '20px 24px', marginBottom: 14, color: '#fff', boxShadow: '0 8px 28px rgba(76,29,149,.35)' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 } },
          h('span', { style: { fontSize: 26 } }, '✦'),
          h('div', { style: { fontSize: 22, fontWeight: 800, letterSpacing: '-.3px' } }, 'AI 招聘能力基座'),
          h('span', { style: { fontSize: 11.5, padding: '2px 10px', borderRadius: 9, background: 'rgba(255,255,255,.16)', fontWeight: 600 } }, 'core engine')),
        h('div', { style: { fontSize: 12.5, opacity: .85, lineHeight: 1.7, maxWidth: 820 } },
          '把招聘全链路的判断沉淀成可复用、可审计、可自迭代的 AI 能力：接入即结构化，评估靠 BARS 逐维判档，面试有 Copilot，校准闭环让模型越用越准。'),
        h('div', { style: { display: 'flex', gap: 18, marginTop: 14, flexWrap: 'wrap' } },
          ...[['能力调用', ai.calls, '次'], ['免人工处理', ai.autoRate, '%'], ['判断可追溯', ai.traceable, '%'], ['节省人工', ai.savedHours, '小时']].map((x, i) =>
            h('div', { key: i },
              h('div', { style: { fontSize: 26, fontWeight: 800, lineHeight: 1 } }, String(x[1] != null ? x[1] : '—'), h('span', { style: { fontSize: 12, fontWeight: 500, opacity: .7, marginLeft: 2 } }, x[2])),
              h('div', { style: { fontSize: 11.5, opacity: .75, marginTop: 2 } }, x[0]))))))
      // ===== 四段价值链：每个能力卡片（讲清"做什么+价值"）=====
      const CHAIN = [
        { stage: '接入即结构化', icon: '⇣', color: C.accent, desc: '简历进来自动清洗、脱敏、去重、抽取，无需人工录入',
          caps: [
            ['简历解析', 'PDF/Word/图片 → 结构化文本，扫描件自动 OCR', ex.ocr],
            ['入口脱敏', '姓名/电话/邮箱等敏感字段在入库前即隔离', null],
            ['三键去重', '姓名+电话+邮箱+内容指纹，同名同人自动识别', null],
            ['技能抽取 + ATS 质检', '自动识别技能栈，并评估简历可读性', ex.skills != null ? (ex.skills + ' 人') : null],
            ['技能缺口对照', '对照岗位需求算覆盖/缺口，辅助判断匹配度', ex.gap != null ? (ex.gap + ' 人') : null],
          ] },
        { stage: '评估靠证据', icon: '⚖', color: C.good, desc: '不看关键词命中，而是逐维对照行为锚点判档、引用原文证据',
          caps: [
            ['BARS 逐维判档', 'LLM 按评分卡每个维度引用证据、判 L0-L3 档位', null],
            ['技术栈硬门槛', '跨栈错配一票否决，避免无效深评', null],
            ['AI 硬门槛判断', '读原文判断学历/专业/年限，非关键词匹配', null],
            ['评级分流', 'S/A 进初试 · B 留人排雷 · C 入库 · 硬门槛fail淘汰', null],
          ] },
        { stage: '面试有副驾', icon: '🎯', color: C.purple, desc: '面试官带着准备卡上场：验证清单、问题、红旗预警',
          caps: [
            ['面试 Copilot', '按候选人疑点生成验证清单 + 参考问题 + 红旗提醒', null],
            ['结构化面评', '面试官按同一 BARS 评分卡定档，与 AI 同尺度可比', null],
          ] },
        { stage: '校准能自迭代', icon: '⟳', color: C.warn, desc: '人的每次改判都沉淀为规范版本，模型越用越懂你的标准',
          caps: [
            ['纠偏写回', '人改判 → correction.made → 聚类达标即产出规范修订建议', null],
            ['AI vs 人一致率', '维度级对照，偏差大的维度优先修锚点', null],
          ] },
      ]
      out.push(h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 12, marginBottom: 14 } },
        ...CHAIN.map(seg => h('div', { key: seg.stage, style: { ...card, padding: '14px 16px' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 } },
            h('span', { style: { fontSize: 18, color: seg.color } }, seg.icon),
            h('b', { style: { fontSize: 13.5 } }, seg.stage)),
          h('div', { style: { fontSize: 11.5, color: C.muted, lineHeight: 1.6, marginBottom: 10 } }, seg.desc),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            ...seg.caps.map((c, i) => h('div', { key: i, style: { borderLeft: '2px solid ' + tint(seg.color, .5), paddingLeft: 10 } },
              h('div', { style: { fontSize: 11.5, fontWeight: 600 } }, c[0], c[2] != null ? h('span', { style: { fontSize: 10, color: seg.color, marginLeft: 6, fontWeight: 700 } }, '· ' + c[2] + (String(c[2]).match(/份|人|维/) ? '' : ' 次')) : null),
              h('div', { style: { fontSize: 10.5, color: C.muted, marginTop: 1 } }, c[1]))))))))
      // ===== 口径说明：置信度 & 适配分 =====
      out.push(h('div', { style: { ...card, padding: '13px 16px', marginBottom: 12, background: 'rgba(47,107,255,.05)', borderColor: tint(C.accent, .3) } },
        h('div', { style: { fontSize: 12.5, fontWeight: 700, marginBottom: 8 } }, '📐 口径说明'),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 12 } },
          h('div', null,
            h('div', { style: { fontSize: 11.5, fontWeight: 600, color: C.good, marginBottom: 3 } }, '置信度 = 这个结论有多可信'),
            h('div', { style: { fontSize: 11.5, color: C.muted, lineHeight: 1.7 } }, '三个信号加权得出：① 三档采样一致性 50% ② 证据覆盖度 30% ③ 硬门槛确定性 20%。低于阈值自动提示人工复核。')),
          h('div', null,
            h('div', { style: { fontSize: 11.5, fontWeight: 600, color: C.accent, marginBottom: 3 } }, '适配分 = BARS 加权综合分'),
            h('div', { style: { fontSize: 11.5, color: C.muted, lineHeight: 1.7 } }, '各维度判 L0-L3 档 → 档位分 × 维度权重 → 加权平均得 0-100。每一分可追溯到维度、档位与引用原文。'))) ))
      // ===== AI vs 人判断偏差 =====
      // ===== 结论级闭环：AI 初筛等级 × 面试实际通过率 =====
      const avi = data.aiVsInterviewer || { groups: [], total: 0, overallPassRate: null }
      if (avi.total) {
        const GR = { S: C.good, A: C.good, B: C.warn, C: C.bad }
        out.push(h('div', { style: { ...card, marginBottom: 10, padding: '13px 16px' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' } },
            h('div', { style: { fontSize: 12.5, fontWeight: 700 } }, '▍AI 初筛结论 × 面试实际结果'),
            h('span', { style: { fontSize: 11.5, color: C.muted } }, '验证"AI 说这人行"到底准不准 —— 结论级闭环'),
            avi.overallPassRate != null ? h('span', { style: { fontSize: 13, fontWeight: 800, color: avi.overallPassRate >= 60 ? C.good : C.warn, marginLeft: 'auto' } }, '整体面试通过率 ' + avi.overallPassRate + '%（' + avi.total + ' 人）') : null),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            ...avi.groups.filter(g => g.n > 0).map(g => h('div', { key: g.grade, style: { flex: '1 1 130px', background: C.surface, borderRadius: 9, padding: '9px 11px' } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 } },
                h('span', { style: { fontSize: 12, fontWeight: 800, color: GR[g.grade] || C.muted } }, 'AI 判 ' + g.grade + ' 级'),
                h('span', { style: { fontSize: 10, color: C.muted } }, g.n + ' 人面试')),
              h('div', { style: { fontSize: 20, fontWeight: 800, color: g.passRate >= 60 ? C.good : C.warn } }, g.passRate + '%'),
              h('div', { style: { fontSize: 10.5, color: C.muted } }, '面试通过 ' + g.pass + '/' + g.n))))))
      }
      const al = data.aiAlignment || { dims: [], overall: null, samples: 0 }
      const dimsAL = al.dims || []
      out.push(h('div', { style: { ...card, marginBottom: 10, padding: '13px 16px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' } },
          h('div', { style: { fontSize: 12.5, fontWeight: 700 } }, '▍AI 判断 vs 人的判断 · 一致率'),
          al.overall != null ? h('span', { style: { fontSize: 14, fontWeight: 800, color: al.overall >= 70 ? C.good : al.overall >= 40 ? C.warn : C.bad } }, al.overall + '%') : null,
          h('span', { style: { fontSize: 11.5, color: C.muted } }, '基于 ' + (al.samples || 0) + ' 次维度对照'),
          h('span', { style: { fontSize: 10.5, color: C.muted, marginLeft: 'auto' } }, '偏差大 = 该维度锚点有歧义，优先修订')),
        dimsAL.length ? h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
          ...dimsAL.slice(0, 8).map(x => h('div', { key: x.dim, style: { flex: '1 1 130px', background: C.surface, borderRadius: 8, padding: '7px 9px' } },
            h('div', { style: { fontSize: 11.5, fontWeight: 700, marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, x.dim),
            h('div', { style: { fontSize: 14, fontWeight: 800, color: x.agreeRate >= 70 ? C.good : x.agreeRate >= 40 ? C.warn : C.bad } }, x.agreeRate + '%'),
            h('div', { style: { fontSize: 10.5, color: C.muted } }, '差1档 ' + x.diff1 + ' · 差2档 ' + x.diff2))))
          : h('div', { style: { fontSize: 11.5, color: C.muted } }, '暂无 AI 与人同维度对照样本。AI 判档后人在面评同维度定档即自动记录。')))
      // ===== 校准仪表 =====
      const cs2 = data.calibrationStats || {}
      out.push(h('div', { style: { ...card, padding: '13px 16px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
          h('div', { style: { fontSize: 12.5, fontWeight: 700 } }, '▍校准闭环 · 标准漂移监控'),
          cs2.drift ? h('span', { style: { fontSize: 11.5, padding: '2px 9px', borderRadius: 9, background: 'rgba(239,68,68,.12)', color: '#fca5a5', fontWeight: 600 } }, '⚠ ' + (cs2.driftMsg || '标准可能漂移')) : h('span', { style: { fontSize: 11.5, color: C.good } }, '✓ 标准稳定')),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          ...[['累计纠偏', cs2.corrections, '次'], ['近 30 天', cs2.last30, '次'], ['AI 评估基数', cs2.agentAssess, '次'], ['纠偏率', cs2.rate, '%']].map((x, i) =>
            h('div', { key: i, style: { flex: '1 1 110px', background: C.surface, borderRadius: 9, padding: '8px 10px', textAlign: 'center' } },
              h('div', { style: { fontSize: 18, fontWeight: 800 } }, String(x[1] != null ? x[1] : '—')),
              h('div', { style: { fontSize: 10.5, color: C.muted, marginTop: 2 } }, x[0]))))))
      return h('div', null, ...out)
    }

    function TalentDossier({ detail, onRevive }) {
      const c = detail.candidate
      const GRADE_HINT = { S: '强烈推荐', A: '推荐', B: '需面试排雷', C: '不建议推进' }
      const grade = (c.route || '').match(/^([SABC])\s*级/)?.[1] || (c.deep && c.deep.grade) || ''
      const score = c.weighted != null ? c.weighted : (c.deep && c.deep.score)
      const sec = (t) => h('div', { style: { fontSize: 11.5, fontWeight: 700, margin: '12px 0 5px' } }, t)
      const TYPE_CN = { 'assessment.recorded': 'AI 评估', 'decision.made': '人工判断', 'stage.advanced': '推进阶段', 'invite.sent': '发送邀约', 'interview.scheduled': '安排面试', 'feedback.submitted': '提交面评', 'candidate.bound': '绑定岗位', 'offer.sent': '发 Offer', 'offer.accepted': 'Offer 接受', 'offer.declined': 'Offer 拒绝', 'background.check': '背景调查', 'hire.confirmed': '确认入职' }
      const tl = (detail.timeline || []).filter(e => TYPE_CN[e.type]).slice(-10)
      return h('div', null,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 } },
          h('b', { style: { fontSize: 16 } }, c.name || c.id),
          h('span', { style: { fontSize: 11.5, padding: '1px 8px', borderRadius: 9, background: C.surface, color: C.muted } }, c.stage),
          (detail.position && detail.position.title) ? h('span', { style: { fontSize: 11.5, color: C.muted } }, detail.position.title) : null),
        h('div', { style: { fontSize: 11, color: C.muted, padding: '8px 11px', background: C.surface, borderRadius: 8, lineHeight: 1.6 } },
          '人才库简历不保留历史评级与分数——每个岗位、每轮机会都从同一起点公平评估。激活后将按新岗位重新初筛。'),
        (detail.skills || []).length ? sec('技能') : null,
        (detail.skills || []).length ? h('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap' } }, ...detail.skills.slice(0, 16).map(sk => h('span', { key: sk.name, style: { fontSize: 11.5, padding: '1px 8px', borderRadius: 8, background: tint(C.accent,.10), color: C.accent } }, sk.name))) : null,
        (c.offer && c.offer.declineReason) ? h('div', null, sec('Offer 拒绝原因'), h('div', { style: { fontSize: 11.5, color: C.warn } }, c.offer.declineReason)) : null,
        tl.length ? h('div', null, sec('历史记录'),
          h('div', { style: { background: C.surface, borderRadius: 8, padding: '8px 10px', fontSize: 11.5, lineHeight: 1.9 } },
            ...tl.map(e => h('div', { key: e.seq, style: { display: 'flex', gap: 6 } },
              h('span', { style: { color: C.muted, flex: 'none', width: 58 } }, e.ts ? new Date(e.ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : ''),
              h('span', { style: { color: e.actor === 'agent' ? C.accent : C.good, flex: 'none', width: 26 } }, e.actor === 'agent' ? 'AI' : '人工'),
              h('span', null, TYPE_CN[e.type]))))) : null,
        sec('简历原文'),
        h('div', { style: { background: C.surface, borderRadius: 8, padding: '8px 10px' } }, h(ResumeView, { text: c.resume, maxH: 300 })),
        h('div', { style: { marginTop: 12 } },
          h('button', { type: 'button', style: { ...primary, width: '100%', padding: '7px 0' }, onClick: onRevive }, '♻ 激活，重新进入流程')))
    }

    function TalentPage({ data, setSel, onGoto }) {
      const pool = data.talentPool || []
      const [picked, setPicked] = React.useState(null)
      const [pickedDetail, setPickedDetail] = React.useState(null)
      const [pickedBusy, setPickedBusy] = React.useState(false)
      const openPick = async (id) => {
        setPicked(id); setPickedBusy(true); setPickedDetail(null)
        try { const j = await api(API + '?candidateId=' + encodeURIComponent(id)); if (j && j.detail) setPickedDetail(j.detail) } catch (e) {} finally { setPickedBusy(false) }
      }
      const [q, setQ] = React.useState('')
      const [skills, setSkills] = React.useState([])
      const [pid, setPid] = React.useState('')
      const [res, setRes] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState('')
      // 池内高频技能（AI 自动抽取，作为筛选入口）
      const counter = {}
      for (const c of pool) for (const sk of (c.skills || [])) counter[sk] = (counter[sk] || 0) + 1
      const topSkills = Object.keys(counter).sort((a, b) => counter[b] - counter[a]).slice(0, 14)
      const search = async (override) => {
        setBusy(true); setMsg('')
        try {
          const body = override || { q, skills, positionId: pid }
          const j = await api('/api/ai-recruiting/talent-search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
          if (!j || !j.ok) { setMsg('检索失败'); return }
          setRes(j)
          if (!j.count) setMsg('没有匹配的历史候选人' + (j.total ? '（池内 ' + j.total + ' 人）' : ''))
        } catch (e) { setMsg('检索失败：' + String(e.message || e)) } finally { setBusy(false) }
      }
      React.useEffect(() => { if (!res) search({ q: '', skills: [], positionId: '' }) }, [])
      const toggleSkill = (sk) => {
        const next = skills.indexOf(sk) >= 0 ? skills.filter(x => x !== sk) : skills.concat([sk])
        setSkills(next); search({ q, skills: next, positionId: pid })
      }
      const revive = async (id) => {
        try {
          const j = await api('/api/ai-recruiting/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'activate', candidateId: id, reason: '人才库激活召回' }) })
          setMsg(j.message || '已激活，进入待评估'); search()
        } catch (e) { setMsg('激活失败：' + String(e.message || e)) }
      }
      const renderTalentDrawer = () => !picked ? null : h('div', { style: { position: 'fixed', inset: 0, background: 'rgba(8,12,22,.5)', zIndex: 9997, display: 'flex', justifyContent: 'flex-end' }, onClick: (e) => { if (e.target === e.currentTarget) { setPicked(null); setPickedDetail(null) } } },
        h('div', { className: 'rec-detail-drawer', style: { width: 560, maxWidth: '96vw', height: '100%', overflowY: 'auto', background: 'var(--dsw-alias-surface-1,#161c2a)', borderLeft: '1px solid ' + C.border, padding: 16 } },
          h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: 10 } }, h('b', { style: { fontSize: 13 } }, '人才档案'), h('div', { style: { flex: 1 } }), h('button', { type: 'button', style: { ...btn, border: 'none', background: 'transparent', fontSize: 15 }, onClick: () => { setPicked(null); setPickedDetail(null) } }, '✕')),
          pickedBusy ? h(Loading, { text: '加载中…' }) : (pickedDetail ? h(TalentDossier, { detail: pickedDetail, onRevive: () => { setPicked(null); setPickedDetail(null); revive(picked) } }) : h(EmptyState, { title: '暂无档案' }))))
      // 初始直接展示池内全部（同步数据），检索有结果时再覆盖——避免异步 search 失败/未回时空白
      const items = (res && res.results) ? res.results : pool.slice(0, 40)
      return h('div', null,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' } },
          h('div', { style: { fontSize: 13, fontWeight: 700 } }, '◈ 人才库'),
          h('span', { style: { fontSize: 11.5, color: C.muted } }, '池内 ' + pool.length + ' 人 · 按技能召回')),
        h('div', { style: { ...card, marginBottom: 9, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
          h('input', { style: { ...input, width: 200 }, value: q, placeholder: '姓名 / 技能关键词', onChange: e => setQ(e.target.value), onKeyDown: e => { if (e.key === 'Enter') search() } }),
          h('select', { style: { ...input, width: 180 }, value: pid, onChange: e => { setPid(e.target.value); search({ q, skills, positionId: e.target.value }) } },
            h('option', { value: '' }, '— 按岗位技能召回 —'),
            ...(data.positions || []).map(p => h('option', { key: p.id, value: p.id }, p.title))),
          h('button', { type: 'button', style: primary, disabled: busy, onClick: () => search() }, busy ? '检索中…' : '检索'),
          skills.length ? h('button', { type: 'button', style: btn, onClick: () => { setSkills([]); search({ q, skills: [], positionId: pid }) } }, '清空技能筛选') : null),
        topSkills.length ? h('div', { style: { display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 10 } },
          ...topSkills.map(sk => h('span', { key: sk, onClick: () => toggleSkill(sk),
            style: { fontSize: 11.5, padding: '3px 10px', borderRadius: 8, cursor: 'pointer', background: skills.indexOf(sk) >= 0 ? C.accent : C.surface, color: skills.indexOf(sk) >= 0 ? '#fff' : C.muted, border: '1px solid ' + (skills.indexOf(sk) >= 0 ? C.accent : C.border) } }, sk))) : null,
        msg ? h('div', { style: { fontSize: 11.5, color: C.muted, marginBottom: 8 } }, msg) : null,
        items.length ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 9 } },
          ...items.map(c => h('div', { key: c.id, style: { ...card, padding: '10px 12px' } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 } },
              h('b', { style: { fontSize: 13 } }, c.name),
              h('span', { style: { fontSize: 10.5, padding: '1px 7px', borderRadius: 8, background: C.surface, color: C.muted } }, c.stage),
              h('span', { style: { marginLeft: 'auto', fontSize: 10.5, color: C.muted } }, '不保留历史评级')),
            (c.skills || []).length ? h('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 5 } },
              ...(c.skills || []).slice(0, 8).map(sk => h('span', { key: sk, style: { fontSize: 10.5, padding: '1px 6px', borderRadius: 7, background: 'rgba(47,107,255,.10)', color: C.accent } }, sk))) : null,
            c.matchReasons && c.matchReasons.length ? h('div', { style: { fontSize: 10.5, color: C.muted, marginBottom: 4 } }, c.matchReasons.slice(0, 3).join(' · ')) : null,
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('span', { style: { fontSize: 10.5, color: C.muted } }, c.positionTitle ? c.positionTitle + ' · ' : '' + (c.daysAgo != null ? c.daysAgo + ' 天前' : '')),
              h('div', { style: { flex: 1 } }),
              h('button', { type: 'button', style: { ...btn, padding: '2px 10px', fontSize: 11.5 }, onClick: () => openPick(c.id) }, '查看'),
              h('button', { type: 'button', style: { ...primary, padding: '2px 10px', fontSize: 11.5 }, onClick: () => revive(c.id) }, '激活')))) )
          : busy ? h(Loading, { text: '检索中…' }) : h(EmptyState, { icon: '◈', title: pool.length ? '用技能或岗位试试检索' : '人才库还没有人', hint: pool.length ? '点上方技能标签或选择岗位召回' : '淘汰或存入人才库的候选人会出现在这里，可随时激活' }),
        renderTalentDrawer())
    }
    function InterviewsPage({ data, setSel, onGoto }) {
      const list = data.interviews || []
      const done = data.interviewsDone || []
      const parseDate = (str) => {
        if (!str) return null
        let m = String(str).match(/(\d{4})-(\d{1,2})-(\d{1,2})/) 
        if (m) return new Date(+m[1], +m[2] - 1, +m[3], 12)
        m = String(str).match(/(\d{1,2})月(\d{1,2})日/)
        if (m) return new Date(new Date().getFullYear(), +m[1] - 1, +m[2], 12)
        return null
      }
      const today = new Date(); today.setHours(0, 0, 0, 0)
      const weekEnd = new Date(today.getTime() + 7 * 86400000)
      const dated = list.map(x => ({ ...x, d: parseDate(x.at) }))
      const undated = dated.filter(x => !x.d)
      const sorted = dated.filter(x => x.d).sort((a, b) => a.d - b.d)
      const groups = [
        { title: '⚠ 已过期未处理', items: sorted.filter(x => x.d < today && ['初试中', '复试中'].indexOf(x.stage) >= 0), color: C.bad },
        { title: '今天', items: sorted.filter(x => x.d >= today && x.d < new Date(today.getTime() + 86400000)), color: C.accent },
        { title: '本周内', items: sorted.filter(x => x.d >= new Date(today.getTime() + 86400000) && x.d <= weekEnd), color: C.good },
        { title: '更远 / 未定时间', items: sorted.filter(x => x.d > weekEnd).concat(undated), color: C.muted },
      ]
      const row = (x, dim) => h('div', { key: x.candidateId + x.ts, onClick: () => { setSel(x.candidateId); onGoto('process') },
        style: { display: 'flex', gap: 8, alignItems: 'center', padding: '7px 10px', borderBottom: '1px solid ' + C.border, cursor: 'pointer', opacity: dim ? .55 : 1 } },
        h('b', { style: { fontSize: 12.5, minWidth: 60 } }, x.name),
        h('span', { style: { fontSize: 11.5, padding: '1px 8px', borderRadius: 8, background: x.round === '复试' ? 'rgba(124,58,237,.10)' : 'var(--dsh-accent-soft, rgba(47,107,255,.10))', color: x.round === '复试' ? '#7c3aed' : C.accent } }, x.round),
        h('span', { style: { fontSize: 11.5, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, x.at || '（时间待定）'),
        x.interviewer ? h('span', { style: { fontSize: 11.5, color: C.muted } }, '面试官 ' + x.interviewer) : null,
        x.place ? h('span', { style: { fontSize: 11.5, color: C.muted } }, x.place) : null,
        h('span', { style: token(C.muted) }, x.stage))
      return h('div', null,
        h('div', { style: { fontSize: 13, fontWeight: 700, margin: '4px 0 10px' } }, '📅 面试日程'),
        list.length || done.length ? null : h('div', { style: card, fontSize: 11.5, color: C.muted, textAlign: 'center' }, '还没有安排面试。在「候选人流程」给待初试/待复试的候选人点「安排面试」。'),
        ...groups.filter(g => g.items.length).map(g => h('div', { key: g.title, style: { ...card, padding: 0, overflow: 'hidden', marginBottom: 10 } },
          h('div', { style: { padding: '8px 10px', fontSize: 11.5, fontWeight: 700, color: g.color, borderBottom: '2px solid ' + (g.color === C.muted ? C.border : g.color) } }, g.title + '（' + g.items.length + '）'),
          ...g.items.map(x => row(x, false)))),
        done.length ? h('div', { style: { ...card, padding: 0, overflow: 'hidden' } },
          h('div', { style: { padding: '8px 10px', fontSize: 11.5, fontWeight: 700, color: C.muted, borderBottom: '1px solid ' + C.border } }, '已完成 / 定局'),
          ...done.map(x => row(x, true))) : null)
    }

    function LogPage({ data, sel }) {
      // detail 只对选中候选人有 timeline；若无选中或未加载详情，提示
      const detail = data.detail && data.detail.candidate
      const useDetail = detail && (!sel || detail.id === sel)
      if (!useDetail) return h('div', { style: card }, '请在「候选人流程」选择一个候选人后查看其完整工作日志')
      const chain = data.detail.timeline || []
      return h('div', null,
        h('div', { style: { fontSize: 13, fontWeight: 700, marginBottom: 10 } }, '工作日志 · ' + detail.name + '（' + chain.length + ' 条流转）'),
        h('div', { style: card }, ...renderTimeline(chain)))
    }

    function Workbench({ ctx }) {
      const [nav, setNav] = React.useState('overview')
      const [sel, setSel] = React.useState(null)
      const [stage, setStage] = React.useState('')
      const [view, setView] = React.useState('kanban')
      const [lastSeq, setLastSeq] = React.useState(null)
      const [toast, setToast] = React.useState('')
      const [hint, setHint] = React.useState(null)
      // 浮层表单：看板卡"下一步"原地办理，不再跳详情页
      const [modal, setModal] = React.useState(null)
      const [period, setPeriod] = React.useState('all')
      const { data, error, busy, reload } = useWorkbench(sel, period)
      // 看板卡"下一步"直达：选人 + 跳流程页 + 打开对应表单（或直接执行轻动作）
      const act = (body) => api(ACTION, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(j => { setToast(j.message || '完成'); reload(); return j }).catch(e => setToast('失败：' + String(e.message || e)))
      const openWith = (id, action) => {
        try {
        setSel(id); setNav('process')
        if (!action) { setHint(null); return }
        if (action === 'auto') { autoAll(); return }
        if (action === 'adopt') { act({ action: 'adopt', candidateId: id }); return }
        if (action === 'activate') { act({ action: 'activate', candidateId: id, reason: '看板一键激活' }); return }
        // 表单类动作 → 原地浮层（flow:xxx / offer）
        if (action.indexOf('flow:') === 0 || action === 'offer') { setModal({ kind: action === 'offer' ? 'send_offer' : action.slice(5), cid: id }); return }
        setHint({ key: action, nonce: Date.now() })
        } catch (e) { setToast('打开失败：' + String((e && e.message) || e)) }
      }
      const onAction = (j) => { setLastSeq(j.seq); setToast(j.message || ''); reload() }
      const autoAll = async () => {
        try { const j = await api(AUTO, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); setToast('AI 初筛完成：' + j.assessed + ' 人'); reload() } catch (e) { setToast('初筛失败：' + e.message) }
      }
      React.useEffect(() => { const t = setTimeout(() => setToast(''), 4000); return () => clearTimeout(t) }, [toast])

      // 防畸形响应：任何字段缺失都走友好提示，绝不白屏
      if (!data || !data.candidates || !data.inbox || !data.dashboard) return h('div', { style: { padding: 30, textAlign: 'center' } }, h('div', { style: card },
        error ? h('span', { style: { color: C.warn } }, '读取失败：' + error + '　') : null,
        h('button', { type: 'button', style: primary, onClick: () => reload() }, '↻ 重试')))
      const counts = { __pending: data.inbox.length }
      for (const c of data.candidates || []) counts[c.stage] = (counts[c.stage] || 0) + 1

      // 顶部工具条（contextual）
      const top = h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '10px 16px', borderBottom: '1px solid ' + C.border } },
        h('div', { style: { fontSize: 14, fontWeight: 700, marginRight: 4 } }, (NAV.find(n => n.id === nav) || {}).label || ''),
        // 周期切换：仅概览（数据大屏按周/月看流量，环比自动）
        nav === 'overview' ? h('div', { style: { display: 'flex', gap: 0, border: '1px solid ' + C.border, borderRadius: 8, overflow: 'hidden' } },
          ...[['week', '本周'], ['month', '本月'], ['all', '累计']].map(([p, lbl]) => h('button', { key: p, type: 'button',
            onClick: () => setPeriod(p),
            style: { border: 'none', padding: '4px 12px', fontSize: 11.5, cursor: 'pointer',
              background: period === p ? C.accent : 'transparent', color: period === p ? '#fff' : C.muted, fontWeight: period === p ? 700 : 400 } }, lbl))) : null,
        h('div', { style: { flex: 1 } }),
        h('button', { type: 'button', style: { ...btn, padding: '3px 10px', fontSize: 11.5 }, onClick: reload }, busy ? '刷新中…' : '刷新'),
        h('button', { type: 'button', style: { ...btn, padding: '3px 10px', fontSize: 11.5 }, onClick: async () => {
          try {
            const j = await api('/api/ai-recruiting/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'all' }) })
            if (!j || !j.ok) { setToast('导出失败'); return }
            const blob = new Blob(['\ufeff' + j.csv], { type: 'text/csv;charset=utf-8' })
            const url = URL.createObjectURL(blob)
            const aEl = document.createElement('a')
            aEl.href = url; aEl.download = j.filename || 'recruiting.csv'
            document.body.appendChild(aEl); aEl.click(); document.body.removeChild(aEl)
            setTimeout(() => URL.revokeObjectURL(url), 2000)
            setToast('已导出 ' + j.filename)
          } catch (e) { setToast('导出失败：' + String(e.message || e)) }
        } }, '⇩ 导出 CSV'),
        h('button', { type: 'button', style: { ...btn, padding: '3px 10px', fontSize: 11.5 }, title: '下载看板数据（KPI/漏斗/渠道/职位/趋势）', onClick: () => {
          try {
            const dd = (data && data.dashboard) || {}
            const rows = []
            rows.push(['板块', '指标', '值', '单位'])
            for (const x of (dd.kpis || [])) rows.push(['KPI', x.label, x.value, x.unit || ''])
            for (const x of (dd.kpisMinor || [])) rows.push(['KPI', x.label, x.value, x.unit || ''])
            for (const x of (dd.pipeline || [])) rows.push(['漏斗', x.label, x.count, ''])
            for (const x of (dd.sourceFunnel || [])) rows.push(['渠道·' + x.source, '简历', x.total, ''], ['渠道·' + x.source, '初筛', x.screened, ''], ['渠道·' + x.source, '初面', x.interview, ''], ['渠道·' + x.source, 'Offer', x.offer, ''], ['渠道·' + x.source, '入职', x.hired, ''])
            for (const x of (dd.hiring || [])) rows.push(['职位·' + x.title, '需求', x.hc, ''], ['职位·' + x.title, '已入职', x.hired, ''], ['职位·' + x.title, '在途', x.inFlow, ''], ['职位·' + x.title, '缺口', x.gap, ''])
            for (const x of (data.trend || [])) rows.push(['趋势', x.date, x.candidates, ''])
            const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'
            const csv = '\ufeff' + rows.map(r => r.map(esc).join(',')).join('\n')
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
            const url = URL.createObjectURL(blob)
            const aEl = document.createElement('a')
            aEl.href = url; aEl.download = 'dashboard-' + ((data.dashboard || {}).periodMode || 'all') + '-' + new Date().toISOString().slice(0, 10) + '.csv'
            document.body.appendChild(aEl); aEl.click(); document.body.removeChild(aEl)
            setTimeout(() => URL.revokeObjectURL(url), 2000)
            setToast('已下载看板数据 CSV')
          } catch (e) { setToast('下载失败：' + String(e.message || e)) }
        } }, '⬇ 数据'))

      // 主区内容按导航切换
      let body
      if (nav === 'overview') body = h(OverviewPage, { data, counts, onGoto: setNav, setSel, onOpen: openWith })
      else if (nav === 'ai') body = h(AiCapPage, { data })
      else if (nav === 'log') body = h(LogPage, { data, sel })
      else if (nav === 'interviews') body = h(InterviewsPage, { data, setSel, onGoto: () => setNav('process') })
      else if (nav === 'talent') body = h(Safe, { render: () => h(TalentPage, { data, setSel, onGoto: setNav }) })
      else if (nav === 'intake') body = h(IntakePage, { data, onDone: reload, onGoto: setNav, onOpen: (id) => setSel(id) })
      else if (nav === 'positions') body = h(PositionForm, { positions: data.positions, hiring: (data.dashboard || {}).hiring || [], salaryAccuracy: data.salaryAccuracy || [], salaryCal: data.salaryCal || {}, onDone: reload, onCancel: () => setNav('overview') })
      else if (nav === 'settings') body = h('div', null,
        h('div', { style: { fontSize: 13, fontWeight: 700, marginBottom: 10 } }, '设置'),
        h('div', { style: { fontSize: 11.5, color: C.muted, marginBottom: 12 } }, '一次性配置项。日常高频操作不在设置里。'),
        h(MailForm, { onDone: reload, onCancel: () => setNav('overview') }))
      else {
        const flowSetStage = (st) => { setStage(st); const l = st ? ((data.candidates||[]).filter(x => x.stage === st)) : (data.candidates||[]); if (l.length) setSel(l[0].id) }
        const viewToggle = h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 } },
          h('div', { style: { display: 'flex', border: '1px solid ' + C.border, borderRadius: 8, overflow: 'hidden' } },
            h('button', { type: 'button', onClick: () => setView('kanban'), style: { ...btn, border: 'none', borderRadius: 0, padding: '4px 12px', fontSize: 11.5, background: view === 'kanban' ? C.accent : 'transparent', color: view === 'kanban' ? '#fff' : 'inherit', fontWeight: view === 'kanban' ? 700 : 400 } }, '▤ 看板'),
            h('button', { type: 'button', onClick: () => setView('list'), style: { ...btn, border: 'none', borderRadius: 0, padding: '4px 12px', fontSize: 11.5, background: view === 'list' ? C.accent : 'transparent', color: view === 'list' ? '#fff' : 'inherit', fontWeight: view === 'list' ? 700 : 400 } }, '☰ 列表')),
          h('div', { style: { flex: 1 } }),
          h('span', { style: { fontSize: 11.5, color: C.muted } }, '共 ' + ((data.candidates || []).length) + ' 位候选人'))
        let flowBody
        if (view === 'kanban') {
          const d = data.detail && data.detail.candidate && data.detail.candidate.id === sel
          const detailPart = d
            ? h('div', { style: { marginTop: 12 } }, h(Detail, { detail: data.detail, onAction, lastSeq, onOpenLog: () => setNav('log'), positions: data.positions, panelHint: hint }))
            : h('div', { style: { ...card, marginTop: 12, fontSize: 11.5, color: C.muted, textAlign: 'center' } }, '点击上方任一候选人卡片查看详情与操作')
          flowBody = h('div', null, h(Funnel, { counts, stage, setStage: flowSetStage }), h(Kanban, { data, sel, setSel, onOpen: openWith, onMore: (st) => { setView('list'); flowSetStage(st) }, onAdopt: (id) => { act({ action: 'adopt', candidateId: id }) } }), detailPart)
        } else {
          const visible = stage ? (data.candidates || []).filter(x => x.stage === stage) : (data.candidates || [])
          const detailOk = data.detail && data.detail.candidate && (!sel || visible.some(x => x.id === sel))
          let right
          if (detailOk) right = h('div', null, h(Detail, { detail: data.detail, onAction, lastSeq, onOpenLog: () => setNav('log'), positions: data.positions, panelHint: hint }))
          else if (visible.length) right = h('div', { style: card }, h('div', { style: { fontSize: 11.5, color: C.muted } }, '当前筛选「' + stage + '」共 ' + visible.length + ' 人，点击左侧查看'))
          else right = h('div', { style: card }, '该筛选下暂无候选人')
          flowBody = h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(250px,320px) 1fr', gap: 12, alignItems: 'start' } },
            h(CandidateList, { data, sel, setSel, stage, setStage: flowSetStage, onAction: () => reload() }), right)
        }
        // 流程页全宽（接入简历是独立模块，不在这里）
        body = h('div', null, viewToggle, flowBody)
      }


      // 左导航固定 + 右主区独立滚动
      const modalCand = modal ? (data.candidates || []).find(x => x.id === modal.cid) : null
      const modalPos = modal ? (data.positions || []).find(x => x.id === (modalCand || {}).pid) : null
      return h('div', { style: { display: 'flex', height: '100%', minHeight: 0, flexDirection: 'column', color: 'var(--dsh-text-primary, inherit)' } },
        top,
        // 浮层表单
        modal && modalCand ? h('div', { style: { position: 'fixed', inset: 0, background: 'rgba(8,12,22,.55)', backdropFilter: 'blur(3px)', zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, animation: 'recFade .15s ease-out' },
          onClick: (e) => { if (e.target === e.currentTarget) setModal(null) } },
          h('div', { style: { width: 480, maxWidth: '94vw', maxHeight: '86vh', overflowY: 'auto', background: 'var(--dsw-alias-surface-1, #161c2a)', border: '1px solid rgba(127,143,170,.22)', borderRadius: 16, boxShadow: '0 24px 70px rgba(0,0,0,.55)', animation: 'recPop .18s ease-out' } },
            h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 16px', borderBottom: '1px solid ' + C.border } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                h('span', { style: { width: 8, height: 8, borderRadius: 99, background: C.accent, display: 'inline-block' } }),
                h('b', { style: { fontSize: 13 } }, (modalCand.name || '') + ' · ' + ({ invite: '发初试邀约', interview: '安排面试', feedback: '录面评', send_offer: '发 Offer', hire: '确认入职', eliminate: '淘汰' }[modal.kind] || '操作')),
                h('span', { style: token(C.muted) }, modalCand.stage || '')),
              h('button', { type: 'button', onClick: () => setModal(null), style: { ...btn, border: 'none', background: 'transparent', fontSize: 15, padding: '2px 8px' } }, '✕')),
            h('div', { style: { padding: '14px 16px 16px' } },
              h(FlowForm, { kind: modal.kind, candidate: modalCand, position: modalPos, round: modalCand.stage === '待复试' || modalCand.stage === '复试中' ? '复试' : '初试',
                onCancel: () => setModal(null),
                onDone: (body) => { setModal(null); api(ACTION, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, candidateId: modal.cid }) }).then(j => { setToast(j.message || '完成'); reload() }).catch(e => setToast('失败：' + String(e.message || e))) } })))) : null,
        h('div', { style: { display: 'flex', flex: 1, minHeight: 0 } },
          h(NavRail, { nav: NAV, active: nav, setActive: setNav, counts, data }),
          h('div', { style: { flex: 1, minWidth: 0, overflowY: 'auto', padding: '14px 18px 40px' } },
            toast ? h('div', { style: { ...card, marginBottom: 10, fontSize: 11.5, color: /^(失败|出错|错误)/.test(toast) ? C.bad : C.good, borderColor: /^(失败|出错|错误)/.test(toast) ? C.bad : C.good } }, toast) : null,
            body)),
        nav === 'overview' ? h(AIDataBot, { data, dark: false }) : null)
    }

    /* ============ 会话首屏精简条 ============ */
    function CompactBar({ ctx }) {
      const [d, setD] = React.useState(null)
      React.useEffect(() => { const load = () => api(BOARD).then(setD).catch(() => {}); load(); const id = setInterval(load, 30000); return () => clearInterval(id) }, [])
      const open = () => { try { if (ctx.layout && ctx.layout.selectPanel) ctx.layout.selectPanel('ai-recruiting') } catch (e) {} }
      if (!d) return null
      const pick = ['candidates', 'pending', 'evaluated']
      return h('div', { style: { ...card, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', margin: '4px 0', padding: '6px 12px' } },
        h('span', { style: { fontWeight: 700, color: C.accent, fontSize: 11.5 } }, '招聘'),
        ...d.kpis.filter(x => pick.indexOf(x.key) >= 0).map(x => h('span', { key: x.key, style: { fontSize: 11.5 } }, h('span', { style: { color: C.muted } }, x.label + ' '), h('b', null, String(x.value) + x.unit)))),
        h('div', { style: { flex: 1 } }),
        h('button', { type: 'button', style: { ...btn, borderColor: C.accent, color: C.accent }, onClick: open }, '打开工作台 →')
    }


    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'ai-recruiting', order: 100, label: 'AI 招聘工作台' }, PanelIcon))
        // mainPanel 是 flex:1/min-height:0 的 flex 列容器，子项用 flex:1+min-height:0 即可撑满并自行滚动
        const fill = { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'auto', width: '100%' }
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'ai-recruiting' }, () => h('div', { style: fill }, h(Safe, { render: () => h(Workbench, { ctx }) }))))
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'ai-recruiting-compact', order: 5, label: '招聘' }, () => h(Safe, { render: () => h(CompactBar, { ctx }) })))
      },
    }
  },
})
