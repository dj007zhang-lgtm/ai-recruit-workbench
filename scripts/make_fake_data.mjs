#!/usr/bin/env node
// 生成演示用假数据（职位 + 2 名假候选人），写入 data/ 目录。
// 用途：新环境无真实数据时的演示。绝不放入真实候选人信息。
// 用法：node scripts/make_fake_data.mjs [输出目录，默认 ./data]
import { mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendEvent } from '../ai-recruiting-workbench/ledger.js'

const out = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..', 'data')
mkdirSync(out, { recursive: true })
if (existsSync(join(out, 'events.jsonl'))) { console.log('该目录已有事件账本，跳过（避免覆盖）：' + out); process.exit(0) }

// 假职位
const p = appendEvent(out, { type: 'position.created', actor: 'human', subject: { kind: 'position', id: 'Pdemo1' },
  payload: { id: 'Pdemo1', title: '演示·后端工程师', dept: '技术部', city: '杭州', hc: 2, status: '在招',
    gates: ['统招本科', '计算机相关专业'], abilities: ['量化成果', '技能深度', '行业匹配', '职业成长'] } })

// 假候选人（虚构姓名 + 虚构联系方式）
const fake = [
  { id: 'Cdemo1', name: '张演示', resume: '张演示 本科 计算机科学与技术 2018-2022 XX大学\n工作经历：2022-至今 某科技公司 后端工程师\n技能：Java Spring MySQL Redis，主导订单系统，QPS 提升 3 倍' },
  { id: 'Cdemo2', name: '李示例', resume: '李示例 硕士 软件工程 2019-2022 YY大学\n工作经历：2022-至今 另一家公司 后端工程师\n技能：Go MySQL Kafka，负责网关重构' },
]
for (const f of fake) {
  appendEvent(out, { type: 'resume.received', actor: 'human', subject: { kind: 'candidate', id: f.id },
    payload: { name: f.name, source: '自搜', pid: 'Pdemo1', resume: f.resume, phone: '13800000000', email: 'demo@example.com' } })
}
console.log('✅ 演示数据已生成：' + out)
console.log('   把插件数据目录指向它即可演示（或直接把 events.jsonl 复制进你的 recruiting/）。')
