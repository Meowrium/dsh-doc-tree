/**
 * dsh-doc-tree — host half.
 *
 * Provides the model-facing half of the document-tree plugin:
 *
 *   - `doc_tree_scan`       scan the workspace docs root and list Markdown files
 *   - `doc_tree_read_plan`  read the current `.dsh-doc-tree.json`
 *   - `doc_tree_apply_plan` validate groups / write `.dsh-doc-tree.json`
 *                           (`dryRun:true` validates and diffs without writing)
 *   - `doc_tree_lint`       read-only mechanical quality checks (links, status,
 *                           duplicates, orphans, classification)
 *   - `/docs-organize`      inject a Chinese prompt that makes the model design
 *                           the layering, lint, preview with `dryRun`, and get
 *                           explicit human approval via `ask_user_question`
 *                           before it is allowed to write the config
 *
 * The client half (./client) only reads the config file; it never runs host
 * code. Everything here goes through the official host services (`ctx.fs`,
 * `ctx.tools`, `ctx.commands`); no `@deepseek-ai/*` import is used, so the
 * package keeps working without its own node_modules.
 */

import { createHash, randomUUID } from 'node:crypto'

export const name = 'dsh-doc-tree'
export const inject = ['commands', 'tools', 'fs']

/** Config file name, written at the workspace root. */
export const CONFIG_FILE = '.dsh-doc-tree.json'
/** Config schema version understood by the client half. */
export const CONFIG_VERSION = 1
/** Default record lifecycles shown by the client. */
export const DEFAULT_LIFECYCLES = Object.freeze(['proposed', 'implemented', 'rejected', 'archived'])

/** Only Markdown flavours are part of the document tree. */
const DOC_EXT_RE = /\.(md|mdx|markdown)$/i
/** Directories never descended into (spec + client-side ignore list). */
const IGNORE_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'output',
  'coverage',
  'vendor',
  '.scratch',
  '.tmp',
])
/** Directory depth cap (root files are depth 0). */
const MAX_DEPTH = 6
/** File count cap per scan. */
const MAX_FILES = 2000
/** Head window used for title / Status extraction. */
const HEAD_CHARS = 2048
/** Directory names that look like a docs root during auto-discovery. */
const ROOT_NAME_RE = /^(docs?|documentation|wiki|design|specs?|handbook|guide|notes?)$/i
/** Auto-discovery breadth caps (kept small so a scan stays a few hundred listings). */
const DISCOVER_TOP_DIRS = 30
const DISCOVER_CHILD_DIRS = 20
const DISCOVER_LEAF_DIRS = 8
const DISCOVER_LIMIT = 12

//#region small helpers

function slashPath(value) {
  return String(value ?? '').replace(/\\/g, '/')
}

function trimTrailingSlash(value) {
  return slashPath(value).replace(/\/+$/u, '')
}

function normalizeRelLabel(value) {
  return trimTrailingSlash(String(value ?? '').trim().replace(/^\.\//u, ''))
}

/** Path of `abs` relative to `base` (forward slashes); `abs` when outside. */
function relativeTo(base, abs) {
  const b = trimTrailingSlash(base)
  const a = slashPath(abs)
  if (b === '') return a.replace(/^\.\//u, '')
  const lb = b.toLowerCase()
  const la = a.toLowerCase()
  if (la === lb) return ''
  if (la.startsWith(lb + '/')) return a.slice(b.length + 1)
  return a
}

function targetDisplay(target, fallback) {
  if (target && typeof target.displayPath === 'string' && target.displayPath.length > 0) return target.displayPath
  return String(fallback ?? '')
}

function messageOf(error) {
  if (error === undefined || error === null) return '未知错误'
  if (typeof error === 'string') return error
  return String(error.message ?? error)
}

function isMissingError(error) {
  const code = String(error?.code ?? '')
  const message = String(error?.message ?? error ?? '')
  return /FS_NOT_FOUND|ENOENT|no such file/iu.test(code) || /FS_NOT_FOUND|ENOENT|no such file/iu.test(message)
}

function isDuplicateRegistration(error) {
  return /already registered|duplicate|已注册/iu.test(String(error?.message ?? error))
}

/**
 * Compile one docs-root-relative glob.
 *
 * Mirrors the client's `globToRegExp` exactly so host validation and the UI
 * always agree on which file belongs to which group: `*` stays inside one
 * path segment, `**` crosses segments, `?` matches one non-separator character.
 *
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  const source = String(glob ?? '').replace(/\\/g, '/').trim()
  let re = '^'
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '*') {
      if (source[i + 1] === '*') {
        re += '.*'
        i += 1
        if (source[i + 1] === '/') i += 1
      } else {
        re += '[^/]*'
      }
    } else if (ch === '?') {
      re += '[^/]'
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  re += '$'
  return new RegExp(re, 'i')
}

function extractTitle(head) {
  const match = /^[ \t]{0,3}#[ \t]+(.+)$/mu.exec(head)
  if (!match) return undefined
  const title = match[1].replace(/[ \t]+#+[ \t]*$/u, '').trim()
  return title.length > 0 ? title : undefined
}

function extractStatus(head) {
  const match = /^[ \t]*(?:>?[ \t]*)?(?:[-*][ \t]+)?status[ \t]*[:：][ \t]*([A-Za-z][\w-]*)/imu.exec(head)
  if (!match) return undefined
  return match[1].toLowerCase()
}

function clampInt(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

//#endregion

//#region scan

async function walkMarkdown(fs, rootTarget, includeStatus) {
  const files = []
  let dirs = 0
  let truncated = false

  async function visit(target, relDir, depth) {
    let entries
    try {
      entries = await fs.listDir(target)
    } catch (error) {
      if (depth === 0) throw error
      return
    }
    if (!Array.isArray(entries)) return
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const entryName = entry?.name
      if (typeof entryName !== 'string' || entryName.length === 0 || entryName.startsWith('.')) continue
      const rel = relDir === '' ? entryName : `${relDir}/${entryName}`
      if (entry.type === 'directory') {
        if (depth >= MAX_DEPTH) continue
        if (IGNORE_DIR_NAMES.has(entryName.toLowerCase())) continue
        dirs += 1
        await visit(entry.target, rel, depth + 1)
        continue
      }
      if (entry.type !== 'file' || !DOC_EXT_RE.test(entryName)) continue
      if (files.length >= MAX_FILES) {
        truncated = true
        continue
      }
      const record = { path: rel }
      if (typeof entry.size === 'number' && Number.isFinite(entry.size)) record.bytes = entry.size
      try {
        const text = await fs.readText(entry.target)
        const head = String(text ?? '').slice(0, HEAD_CHARS)
        const title = extractTitle(head)
        if (title !== undefined) record.title = title
        if (includeStatus) {
          const status = extractStatus(head)
          if (status !== undefined) record.status = status
        }
      } catch {
        // A single unreadable file must not abort the whole scan.
      }
      files.push(record)
    }
  }

  await visit(rootTarget, '', 0)
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { files, dirs, truncated }
}

async function listDirAt(fs, cwd, rel) {
  try {
    const target = await fs.resolve(rel, { cwd })
    return await fs.listDir(target)
  } catch {
    return []
  }
}

/**
 * Best-effort docs-root discovery under the workspace root.
 *
 * Looks for `docs` / `documentation` / `wiki` style directories at the first
 * level, one project below (`<top>/docs`), and two levels below
 * (`<top>/<project>/docs`), scoring by config presence, entry markers and the
 * number of direct Markdown files.
 *
 * @param {object} fs host filesystem (`resolve` / `listDir`)
 * @param {string} workspaceRoot absolute workspace root
 * @returns {Promise<Array<{path: string, score: number, count: number}>>}
 */
export async function discoverRoots(fs, workspaceRoot) {
  const workspace = trimTrailingSlash(workspaceRoot)
  const found = []
  const seen = new Set()
  // Hard budget on directory listings: auto-discovery is best-effort and must
  // never turn into a full recursive walk of a large workspace.
  let budget = 2000

  async function probe(rel, baseScore) {
    const path = normalizeRelLabel(rel)
    if (path === '' || seen.has(path) || budget <= 0) return
    seen.add(path)
    budget -= 1
    let target
    try {
      target = await fs.resolve(path, { cwd: workspace })
    } catch {
      return
    }
    let entries
    try {
      entries = await fs.listDir(target)
    } catch {
      return
    }
    if (!Array.isArray(entries)) return
    const names = new Set(entries.map((entry) => entry.name))
    const md = entries.filter((entry) => entry.type === 'file' && DOC_EXT_RE.test(String(entry.name))).length
    const marker = names.has('README.md') || names.has('AGENTS.md') || names.has('index.md')
    const hasConfig = names.has(CONFIG_FILE)
    if (!marker && md < 2 && !hasConfig) return
    found.push({
      path,
      score: (baseScore || 0) + (hasConfig ? 4 : 0) + (marker ? 2 : 0) + Math.min(md, 5),
      count: md,
    })
  }

  const isUsableDir = (entry) =>
    entry &&
    entry.type === 'directory' &&
    typeof entry.name === 'string' &&
    !entry.name.startsWith('.') &&
    !IGNORE_DIR_NAMES.has(entry.name.toLowerCase())

  const listDir = async (rel) => {
    if (budget <= 0) return []
    budget -= 1
    return listDirAt(fs, workspace, rel)
  }

  const byName = (a, b) => {
    // Raw (ASCII) order keeps punctuation/upper-case project names ahead of
    // the long lower-case tail, so a real project directory is reached before
    // the breadth caps kick in. Deterministic on every platform.
    const la = String(a.name)
    const lb = String(b.name)
    if (la === lb) return 0
    return la < lb ? -1 : 1
  }

  const top = (await listDir('.')).slice().sort(byName)
  const topDirs = top.filter(isUsableDir).slice(0, DISCOVER_TOP_DIRS)
  for (const dir of topDirs) {
    if (ROOT_NAME_RE.test(dir.name)) await probe(dir.name, 2)
    const children = await listDir(dir.name)
    if (children.some((entry) => entry.name === CONFIG_FILE)) await probe(dir.name, 4)
    const childDirs = children.slice().sort(byName).filter(isUsableDir).slice(0, DISCOVER_CHILD_DIRS)
    for (const child of childDirs) {
      const childRel = `${dir.name}/${child.name}`
      if (ROOT_NAME_RE.test(child.name)) await probe(childRel, 2)
      const grand = await listDir(childRel)
      if (grand.some((entry) => entry.name === CONFIG_FILE)) await probe(childRel, 4)
      const leaves = grand
        .slice()
        .sort(byName)
        .filter((entry) => isUsableDir(entry) && ROOT_NAME_RE.test(entry.name))
        .slice(0, DISCOVER_LEAF_DIRS)
      for (const leaf of leaves) await probe(`${childRel}/${leaf.name}`, 1)
    }
  }

  found.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  return found.slice(0, DISCOVER_LIMIT)
}

function scanError(workspace, error) {
  return {
    workspaceRoot: workspace,
    root: null,
    candidates: [],
    files: [],
    counts: { files: 0, dirs: 0, withStatus: 0, truncated: false },
    error,
  }
}

function isStatusRecord(file) {
  return typeof file.status === 'string' && file.status.length > 0
}

/**
 * Scan one docs root (or auto-discover it) and return the JSON-ready payload.
 *
 * Exported as a pure-ish helper (everything through the injected `fs`) so the
 * host wiring can be exercised by tests without booting DSH.
 *
 * @param {object} fs host filesystem (`resolve` / `listDir` / `readText`)
 * @param {string} workspaceRoot absolute workspace root
 * @param {{root?: string, includeStatus?: boolean}} [options]
 * @returns {Promise<{
 *   workspaceRoot: string,
 *   root: string|null,
 *   candidates: Array<{path: string, score: number, count: number}>,
 *   files: Array<{path: string, title?: string, status?: string, bytes?: number}>,
 *   counts: {files: number, dirs: number, withStatus: number, truncated: boolean},
 *   error?: string
 * }>}
 */
export async function scanDocs(fs, workspaceRoot, options = {}) {
  const workspace = trimTrailingSlash(workspaceRoot)
  const includeStatus = options.includeStatus === true
  const requested = typeof options.root === 'string' ? options.root.trim() : ''
  if (workspace === '') return scanError(workspace, '缺少工作区根目录（session.header.cwd）')

  let rootRel = ''
  let rootTarget
  let candidates = []

  if (requested !== '') {
    try {
      rootTarget = await fs.resolve(requested, { cwd: workspace })
    } catch (error) {
      return scanError(workspace, `无法解析文档根 "${requested}"：${messageOf(error)}`)
    }
    rootRel = relativeTo(workspace, targetDisplay(rootTarget, requested))
    if (rootRel === '') rootRel = normalizeRelLabel(requested) || requested
  } else {
    candidates = await discoverRoots(fs, workspace)
    if (candidates.length === 0) {
      return scanError(
        workspace,
        '未找到文档目录：请传 root（例如 "docs"），或确认工作区下有 docs/documentation/wiki',
      )
    }
    rootRel = candidates[0].path
    try {
      rootTarget = await fs.resolve(rootRel, { cwd: workspace })
    } catch (error) {
      return scanError(workspace, `无法解析文档根 "${rootRel}"：${messageOf(error)}`)
    }
  }

  let walk
  try {
    walk = await walkMarkdown(fs, rootTarget, includeStatus)
  } catch (error) {
    return scanError(workspace, `扫描文档根 "${rootRel}" 失败：${messageOf(error)}`)
  }

  const files = walk.files
  const withStatus = files.filter(isStatusRecord).length
  if (requested !== '') {
    candidates = [{ path: rootRel, score: 0, count: files.length }]
  } else if (candidates.length > 0) {
    candidates = candidates.map((candidate, index) =>
      index === 0 ? { ...candidate, count: files.length } : candidate,
    )
  }

  return {
    workspaceRoot: workspace,
    root: rootRel,
    candidates,
    files,
    counts: { files: files.length, dirs: walk.dirs, withStatus, truncated: walk.truncated },
  }
}

//#endregion

//#region lint

/** Severity per lint code (error → warn → info order is the report order). */
const LINT_SEVERITIES = {
  'root-not-found': 'error',
  'missing-entry': 'warn',
  'duplicate-content': 'warn',
  'duplicate-title': 'info',
  'broken-link': 'error',
  'orphan-doc': 'info',
  'unreachable-from-entry': 'info',
  'status-conflict': 'warn',
  'unknown-status': 'warn',
  'unclassified': 'warn',
  'empty-doc': 'info',
  'duplicate-path': 'warn',
  'case-collision': 'info',
  'config-invalid': 'warn',
}
const LINT_SEVERITY_RANK = { error: 0, warn: 1, info: 2 }
const LINT_MAX_ISSUES_DEFAULT = 200
const LINT_MAX_ISSUES_CAP = 2000
const ENTRY_BASENAMES = Object.freeze(['README.md', 'AGENTS.md', 'index.md'])

function normalizeDocText(text) {
  return String(text ?? '')
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/u, ''))
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

function contentHash(text) {
  return createHash('sha256').update(normalizeDocText(text), 'utf8').digest('hex')
}

/**
 * Resolve a relative Markdown link against the linking file into an absolute
 * (lexically normalized) path. `..` walks above the docs root when needed, so
 * callers can classify the target as inside-docs / cross-root / outside-workspace.
 *
 * @param {string} docsRootAbs absolute docs root (forward-slash form)
 * @param {string} fromPath docs-root-relative path of the linking file
 * @param {string} target relative link target
 * @returns {string} normalized absolute-ish path (e.g. `D:/repo/docs/x.md`)
 */
function resolveLinkAbsolute(docsRootAbs, fromPath, target) {
  const dir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : ''
  const joined = slashPath(`${trimTrailingSlash(docsRootAbs)}/${dir}/${target}`)
  const prefix = joined.startsWith('/') ? '/' : ''
  const parts = []
  for (const segment of joined.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (parts.length > 0) parts.pop()
      continue
    }
    parts.push(segment)
  }
  return prefix + parts.join('/')
}

/** Case-insensitive containment test for two normalized absolute paths. */
function isWithinPath(parent, child) {
  const base = trimTrailingSlash(parent).toLowerCase()
  const target = slashPath(child).toLowerCase()
  if (base === '') return false
  return target === base || target.startsWith(`${base}/`)
}

/**
 * Check that a real file exists at an absolute path, through the injected fs.
 * Uses `stat` when the backend provides it, otherwise a text read.
 */
async function fileExistsViaFs(fs, absolutePath) {
  let target
  try {
    target = await fs.resolve(absolutePath)
  } catch {
    return false
  }
  if (typeof fs.stat === 'function') {
    try {
      const info = await fs.stat(target)
      if (info === undefined || info === null) return false
      return info.type === undefined || info.type === 'file'
    } catch {
      return false
    }
  }
  try {
    await fs.readText(target)
    return true
  } catch {
    return false
  }
}

function isSkippableLinkTarget(target) {
  const value = String(target ?? '').trim()
  if (value === '') return true
  if (value.startsWith('#')) return true
  if (value.startsWith('//')) return true
  if (value.startsWith('/')) return true
  // http:, https:, mailto:, data:, tel:, and any other explicit scheme.
  if (/^[a-z][a-z0-9+.-]*:/iu.test(value)) return true
  return false
}

function isMarkdownLinkTarget(target) {
  const clean = String(target ?? '').split(/[#?]/u)[0]
  return /\.(?:md|markdown|mdx)$/iu.test(clean)
}

function extractDocLinks(text) {
  const links = []
  const source = String(text ?? '')
  const re = /!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/gu
  let match
  while ((match = re.exec(source)) !== null) {
    let target = String(match[1] ?? '').trim()
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1).trim()
    links.push(target)
  }
  return links
}

function decodeLinkTarget(target) {
  try {
    return decodeURIComponent(target)
  } catch {
    return target
  }
}

/** Full-text walk used by lint (needs bodies for hashing and link parsing). */
async function walkDocuments(fs, rootTarget) {
  const files = []
  const duplicatePaths = []
  const seen = new Set()
  let dirs = 0
  let truncated = false

  async function visit(target, relDir, depth) {
    let entries
    try {
      entries = await fs.listDir(target)
    } catch (error) {
      if (depth === 0) throw error
      return
    }
    if (!Array.isArray(entries)) return
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const name = entry?.name
      if (typeof name !== 'string' || name.length === 0 || name.startsWith('.')) continue
      const rel = relDir === '' ? name : `${relDir}/${name}`
      if (entry.type === 'directory') {
        if (depth >= MAX_DEPTH) continue
        if (IGNORE_DIR_NAMES.has(name.toLowerCase())) continue
        dirs += 1
        await visit(entry.target, rel, depth + 1)
        continue
      }
      if (entry.type !== 'file' || !DOC_EXT_RE.test(name)) continue
      if (files.length >= MAX_FILES) {
        truncated = true
        continue
      }
      if (seen.has(rel)) {
        duplicatePaths.push(rel)
        continue
      }
      seen.add(rel)
      const record = { path: rel, text: '', bytes: 0 }
      if (typeof entry.size === 'number' && Number.isFinite(entry.size)) record.bytes = entry.size
      try {
        record.text = String((await fs.readText(entry.target)) ?? '')
      } catch {
        // unreadable file: keep the path, body stays empty
      }
      if (record.bytes === 0 && record.text.length > 0) record.bytes = record.text.length
      record.title = extractTitle(record.text.slice(0, HEAD_CHARS))
      record.status = extractStatus(record.text.slice(0, HEAD_CHARS))
      files.push(record)
    }
  }

  await visit(rootTarget, '', 0)
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { files, dirs, truncated, duplicatePaths }
}

/** Read the workspace-root plan file, distinguishing missing / invalid / unreadable. */
async function readPlanConfig(fs, workspace) {
  const fallbackPath = `${workspace}/${CONFIG_FILE}`
  let target
  try {
    target = await fs.resolve(CONFIG_FILE, { cwd: workspace })
  } catch (error) {
    return { text: null, config: null, path: fallbackPath, missing: true, invalid: false, error: messageOf(error) }
  }
  const path = targetDisplay(target, fallbackPath)
  let text
  try {
    text = await fs.readText(target)
  } catch (error) {
    if (isMissingError(error)) return { text: null, config: null, path, missing: true, invalid: false, error: null }
    return { text: null, config: null, path, missing: false, invalid: false, error: messageOf(error) }
  }
  let config = null
  try {
    const parsed = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed
  } catch {
    config = null
  }
  return { text, config, path, missing: false, invalid: config === null, error: null }
}

function compileGroupsLoose(rawGroups) {
  if (!Array.isArray(rawGroups)) return []
  const compiled = []
  for (const raw of rawGroups) {
    if (raw === null || typeof raw !== 'object' || typeof raw.id !== 'string' || typeof raw.title !== 'string') continue
    const rawMatch = raw.match
    const patterns = (Array.isArray(rawMatch) ? rawMatch : typeof rawMatch === 'string' ? [rawMatch] : [])
      .filter((pattern) => typeof pattern === 'string' && pattern.trim() !== '')
      .map((pattern) => pattern.trim())
    if (patterns.length === 0) continue
    compiled.push({
      id: raw.id,
      title: raw.title,
      records: raw.records === true,
      regexes: patterns.map(globToRegExp),
    })
  }
  return compiled
}

function lifecycleSegmentsOf(path) {
  return String(path ?? '').split('/').slice(0, -1)
}

function makeLintIssue(code, message, extra = {}) {
  return { code, severity: LINT_SEVERITIES[code] ?? 'info', message, ...extra }
}

function resolveLintRoot(fs, workspace, requested) {
  return (async () => {
    if (requested !== '') {
      try {
        const rootTarget = await fs.resolve(requested, { cwd: workspace })
        const rootRel = relativeTo(workspace, targetDisplay(rootTarget, requested)) || normalizeRelLabel(requested) || requested
        return { rootRel, rootTarget }
      } catch (error) {
        return { error: `无法解析文档根 "${requested}"：${messageOf(error)}` }
      }
    }
    const candidates = await discoverRoots(fs, workspace)
    if (candidates.length === 0) {
      return { error: '未找到文档目录：请传 root（例如 "docs"），或确认工作区下有 docs/documentation/wiki' }
    }
    const rootRel = candidates[0].path
    try {
      const rootTarget = await fs.resolve(rootRel, { cwd: workspace })
      return { rootRel, rootTarget }
    } catch (error) {
      return { error: `无法解析文档根 "${rootRel}"：${messageOf(error)}` }
    }
  })()
}

/**
 * Read-only mechanical lint over one docs root + the current plan file.
 *
 * Checks: root-not-found / missing-entry / duplicate-content / duplicate-title /
 * broken-link / orphan-doc / unreachable-from-entry / status-conflict /
 * unknown-status / unclassified / empty-doc / duplicate-path / case-collision
 * (+ config-invalid when the plan file is not parseable).
 *
 * @param {object} fs host filesystem (`resolve` / `listDir` / `readText`)
 * @param {string} workspaceRoot absolute workspace root
 * @param {{root?: string, includeLinks?: boolean, maxIssues?: number, entryHops?: number}} [options]
 * @returns {Promise<{
 *   workspaceRoot: string,
 *   root: string|null,
 *   counts: {files: number, groups: number, issues: number, bySeverity: {error: number, warn: number, info: number}},
 *   issues: Array<object>,
 *   truncated: boolean
 * }>}
 */
export async function lintDocs(fs, workspaceRoot, options = {}) {
  const workspace = trimTrailingSlash(workspaceRoot)
  const includeLinks = options.includeLinks !== false
  const maxIssues = clampInt(options.maxIssues, 1, LINT_MAX_ISSUES_CAP, LINT_MAX_ISSUES_DEFAULT)
  const requested = typeof options.root === 'string' ? options.root.trim() : ''
  const baseCounts = () => ({ files: 0, groups: 0, issues: 0, bySeverity: { error: 0, warn: 0, info: 0 } })

  if (workspace === '') {
    const issue = makeLintIssue('root-not-found', '缺少工作区根目录（session.header.cwd）')
    return {
      workspaceRoot: workspace,
      root: null,
      counts: { ...baseCounts(), issues: 1, bySeverity: { error: 1, warn: 0, info: 0 } },
      issues: [issue],
      truncated: false,
    }
  }

  const resolved = await resolveLintRoot(fs, workspace, requested)
  if (resolved.error) {
    const issue = makeLintIssue('root-not-found', resolved.error)
    return {
      workspaceRoot: workspace,
      root: null,
      counts: { ...baseCounts(), issues: 1, bySeverity: { error: 1, warn: 0, info: 0 } },
      issues: [issue],
      truncated: false,
    }
  }

  let walk
  try {
    walk = await walkDocuments(fs, resolved.rootTarget)
  } catch (error) {
    const issue = makeLintIssue('root-not-found', `扫描文档根 "${resolved.rootRel}" 失败：${messageOf(error)}`)
    return {
      workspaceRoot: workspace,
      root: null,
      counts: { ...baseCounts(), issues: 1, bySeverity: { error: 1, warn: 0, info: 0 } },
      issues: [issue],
      truncated: false,
    }
  }

  const files = walk.files
  const docsRootAbs = trimTrailingSlash(targetDisplay(resolved.rootTarget, resolved.rootRel))
  const workspaceAbs = trimTrailingSlash(workspace)
  const byPath = new Map(files.map((file) => [file.path, file]))
  const byLowerPath = new Map()
  for (const file of files) {
    const key = file.path.toLowerCase()
    const bucket = byLowerPath.get(key)
    if (bucket === undefined) byLowerPath.set(key, [file.path])
    else bucket.push(file.path)
  }

  const plan = await readPlanConfig(fs, workspace)
  const config = plan.config
  const configGroups = config === null ? [] : compileGroupsLoose(config.groups)
  const configRoot = config && typeof config.root === 'string' ? normalizeRelLabel(config.root) : ''
  const configApplies = config !== null && (configRoot === '' || configRoot.toLowerCase() === String(resolved.rootRel).toLowerCase())
  const lifecycles =
    config && config.records && Array.isArray(config.records.lifecycles)
      ? config.records.lifecycles.filter((value) => typeof value === 'string' && value.trim() !== '').map((value) => value.trim())
      : [...DEFAULT_LIFECYCLES]
  const lifecycleLower = new Map(lifecycles.map((value) => [value.toLowerCase(), value]))
  const entryFiles = ENTRY_BASENAMES.filter((name) => byPath.has(name))

  const issues = []

  if (plan.invalid) {
    issues.push(makeLintIssue('config-invalid', `${plan.path} 不是合法的 JSON 对象，lint 已忽略配置，unclassified 无法检查`))
  }

  // missing-entry
  if (entryFiles.length === 0) {
    issues.push(makeLintIssue('missing-entry', '文档根缺少入口文件（README.md / AGENTS.md / index.md 至少一个）'))
  }

  // duplicate-content
  const byHash = new Map()
  for (const file of files) {
    if (file.bytes < 50 || normalizeDocText(file.text) === '') continue
    const hash = contentHash(file.text)
    const bucket = byHash.get(hash)
    if (bucket === undefined) byHash.set(hash, [file.path])
    else bucket.push(file.path)
  }
  for (const [, paths] of byHash) {
    if (paths.length < 2) continue
    const sorted = [...paths].sort()
    issues.push(
      makeLintIssue(
        'duplicate-content',
        `${sorted.length} 篇文档正文归一化后完全相同（sha256）`,
        { files: sorted },
      ),
    )
  }

  // duplicate-title
  const byTitle = new Map()
  for (const file of files) {
    if (file.title === undefined) continue
    const bucket = byTitle.get(file.title)
    if (bucket === undefined) byTitle.set(file.title, [file.path])
    else bucket.push(file.path)
  }
  for (const [title, paths] of byTitle) {
    if (paths.length < 2) continue
    issues.push(
      makeLintIssue('duplicate-title', `首个一级标题重复：「${title}」`, { files: [...paths].sort(), title }),
    )
  }

  // link-derived checks (broken-link / orphan-doc / unreachable-from-entry)
  if (includeLinks) {
    const edges = new Map(files.map((file) => [file.path, new Set()]))
    const inbound = new Map(files.map((file) => [file.path, 0]))
    for (const file of files) {
      for (const rawTarget of extractDocLinks(file.text)) {
        if (isSkippableLinkTarget(rawTarget)) continue
        if (!isMarkdownLinkTarget(rawTarget)) continue
        const clean = decodeLinkTarget(String(rawTarget).split(/[#?]/u)[0]).trim()
        if (clean === '') continue
        const absolute = resolveLinkAbsolute(docsRootAbs, file.path, clean)
        if (isWithinPath(docsRootAbs, absolute)) {
          // Inside the docs root: must exist in the scanned Markdown set.
          const targetPath = relativeTo(docsRootAbs, absolute)
          const bucket = byLowerPath.get(targetPath.toLowerCase())
          const actual = bucket === undefined ? undefined : bucket.find((candidate) => candidate === targetPath) ?? bucket[0]
          if (actual === undefined) {
            issues.push(
              makeLintIssue('broken-link', `链接目标不存在：${rawTarget}（解析为 ${targetPath}）`, {
                file: file.path,
                link: rawTarget,
              }),
            )
            continue
          }
          edges.get(file.path).add(actual)
          inbound.set(actual, (inbound.get(actual) ?? 0) + 1)
          continue
        }
        if (isWithinPath(workspaceAbs, absolute)) {
          // Cross-root link that stays inside the workspace: check the real file.
          // Existing cross-root links are not issues; missing ones still are.
          const exists = await fileExistsViaFs(fs, absolute)
          if (!exists) {
            issues.push(
              makeLintIssue('broken-link', `跨根且不存在：${rawTarget}（解析为 ${absolute}）`, {
                file: file.path,
                link: rawTarget,
              }),
            )
          }
          continue
        }
        // Outside the workspace: not scanned, not our business — skip silently.
      }
    }

    const entrySet = new Set(entryFiles)
    for (const file of files) {
      if (entrySet.has(file.path)) continue
      if ((inbound.get(file.path) ?? 0) === 0) {
        issues.push(makeLintIssue('orphan-doc', '没有任何其他文档链接到本篇', { file: file.path }))
      }
    }

    const entryPath = entryFiles[0]
    if (entryPath !== undefined) {
      const configuredHops =
        config !== null && Number.isFinite(config.entryHops) ? config.entryHops : undefined
      const hops = clampInt(options.entryHops ?? configuredHops, 1, 10, 2)
      const visited = new Map([[entryPath, 0]])
      const queue = [entryPath]
      while (queue.length > 0) {
        const current = queue.shift()
        const depth = visited.get(current) ?? 0
        if (depth >= hops) continue
        for (const next of edges.get(current) ?? []) {
          if (visited.has(next)) continue
          visited.set(next, depth + 1)
          queue.push(next)
        }
      }
      for (const file of files) {
        if (entrySet.has(file.path) || visited.has(file.path)) continue
        issues.push(
          makeLintIssue('unreachable-from-entry', `从入口 ${entryPath} 出发 ${hops} 跳内不可达`, { file: file.path }),
        )
      }
    }
  }

  // status checks
  const recordsMatcher = configGroups.find((group) => group.records === true)
  for (const file of files) {
    if (file.status === undefined) continue
    if (!lifecycleLower.has(file.status)) {
      issues.push(
        makeLintIssue('unknown-status', `Status: ${file.status} 不在生命周期集合（${lifecycles.join(' / ')}）`, {
          file: file.path,
          status: file.status,
        }),
      )
    }
    const lifecycleSegment = lifecycleSegmentsOf(file.path)
      .map((segment) => segment.toLowerCase())
      .find((segment) => lifecycleLower.has(segment))
    if (lifecycleSegment === undefined) continue
    const inRecordsScope =
      recordsMatcher === undefined || recordsMatcher.regexes.some((regex) => regex.test(file.path))
    if (!inRecordsScope) continue
    const expected = lifecycleLower.get(lifecycleSegment)
    if (file.status === expected) continue
    issues.push(
      makeLintIssue(
        'status-conflict',
        `Status: ${file.status} 与路径 lifecycle 目录「${expected}」不一致`,
        { file: file.path, status: file.status, lifecycle: expected },
      ),
    )
  }

  // unclassified (only when a plan for this exact root exists)
  if (configApplies && configGroups.length > 0) {
    for (const file of files) {
      if (configGroups.some((group) => group.regexes.some((regex) => regex.test(file.path)))) continue
      issues.push(makeLintIssue('unclassified', '文件不被配置中任何分组的 match 命中', { file: file.path }))
    }
  }

  // empty-doc
  for (const file of files) {
    if (file.bytes >= 50) continue
    issues.push(makeLintIssue('empty-doc', `文档过短（${file.bytes} 字节 < 50）`, { file: file.path, bytes: file.bytes }))
  }

  // duplicate-path / case-collision
  for (const path of walk.duplicatePaths) {
    issues.push(makeLintIssue('duplicate-path', '同一路径在扫描中出现多次', { file: path }))
  }
  for (const [, paths] of byLowerPath) {
    if (paths.length < 2) continue
    issues.push(
      makeLintIssue('case-collision', '路径大小写冲突（Windows 不敏感）', { files: [...paths].sort() }),
    )
  }

  // dedupe by code + file(s), sort by severity, truncate
  const seen = new Set()
  const deduped = []
  for (const issue of issues) {
    const key = `${issue.code}|${issue.file ?? (issue.files ?? []).join('|')}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(issue)
  }
  deduped.sort((left, right) => {
    const bySeverity = (LINT_SEVERITY_RANK[left.severity] ?? 9) - (LINT_SEVERITY_RANK[right.severity] ?? 9)
    if (bySeverity !== 0) return bySeverity
    if (left.code !== right.code) return left.code < right.code ? -1 : 1
    const leftKey = left.file ?? (left.files ?? [])[0] ?? ''
    const rightKey = right.file ?? (right.files ?? [])[0] ?? ''
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  })

  const bySeverity = { error: 0, warn: 0, info: 0 }
  for (const issue of deduped) {
    if (issue.severity === 'error') bySeverity.error += 1
    else if (issue.severity === 'warn') bySeverity.warn += 1
    else bySeverity.info += 1
  }
  const truncated = deduped.length > maxIssues
  return {
    workspaceRoot: workspace,
    root: resolved.rootRel,
    counts: { files: files.length, groups: configGroups.length, issues: deduped.length, bySeverity },
    issues: deduped.slice(0, maxIssues),
    truncated,
  }
}

//#endregion

//#region apply plan

function fail(text, extra = {}) {
  return { ok: false, text: `❌ ${text}`, ...extra }
}

function normalizeGroups(rawGroups) {
  if (!Array.isArray(rawGroups) || rawGroups.length === 0) {
    return { ok: false, error: 'groups 必须是非空数组（建议 3–8 个分组）' }
  }
  const groups = []
  const seen = new Set()
  for (let i = 0; i < rawGroups.length; i += 1) {
    const raw = rawGroups[i]
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: `groups[${i}] 必须是对象` }
    }
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (id === '') return { ok: false, error: `groups[${i}].id 必须是非空字符串` }
    if (seen.has(id)) return { ok: false, error: `分组 id 重复：${id}` }
    seen.add(id)
    const title = typeof raw.title === 'string' ? raw.title.trim() : ''
    if (title === '') return { ok: false, error: `分组 "${id}" 的 title 必须是非空字符串` }
    const rawMatch = raw.match
    const matchList = Array.isArray(rawMatch) ? rawMatch : typeof rawMatch === 'string' ? [rawMatch] : []
    if (matchList.length === 0) return { ok: false, error: `分组 "${id}" 的 match 必须是非空字符串数组` }
    const cleaned = []
    for (const pattern of matchList) {
      if (typeof pattern !== 'string' || pattern.trim() === '') {
        return { ok: false, error: `分组 "${id}" 的 match 含空字符串或非字符串项` }
      }
      cleaned.push(pattern.trim())
    }
    groups.push({
      id,
      title,
      hint: typeof raw.hint === 'string' ? raw.hint : '',
      prefix: typeof raw.prefix === 'string' ? raw.prefix : '',
      match: cleaned,
      ...(raw.records === true ? { records: true } : {}),
    })
  }
  return { ok: true, groups }
}

function normalizeRecords(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: undefined }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'records 必须是对象' }
  let dir
  if (raw.dir !== undefined) {
    if (typeof raw.dir !== 'string' || raw.dir.trim() === '') {
      return { ok: false, error: 'records.dir 必须是非空字符串' }
    }
    dir = normalizeRelLabel(raw.dir)
  }
  let lifecycles
  if (raw.lifecycles !== undefined) {
    if (!Array.isArray(raw.lifecycles) || raw.lifecycles.length === 0) {
      return { ok: false, error: 'records.lifecycles 必须是非空字符串数组' }
    }
    const cleaned = []
    for (const item of raw.lifecycles) {
      if (typeof item !== 'string' || item.trim() === '') {
        return { ok: false, error: 'records.lifecycles 必须是非空字符串数组' }
      }
      cleaned.push(item.trim())
    }
    lifecycles = cleaned
  }
  let statuses
  if (raw.statuses !== undefined) {
    if (raw.statuses === null || typeof raw.statuses !== 'object' || Array.isArray(raw.statuses)) {
      return { ok: false, error: 'records.statuses 必须是 {路径: 状态} 对象' }
    }
    statuses = {}
    for (const [key, value] of Object.entries(raw.statuses)) {
      if (typeof value !== 'string') {
        return { ok: false, error: `records.statuses["${key}"] 必须是字符串` }
      }
      statuses[normalizeRelLabel(key)] = value.trim()
    }
  }
  return { ok: true, value: { dir, lifecycles, statuses } }
}

/** Directory a records group points at, derived from prefix / match. */
function recordsDirOf(group) {
  if (group === undefined) return 'records'
  const prefix = normalizeRelLabel(group.prefix)
  if (prefix !== '') return prefix
  for (const pattern of group.match) {
    const wildcardAt = pattern.search(/[*?]/u)
    const head = wildcardAt === -1 ? pattern : pattern.slice(0, wildcardAt)
    const dir = normalizeRelLabel(head)
    if (dir !== '') return dir
  }
  return 'records'
}

function formatUnmatched(unmatched) {
  const lines = [`分组未覆盖全部文档：还有 ${unmatched.length} 篇未匹配任何分组（下列前 20 个）：`]
  for (const path of unmatched.slice(0, 20)) lines.push(`- ${path}`)
  if (unmatched.length > 20) lines.push(`…（其余 ${unmatched.length - 20} 篇省略）`)
  lines.push('')
  lines.push('请补充/调整 groups 的 match 后重试；最简单的兜底是追加 catch-all 分组：')
  lines.push('{"id":"other","title":"其他","hint":"","prefix":"","match":["**"]}')
  return lines.join('\n')
}

/**
 * Attribute every file to one group exactly like the client half does: first
 * non-`other` match wins, otherwise the last group (the recommended catch-all).
 *
 * @returns {{counts: Map<string, number>, unmatched: string[]}}
 */
function attributeFiles(files, compiledGroups) {
  const counts = new Map()
  const unmatched = []
  for (const file of files) {
    const covered = compiledGroups.some((group) => group.regexes.some((regex) => regex.test(file.path)))
    if (!covered) {
      unmatched.push(file.path)
      continue
    }
    let owner = null
    for (const group of compiledGroups) {
      if (group.id !== 'other' && group.regexes.some((regex) => regex.test(file.path))) {
        owner = group
        break
      }
    }
    if (owner === null) owner = compiledGroups[compiledGroups.length - 1]
    counts.set(owner.id, (counts.get(owner.id) ?? 0) + 1)
  }
  return { counts, unmatched }
}

/**
 * Build the human-readable "old plan → new plan" diff used by `dryRun:true`.
 *
 * @returns {{lines: string[], data: object}}
 */
function buildPlanDiff(context) {
  const { old, groups, scanned, counts, configPath } = context
  const lines = []
  const data = {
    hasOld: false,
    oldPath: null,
    sameRoot: false,
    added: [],
    removed: [],
    renamed: [],
    counts: [],
    oldUnmatched: null,
    newUnmatched: 0,
  }

  lines.push('🔎 dryRun：已完成校验并计算差异，未写入文件')
  lines.push('')
  lines.push(`- 文档根：${scanned.root}（${scanned.files.length} 篇 Markdown）`)
  lines.push(`- 新方案：${groups.length} 个分组，覆盖 ${scanned.files.length}/${scanned.files.length} 篇，未匹配 0`)

  const oldConfig = old && old.config ? old.config : null
  const oldGroups = oldConfig === null ? [] : compileGroupsLoose(oldConfig.groups)
  const oldById = new Map(oldGroups.map((group) => [group.id, group]))
  const newById = new Map(groups.map((group) => [group.id, group]))

  if (oldConfig === null) {
    if (old && old.invalid) lines.push('- 对比旧配置：旧配置无法解析，跳过 diff')
    else lines.push('- 对比旧配置：无（首次生成）')
    lines.push('- 新方案每层篇数：')
    for (const group of groups) {
      const now = counts.get(group.id) ?? 0
      lines.push(`    ${group.title}（${group.id}）：${now} 篇`)
      data.counts.push({ id: group.id, title: group.title, old: null, new: now })
    }
  } else {
    data.hasOld = true
    data.oldPath = old.path
    lines.push(`- 对比旧配置：${old.path}`)

    for (const group of groups) {
      if (!oldById.has(group.id)) data.added.push({ id: group.id, title: group.title })
    }
    for (const group of oldGroups) {
      if (!newById.has(group.id)) data.removed.push({ id: group.id, title: group.title })
    }
    for (const group of groups) {
      const previous = oldById.get(group.id)
      if (previous !== undefined && String(previous.title).trim() !== group.title.trim()) {
        data.renamed.push({ id: group.id, from: previous.title, to: group.title })
      }
    }
    for (const item of data.added) lines.push(`- 新增分组：+ ${item.title}（${item.id}）`)
    for (const item of data.removed) lines.push(`- 删除分组：- ${item.title}（${item.id}）`)
    for (const item of data.renamed) lines.push(`- 组改名：${item.id}：「${item.from}」→「${item.to}」`)
    if (data.added.length === 0 && data.removed.length === 0 && data.renamed.length === 0) {
      lines.push('- 分组集合与标题：无变化')
    }

    const oldRoot = oldConfig.root ? trimTrailingSlash(oldConfig.root) : ''
    data.sameRoot = oldRoot === '' || oldRoot.toLowerCase() === String(scanned.root).toLowerCase()
    if (data.sameRoot && oldGroups.length > 0) {
      const oldAttribution = attributeFiles(scanned.files, oldGroups)
      data.oldUnmatched = oldAttribution.unmatched.length
      lines.push(`- 未匹配：旧配置 ${oldAttribution.unmatched.length} 篇 → 新配置 0 篇`)
      lines.push('- 每层篇数（旧 → 新）：')
      for (const group of groups) {
        const now = counts.get(group.id) ?? 0
        const previous = oldAttribution.counts.get(group.id)
        if (previous === undefined) {
          lines.push(`    ${group.title}（${group.id}）：新增 ${now} 篇`)
        } else {
          const mark = previous === now ? '（不变）' : ''
          lines.push(`    ${group.title}（${group.id}）：${previous} → ${now}${mark}`)
        }
        data.counts.push({ id: group.id, title: group.title, old: previous ?? null, new: now })
      }
      for (const group of oldGroups) {
        if (newById.has(group.id)) continue
        const previous = oldAttribution.counts.get(group.id) ?? 0
        lines.push(`    已删除：${group.title}（${group.id}），旧 ${previous} 篇`)
        data.counts.push({ id: group.id, title: group.title, old: previous, new: null })
      }
    } else {
      lines.push('- 旧配置 root 与新方案不同（或旧配置无 groups），跳过逐层篇数对比')
      lines.push('- 新方案每层篇数：')
      for (const group of groups) {
        const now = counts.get(group.id) ?? 0
        lines.push(`    ${group.title}（${group.id}）：${now} 篇`)
        data.counts.push({ id: group.id, title: group.title, old: null, new: now })
      }
    }
  }

  lines.push('')
  lines.push(`- 配置路径（未写入）：${configPath}`)
  lines.push('')
  lines.push('确认方案后再以 dryRun:false 调用 doc_tree_apply_plan 才会落盘。')
  return { lines, data }
}

/**
 * Validate one plan and write `<workspaceRoot>/.dsh-doc-tree.json`.
 *
 * Coverage is checked against every Markdown file under the docs root: each
 * file must be matched by at least one group glob, otherwise nothing is
 * written and the first 20 unmatched paths are returned for the model to fix.
 *
 * With `dryRun:true` everything above still runs (including validation and the
 * old → new diff) but the config file is never written.
 *
 * @param {object} fs host filesystem (`resolve` / `listDir` / `readText` / `writeText`)
 * @param {string} workspaceRoot absolute workspace root
 * @param {{root?: string, groups?: unknown, records?: unknown, includeStatus?: boolean, dryRun?: boolean}} args
 * @returns {Promise<{ok: boolean, text: string, config?: object, configPath?: string, unmatched?: string[], dryRun?: boolean, diff?: object}>}
 */
export async function applyPlan(fs, workspaceRoot, args = {}) {
  const workspace = trimTrailingSlash(workspaceRoot)
  if (workspace === '') return fail('缺少工作区根目录（session.header.cwd）')
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return fail('参数必须是对象')

  const rootArg = typeof args.root === 'string' ? args.root.trim() : ''
  if (rootArg === '') return fail('缺少 root：请传文档根目录（相对工作区，例如 "docs"）')

  const groupsResult = normalizeGroups(args.groups)
  if (!groupsResult.ok) return fail(`分组校验失败：${groupsResult.error}`)
  const groups = groupsResult.groups

  const recordsResult = normalizeRecords(args.records)
  if (!recordsResult.ok) return fail(`records 校验失败：${recordsResult.error}`)
  const recordsInput = recordsResult.value

  const scanned = await scanDocs(fs, workspace, {
    root: rootArg,
    includeStatus: args.includeStatus === true,
  })
  if (scanned.error) return fail(scanned.error)
  if (scanned.files.length === 0) {
    return fail(`文档根 "${scanned.root}" 下没有找到 Markdown 文件，无法分层`)
  }

  const compiled = groups.map((group) => ({
    ...group,
    regexes: group.match.map(globToRegExp),
  }))

  const attribution = attributeFiles(scanned.files, compiled)
  const counts = attribution.counts
  if (attribution.unmatched.length > 0) {
    return fail(formatUnmatched(attribution.unmatched), { unmatched: attribution.unmatched })
  }

  const recordsGroup = compiled.find((group) => group.records === true)
  const recordsDir = recordsInput?.dir ?? recordsDirOf(recordsGroup)
  const lifecycles = recordsInput?.lifecycles ?? [...DEFAULT_LIFECYCLES]
  const statuses = { ...(recordsInput?.statuses ?? {}) }
  if (args.includeStatus === true) {
    const belongsToRecords = (file) => {
      if (recordsGroup !== undefined) return recordsGroup.regexes.some((re) => re.test(file.path))
      return file.path === recordsDir || file.path.startsWith(`${recordsDir}/`)
    }
    for (const file of scanned.files) {
      if (isStatusRecord(file) && belongsToRecords(file)) statuses[file.path] = file.status
    }
  }
  const statusCount = Object.keys(statuses).length

  const config = {
    version: CONFIG_VERSION,
    root: scanned.root,
    generatedAt: new Date().toISOString(),
    generatedBy: 'docs-organize',
    groups,
    records: { dir: recordsDir, lifecycles, statuses },
  }

  let configTarget
  try {
    configTarget = await fs.resolve(CONFIG_FILE, { cwd: workspace })
  } catch (error) {
    return fail(`无法定位配置文件 ${CONFIG_FILE}：${messageOf(error)}`)
  }
  const configPath = targetDisplay(configTarget, `${workspace}/${CONFIG_FILE}`)
  if (args.dryRun === true) {
    const old = await readPlanConfig(fs, workspace)
    const diff = buildPlanDiff({ old, groups, scanned, counts, configPath })
    return {
      ok: true,
      dryRun: true,
      text: diff.lines.join('\n'),
      config,
      diff: diff.data,
      configPath,
      unmatched: [],
    }
  }
  try {
    await fs.writeText(configTarget, `${JSON.stringify(config, null, 2)}\n`)
  } catch (error) {
    return fail(`写入配置失败：${messageOf(error)}`)
  }

  const lines = []
  lines.push(`✅ 文档树配置已写入：${configPath}`)
  lines.push('')
  lines.push(`- 工作区：${workspace}`)
  lines.push(`- 文档根：${scanned.root}（${scanned.files.length} 篇 Markdown）`)
  lines.push(`- 分组：${groups.length} 个，覆盖 ${scanned.files.length}/${scanned.files.length} 篇，未匹配 0`)
  for (const group of groups) {
    const count = counts.get(group.id) ?? 0
    const hint = group.hint !== '' ? `（${group.hint}）` : ''
    const recordsMark = group.records === true ? ' · records' : ''
    lines.push(`  - ${group.title}${hint}：${count} 篇${recordsMark}`)
  }
  const statusLine =
    args.includeStatus === true
      ? `${statusCount} 条（已写入 records.statuses）`
      : statusCount > 0
        ? `${statusCount} 条（来自传入的 records.statuses）`
        : '未采集（需要时传 includeStatus:true）'
  lines.push(`- 状态快照：${statusLine}`)
  return { ok: true, text: lines.join('\n'), config, configPath }
}

//#endregion

//#region prompt

/**
 * Build the Chinese `/docs-organize` prompt injected into the model turn.
 *
 * The default prompt makes human approval a HARD step: design → lint →
 * `dryRun:true` preview → one batched `ask_user_question` → only then write.
 * `reportMode` (the `--report` flag) skips the question and only asks for the
 * structured approval checklist.
 *
 * @param {{workspaceRoot?: string, root?: string, reportMode?: boolean}} [context]
 * @returns {string}
 */
export function buildOrganizePrompt(context = {}) {
  const workspaceRoot = trimTrailingSlash(context.workspaceRoot)
  const root = typeof context.root === 'string' ? context.root.trim() : ''
  const reportMode = context.reportMode === true
  const lines = []

  lines.push(
    reportMode
      ? '请完成一次「文档分层整理（仅报告模式）」任务：只做扫描、阅读、lint 与 dryRun 预览，最后输出结构化「待审批清单」。**不要调用 ask_user_question，也不要写配置文件。**'
      : '请完成一次「文档分层整理 + 人工审批」任务：扫描、阅读、lint、设计分组，先用 dryRun 预览，再**必须**通过 ask_user_question 获得用户批量批准，只有用户选择「应用」后才允许写配置。不要修改任何文档正文。',
  )
  lines.push('')
  lines.push('## 上下文')
  lines.push(`- 工作区根：${workspaceRoot || '（未知）'}`)
  if (root !== '') {
    lines.push(`- 目标文档根：\`${root}\`（调用 doc_tree_scan / doc_tree_lint / doc_tree_apply_plan 时 root 参数传这个值）`)
  } else {
    lines.push(
      '- 目标文档根：未指定。先调用 `doc_tree_scan`（不传 root），从返回的 candidates 中选择最合适的根（通常评分最高、含 README.md/AGENTS.md 的那个），后续步骤都用它。',
    )
  }
  lines.push('')
  lines.push('## 硬约束（先读）')
  lines.push(
    '- 本任务只整理「配置分层」：**合并 / 删除 / 移动文档不在本任务范围内**，绝对不要修改、移动、删除任何文档内容。',
  )
  lines.push(
    '- lint 发现的问题默认**只报告**；只有当用户明确选择「允许处理可机械项」时，才可以处理（例如补 `Status:` 行、修正明确的相对链接），并且处理前要列出将改哪些文件、改什么内容。',
  )
  lines.push(
    '- 写入配置只能通过 `doc_tree_apply_plan` 完成；用户批准前只允许 `dryRun:true`，不得调用 `dryRun:false`，也不要用 shell / 脚本 / write 工具直接创建或修改 `.dsh-doc-tree.json`。',
  )
  lines.push('')
  lines.push('## 执行步骤（必须按顺序）')
  lines.push('')
  lines.push(
    '1. 调用工具 `doc_tree_scan` 获取文件清单。参数 `{ root?, includeStatus? }`；返回 JSON 含 `workspaceRoot`、`root`、`candidates`、`files[]`（path/title/status/bytes）与 `counts`。建议先传 includeStatus:true 一次性拿到状态行。',
  )
  lines.push(
    '2. 阅读入口文档：至少读 `README.md`、`AGENTS.md`，以及各子目录的 `README.md` / 索引文件（用 read 工具），理解每篇文档的主题、用途和所属层级。',
  )
  lines.push(
    '3. 调用工具 `doc_tree_lint`（参数 `{root, includeLinks:true, maxIssues:200}`）做机械体检，并把问题分成两类：',
  )
  lines.push(
    '   - 「必须人决定」：合并 / 归档 / 改名 / 删除文档、status-conflict 的取舍、断链是否修复、记录层归类等业务判断。',
  )
  lines.push('   - 「仅报告」：orphan-doc、unreachable-from-entry、empty-doc、duplicate-title 等不改变内容的提示。')
  lines.push(
    '4. 设计 3–8 个分组 + 待人工决策清单（**先不写配置**）。分组是**语义分层**，不是目录镜像：不要仅按目录名机械套用；同一目录下主题不同的文档可以拆到不同组，不同目录但主题相同的可以合并。每个分组形如：',
  )
  lines.push(
    '   `{"id":"<短英文标识>","title":"<中文标题>","hint":"<可选层级标记，如 L2 / L4 / L5>","prefix":"<可选路径前缀，仅用于 UI 显示时剥离>","match":["<glob>", ...]}`',
  )
  lines.push(
    '   - `match` 是相对文档根的 glob：`*` 匹配段内任意字符、`**` 跨段、`?` 匹配单字符；例如 `README.md`、`contracts/**`、`development/**`、`*.md`。',
  )
  lines.push(
    '   - 所有文件必须被覆盖（一个都不能漏）。最后一个分组必须是 catch-all：`{"id":"other","title":"其他","hint":"","prefix":"","match":["**"]}`。',
  )
  lines.push(
    '   - 若存在决策记录 / 方案 / 归档类目录（如 records/），必须有一个分组标 `"records": true`（全配置只能有一个），用于生命周期徽标与状态快照。',
  )
  lines.push(
    '5. 调用 `doc_tree_apply_plan` 做**预览**：参数 `{root, groups, records?, includeStatus?, dryRun:true}`；`records` 可传 `{"dir":"records","lifecycles":["proposed","implemented","rejected","archived"]}`。dryRun 会完整校验并输出「旧配置 → 新配置」diff，**不会写文件**。若返回「未匹配」错误，按列出的路径补齐 `match` 后重跑 dryRun（整轮最多 3 次）。',
  )
  if (reportMode) {
    lines.push(
      '6. **不要调用 `ask_user_question`，也不要写配置。** 直接输出结构化「待审批清单」（中文）：',
    )
  } else {
    lines.push(
      '6. **必须调用 `ask_user_question` 工具**（不是正文里提问）做一次批量审批。一次调用、最多 3 个问题，参数形如 `{\"questions\":[{\"id\":\"apply-plan\",\"question\":\"…\",\"options\":[{\"label\":\"应用\"}]}, …]}`；`id` 必须稳定为下面三个，不要改名、不要拆分多次：',
    )
    lines.push(
      '   - `id: "apply-plan"`，问题「是否按该方案写入 `.dsh-doc-tree.json`？」选项：`应用`（按 dryRun 方案写入配置）/ `只看报告`（不写，只给清单）/ `调整后重试`（按反馈修改方案）。',
    )
    lines.push(
      '   - `id: "lint-decisions"`，问题「lint 中需要人决定的事项如何处理？」选项：`仅报告` / `允许处理可机械项` / `逐项说明`（允许用户自定义回答）。',
    )
    lines.push(
      '   - `id: "status-snapshot"`，问题「是否把每篇的 `Status:` 快照写入配置 `records.statuses`？」选项：`写入` / `不写`。',
    )
    lines.push('7. 按用户选择执行：')
    lines.push(
      '   - `apply-plan` = **应用** → 以 `dryRun:false` 重新调用 `doc_tree_apply_plan`（`includeStatus` 由 `status-snapshot` 决定），输出最终摘要：分组、每层篇数、总篇数、配置绝对路径、lint 未处理项。',
    )
    lines.push(
      '   - `apply-plan` = **只看报告** → 不要写配置，输出「待审批清单」：方案、diff、lint 分类、建议动作。',
    )
    lines.push(
      '   - `apply-plan` = **调整后重试** → 按 `lint-decisions` 与用户反馈修改方案后重跑 `dryRun:true`（最多 2 轮），再次调用 `ask_user_question` 审批；用户没给新意见就按原方案重新询问。',
    )
    lines.push(
      '8. 如果 `ask_user_question` 不可用、调用报错或没有返回有效选择：**绝对不要写配置**。改为输出结构化「待审批清单」（方案、diff、lint 问题、建议动作），并提示用户明确批准后再执行。',
    )
    lines.push(
      '9. 最终汇报（中文）：文档根、分组数、每层的名称与篇数、总篇数、未匹配数（必须为 0）、配置文件的绝对路径（`--report`/未批准时注明「尚未写入」）、lint 未处理项。',
    )
  }
  if (reportMode) {
    lines.push('   清单至少包含：')
  } else {
    lines.push('   「待审批清单」至少包含：')
  }
  lines.push('   - 方案：root、分组（id / 标题 / match / 篇数 / records 标记）。')
  lines.push('   - diff：dryRun 输出中的新增 / 删除 / 改名分组与每层篇数变化、未匹配数。')
  lines.push('   - lint 问题：按「必须人决定」与「仅报告」分类列出（code + 文件 + 建议动作）。')
  lines.push('   - 建议动作：建议用户批准哪些项、需要人工决定哪些项、哪些 lint 项建议保持只报告。')
  if (reportMode) {
    lines.push('   - 明确提示：本次为 `--report` 仅报告模式，未写入配置；如需写入请用户批准后再执行 `/docs-organize`（或让模型以 dryRun:false 应用）。')
  }
  return lines.join('\n')
}


//#endregion

//#region host wiring

function requireCwd(exec) {
  const agent = exec?.agent
  if (agent === undefined || agent === null) {
    throw new Error('dsh-doc-tree：缺少 agent 上下文（该工具只能在会话内调用）')
  }
  const cwd = agent.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd === '') {
    throw new Error('dsh-doc-tree：当前会话没有工作目录（session.header.cwd）')
  }
  return cwd
}

function makeTool(spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : String(value) }],
    },
    execute: spec.execute,
  }
}

const STRING_PARAM = (description) => ({ type: 'string', description })
const BOOLEAN_PARAM = (description) => ({ type: 'boolean', description })

const SCAN_PARAMETERS = {
  type: 'object',
  properties: {
    root: STRING_PARAM('文档根（相对工作区，如 "docs"）。省略时自动在 cwd 下查找 docs/documentation/wiki，以及一级项目目录下的 docs'),
    includeStatus: BOOLEAN_PARAM('是否读取每篇文档开头的 Status: 状态行（默认 false；整理记录层时建议 true）'),
  },
  additionalProperties: false,
}

const READ_PLAN_PARAMETERS = {
  type: 'object',
  properties: {},
  additionalProperties: false,
}

const LINT_PARAMETERS = {
  type: 'object',
  properties: {
    root: STRING_PARAM('文档根（相对工作区，如 "docs"）。省略时自动发现'),
    includeLinks: BOOLEAN_PARAM('是否检查相对 .md 链接 / 孤儿文档 / 从入口的可达性（默认 true）'),
    maxIssues: {
      type: 'integer',
      description: '最多返回的问题条数（默认 200，上限 2000）；超出时 truncated:true，counts 仍统计全量',
    },
  },
  additionalProperties: false,
}

const APPLY_PLAN_PARAMETERS = {
  type: 'object',
  properties: {
    root: STRING_PARAM('文档根（相对工作区，如 "docs"），必须已存在'),
    groups: {
      type: 'array',
      description: '3–8 个语义分组，按顺序匹配；必须覆盖全部 Markdown 文件（建议最后一组为 catch-all）',
      items: {
        type: 'object',
        properties: {
          id: STRING_PARAM('短英文标识（唯一），如 map / contracts / records / other'),
          title: STRING_PARAM('中文标题，如 "文档地图" / "口径契约"'),
          hint: STRING_PARAM('可选层级标记，如 L2 / L4 / L5'),
          prefix: STRING_PARAM('可选路径前缀（如 "contracts/"），仅用于 UI 显示时剥离'),
          match: {
            type: 'array',
            description: '相对文档根的 glob 列表；* 段内、** 跨段、? 单字符',
            items: { type: 'string' },
          },
          records: BOOLEAN_PARAM('是否为记录层分组（生命周期徽标，全配置只能有一个）'),
        },
        required: ['id', 'title', 'match'],
        additionalProperties: false,
      },
    },
    records: {
      type: 'object',
      description: '记录层元数据（可选）',
      properties: {
        dir: STRING_PARAM('记录层目录（相对文档根，默认取自 records 分组的 prefix，如 "records"）'),
        lifecycles: {
          type: 'array',
          description: '生命周期枚举（默认 proposed / implemented / rejected / archived）',
          items: { type: 'string' },
        },
        statuses: {
          type: 'object',
          description: '路径 → 状态 的快照；includeStatus:true 时会自动补全 records 组文件',
        },
      },
      additionalProperties: false,
    },
    includeStatus: BOOLEAN_PARAM('是否把 records 组文档的 Status: 行写入 records.statuses（默认 false）'),
    dryRun: BOOLEAN_PARAM('true 时只做完整校验并输出「旧配置 → 新配置」diff，不写文件（默认 false）'),
  },
  required: ['root', 'groups'],
  additionalProperties: false,
}

/**
 * Parse `/docs-organize` raw input: optional `--report` flag and optional root.
 *
 * @param {unknown} rawInput
 * @returns {{ok: true, report: boolean, root: string} | {ok: false, error: string}}
 */
function parseOrganizeInput(rawInput) {
  const tokens = String(rawInput ?? '')
    .trim()
    .split(/\s+/u)
    .filter((token) => token !== '')
  let report = false
  let root = ''
  for (const token of tokens) {
    if (token === '--report') {
      if (report) return { ok: false, error: '参数 --report 重复' }
      report = true
      continue
    }
    if (token.startsWith('-')) return { ok: false, error: `未知参数：${token}` }
    if (root !== '') return { ok: false, error: `多余参数：${token}` }
    root = token
  }
  return { ok: true, report, root }
}

/**
 * Plugin entry: register the four tools and the slash command, each through
 * `ctx.effect` so a hot reload / unload removes every registration cleanly.
 *
 * @param {object} ctx cordis plugin context
 */
export function apply(ctx) {
  const register = (label, factory) => {
    ctx.effect(() => {
      try {
        return factory()
      } catch (error) {
        if (isDuplicateRegistration(error)) {
          try {
            ctx.logger?.warn?.(`dsh-doc-tree: ${label} 已有同名注册，本实例跳过（双路径装配）`)
          } catch {
            // logging is best-effort
          }
          return () => {}
        }
        throw error
      }
    }, label)
  }

  register('doc_tree_scan', () =>
    ctx.tools.register(
      makeTool({
        name: 'doc_tree_scan',
        description:
          '扫描工作区里的文档目录（Markdown），返回文件清单与候选根目录。root 省略时自动在 cwd 下查找 ' +
          'docs/documentation/wiki（含一级项目目录下的 docs）；只收 .md/.mdx/.markdown，自动跳过 ' +
          'node_modules/.git/dist/build/out/.scratch/.tmp，深度≤6、最多 2000 个文件。返回 JSON 字符串：' +
          '{workspaceRoot, root, candidates:[{path,score,count}], files:[{path,title?,status?,bytes?}], counts}。' +
          '做文档分层前先调用本工具。',
        parameters: SCAN_PARAMETERS,
        async execute(args, exec) {
          const cwd = requireCwd(exec)
          const payload = await scanDocs(ctx.fs, cwd, args ?? {})
          return JSON.stringify(payload)
        },
      }),
    ),
  )

  register('doc_tree_read_plan', () =>
    ctx.tools.register(
      makeTool({
        name: 'doc_tree_read_plan',
        description:
          '读取工作区根目录下当前生效的文档树配置 .dsh-doc-tree.json 原文（不存在时返回字符串 "null"）。' +
          '整理前可用它查看已有分组，避免重复劳动。',
        parameters: READ_PLAN_PARAMETERS,
        async execute(_args, exec) {
          const cwd = requireCwd(exec)
          let target
          try {
            target = await ctx.fs.resolve(CONFIG_FILE, { cwd })
          } catch (error) {
            if (isMissingError(error)) return 'null'
            throw error
          }
          try {
            const text = await ctx.fs.readText(target)
            return typeof text === 'string' ? text : 'null'
          } catch (error) {
            if (isMissingError(error)) return 'null'
            throw error
          }
        },
      }),
    ),
  )

  register('doc_tree_lint', () =>
    ctx.tools.register(
      makeTool({
        name: 'doc_tree_lint',
        description:
          '只读体检文档树并聚合当前配置：返回 JSON 字符串 {workspaceRoot, root, counts:{files,groups,issues,bySeverity}, issues, truncated}。' +
          '检查 code：root-not-found / missing-entry / duplicate-content（归一化 sha256）/ duplicate-title / broken-link（相对 .md 链接）/ ' +
          'orphan-doc / unreachable-from-entry（从 README BFS 2 跳）/ status-conflict（Status 与路径 lifecycle 不一致）/ unknown-status / ' +
          'unclassified（配置存在但不被任何 group 匹配）/ empty-doc（<50 字节）/ duplicate-path / case-collision（+ config-invalid）。' +
          '按 error→warn→info 排序、同一 code+file 去重、maxIssues 截断。不改任何文件。',
        parameters: LINT_PARAMETERS,
        async execute(args, exec) {
          const cwd = requireCwd(exec)
          const payload = await lintDocs(ctx.fs, cwd, args ?? {})
          return JSON.stringify(payload)
        },
      }),
    ),
  )

  register('doc_tree_apply_plan', () =>
    ctx.tools.register(
      makeTool({
        name: 'doc_tree_apply_plan',
        description:
          '校验并写入文档树配置 <工作区根>/.dsh-doc-tree.json。root 为文档根（如 "docs"）；groups 为 3–8 个语义分组，' +
          'match 是相对文档根的 glob（* 段内、** 跨段、? 单字符），必须覆盖全部 Markdown——建议最后一组用 catch-all ' +
          '{"id":"other","title":"其他","match":["**"]}；记录层分组标 records:true；includeStatus:true 时把每篇的 ' +
          'Status: 写入 records.statuses。覆盖不全时返回前 20 个未匹配路径（不写文件），按提示补齐后重试（最多 3 次）。' +
          'dryRun:true 时完整校验并输出「旧配置 → 新配置」diff，但绝不写文件——人工审批流程必须先 dryRun 再等用户批准。',
        parameters: APPLY_PLAN_PARAMETERS,
        async execute(args, exec) {
          const cwd = requireCwd(exec)
          const result = await applyPlan(ctx.fs, cwd, args ?? {})
          return result.text
        },
      }),
    ),
  )

  register('docs-organize', () =>
    ctx.commands.register({
      name: 'docs-organize',
      description:
        '整理文档树配置：模型先 doc_tree_scan / 读入口 / doc_tree_lint，再用 doc_tree_apply_plan(dryRun:true) 出 diff，' +
        '然后必须通过 ask_user_question 批量征求你批准，只有选「应用」才写 .dsh-doc-tree.json；不修改文档正文。' +
        '用法：/docs-organize [--report] [root]；--report 只出「待审批清单」，跳过提问、不写配置。',
      input: { hint: '[--report] [root]' },
      async handler(invocation) {
        try {
          const agent = invocation?.agent
          if (agent === undefined || agent === null) {
            return { kind: 'error', text: '/docs-organize 需要在会话内执行（缺少 agent 上下文）。' }
          }
          const cwd = agent.session?.header?.cwd
          if (typeof cwd !== 'string' || cwd === '') {
            return { kind: 'error', text: '/docs-organize 失败：当前会话没有工作目录（session.header.cwd）。' }
          }
          const parsed = parseOrganizeInput(invocation.rawInput)
          if (!parsed.ok) {
            return {
              kind: 'error',
              text: `用法：/docs-organize [--report] [root]\n${parsed.error}`,
            }
          }
          const { report, root } = parsed
          if (root !== '') {
            let ok = false
            try {
              const target = await ctx.fs.resolve(root, { cwd })
              const entries = await ctx.fs.listDir(target)
              ok = Array.isArray(entries)
            } catch {
              ok = false
            }
            if (!ok) {
              return {
                kind: 'error',
                text:
                  `文档根不存在或不是目录：${root}\n` +
                  '用法：/docs-organize [--report] [root]（root 相对工作区，如 docs）',
              }
            }
          }
          const prompt = buildOrganizePrompt({ workspaceRoot: cwd, root, reportMode: report })
          agent.followup({
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text: prompt }],
            source: { kind: 'user' },
          })
          return {
            kind: 'success',
            text: report
              ? '已把文档整理任务发给模型（仅报告模式）：' +
                (root !== '' ? `文档根 ${root}。` : '文档根由模型自动发现。') +
                '模型会 scan / 读入口 / lint / dryRun 预览后直接输出「待审批清单」，不会调用 ask_user_question，也不会写入配置。'
              : '已把文档整理任务发给模型：' +
                (root !== '' ? `文档根 ${root}。` : '文档根由模型自动发现。') +
                '模型会 scan / 读入口 / lint / dryRun 预览，然后用 ask_user_question 批量征求你批准，只有你选「应用」后才会写入 .dsh-doc-tree.json。',
          }
        } catch (error) {
          return { kind: 'error', text: `/docs-organize 失败：${messageOf(error)}` }
        }
      },
    }),
  )
}

//#endregion
