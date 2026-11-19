/* 接入层：原件留档 → 解析 → 脱敏 → 去重 → 写 resume.received 事件。
   以及数据穿透：看板指标 / 阶段 / 渠道 → 候选人名单 → 原件与事件链。 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { appendEvent, fold, replay, readEvents, migrateLegacy } from './ledger.js'
import { scrub, hash } from './util.js'
import { techStackFit } from './deepscore.js'

import { SOURCES } from './ledger.js'
const DEFAULT_PY = '/Users/andyzhang/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3'

function safe(s) { return String(s || 'attachment').replace(/[/\\:*?"<>|\r\n\t]/g, '_').slice(0, 120) }

/** 从文件名推导候选人姓名：去掉「简历/resume/CV」等噪声与日期、括号、版本号。 */
// ===== 从简历【正文】提取姓名（此前只看文件名，导致猎聘导出的公司名"元璟被投"成了人名）=====
// 常见姓氏（百家姓高频）
const SURNAMES = '王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤'
// 平台噪音行（猎聘导出头部/栏目名）
const NOISE_LINE = /^(主动应聘|声明[:：]|操作时间|求职意向|工作经历|教育经历|语言能力|技能标签|自我评价|附加信息|附件简历|作品|个人优势|意向[:：]|优先|以上|点击查看|职位|电话|邮件|邮箱|城市|薪资|到岗| Summary)/i

export function extractNameFromText(text) {
  const t = String(text || '')
  if (!t) return ''
  // 1) 显式标签：姓名：张三 / 姓 名：张三
  let m = t.match(/姓\s*名[：:]?\s*([\u4e00-\u9fa5]{2,4})/)
  if (m) return cleanName(m[1]) || m[1]
  // 2) 猎聘/平台称谓：| 张女士 在职（正文里唯一的真人指代）
  m = t.match(/[|｜]\s*([\u4e00-\u9fa5]{1,3}(?:先生|女士))\s*(?:在职|看看|离职|正在找)/)
  if (m) return m[1]
  // 2.5) 首行以"姓名 | 字段 | ..."开头（表格型简历）
  const firstLine = (t.split(/\r?\n/)[0] || '').replace(/[\xa0\u3000]/g, ' ')
  const seg0 = firstLine.split(/[|｜]/)[0].replace(/\s+/g, '').trim()
  if (seg0.length >= 2 && seg0.length <= 4 && /^[\u4e00-\u9fa5]+$/.test(seg0) && SURNAMES.indexOf(seg0[0]) >= 0) return seg0
  // 3) 逐行扫描：独立姓名行（2-4 汉字、首字常见姓）
  const lines = t.split(/\r?\n/).map(x => x.replace(/[\xa0\u3000]/g, ' ').trim()).filter(Boolean)
  for (let i = 0; i < Math.min(lines.length, 16); i++) {
    const line = lines[i]
    if (NOISE_LINE.test(line) || line.length > 12) continue
    const core = line.replace(/^[·•\-—|｜\s]+|[·•\-—|｜\s]+$/g, '').replace(/\s+/g, '')
    if (core.length < 2 || core.length > 4) continue
    if (!/^[\u4e00-\u9fa5]+$/.test(core)) continue           // 纯汉字
    if (SURNAMES.indexOf(core[0]) < 0) continue                 // 首字是常见姓
    if (/(意向|经历|能力|优势|评价|信息|简历|城市|薪资|时间|开发|工程师|程序员|经理|主管|总监|人事|招聘|行政|产品|运营|分析|测试|设计)/.test(core)) continue // 栏目/职业词误报
    // 前 3 行直接采信（简历开头即姓名是惯例）；其后需邻行佐证（日期/电话/邮箱/教育）
    if (i < 3) return core
    const next = lines[i + 1] || ''
    if (/^\d{4}[-~—至]|1[3-9]\d{9}|[\w.]+@[\w]|大学|学院|本科|硕士|博士/.test(next)) return core
  }
  return ''
}

export function cleanName(raw) {
  let s = String(raw || '').replace(/[_-]+/g, ' ').trim()
  s = s.replace(/[（(\[【].*?[）)\]】]/g, ' ')          // 去括号注释
  s = s.replace(/\d{4}[-./年]?\d{0,2}[-./月]?\d{0,2}日?/g, ' ') // 去日期
  s = s.replace(/(个人)?简历|求职简历|应聘|resume|cv|v\d+|终版|最新|副本|copy/gi, ' ')
  s = s.replace(/[\s·,，.]+/g, ' ').trim()
  // 中文姓名：取前 2-4 个连续汉字；否则取第一段
  const zh = s.match(/[\u4e00-\u9fa5]{2,4}/)
  if (zh) return zh[0]
  return s.split(/\s+/)[0] || ''
}
// 身份键：姓名归一 +（手机或邮箱任一）。不含 pid —— 同一人换岗位/换邮箱/换手机投递也要识别
function normName(n) { return String(n || '').replace(/\s|简历|的简历/g, '').trim().toLowerCase() }
function identityKeys(c) {
  const keys = []
  const name = normName(c.name)
  const phone = String(c.phone || '').replace(/\D/g, '')
  const email = String(c.email || '').toLowerCase().trim()
  if (name && phone) keys.push('np:' + name + '|' + phone)
  if (name && email) keys.push('ne:' + name + '|' + email)
  if (phone && phone.length >= 7) keys.push('p:' + phone)   // 仅凭手机也算同一人
  if (email) keys.push('e:' + email)                          // 仅凭邮箱也算同一人
  return keys
}
// 内容指纹：简历正文前若干字→判"换马甲重复投"（改了名字但内容相同）
function contentHash(resume) { return hash(String(resume || '').replace(/\s/g, '').slice(0, 400)) }

/** 解析一份原件：调用自带的 parse_resume.py，失败不阻断接入。 */
function parseFile(file, pythonPath, scriptDir) {
  const script = join(scriptDir, 'parse_resume.py')
  const candidates = [pythonPath, DEFAULT_PY, 'python3'].filter(Boolean)
  for (const py of candidates) {
    const r = spawnSync(py, [script, file], { encoding: 'utf8', timeout: 40000, maxBuffer: 4 * 1024 * 1024 })
    if (r.error && r.error.code === 'ENOENT') continue
    if (r.status === 0 && r.stdout) {
      try { return JSON.parse(r.stdout.trim().split('\n').pop()) } catch (e) { /* fall through */ }
    }
  }
  return { ok: false, text: '', format: '', needsOcr: false, warnings: ['解析脚本不可用，原件已留档，需人工补录'] }
}

/**
 * 上传 / 邮件推送统一入口。
 * a: {name, filename, contentBase64, positionId, source, phone, email, from, subject, date, messageId}
 */
export function handleUpload(d, a, opts = {}) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  migrateLegacy(d)
  const filename = safe(basename(String(a.filename || 'resume.txt')))
  if (!a.contentBase64) throw new Error('contentBase64 is required')
  const buf = Buffer.from(String(a.contentBase64), 'base64')
  if (!buf.length) throw new Error('empty file')
  if (buf.length > 20 * 1024 * 1024) throw new Error('file exceeds 20MB')

  const s0 = fold(d)
  const mailId = a.messageId ? String(a.messageId) : ''
  if (mailId) {
    const dupMail = readEvents(d).find(e => e.type === 'resume.received' && (e.payload || {}).mail && e.payload.mail.messageId === mailId)
    if (dupMail) return { ok: false, duplicateOf: dupMail.subject.id, reason: '同一封邮件已接入' }
  }

  const cid = 'C' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
  const fileDir = join(d, 'files', cid)
  mkdirSync(fileDir, { recursive: true })
  const filePath = join(fileDir, filename)
  writeFileSync(filePath, buf)
  const relFile = join('files', cid, filename)

  const parsed = parseFile(filePath, opts.pythonPath, opts.scriptDir)
  const clean = scrub(parsed.text || '')
  const inferred = extractNameFromText(clean.text) || cleanName(filename.replace(/\.[^.]+$/, ''))
  const name = String(a.name || '').trim() || inferred || '待补录候选人'
  const phone = String(a.phone || '')
  const emailAddr = String(a.email || '')
  const pid = String(a.positionId || '')
  // 来源：规范渠道或自定义（自由文本，≤12字）；空白才落「其他」
  const srcRaw = String(a.source || '').trim()
  const source = srcRaw ? (SOURCES.indexOf(srcRaw) >= 0 ? srcRaw : srcRaw.slice(0, 12)) : '其他'

  const c = { name, phone, email: emailAddr, pid }

  // ===== 前置校验 1：身份去重（跨岗位/换邮箱/换手机）=====
  const myKeys = identityKeys(c)
  const chash = contentHash(clean.text)
  let dup = null, dupReason = ''
  for (const x of s0.candidates) {
    if (myKeys.some(k => identityKeys(x).indexOf(k) >= 0)) { dup = x; dupReason = '同一人（姓名/手机/邮箱匹配）'; break }
  }
  // 内容指纹：改名字换马甲但简历正文几乎相同
  if (!dup && clean.text.length > 30) {
    for (const x of s0.candidates) {
      if (x.resume && contentHash(x.resume) === chash) {
        dup = x
        dupReason = (x.name === name) ? '同一人重复投递（简历内容一致）' : ('简历内容与「' + x.name + '」高度重合（疑似换名重复投）')
        break
      }
    }
  }
  if (dup) {
    // 跨岗位锁定：同一人已在某岗位流程中，投其他岗位不另开流程（避免一人多流程、状态打架）
    const curPos = dup.pid ? s0.positions.find(p => p.id === dup.pid) : null
    const appliedPos = pid ? s0.positions.find(p => p.id === pid) : null
    const crossPos = !!(pid && dup.pid && pid !== dup.pid)
    const locked = crossPos && ['待初试', '初试中', '待复试', '复试中', '待背调', '待发 Offer', 'Offer已发', 'Offer已接受', '待入职', '已入职'].indexOf(dup.stage) >= 0
    const lockNote = locked
      ? ('已在「' + ((curPos && curPos.title) || dup.pid) + '」流程中（' + dup.stage + '），本次「' + ((appliedPos && appliedPos.title) || pid) + '」投递已记录意向但不开新流程')
      : ''
    const ev = appendEvent(d, {
      type: 'resume.received', actor: 'system', subject: { kind: 'candidate', id: dup.id },
      payload: { duplicateAttachment: relFile, dupReason, appliedPid: pid, appliedPidTitle: (appliedPos && appliedPos.title) || '',
        crossPosition: crossPos, lockedByFlow: locked, lockNote,
        mail: { from: a.from || '', subject: a.subject || '', date: a.date || '', messageId: mailId, sourceReason: a.sourceReason || '', sourceConf: a.sourceConf || '' } },
      causedBy: dup.seqs ? dup.seqs[dup.seqs.length - 1] : null,
    })
    return { ok: true, duplicate: true, duplicateOf: dup.id, candidateId: dup.id, seq: ev.seq, file: relFile,
      reason: dupReason, crossPosition: crossPos, lockedByFlow: locked, lockNote,
      note: locked ? lockNote : '重复投递，已并入原候选人并留档原件' }
  }

  // ===== 前置校验 2：技术栈适配预检（投错岗位）=====
  let bindPid = pid, precheck = null
  if (pid) {
    const pos = s0.positions.find(x => x.id === pid)
    if (pos) {
      const fit = techStackFit(pos, clean.text)
      precheck = fit
      if (fit.fit === 'mismatch') {
        bindPid = ''   // 方向不符：不绑定，进"待分配"，人来确认真实意向
      }
    }
  }

  const ev = appendEvent(d, {
    type: 'resume.received', actor: a.messageId ? 'system' : 'human',
    subject: { kind: 'candidate', id: cid },
    payload: {
      name, pid: bindPid, appliedPid: pid, source, phone, email: emailAddr, resume: clean.text,
      precheck: precheck ? { fit: precheck.fit, reason: precheck.reason, jobStacks: precheck.jobStacks, candStacks: precheck.candStacks } : null,
      intentFlag: (pid && !bindPid) ? '疑似投错岗位，待确认意向' : (pid ? '' : '未指定岗位，待分配'),
      dropped: clean.dropped,
      files: [relFile],
      needsOcr: !!parsed.needsOcr,
      parse: { format: parsed.format, warnings: parsed.warnings || [], ok: parsed.ok !== false, readability: parsed.readability || null, ocr: !!parsed.ocr },
      mail: { from: a.from || '', subject: a.subject || '', date: a.date || '', messageId: mailId, sourceReason: a.sourceReason || '', sourceConf: a.sourceConf || '' },
      created: new Date().toISOString(),
    },
    evidence: clean.dropped.length ? ['入口脱敏：' + clean.dropped.join('、')] : [],
    inputHash: hash(buf),
  })
  // 上传即绑定也记 candidate.bound（与后绑定同口径：账本里岗位关联全程可追溯）
  if (bindPid) appendEvent(d, { type: 'candidate.bound', actor: 'system', subject: { kind: 'candidate', id: cid }, payload: { pid: bindPid, atIntake: true }, causedBy: ev.seq })
  return {
    ok: true, candidateId: cid, seq: ev.seq, stage: '待评估',
    file: relFile, parsedChars: clean.text.length,
    needsOcr: !!parsed.needsOcr, warnings: parsed.warnings || [],
    dropped: clean.dropped,
  }
}

/** 数据穿透：从看板指标 / 阶段 / 渠道下钻到候选人，并带上原件与事件链摘要。 */
export function drill(d, q = {}) {
  migrateLegacy(d)
  const s = fold(d)
  let items = s.candidates.slice()
  const label = []

  const metric = String(q.metric || '')
  if (metric === 'pending') {
    items = items.filter(c => c.stage === '待发 Offer' || c.stage === '待评估')
    label.push('待办')
  } else if (metric === 'evaluated') {
    items = items.filter(c => c.scores)
    label.push('已评估')
  } else if (metric === 'hired') {
    items = items.filter(c => c.stage === '已入职')
    label.push('已入职')
  } else if (metric === 'active') {
    return { criteria: '在招职位', count: s.positions.length, items: s.positions.map(p => ({ id: p.id, title: p.title, dept: p.dept, city: p.city, band: p.band, status: p.status })), kind: 'positions' }
  } else if (metric === 'candidates' || metric === '') {
    label.push('全部候选人')
  }
  if (q.stage) { items = items.filter(c => c.stage === q.stage); label.push('阶段 ' + q.stage) }
  if (q.source) { items = items.filter(c => c.source === q.source); label.push('渠道 ' + q.source) }

  const rows = items.map(c => {
    const r = replay(d, c.id)
    return {
      id: c.id, name: c.name, stage: c.stage, source: c.source, pid: c.pid,
      conf: c.conf, route: c.route, undetermined: c.undetermined || [],
      files: c.files || [], needsOcr: !!c.needsOcr,
      eventCount: r.eventCount,
      lastEvent: r.chain.length ? { seq: r.chain[r.chain.length - 1].seq, type: r.chain[r.chain.length - 1].type, actor: r.chain[r.chain.length - 1].actor } : null,
      firstEventAt: r.chain.length ? r.chain[0].ts : null,
    }
  })
  return { criteria: label.join(' / ') || '全部候选人', count: rows.length, kind: 'candidates', items: rows }
}

/** 留档清单：所有原件与对应候选人。 */
export function archive(d) {
  migrateLegacy(d)
  const s = fold(d)
  const root = join(d, 'files')
  let count = 0
  if (existsSync(root)) {
    for (const sub of readdirSync(root)) {
      const p = join(root, sub)
      if (existsSync(p)) count += readdirSync(p).length
    }
  }
  return {
    dir: root, fileCount: count,
    candidatesWithFiles: s.candidates.filter(c => (c.files || []).length).map(c => ({ id: c.id, name: c.name, files: c.files })),
    ledgerEvents: readEvents(d).length,
    dataDir: d,
  }
}
