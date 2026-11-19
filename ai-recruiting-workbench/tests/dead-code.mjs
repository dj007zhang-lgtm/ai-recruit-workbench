/* 全局死代码/残留扫描（只读报告）：
   1. 定义了但从未被引用的组件/函数（死代码温床）
   2. 重复出现的 UI 区块标题（同一概念多处渲染）
   3. 导出但未被任何文件引用的函数
   用法：node tests/dead-code.mjs */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = fileURLToPath(new URL('..', import.meta.url))
const files = readdirSync(DIR).filter(f => f.endsWith('.js') && !f.startsWith('.'))

let problems = 0
const report = (msg) => { problems++; console.log('  ⚠ ' + msg) }

console.log('===== 1. 定义但从未引用的函数/组件（排除导出与测试） =====')
for (const f of files) {
  const src = readFileSync(join(DIR, f), 'utf8')
  // 收集定义名
  const defs = []
  for (const m of src.matchAll(/^\s*(?:function\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\(|function|async))/gm)) {
    defs.push(m[1] || m[2])
  }
  for (const name of new Set(defs)) {
    if (/^(app|ctx|config|dispose|export|default|require|module|globalThis)$/.test(name)) continue
    // 引用次数：其他行出现同名（排除定义行）
    const defLine = new RegExp('^\\s*(?:function\\s+' + name + '\\b|const\\s+' + name + '\\s*=)', 'm')
    const all = (src.match(new RegExp('\\b' + name + '\\b', 'g')) || []).length
    const exported = new RegExp('export\\s+(?:function|const)\\s+' + name + '\\b').test(src)
    if (all <= 1 && !exported) report(f + ' :: ' + name + ' 定义后从未使用')
  }
}

console.log('\n===== 2. 重复出现的区块标题（可能残留） =====')
const titles = {}
for (const f of files) {
  const src = readFileSync(join(DIR, f), 'utf8')
  for (const m of src.matchAll(/['"]([▍▎■✦⚑◇◈📥📊🎯⚡]{1,2}\s?[\u4e00-\u9fa5A-Za-z0-9（）·\- ]{2,24})['"]/g)) {
    const t = m[1].replace(/^[▍▎■✦⚑◇◈📥📊🎯⚡]\s?/, '').trim()
    if (t.length < 2) continue
    titles[t] = (titles[t] || []).concat([f])
  }
}
for (const t of Object.keys(titles)) {
  const n = titles[t].length
  if (n > 2) report('标题「' + t + '」出现 ' + n + ' 次 by ' + Array.from(new Set(titles[t])).join(','))
}

console.log('\n===== 3. 导出但没人 import 的模块函数 =====')
const exportsByFile = {}
for (const f of files) {
  const src = readFileSync(join(DIR, f), 'utf8')
  exportsByFile[f] = Array.from(src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)).map(m => m[1])
}
for (const f of Object.keys(exportsByFile)) {
  for (const name of exportsByFile[f]) {
    let used = 0
    for (const g of files) {
      if (g === f) continue
      const src = readFileSync(join(DIR, g), 'utf8')
      if (new RegExp('\\b' + name + '\\b').test(src)) used++
    }
    // 同文件内也有引用（模块内部使用 + export 供测试）→ 不算死导出
    const ownSrc = readFileSync(join(DIR, f), 'utf8')
    const ownUses = (ownSrc.match(new RegExp('\\b' + name + '\\b', 'g')) || []).length
    if (used === 0 && ownUses <= 1) report(f + ' :: export ' + name + ' 无外部使用（测试或死导出）')
  }
}

console.log('\n' + (problems ? '发现 ' + problems + ' 个可疑项（人工确认后清理）' : '✅ 未发现死代码'))
