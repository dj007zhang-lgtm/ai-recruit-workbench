/* LLM 调用契约检查：llmDeepAssess 返回 {ok,text}，误当字符串用是隐蔽 bug（曾导致 [object Object]）。
   规则：`= await llmDeepAssess(` 必须同时出现 .text 或走 llmText() 包装 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const DIR = fileURLToPath(new URL('..', import.meta.url))
let bad = 0
for (const f of readdirSync(DIR).filter(x => x.endsWith('.js'))) {
  const src = readFileSync(join(DIR, f), 'utf8')
  const lines = src.split('\n')
  lines.forEach((ln, i) => {
    if (!/await llmDeepAssess\(/.test(ln)) return
    if (/llmText\(/.test(ln)) return
    // 本行或后 2 行必须出现 .text
    const ctx = lines.slice(i, i + 5).join('\n')
    if (!/\.text|\.ok/.test(ctx)) { bad++; console.log('  ⚠ ' + f + ':' + (i + 1) + ' 直接使用 llmDeepAssess 返回值（应为 {ok,text} 对象）') }
  })
}
console.log(bad ? '发现 ' + bad + ' 处契约违规' : '✅ LLM 调用契约正常')
process.exit(bad ? 1 : 0)
