#!/usr/bin/env node
// kr-skill-release-check 점검 스크립트. 읽기 전용이며 값은 가려서 출력한다(위치와 건수 위주).
// 사용: node scan.mjs <대상 폴더> [--terms=<사전 파일>] [--no-history] [--max-commits=500]
// 종료 코드: 차단이 1건 이상이면 1, 아니면 0.
import { readFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs'
import { join, relative, basename, extname, resolve, dirname, sep } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const flag = (name) => argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
const flagVal = (name) => flag(name)?.split('=').slice(1).join('=')
const target = resolve(argv.find((a) => !a.startsWith('--')) || '.')
if (!existsSync(target) || !statSync(target).isDirectory()) {
  console.error(`대상 폴더를 찾지 못했습니다: ${target}`)
  process.exit(2)
}
const doHistory = !flag('no-history')
const maxCommits = Number(flagVal('max-commits') || 500)

// ---------- 규칙 불러오기 (Rust 문법 → JS 정규식) ----------
const P = JSON.parse(readFileSync(join(HERE, '..', 'references', 'patterns.json'), 'utf8'))
const toRe = (src) => {
  let s = src
  let flags = 'gu'
  if (s.startsWith('(?i)')) { s = s.slice(4); flags += 'i' }
  s = s.replace(/\\x\{([0-9A-Fa-f]+)\}/g, '\\u{$1}')
  return new RegExp(s, flags)
}
const rules = P.rules.map((r) => ({ ...r, re: toRe(r.regex) }))
const hints = (P.placeholder_hints || []).map((h) => h.toLowerCase())

// ---------- 가리기 ----------
const maskVal = (v) => (v.length <= 2 ? '*'.repeat(v.length) : v.slice(0, 2) + '*'.repeat(Math.min(v.length - 2, 8)))
const maskTerm = (t) => (t.length <= 1 ? '*' : t[0] + '*'.repeat(Math.min(t.length - 1, 6)))
const maskEmail = (e) => {
  const [l, d = ''] = e.split('@')
  const parts = d.split('.')
  const tld = parts.length > 1 ? parts[parts.length - 1] : ''
  return `${l.slice(0, 1)}**@${d.slice(0, 1)}***${tld ? '.' + tld : ''}`
}

// ---------- 사용자 사전 ----------
let termsPath = flagVal('terms')
const candidates = [join(target, '.release-check-terms.txt'), join(homedir(), '.claude', 'kr-skill-release-check', 'private-terms.txt')]
if (!termsPath) termsPath = candidates.find((p) => existsSync(p))
const terms = termsPath && existsSync(termsPath)
  ? readFileSync(termsPath, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  : []
const termsAbs = termsPath ? resolve(termsPath) : null

// ---------- 가려서 보기 ----------
const redactView = flagVal('redact-view')
if (redactView) {
  const p = resolve(target, redactView)
  if (!p.startsWith(target + sep) || !existsSync(p)) { console.error('대상 폴더 안의 파일만 볼 수 있습니다: ' + redactView); process.exit(2) }
  const t = readFileSync(p, 'utf8').split(/\r?\n/)
  t.forEach((line, i) => {
    let out = line
    for (const r of rules) out = out.replace(new RegExp(r.re.source, r.re.flags), (m) => maskVal(m))
    for (const term of terms) out = out.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => maskTerm(m))
    console.log(String(i + 1).padStart(4) + '  ' + out)
  })
  process.exit(0)
}

// ---------- 파일 순회 ----------
const SKIP_DIRS = new Set(['.git', 'node_modules'])
const BIN_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.woff', '.woff2', '.ttf', '.otf', '.zip', '.gz', '.mp3', '.mp4', '.exe', '.dll', '.jar', '.pptx', '.docx', '.xlsx'])
const files = []
const allNames = [] // 상대 경로(바이너리 포함)
const skippedBinary = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) walk(p); continue }
    allNames.push(relative(target, p).split(sep).join('/'))
    if (BIN_EXT.has(extname(name).toLowerCase())) { skippedBinary.push(relative(target, p)); continue }
    files.push(p)
  }
}
walk(target)

const readText = (p) => {
  const st = statSync(p)
  if (st.size > 2 * 1024 * 1024) return null
  const fd = openSync(p, 'r')
  const buf = Buffer.alloc(Math.min(st.size, 2 * 1024 * 1024))
  readSync(fd, buf, 0, buf.length, 0)
  closeSync(fd)
  if (buf.includes(0)) return null
  return buf.toString('utf8')
}

// ---------- 점검 ----------
const groups = new Map() // key: kind|id|file -> {sev, label, file, lines:Set, previews:Set, placeholder}
const note = (sev, kind, id, label, file, line, preview, placeholder) => {
  const key = `${kind}|${id}|${file}`
  if (!groups.has(key)) groups.set(key, { sev, kind, id, label, file, lines: new Set(), previews: new Set(), placeholder: true })
  const g = groups.get(key)
  g.lines.add(line)
  if (g.previews.size < 2) g.previews.add(preview)
  if (!placeholder) g.placeholder = false
}
const isPlaceholder = (line) => { const l = line.toLowerCase(); return hints.some((h) => l.includes(h)) }
const ruleHits = new Map(rules.map((r) => [r.id, 0]))

let skippedBig = 0
for (const f of files) {
  if (termsAbs && resolve(f) === termsAbs) continue
  const rel = relative(target, f).split(sep).join('/')
  const text = readText(f)
  if (text === null) { skippedBig++; continue }
  const lines = text.split(/\r?\n/)
  lines.forEach((line, i) => {
    for (const r of rules) {
      r.re.lastIndex = 0
      const m = r.re.exec(line)
      if (m) {
        ruleHits.set(r.id, ruleHits.get(r.id) + 1)
        note(r.severity, 'rule', r.id, r.name, rel, i + 1, maskVal(m[0]), isPlaceholder(line))
      }
    }
    const low = line.toLowerCase()
    terms.forEach((t, ti) => { if (low.includes(t.toLowerCase())) note('block', 'term', `t${ti}`, '사용자 사전 단어', rel, i + 1, maskTerm(t), false) })
  })
  const relLow = rel.toLowerCase()
  terms.forEach((t, ti) => { if (relLow.includes(t.toLowerCase())) note('block', 'term', `t${ti}`, '사용자 사전 단어(파일·폴더 이름)', rel, 0, maskTerm(t), false) })
}

// ---------- git ----------
const git = (args) => spawnSync('git', args, { cwd: target, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
const isRepo = existsSync(join(target, '.git'))
const extra = [] // {sev, label, detail}
const PERSONAL = ['gmail.com', 'naver.com', 'daum.net', 'hanmail.net', 'kakao.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'yahoo.com', 'proton.me', 'protonmail.com', 'users.noreply.github.com', 'noreply.github.com']

// 사전 파일 보호 상태
if (termsAbs && resolve(termsAbs).startsWith(target + sep)) {
  const relTerms = relative(target, termsAbs).split(sep).join('/')
  if (isRepo) {
    const ignored = git(['check-ignore', '-q', '--', relTerms]).status === 0
    const tracked = git(['ls-files', '--error-unmatch', '--', relTerms]).status === 0
    if (tracked) extra.push({ sev: 'block', label: '사전 파일이 git에 추적 중', detail: `${relTerms} → .gitignore에 추가하고 \`git rm --cached ${relTerms}\`로 추적 해제. 이미 커밋됐다면 이력에도 남아 있으니 새 저장소로 올리거나 이력을 정리해야 함` })
    else if (!ignored) extra.push({ sev: 'block', label: '사전 파일이 .gitignore에 없음', detail: `${relTerms} → .gitignore에 한 줄 추가(또는 파일을 ~/.claude/kr-skill-release-check/private-terms.txt로 이동)` })
  } else {
    extra.push({ sev: 'warn', label: '사전 파일이 대상 폴더 안에 있음', detail: `${relTerms} → 공개 전 반드시 제외하거나 저장소 밖으로 이동` })
  }
}

const relTermsRepo = termsAbs && termsAbs.startsWith(target + sep) ? relative(target, termsAbs).split(sep).join('/') : null
const SECRET_NAMES = /(^|\/)(\.env(\.(?!example|sample|template)[^/]*)?|id_rsa|id_ed25519|id_dsa|credentials\.json|\.npmrc|\.pypirc|[^/]+\.(pem|key|p12|pfx|keystore))$/i
for (const n of allNames.filter((x) => SECRET_NAMES.test(x))) {
  let tracked = false
  if (isRepo) tracked = git(['ls-files', '--error-unmatch', '--', n]).status === 0
  const ignored = isRepo && git(['check-ignore', '-q', '--', n]).status === 0
  extra.push({ sev: tracked || !ignored ? 'block' : 'warn', label: '비밀 파일 이름', detail: `${n} → ${tracked ? 'git에 추적 중. 추적 해제(git rm --cached)하고 .gitignore에 추가, 이미 커밋됐으면 키 폐기와 이력 정리' : !ignored ? '.gitignore에 없음. 공개 대상에서 빼거나 .gitignore에 추가' : '.gitignore로 제외됨 (그래도 값이 이력에 없는지 확인)'}` })
}
let historyInfo = null
if (isRepo && doHistory) {
  const emailOut = git(['log', '--all', '--format=%ae%n%ce'])
  const emails = [...new Set((emailOut.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean))]
  const nonPersonal = emails.filter((e) => !PERSONAL.includes((e.split('@')[1] || '').toLowerCase()))
  for (const e of nonPersonal) extra.push({ sev: 'warn', label: '커밋 작성자 이메일이 개인 도메인 목록에 없음', detail: `${maskEmail(e)} → 회사 주소인지 확인. 회사 주소면 이력을 다시 쓰거나 새 저장소로 올려야 함` })
  const log = git(['log', '--all', `--max-count=${maxCommits}`, '-p', '--no-color', '--format=@@COMMIT %h'])
  const out = log.stdout || ''
  const commitCount = (out.match(/^@@COMMIT /gm) || []).length
  const hist = new Map() // kind|id|file -> {commits:Set}
  let commit = '', file = ''
  const blockRules = rules.filter((r) => r.severity === 'block')
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('@@COMMIT ')) { commit = line.slice(9); continue }
    if (line.startsWith('diff --git ')) {
      file = line.replace(/^diff --git a\/.* b\//, '')
      const fl = file.toLowerCase()
      if (!(relTermsRepo && file === relTermsRepo)) terms.forEach((t, ti) => { if (fl.includes(t.toLowerCase())) bump('term', `t${ti}`, '사전 단어(이력의 파일 이름)', file, commit) })
      continue
    }
    if (!line.startsWith('+') || line.startsWith('+++')) continue
    if (relTermsRepo && file === relTermsRepo) continue // 사전 파일 자체는 위에서 따로 보고함
    const body = line.slice(1)
    for (const r of blockRules) { r.re.lastIndex = 0; if (r.re.test(body)) bump('rule', r.id, r.name, file, commit) }
    const low = body.toLowerCase()
    terms.forEach((t, ti) => { if (low.includes(t.toLowerCase())) bump('term', `t${ti}`, '사용자 사전 단어', file, commit) })
  }
  function bump(kind, id, label, f, c) {
    const key = `${kind}|${id}|${f}`
    if (!hist.has(key)) hist.set(key, { label, file: f, commits: new Set() })
    hist.get(key).commits.add(c)
  }
  for (const h of hist.values()) extra.push({ sev: 'block', label: `이력에 남은 값: ${h.label}`, detail: `${h.file} (커밋 ${[...h.commits].slice(0, 3).join(', ')}${h.commits.size > 3 ? ' 외' : ''}) → 현재 파일에서 지워도 이력에 남음. 키는 폐기, 이력은 재작성하거나 새 저장소로 이전` })
  historyInfo = { commitCount, truncated: commitCount >= maxCommits, emails: emails.length }
}

// ---------- 구조 ----------
const structure = []
const findSkillMd = (dir, depth) => {
  const found = []
  if (existsSync(join(dir, 'SKILL.md'))) found.push(dir)
  if (depth > 0) for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (!SKIP_DIRS.has(n) && statSync(p).isDirectory()) found.push(...findSkillMd(p, depth - 1))
  }
  return found
}
const skillDirs = findSkillMd(target, 3)
if (!skillDirs.length) structure.push(['SKILL.md', '없음 (스킬 폴더가 아닐 수 있음)'])
for (const d of skillDirs) {
  const rel = relative(target, d).split(sep).join('/') || '.'
  const md = readFileSync(join(d, 'SKILL.md'), 'utf8')
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)
  if (!fm) { structure.push([`${rel}/SKILL.md 프런트매터`, '실패 (--- 블록 없음)']); continue }
  const name = /^name:\s*(.+)$/m.exec(fm[1])?.[1]?.trim()
  const desc = /^description:\s*(.+)$/m.exec(fm[1])?.[1]?.trim()
  structure.push([`${rel} name`, name ? (/^[a-z0-9-]+$/.test(name) ? `통과 (${name})` : `실패 (소문자·숫자·하이픈만: ${name})`) : '실패 (없음)'])
  if (name && basename(d) !== name && d !== target) structure.push([`${rel} name과 폴더 이름 일치`, `실패 (폴더: ${basename(d)})`])
  structure.push([`${rel} description`, !desc ? '실패 (없음)' : desc.length < 30 || !/사용|때|when|use/i.test(desc) ? '경고 ("언제 쓰는지"와 사용자 발화 예시가 부족해 보임)' : '통과'])
}
const rootNames = readdirSync(target)
structure.push(['LICENSE', rootNames.some((n) => /^licen[sc]e/i.test(n)) ? '통과' : '실패 (없음)'])
structure.push(['README', rootNames.some((n) => /^readme/i.test(n)) ? '통과' : '실패 (없음)'])

// ---------- 출력 ----------
const all = [...groups.values()]
const blockGroups = all.filter((g) => g.sev === 'block')
const warnGroups = all.filter((g) => g.sev === 'warn')
const blockExtra = extra.filter((e) => e.sev === 'block')
const warnExtra = extra.filter((e) => e.sev === 'warn')
const blockN = blockGroups.length + blockExtra.length
const warnN = warnGroups.length + warnExtra.length

const fmtLines = (s) => { const a = [...s].filter((n) => n > 0).sort((x, y) => x - y); return a.length ? (a.length > 4 ? `${a.slice(0, 4).join(',')} 외 ${a.length - 4}줄` : a.join(',')) : '-' }
const actionFor = (g) => (g.kind === 'term' ? '일반 표현이나 가상의 이름으로 교체' : g.sev === 'block' ? '삭제하거나 가상 값으로 교체. 키·토큰이면 폐기' : '예시·플레이스홀더인지 확인')
const row = (g) => `| ${g.label}${g.kind === 'rule' ? ' [' + g.id + ']' : ''} | ${g.file}${g.lines.size && [...g.lines][0] > 0 ? ':' + fmtLines(g.lines) : ''} | ${[...g.previews].join(' / ')}${g.sev === 'block' && g.kind === 'rule' && g.placeholder ? ' (예시처럼 보임, 사용자 확인 필요)' : ''} | ${actionFor(g)} |`
const extraRow = (e) => { const i = e.detail.indexOf(' → '); return i < 0 ? `| ${e.label} | - | - | ${e.detail} |` : `| ${e.label} | ${e.detail.slice(0, i)} | - | ${e.detail.slice(i + 3)} |` }

console.log(`# scan 결과: ${basename(target)}`)
console.log(`대상: ${target}`)
console.log(`검사한 텍스트 파일 ${files.length - skippedBig}개 (숨김 파일 포함). 건너뜀: 바이너리 ${skippedBinary.length}개, 큰 파일·NUL 포함 ${skippedBig}개.`)
console.log(`사전: ${terms.length ? `${terms.length}단어 (${termsPath})` : '없음 (규칙 점검만)'}`)
console.log(`건수 기준: 같은 원인(규칙 또는 사전 단어) × 같은 파일은 1건으로 센다.`)
console.log(`\nSUMMARY block=${blockN} warn=${warnN}\n`)

console.log('## 차단')
if (!blockN) console.log('없음')
else {
  console.log('| 구분 | 위치 | 가린 미리보기 | 조치 안내 |\n|---|---|---|---|')
  blockGroups.forEach((g) => console.log(row(g)))
  blockExtra.forEach((e) => console.log(extraRow(e)))
}
console.log('\n## 경고')
if (!warnN) console.log('없음')
else {
  console.log('| 구분 | 위치 | 가린 미리보기 | 조치 안내 |\n|---|---|---|---|')
  warnGroups.forEach((g) => console.log(row(g)))
  warnExtra.forEach((e) => console.log(extraRow(e)))
}
const zero = rules.filter((r) => ruleHits.get(r.id) === 0).map((r) => `${r.id}(${r.name})`)
console.log(`\n## 규칙 점검: ${rules.length}개 규칙 중 ${rules.length - zero.length}개에서 발견`)
console.log(`0건: ${zero.join(', ') || '-'}`)
console.log('\n## 이력')
console.log(!isRepo ? 'git 저장소가 아님 (점검 안 함)' : !doHistory ? '--no-history로 건너뜀' : `커밋 ${historyInfo.commitCount}개 검사${historyInfo.truncated ? ` (상한 ${maxCommits}개에서 멈춤, --max-commits로 늘릴 수 있음)` : ''}, 작성자·커미터 이메일 ${historyInfo.emails}개`)
console.log('\n## 구조')
console.log('| 항목 | 결과 |\n|---|---|')
structure.forEach(([a, b]) => console.log(`| ${a} | ${b} |`))
console.log('\n## 확인하지 못한 것')
console.log('- 이미지·PDF 등 바이너리 속 글자' + (skippedBinary.length ? ` (${skippedBinary.length}개 파일: ${skippedBinary.slice(0, 5).join(', ')}${skippedBinary.length > 5 ? ' 외' : ''})` : ''))
console.log('- 규칙과 사전에 없는 기밀. 통과는 "안전하다"는 뜻이 아님')
process.exit(blockN ? 1 : 0)
