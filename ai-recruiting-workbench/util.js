/* 公共工具：入口脱敏与输入哈希。工具层、上传端点、邮箱管道共用同一套规则。 */
export const SENSITIVE = [
  { n: '性别', re: /(性别\s*[:：]?\s*[男女]|(?:^|[|/,，\s])[男女](?:[|/,，\s]|$))/g },
  { n: '年龄/出生', re: /(年龄\s*[:：]?\s*\d{1,3}\s*岁?|出生(?:日期|年月)?\s*[:：]?\s*\d{4}[-/.年]\d{1,2}|\d{4}年\d{1,2}月出生|\d{2,3}\s*岁)/g },
  { n: '婚育', re: /(婚姻状况|已婚|未婚|已育|未育|育有|子女|生育)/g },
  { n: '民族/宗教', re: /(民族\s*[:：]?\s*\S{1,6}|宗教\s*[:：]?\s*\S{1,8}|信仰\s*\S{1,8})/g },
  { n: '户籍/籍贯', re: /(户籍|籍贯|户口所在地)\s*[:：]?\s*\S{2,14}/g },
]

export function scrub(text) {
  let out = String(text || ''), dropped = []
  for (const s of SENSITIVE) {
    const m = out.match(s.re)
    if (m && m.length) { dropped.push(`${s.n}×${m.length}`); out = out.replace(s.re, ' ') }  // 直接删除敏感片段，不留占位符污染评估
  }
  return { text: out, dropped }
}

export function hash(s) {
  // 对 Buffer 直接按字节算；对字符串按字符算。绝不 String(buffer)——那会把二进制
  // 展开成巨字符串，O(n^2) 卡死大文件上传。
  let h = 2166136261
  if (Buffer.isBuffer(s) || ArrayBuffer.isView(s)) {
    const b = Buffer.isBuffer(s) ? s : Buffer.from(s)
    for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 16777619) }
  } else {
    const str = String(s)
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) }
  }
  return 'h' + (h >>> 0).toString(16)
}
