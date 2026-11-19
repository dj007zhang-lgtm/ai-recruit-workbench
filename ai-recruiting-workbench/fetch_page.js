/* 用 Chrome headless + CDP 抓取渲染后的页面正文（解决 SPA 招聘页）。
   特点：完全静默（--headless=new 无窗口）、独立 user-data-dir（不碰用户主 Chrome）、
        不需要任何 Apple Events / 浏览器授权设置；用完即杀、清理临时目录。
   依赖：本机已安装 Google Chrome（未安装则返回明确错误）。 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
]
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
// 页面是否真的渲染出了职位内容：长度 + 关键词双判定（避免只拿到"加载中"框架）
const JD_WORDS = ['职责', '要求', '任职', '岗位', '经验', '技能', '学历', '工作内容', '薪资', '优先', '能力', '招聘']
function looksLikeJd(text) {
  const t = String(text || '')
  if (t.trim().length < 260) return false
  let hits = 0
  for (const w of JD_WORDS) if (t.indexOf(w) >= 0) hits++
  return hits >= 2
}

function findChrome() {
  for (const p of CHROME_PATHS) if (existsSync(p)) return p
  return null
}

async function getJSON(url, timeoutMs = 5000) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: ctl.signal })
    if (!r.ok) return null
    return await r.json()
  } catch (e) { return null } finally { clearTimeout(t) }
}

/** 用 CDP 打开页面、等加载、取 body.innerText、关闭。返回 {ok, text, error} */
export async function fetchRenderedPage(url, opts = {}) {
  const chrome = findChrome()
  if (!chrome) return { ok: false, error: '未找到 Google Chrome（需要本机安装 Chrome 才能渲染动态页面）' }
  const port = 9200 + Math.floor(Math.random() * 600)
  const profile = mkdtempSync(join(tmpdir(), 'rc-cdp-'))
  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--mute-audio', '--hide-scrollbars',
    '--window-size=1280,1600',
    '--user-data-dir=' + profile,
    '--remote-debugging-port=' + port,
    'about:blank',
  ]
  let child = null
  try {
    child = spawn(chrome, args, { stdio: 'ignore', detached: false })
    // 等 CDP 就绪
    let ready = false
    for (let i = 0; i < 40; i++) {
      await sleep(250)
      const v = await getJSON('http://127.0.0.1:' + port + '/json/version', 1500)
      if (v) { ready = true; break }
    }
    if (!ready) return { ok: false, error: 'Chrome 调试端口未就绪（可能被安全软件拦截）' }
    // 新建标签
    let tab = await getJSON('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(url), 5000)
    if (!tab || !tab.webSocketDebuggerUrl) {
      // 新版 Chrome 要求 PUT
      try {
        const r = await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(url), { method: 'PUT' })
        if (r.ok) tab = await r.json()
      } catch (e) {}
    }
    if (!tab || !tab.webSocketDebuggerUrl) return { ok: false, error: '无法创建浏览器标签（CDP 拒绝）' }
    const ws = new WebSocket(tab.webSocketDebuggerUrl)
    const send = (id, method, params) => ws.send(JSON.stringify({ id, method, params }))
    const result = await new Promise((resolve) => {
      let done = false
      const finish = (v) => { if (!done) { done = true; resolve(v) } }
      const timer = setTimeout(() => finish({ ok: false, error: '页面加载超时或未完成渲染（可能需登录）' }), opts.timeoutMs || 30000)
      ws.onopen = () => { send(1, 'Runtime.enable', {}) }
      ws.onmessage = async (ev) => {
        let msg = null
        try { msg = JSON.parse(String(ev.data)) } catch (e) { return }
        if (msg.id === 1) {
          // 轮询正文：SPA 需要时间渲染
          for (let i = 0; i < 18; i++) {
            await sleep(800)
            send(100 + i, 'Runtime.evaluate', {
              expression: "document.body ? document.body.innerText : ''",
              returnByValue: true, awaitPromise: false,
            })
          }
        }
        if (typeof msg.id === 'number' && msg.id >= 100) {
          const val = msg.result && msg.result.result && msg.result.result.value
          if (typeof val === 'string' && looksLikeJd(val)) {
            clearTimeout(timer); finish({ ok: true, text: val })
          }
        }
      }
      ws.onerror = () => { clearTimeout(timer); finish({ ok: false, error: 'CDP 连接失败' }) }
    })
    try { ws.close() } catch (e) {}
    return result
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  } finally {
    try { if (child) child.kill('SIGKILL') } catch (e) {}
    await sleep(200)
    try { rmSync(profile, { recursive: true, force: true }) } catch (e) {}
  }
}
