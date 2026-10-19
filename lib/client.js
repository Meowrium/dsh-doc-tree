/**
 * dsh-doc-tree — browser half.
 *
 * Registers a page tab type (`doc-tree`) into DSH's native right Sidebar and
 * renders a curated document tree for a governed docs directory:
 *
 *   - layers (文档地图 / 口径契约 / 记录层 / 子系统参考 / 运维手册 / 术语 / 生成区)
 *   - the records tree with lifecycle colors (proposed / implemented / rejected / archived)
 *   - path search, an "原始结构" toggle, and in-pane Markdown reading with outline
 *
 * Data comes from the official `workspaceFiles` Remote (read-only, workspace
 * relative listing; reads by workspace path or absolute path). Markdown is
 * rendered by the host's own `MarkdownText` primitive, and local `.md` links
 * are routed back into this tab through `MarkdownDelegateProvider.openFile`.
 *
 * Browser artifact format matches the platform's lazy-CJS module table: a
 * classic script that registers a factory whose id equals the package name.
 */

window.__ModuleLoader__.load({
	id: 'dsh-doc-tree',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const React = require('react')
		const h = React.createElement
		const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
		const MarkdownText = primitives.MarkdownText
		const MarkdownDelegateProvider = primitives.MarkdownDelegateProvider

		const ID = 'dsh-doc-tree'
		const KIND = 'doc-tree'
		const STORE = 'dsh-doc-tree.v1'
		const LABELS = {
			code: { copyLabel: '复制', copiedLabel: '已复制' },
			footnotes: '脚注'
		}

		const MAX_DEPTH = 6
		const MAX_FILES = 2000

		const DEFAULT_GROUPS = [
			{ id: 'map', title: '文档地图', hint: 'L2 入口 / 文档标准', order: 1, prefix: '', match: (r) => r === 'README.md' || r === 'AGENTS.md' },
			{ id: 'contracts', title: '口径契约', hint: 'L4', order: 2, prefix: 'contracts/', match: (r) => r.startsWith('contracts/') },
			{ id: 'records', title: '记录层', hint: 'L5 · lifecycle / class', order: 3, prefix: 'records/', match: (r) => r.startsWith('records/'), records: true },
			{ id: 'development', title: '子系统参考', hint: 'L2', order: 4, prefix: 'development/', match: (r) => r.startsWith('development/') },
			{ id: 'cookbook', title: '运维手册', hint: 'cookbook', order: 5, prefix: 'cookbook/', match: (r) => r.startsWith('cookbook/') },
			{ id: 'terminology', title: '术语', hint: 'L7', order: 6, prefix: '', match: (r) => /^terminology[^/]*\.md$/i.test(r) },
			{ id: 'generated', title: '生成 / 机器', hint: '生成区', order: 7, prefix: '', match: (r) => r === 'cli-help.md' },
			{ id: 'other', title: '其他', hint: '', order: 8, prefix: '', match: () => true }
		]

		const LIFECYCLES = {
			proposed: { label: '提案', color: '#d4a72c' },
			implemented: { label: '已落地', color: '#3ba55d' },
			rejected: { label: '已否决', color: '#d9534f' },
			archived: { label: '封印', color: '#8f959e' }
		}

		const ROOT_NAME_RE = /^(docs?|documentation|wiki|design|specs?|handbook|guide|notes?)$/i
		const IGNORE_DIR_RE = /^(node_modules|\.git|dist|build|out|output|coverage|vendor|\.scratch|\.tmp)$/i
		const isIgnoredDir = (name) => name.startsWith('.') || name.startsWith('_') || IGNORE_DIR_RE.test(name)

		function globToRegExp(glob) {
			const source = String(glob || '').replace(/\\/g, '/').trim()
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

		function compileGroups(configGroups) {
			if (!Array.isArray(configGroups) || configGroups.length === 0) return null
			const out = []
			for (const raw of configGroups) {
				if (!raw || typeof raw.id !== 'string' || typeof raw.title !== 'string') continue
				const patterns = Array.isArray(raw.match) ? raw.match : typeof raw.match === 'string' ? [raw.match] : []
				if (patterns.length === 0) continue
				const regs = patterns.map(globToRegExp)
				out.push({
					id: raw.id,
					title: raw.title,
					hint: typeof raw.hint === 'string' ? raw.hint : '',
					prefix: typeof raw.prefix === 'string' ? raw.prefix : '',
					records: raw.records === true,
					match: (rel) => regs.some((re) => re.test(rel))
				})
			}
			return out.length > 0 ? out : null
		}

		function parseConfig(text) {
			try {
				const parsed = JSON.parse(String(text || ''))
				if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
			} catch (error) {
				// malformed config: fall back to defaults
			}
			return null
		}

		async function readConfigFile(readDoc, cwd, root) {
			if (!cwd) return null
			const paths = ['.dsh-doc-tree.json']
			if (root) paths.push(normPath(root) + '/.dsh-doc-tree.json')
			for (const rel of paths) {
				try {
					const page = await readDoc(absPath(cwd, '', rel))
					const text = page && typeof page.text === 'string' ? page.text : ''
					const parsed = parseConfig(text)
					if (parsed) return parsed
				} catch (error) {
					// try the next location
				}
			}
			return null
		}

		async function discoverRoots(list, signal, base) {
			const found = []
			const seen = new Set()
			const prefix = base ? String(base).replace(/\\/g, '/').replace(/\/+$/, '') + '/' : ''
			const read = (rel) => list(rel ? normPath(rel) : '.', signal)
			async function probe(path, baseScore) {
				const normalized = normPath(path)
				if (!normalized || seen.has(normalized)) return
				seen.add(normalized)
				try {
					const listing = await read(normalized)
					const names = listing.entries.map((entry) => entry.name)
					const md = listing.entries.filter((entry) => entry.type === 'file' && /\.(md|markdown)$/i.test(entry.name)).length
					const marker = names.includes('README.md') || names.includes('AGENTS.md') || names.includes('index.md')
					const config = names.includes('.dsh-doc-tree.json')
					if (!marker && md < 2 && !config) return
					found.push({
						path: normalized,
						score: (baseScore || 0) + (config ? 4 : 0) + (marker ? 2 : 0) + Math.min(md, 50),
						count: md
					})
				} catch (error) {
					// not a readable directory
				}
			}
			let top = []
			try {
				top = await list('.', signal)
			} catch (error) {
				return found
			}
			const topDirs = top.entries.filter((entry) => entry.type === 'directory' && !isIgnoredDir(entry.name)).slice(0, 64)
			for (const dir of topDirs) {
				if (ROOT_NAME_RE.test(dir.name)) await probe(dir.name, 2)
				let children = []
				try {
					children = await read(dir.name)
				} catch (error) {
					continue
				}
				const childNames = children.entries.map((entry) => entry.name)
				if (childNames.includes('.dsh-doc-tree.json')) await probe(dir.name, 4)
				const childDirs = children.entries.filter((entry) => entry.type === 'directory' && !isIgnoredDir(entry.name)).slice(0, 16)
				for (const child of childDirs) {
					if (ROOT_NAME_RE.test(child.name)) await probe(dir.name + '/' + child.name, 2)
					let grand = []
					try {
						grand = await read(dir.name + '/' + child.name)
					} catch (error) {
						continue
					}
					const grandNames = grand.entries.map((entry) => entry.name)
					if (grandNames.includes('.dsh-doc-tree.json')) await probe(dir.name + '/' + child.name, 4)
					for (const leaf of grand.entries.filter((entry) => entry.type === 'directory' && ROOT_NAME_RE.test(entry.name)).slice(0, 4)) {
						await probe(dir.name + '/' + child.name + '/' + leaf.name, 1)
					}
				}
			}
			found.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
			return found.slice(0, 10)
		}

		//#region path helpers

		function normPath(p) {
			return String(p || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '').replace(/\/$/, '')
		}

		function basename(p) {
			const n = normPath(p)
			const i = n.lastIndexOf('/')
			return i < 0 ? n : n.slice(i + 1)
		}

		function dirname(p) {
			const n = normPath(p)
			const i = n.lastIndexOf('/')
			return i < 0 ? '' : n.slice(0, i)
		}

		function absPath(cwd, root, rel) {
			const base = String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '')
			const r = normPath(root)
			const p = normPath(rel)
			if (!base) return r ? r + '/' + p : p
			return base + '/' + (r ? r + '/' : '') + p
		}

		function joinRel(a, b) {
			const left = normPath(a)
			const right = normPath(b)
			return left ? left + '/' + right : right
		}

		function normalizeRel(p) {
			const parts = []
			for (const part of normPath(p).split('/')) {
				if (part === '' || part === '.') continue
				if (part === '..') parts.pop()
				else parts.push(part)
			}
			return parts.join('/')
		}

		function resolveHref(root, currentRel, href) {
			const raw = String(href || '')
			if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return { external: true, href: raw }
			let p = raw.split('#')[0].split('?')[0]
			if (!p) return null
			p = p.replace(/\\/g, '/')
			const rootNorm = normPath(root)
			if (rootNorm) {
				if (p === rootNorm) p = ''
				else if (p.startsWith(rootNorm + '/')) p = p.slice(rootNorm.length + 1)
				else {
					const marker = '/' + rootNorm + '/'
					const idx = p.lastIndexOf(marker)
					if (idx >= 0) p = p.slice(idx + marker.length)
				}
			}
			const absolute = /^([A-Za-z]:\/|\/)/.test(p)
			p = p.replace(/^[A-Za-z]:\//, '').replace(/^\/+/, '')
			if (!absolute && currentRel) p = joinRel(dirname(currentRel), p)
			return { rel: normalizeRel(p) }
		}

		function lifecycleOf(rel) {
			const parts = normPath(rel).split('/')
			for (let i = 0; i < parts.length - 1; i += 1) {
				if (LIFECYCLES[parts[i]]) return { lifecycle: parts[i], cls: parts[i + 1] || null }
			}
			return null
		}

		function statusLine(text) {
			const head = String(text || '').slice(0, 800)
			const m = /^Status:\s*(.+)$/m.exec(head)
			return m ? m[1].trim() : ''
		}

		function parseHeadings(text) {
			const out = []
			const lines = String(text || '').split('\n')
			let inFence = false
			for (const line of lines) {
				if (/^\s*```/.test(line)) {
					inFence = !inFence
					continue
				}
				if (inFence) continue
				const m = /^(#{1,4})\s+(.+?)\s*$/.exec(line)
				if (m) out.push({ level: m[1].length, text: m[2].replace(/[#*`]/g, '').trim() })
			}
			return out
		}

		function highlightSnippet(text, at, q) {
			const start = Math.max(0, at - 40)
			const end = Math.min(text.length, at + q.length + 70)
			const s = text.slice(start, end).replace(/\s+/g, ' ')
			const i = s.toLowerCase().indexOf(q)
			if (i < 0) return s
			return [
				s.slice(0, i),
				h('mark', { className: 'dt-mark', key: 'm' }, s.slice(i, i + q.length)),
				s.slice(i + q.length)
			]
		}

		//#endregion

		//#region data

		function createFs(remote) {
			return {
				async list(sessionId, path, signal) {
					const result = await remote.workspaceFiles.list(sessionId, path, signal)
					if (!result || !result.ok) throw result && result.error ? result.error : new Error('无法列出目录：' + path)
					return result.value
				},
				async read(sessionId, path, signal) {
					const result = await remote.workspaceFiles.read(sessionId, path, { offset: 1, limit: 5000 }, signal)
					if (!result || !result.ok) throw result && result.error ? result.error : new Error('无法读取文件：' + path)
					return result.value
				}
			}
		}

		function errorMessage(error) {
			if (!error) return '未知错误'
			if (typeof error === 'string') return error
			if (error.message) return String(error.message)
			return String(error)
		}

		async function walkAll(list, root, signal, onCount) {
			const files = []
			const queue = [{ rel: '', depth: 0 }]
			while (queue.length > 0) {
				if (files.length > MAX_FILES) break
				const current = queue.shift()
				const path = current.rel ? joinRel(root, current.rel) : root
				let listing
				try {
					listing = await list(path, signal)
				} catch (error) {
					continue
				}
				for (const entry of listing.entries) {
					if (!entry || typeof entry.name !== 'string' || entry.name.startsWith('.')) continue
					const rel = current.rel ? current.rel + '/' + entry.name : entry.name
					if (entry.type === 'directory') {
						if (current.depth < MAX_DEPTH) queue.push({ rel, depth: current.depth + 1 })
					} else if (entry.type === 'file' && /\.(md|markdown)$/i.test(entry.name)) {
						files.push({ rel, name: entry.name, size: entry.size })
						if (onCount) onCount(files.length)
					}
				}
			}
			files.sort((a, b) => a.rel.localeCompare(b.rel, 'zh-Hans-CN'))
			return files
		}

		//#endregion

		//#region tree model

		function buildTree(files, prefix) {
			const root = { name: '', path: '', type: 'dir', children: new Map() }
			for (const file of files) {
				const display = prefix && file.rel.startsWith(prefix) ? file.rel.slice(prefix.length) : file.rel
				const parts = display.split('/')
				let node = root
				for (let i = 0; i < parts.length - 1; i += 1) {
					const rel = parts.slice(0, i + 1).join('/')
					if (!node.children.has(parts[i])) {
						node.children.set(parts[i], { name: parts[i], path: rel, type: 'dir', children: new Map() })
					}
					node = node.children.get(parts[i])
				}
				const leaf = parts[parts.length - 1]
				node.children.set(leaf, { name: leaf, path: display, full: file.rel, type: 'file', size: file.size })
			}
			return root
		}

		function countFiles(node) {
			if (node.type === 'file') return 1
			let n = 0
			for (const child of node.children.values()) n += countFiles(child)
			return n
		}

		function sortedChildren(node) {
			return [...node.children.values()].sort((a, b) => {
				if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
				return a.name.localeCompare(b.name, 'zh-Hans-CN')
			})
		}

		//#endregion

		//#region state

		function stateKey(sessionId) {
			return STORE + '.' + (sessionId || 'global')
		}

		function readState(sessionId) {
			try {
				const raw = window.localStorage.getItem(stateKey(sessionId))
				return raw ? JSON.parse(raw) : {}
			} catch (error) {
				return {}
			}
		}

		function writeState(sessionId, patch) {
			try {
				const next = Object.assign({}, readState(sessionId), patch)
				window.localStorage.setItem(stateKey(sessionId), JSON.stringify(next))
			} catch (error) {
				// localStorage may be unavailable; state is a convenience only
			}
		}

		//#endregion

		//#region icons

		function icon(path, size) {
			return h('svg', {
				width: size || 14,
				height: size || 14,
				viewBox: '0 0 24 24',
				fill: 'none',
				stroke: 'currentColor',
				strokeWidth: 1.8,
				strokeLinecap: 'round',
				strokeLinejoin: 'round',
				'aria-hidden': true,
				style: { display: 'block', flex: 'none' }
			}, h('path', { d: path }))
		}

		const ICON = {
			chevron: (open) => icon(open ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6'),
			folder: () => icon('M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'),
			file: () => icon('M6 3h8l4 4v14H6zM14 3v4h4'),
			search: () => icon('M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4'),
			refresh: () => icon('M20 11a8 8 0 1 0-2.3 6.3M20 5v6h-6'),
			back: () => icon('M15 6l-6 6 6 6'),
			outline: () => icon('M4 6h16M4 12h10M4 18h13'),
			filter: () => icon('M3 5h18l-7 8v6l-4 2v-8z'),
			scan: () => icon('M12 3a9 9 0 1 0 9 9M12 7v5l3 2M20 4l-4 4'),
			close: () => icon('M6 6l12 12M18 6L6 18'),
			raw: () => icon('M8 6l-5 6 5 6M16 6l5 6-5 6'),
			layers: () => icon('M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5'),
			palette: () => icon('M12 3a9 9 0 1 0 0 18c1.6 0 2.2-1.1 1.6-2.3-.5-1.1.1-2.2 1.4-2.2H18a3 3 0 0 0 3-3 9 9 0 0 0-9-10.5zM7.5 10h.01M10 7h.01M15 7h.01'),
			command: () => icon('M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z'),
			columns: () => icon('M4 5h16v14H4zM12 5v14')
		}

		//#endregion

		//#region styles

		function installStyle() {
			const cssText = [
				'.dt-root{--dt-bg:var(--dsw-alias-bg-base,#fff);--dt-layer:var(--dsw-alias-bg-layer-1,#f7f8fa);--dt-overlay:var(--dsw-alias-bg-overlay,#fff);--dt-text:var(--dsw-alias-label-primary,#1f2329);--dt-dim:var(--dsw-alias-label-secondary,#646a73);--dt-faint:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-tertiary,#8f959e));--dt-border:var(--dsw-alias-border-l1,rgba(127,127,127,.16));--dt-border2:var(--dsw-alias-border-l2,rgba(127,127,127,.24));--dt-hover:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));--dt-active:var(--dsw-alias-interactive-bg-active,rgba(77,107,254,.12));--dt-accent:var(--dsw-alias-brand-primary,#4d6bfe);--dt-mono:var(--dsh-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);box-sizing:border-box;height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dt-layer);color:var(--dt-text);font-size:13px;line-height:1.6}',
				'.dt-head{flex:none;padding:0 6px 0 12px;background:var(--dt-layer)}',
				'.dt-head-row{display:flex;align-items:center;gap:8px;height:38px;min-height:38px}',
				'.dt-logo{color:var(--dt-accent);display:flex;align-items:center}',
				'.dt-title{font-size:14px;font-weight:600;line-height:20px;white-space:nowrap}',
				'.dt-rootpath{margin-left:auto;max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dt-faint);font-size:11px;line-height:16px;cursor:pointer;padding:2px 6px;border-radius:6px}',
				'.dt-rootpath:hover{background:var(--dt-hover);color:var(--dt-dim)}',
				'.dt-head-actions{display:flex;align-items:center;gap:2px;flex:none}',
				'.dt-icon{width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border:none;background:transparent;color:var(--dt-dim);border-radius:50%;cursor:pointer;padding:0;flex:none;font-size:14px}',
				'.dt-icon:hover{background:var(--dt-hover);color:var(--dt-text)}',
				'.dt-icon.on{background:var(--dt-hover);color:var(--dt-accent)}',
				'.dt-search{margin:0 6px 8px;display:flex;align-items:center;gap:6px;background:var(--dt-bg);border:1px solid var(--dt-border2);border-radius:8px;padding:0 10px;height:30px;color:var(--dt-faint);transition:border-color .15s ease}',
				'.dt-search:focus-within{border-color:var(--dt-accent)}',
				'.dt-search input{flex:1;min-width:0;border:none;background:transparent;outline:none;color:var(--dt-text);font:inherit;font-size:12.5px;height:100%}',
				'.dt-rootedit{display:flex;gap:6px;padding:0 6px 8px}',
				'.dt-rootedit input{flex:1;min-width:0;height:28px;border:1px solid var(--dt-border2);border-radius:6px;background:var(--dt-bg);color:var(--dt-text);font:inherit;font-size:12px;padding:0 8px;outline:none}',
				'.dt-rootedit input:focus{border-color:var(--dt-accent)}',
				'.dt-rootedit button{height:28px;border:1px solid var(--dt-border2);border-radius:6px;background:transparent;color:var(--dt-dim);font:inherit;font-size:12px;padding:0 10px;cursor:pointer}',
				'.dt-rootedit button:hover{background:var(--dt-hover);color:var(--dt-text)}',
				'.dt-candidates{display:flex;flex-direction:column;gap:1px;padding:0 6px 8px;max-height:168px;overflow:auto}',
				'.dt-candidate{display:flex;align-items:center;gap:8px;border:none;background:transparent;color:var(--dt-text);font:inherit;font-size:11.5px;text-align:left;padding:4px 8px;border-radius:6px;cursor:pointer;overflow:hidden}',
				'.dt-candidate:hover{background:var(--dt-hover)}',
				'.dt-candidate-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
				'.dt-candidate-count{margin-left:auto;color:var(--dt-faint);font-size:10px;flex:none}',
				'.dt-candidates-empty{color:var(--dt-faint);font-size:11px;padding:4px 8px}',
				'.dt-main{flex:1;min-height:0;display:flex}',
				'.dt-list{box-sizing:border-box;width:300px;flex:none;border-right:1px solid var(--dt-border);background:var(--dt-layer);display:flex;flex-direction:column;min-height:0}',
				'.dt-main.narrow .dt-list{width:100%;border-right:none}',
				'.dt-list-meta{flex:none;padding:0 12px 6px;color:var(--dt-faint);font-size:11px;line-height:16px;display:flex;align-items:center;gap:8px}',
				'.dt-list-note{flex:none;padding:0 6px 6px;color:var(--dt-faint);font-size:11px;line-height:16px}',
				'.dt-list-scroll{flex:1;min-height:0;overflow:auto;padding:2px 6px 18px}',
				'.dt-reader-pane{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;background:var(--dt-bg)}',
				'.dt-placeholder{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:var(--dt-faint);font-size:12px;padding:28px;text-align:center}',
				'.dt-placeholder-icon{opacity:.45}',
				'.dt-reader{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dt-bg)}',
				'.dt-reader-toolbar{flex:none;display:flex;align-items:center;gap:8px;height:38px;padding:0 8px 0 10px;border-bottom:1px solid var(--dt-border);background:var(--dt-layer)}',
				'.dt-reader-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600;line-height:20px}',
				'.dt-chip{flex:none;font-size:10.5px;padding:1px 7px;border-radius:999px;color:#fff;line-height:16px;border:none}',
				'.dt-tool-btn{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 9px;border:1px solid var(--dt-border2);border-radius:6px;background:transparent;color:var(--dt-dim);font:inherit;font-size:12px;cursor:pointer;flex:none}',
				'.dt-tool-btn:hover{background:var(--dt-hover);color:var(--dt-text)}',
				'.dt-tool-btn.on{background:var(--dt-hover);color:var(--dt-accent);border-color:var(--dt-accent)}',
				'.dt-toc-wrap{position:relative;flex:none}',
				'.dt-toc{position:absolute;top:calc(100% + 6px);right:0;width:240px;max-height:280px;overflow:auto;background:var(--dt-overlay);border:1px solid var(--dt-border);border-radius:10px;box-shadow:0 10px 28px rgba(0,0,0,.18);padding:6px;z-index:20}',
				'.dt-toc button{display:block;width:100%;text-align:left;border:none;background:transparent;color:var(--dt-text);cursor:pointer;font:inherit;font-size:12px;line-height:18px;padding:4px 8px;border-radius:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
				'.dt-toc button:hover{background:var(--dt-hover)}',
				'.dt-status{flex:none;padding:4px 12px 0;color:var(--dt-faint);font-size:11px;line-height:16px;background:var(--dt-bg)}',
				'.dt-reader-scroll{flex:1;min-height:0;overflow:auto;padding:20px 24px 48px}',
				'.dt-md{max-width:720px;margin:0 auto;color:var(--dt-text);font-size:14px;line-height:1.75;overflow-wrap:break-word}',
				'.dt-md h1{font-size:24px;line-height:1.35;margin:0 0 18px;padding-bottom:10px;border-bottom:1px solid var(--dt-border);font-weight:650}',
				'.dt-md h2{font-size:19px;line-height:1.4;margin:28px 0 12px;font-weight:650}',
				'.dt-md h3{font-size:16px;line-height:1.4;margin:24px 0 10px;font-weight:600}',
				'.dt-md h4{font-size:15px;margin:20px 0 8px;font-weight:600}',
				'.dt-md h5{font-size:14px;margin:18px 0 8px;font-weight:600}',
				'.dt-md h6{font-size:13px;color:var(--dt-dim);margin:16px 0 8px;font-weight:600}',
				'.dt-md p{margin:0 0 14px}',
				'.dt-md ul,.dt-md ol{margin:0 0 14px;padding-left:24px}',
				'.dt-md li{margin:4px 0}',
				'.dt-md li>ul,.dt-md li>ol{margin:4px 0}',
				'.dt-md a{color:var(--dt-accent);text-decoration:none}',
				'.dt-md a:hover{text-decoration:underline}',
				'.dt-md strong{font-weight:600}',
				'.dt-md hr{border:none;border-top:1px solid var(--dt-border);margin:24px 0}',
				'.dt-md code{font-family:var(--dt-mono);font-size:.9em;padding:1px 6px;border-radius:6px;background:var(--dsw-alias-markdown-inline-code,rgba(128,132,144,.16))}',
				'.dt-md pre{margin:0 0 14px;border:1px solid var(--dt-border);border-radius:10px;overflow:auto;background:var(--dsw-alias-markdown-code-block,var(--dt-layer));padding:12px 14px}',
				'.dt-md pre code{padding:0;background:transparent;font-size:12.5px;line-height:1.65}',
				'.dt-md blockquote{margin:0 0 14px;padding:10px 16px;border-left:3px solid var(--dt-accent);background:var(--dt-layer);color:var(--dt-dim);border-radius:0 10px 10px 0}',
				'.dt-md blockquote p:last-child{margin:0}',
				'.dt-md table{border-collapse:collapse;width:100%;margin:0 0 14px;font-size:13px;display:block;overflow-x:auto}',
				'.dt-md th,.dt-md td{border:1px solid var(--dt-border);padding:7px 12px;text-align:left;vertical-align:top}',
				'.dt-md th{background:var(--dt-layer);font-weight:600}',
				'.dt-md img{max-width:100%;border-radius:8px}',
				'.dt-group{margin-top:2px}',
				'.dt-group-head{display:flex;align-items:center;gap:2px;width:100%;border-radius:7px}',
				'.dt-group-toggle{flex:1;min-width:0;display:flex;align-items:center;gap:6px;padding:6px 8px;border:none;background:transparent;color:var(--dt-text);font:inherit;font-weight:600;font-size:12.5px;border-radius:7px;cursor:pointer;text-align:left}',
				'.dt-group-toggle:hover{background:var(--dt-hover)}',
								'.dt-filter-panel{padding:2px 8px 8px;border-bottom:1px solid var(--dt-border);margin:0 0 4px;background:var(--dt-layer)}',
				'.dt-filter-panel .dt-filters{padding:0}',
				'.dt-filter-dot{width:6px;height:6px;border-radius:50%;background:var(--dt-accent);flex:none}',
								'.dt-group-hint{font-weight:400;color:var(--dt-faint);font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
				'.dt-count{margin-left:auto;color:var(--dt-faint);font-size:10.5px;font-weight:400;flex:none}',
				'.dt-row{display:flex;align-items:center;gap:6px;width:100%;text-align:left;border:none;background:transparent;color:var(--dt-text);padding:4px 8px;cursor:pointer;font:inherit;font-size:13px;line-height:20px;border-radius:7px;min-height:28px}',
				'.dt-row:hover{background:var(--dt-hover)}',
				'.dt-row.active{background:var(--dt-active);color:var(--dt-accent)}',
				'.dt-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
				'.dt-dot{width:7px;height:7px;border-radius:50%;flex:none;display:inline-block}',
				'.dt-cls{color:var(--dt-faint);font-size:10px;flex:none}',
				'.dt-results{display:flex;flex-direction:column;gap:1px}',
				'.dt-result{border:none;background:transparent;text-align:left;padding:7px 10px;cursor:pointer;color:var(--dt-text);display:block;width:100%;border-radius:8px;font:inherit}',
				'.dt-result:hover{background:var(--dt-hover)}',
				'.dt-result-name{font-size:13px;line-height:20px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
				'.dt-result-dir{font-size:11px;line-height:15px;color:var(--dt-faint);display:block;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
				'.dt-result-snippet{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:11px;line-height:1.5;color:var(--dt-dim);margin-top:2px}',
				'.dt-mark{background:var(--dsw-alias-markdown-highlight,rgba(212,167,44,.35));color:inherit;border-radius:2px;padding:0 1px}',
				'.dt-filters{display:flex;flex-direction:column;gap:4px;padding:0 8px 6px}',
				'.dt-filter-row{display:flex;flex-wrap:wrap;gap:4px}',
				'.dt-fchip{display:inline-flex;align-items:center;gap:4px;flex:none;white-space:nowrap;border:1px solid var(--dt-border2);background:transparent;color:var(--dt-dim);border-radius:999px;font:inherit;font-size:10.5px;padding:1px 7px;cursor:pointer;line-height:16px}',
				'.dt-fchip:hover{background:var(--dt-hover)}',
				'.dt-fchip.on{background:var(--dt-hover);color:var(--dt-text);border-color:var(--dt-accent)}',
				'.dt-fchip .dt-dot{width:6px;height:6px}',
				'.dt-chip-count{color:var(--dt-faint);font-size:9.5px}',
				'.dt-empty{padding:18px 12px;color:var(--dt-faint);font-size:12px;line-height:1.7}',
				'.dt-error{color:var(--dsw-alias-state-error-primary,#d9534f)}',
				'.dt-toast{position:absolute;left:12px;right:12px;bottom:12px;background:rgba(0,0,0,.78);color:#fff;font-size:11.5px;border-radius:8px;padding:7px 10px;z-index:30}',
				'.dt-wrap{position:relative;height:100%;min-height:0;display:flex;flex-direction:column}',
				'.dt-reader-pane.dt-pair{flex-direction:row}',
				'.dt-reader-pane.dt-pair>.dt-reader{flex:1;min-width:0}',
				'.dt-reader-pane.dt-pair>.dt-reader+.dt-reader{border-left:1px solid var(--dt-border)}',
				'.dt-quick{position:absolute;inset:0;z-index:40;display:flex;align-items:flex-start;justify-content:center;padding:56px 14px 14px;background:rgba(0,0,0,.42)}',
				'.dt-quick-box{width:min(560px,100%);max-height:calc(100% - 20px);display:flex;flex-direction:column;background:var(--dt-overlay);border:1px solid var(--dt-border);border-radius:12px;box-shadow:0 18px 48px rgba(0,0,0,.32);overflow:hidden}',
				'.dt-quick-input{flex:none;display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dt-border);color:var(--dt-faint)}',
				'.dt-quick-input input{flex:1;min-width:0;border:none;background:transparent;outline:none;color:var(--dt-text);font:inherit;font-size:13px}',
				'.dt-quick-list{flex:1;min-height:0;overflow:auto;padding:6px}',
				'.dt-quick-item{display:flex;flex-direction:column;gap:1px;width:100%;text-align:left;border:none;background:transparent;color:var(--dt-text);padding:7px 9px;border-radius:7px;cursor:pointer;font:inherit}',
				'.dt-quick-item:hover,.dt-quick-item.active{background:var(--dt-active)}',
				'.dt-quick-name{font-size:13px;line-height:19px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
				'.dt-quick-dir{font-size:10.5px;line-height:15px;color:var(--dt-faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
				'.dt-quick-empty{padding:16px 10px;color:var(--dt-faint);font-size:12px}',
				'.dt-md .katex-display{margin:18px 0;overflow-x:auto;overflow-y:hidden}',
				'.dt-md .katex{font-size:1.04em}',
				'.dt-filesmd{--dt-bg:#262624;--dt-layer:#2b2b29;--dt-overlay:#30302d;--dt-text:#e8e6e3;--dt-dim:#b8b5b0;--dt-faint:#8d8a85;--dt-border:rgba(255,255,255,.10);--dt-border2:rgba(255,255,255,.16);--dt-hover:rgba(255,255,255,.07);--dt-active:rgba(96,125,255,.22);--dt-accent:#8ab4f8;background:var(--dt-bg);color:var(--dt-text)}',
				'.dt-filesmd .dt-head,.dt-filesmd .dt-list,.dt-filesmd .dt-reader-toolbar{background:var(--dt-layer)}',
				'.dt-filesmd .dt-list{border-right-color:rgba(255,255,255,.09)}',
				'.dt-filesmd .dt-md{max-width:760px;font-size:16.5px;line-height:1.72}',
				'.dt-filesmd .dt-md h1{font-size:36px;line-height:1.18;font-weight:700;letter-spacing:-.012em;margin:0 0 22px;padding-bottom:0;border-bottom:none}',
				'.dt-filesmd .dt-md h2{font-size:27px;line-height:1.3;font-weight:700;margin:34px 0 14px}',
				'.dt-filesmd .dt-md h3{font-size:21px;line-height:1.35;margin:28px 0 10px}',
				'.dt-filesmd .dt-md h4{font-size:17px}',
				'.dt-filesmd .dt-md p{margin:0 0 16px}',
				'.dt-filesmd .dt-md a{color:#9ecbff;text-decoration:underline;text-underline-offset:2px}',
				'.dt-filesmd .dt-md blockquote{border-left:4px solid #5b7cfa;background:rgba(91,124,250,.12);color:#d8d5d0;border-radius:0;padding:12px 18px}',
				'.dt-filesmd .dt-md code{background:rgba(255,255,255,.09);color:#ffd28a;border-radius:4px}',
				'.dt-filesmd .dt-md pre{background:#1e1e1c;border-color:rgba(255,255,255,.10)}',
				'.dt-filesmd .dt-md table{font-size:14px}',
				'.dt-filesmd .dt-md th{background:rgba(255,255,255,.05)}',
				'.dt-filesmd .dt-md strong{font-weight:700}',
				'.dt-filesmd .dt-md .katex{font-size:1.08em}',
				'.dt-filesmd .dt-quick-box{background:#30302d;border-color:rgba(255,255,255,.14)}',
								'@media (max-width:560px){.dt-reader-scroll{padding:16px 14px 40px}}'
			].join('\n')
			const existing = document.getElementById('dsh-doc-tree/css')
			if (existing) {
				existing.textContent = cssText
				return undefined
			}
			const style = document.createElement('style')
			style.id = 'dsh-doc-tree/css'
			style.dataset.plugin = 'dsh-doc-tree'
			style.textContent = cssText
			document.head.appendChild(style)
			return () => style.remove()
		}
		//#endregion

		//#region components

		function useToast() {
			const [toast, setToast] = React.useState('')
			React.useEffect(() => {
				if (!toast) return undefined
				const timer = window.setTimeout(() => setToast(''), 2600)
				return () => window.clearTimeout(timer)
			}, [toast])
			return [toast, setToast]
		}

		function TreeRow(props) {
			const { node, depth, expandedDirs, onToggleDir, onOpen, activeRel, statusMap } = props
			const pad = { paddingLeft: 8 + depth * 12 + 'px' }
			const lifecycle = lifecycleOf(node.full || node.path)
			const status = node.type === 'file' && statusMap && typeof statusMap[node.full] === 'string' ? statusMap[node.full] : ''
			const statusMeta = status && LIFECYCLES[status] ? LIFECYCLES[status] : null
			const dirLifecycle = node.type === 'dir' && LIFECYCLES[node.name] ? LIFECYCLES[node.name] : null
			if (node.type === 'dir') {
				const open = !!expandedDirs[node.path]
				return h(React.Fragment, { key: 'd:' + node.path },
					h('button', {
						className: 'dt-row dt-dir',
						style: pad,
						title: node.path,
						onClick: () => onToggleDir(node.path)
					},
						ICON.chevron(open),
						h('span', { style: { color: 'var(--dt-faint)', display: 'flex' } }, ICON.folder()),
						dirLifecycle ? h('span', { className: 'dt-dot', style: { background: dirLifecycle.color }, title: dirLifecycle.label }) : null,
						h('span', { className: 'dt-name' }, node.name),
						h('span', { className: 'dt-count' }, String(countFiles(node)))
					),
					open
						? sortedChildren(node).map((child) => h(TreeRow, {
							key: (child.full || child.path),
							node: child,
							depth: depth + 1,
							expandedDirs,
							onToggleDir,
							onOpen,
							activeRel,
							statusMap
						}))
						: null
				)
			}
			return h('button', {
				key: 'f:' + node.full,
				className: 'dt-row dt-file' + (activeRel === node.full ? ' active' : ''),
				style: pad,
				title: node.full + (status ? ' · Status: ' + status : ''),
				onClick: () => onOpen(node.full)
			},
				h('span', { style: { width: 14, flex: 'none' } }),
				h('span', { style: { color: 'var(--dt-faint)', display: 'flex' } }, ICON.file()),
				lifecycle
					? h('span', { className: 'dt-dot', style: { background: LIFECYCLES[lifecycle.lifecycle].color }, title: LIFECYCLES[lifecycle.lifecycle].label })
					: statusMeta ? h('span', { className: 'dt-dot', style: { background: statusMeta.color }, title: statusMeta.label }) : null,
				h('span', { className: 'dt-name' }, node.name),
				lifecycle && lifecycle.cls ? h('span', { className: 'dt-cls' }, lifecycle.cls) : null,
				!lifecycle && status ? h('span', { className: 'dt-cls' }, status) : null
			)
		}

		function RecordFilterBar(props) {
			const { filter, setFilter, classes, counts } = props
			const lifecycleOrder = ['implemented', 'proposed', 'rejected', 'archived']
			return h('div', { className: 'dt-filters' },
				h('div', { className: 'dt-filter-row' },
					h('button', {
						className: 'dt-fchip' + (filter.lifecycle === 'all' ? ' on' : ''),
						onClick: () => setFilter((prev) => ({ ...prev, lifecycle: 'all' }))
					}, '全部状态'),
					lifecycleOrder.map((id) => h('button', {
						key: id,
						className: 'dt-fchip' + (filter.lifecycle === id ? ' on' : ''),
						style: { borderColor: LIFECYCLES[id].color },
						onClick: () => setFilter((prev) => ({ ...prev, lifecycle: prev.lifecycle === id ? 'all' : id }))
					},
						h('span', { className: 'dt-dot', style: { background: LIFECYCLES[id].color } }),
						LIFECYCLES[id].label,
						h('span', { className: 'dt-chip-count' }, String(counts[id] || 0))
					))
				),
				classes.length > 1
					? h('div', { className: 'dt-filter-row' },
						h('button', {
							className: 'dt-fchip' + (filter.cls === 'all' ? ' on' : ''),
							onClick: () => setFilter((prev) => ({ ...prev, cls: 'all' }))
						}, '全部 class'),
						classes.map((cls) => h('button', {
							key: cls,
							className: 'dt-fchip' + (filter.cls === cls ? ' on' : ''),
							onClick: () => setFilter((prev) => ({ ...prev, cls: prev.cls === cls ? 'all' : cls }))
						}, cls))
					)
					: null
			)
		}

		function DocumentTree(props) {
			const { files, raw, expandedGroups, setExpandedGroups, expandedDirs, toggleDir, onOpen, query, setQuery, activeRel, indexMap, indexProgress, recordFilter, setRecordFilter, groupsDef, statusMap } = props
			const [filterOpen, setFilterOpen] = React.useState(false)
			const activeFilterCount = (recordFilter.lifecycle !== 'all' ? 1 : 0) + (recordFilter.cls !== 'all' ? 1 : 0)

			const recordsGroup = React.useMemo(() => groupsDef.find((group) => group.records) || null, [groupsDef])
			const recordFiles = React.useMemo(() => recordsGroup ? files.filter((f) => recordsGroup.match(f.rel)) : [], [files, recordsGroup])
			const recordClasses = React.useMemo(() => {
				const set = new Set()
				for (const f of recordFiles) {
					const lc = lifecycleOf(f.rel)
					if (lc && lc.cls) set.add(lc.cls)
				}
				return [...set].sort()
			}, [recordFiles])
			const groups = React.useMemo(() => {
				const result = groupsDef.map((group) => ({ ...group, files: [] }))
				for (const file of files) {
					let target = null
					for (const group of groupsDef) {
						if (group.id !== 'other' && group.match(file.rel)) {
							target = group
							break
						}
					}
					if (!target) target = groupsDef[groupsDef.length - 1]
					result.find((g) => g.id === target.id).files.push(file)
				}
				for (const group of result) {
					if (group.id !== 'records') continue
					if (recordFilter.lifecycle !== 'all') {
						group.files = group.files.filter((f) => {
							const lc = lifecycleOf(f.rel)
							return lc && lc.lifecycle === recordFilter.lifecycle
						})
					}
					if (recordFilter.cls !== 'all') {
						group.files = group.files.filter((f) => {
							const lc = lifecycleOf(f.rel)
							return lc && lc.cls === recordFilter.cls
						})
					}
				}
				return result.filter((group) => group.files.length > 0)
			}, [files, recordFilter])

			const q = query.trim().toLowerCase()
			const searchResults = React.useMemo(() => {
				if (!q) return []
				return files.filter((f) => f.rel.toLowerCase().includes(q)).slice(0, 100)
			}, [files, q])

			const contentResults = React.useMemo(() => {
				if (q.length < 2 || indexMap === null) return []
				const out = []
				for (const entry of indexMap) {
					const rel = entry[0]
					const text = entry[1]
					const at = text.toLowerCase().indexOf(q)
					if (at < 0) continue
					out.push({ rel, at, text })
					if (out.length >= 100) break
				}
				return out
			}, [q, indexMap])

			if (q) {
				const total = searchResults.length + contentResults.length
				return h(React.Fragment, null,
					h('div', { className: 'dt-list-note' },
						'路径 ' + searchResults.length + ' · 正文 ' + contentResults.length +
						(indexMap === null && indexProgress.total > 0 ? ' · 索引中 ' + indexProgress.done + '/' + indexProgress.total : '')
					),
					total === 0
						? h('div', { className: 'dt-empty' }, indexMap === null ? '正在建立正文索引，稍后再试…' : '没有匹配的文档。')
						: h('div', { className: 'dt-results' },
							searchResults.map((file) => {
								const lc = lifecycleOf(file.rel)
								return h('button', {
									key: 'p:' + file.rel,
									className: 'dt-result',
									title: file.rel,
									onClick: () => onOpen(file.rel)
								},
									h('span', { className: 'dt-result-name' },
										lc ? h('span', { className: 'dt-dot', style: { background: LIFECYCLES[lc.lifecycle].color, marginRight: '5px' } }) : null,
										basename(file.rel)
									),
									h('span', { className: 'dt-result-dir' }, '路径 · ' + (dirname(file.rel) || 'docs/'))
								)
							}),
							contentResults.map((hit) => h('button', {
								key: 'c:' + hit.rel,
								className: 'dt-result',
								title: hit.rel,
								onClick: () => onOpen(hit.rel)
							},
								h('span', { className: 'dt-result-name' }, basename(hit.rel)),
								h('span', { className: 'dt-result-dir' }, '正文 · ' + (dirname(hit.rel) || 'docs/')),
								h('span', { className: 'dt-result-snippet' }, highlightSnippet(hit.text, hit.at, q))
							))
						)
				)
			}

			if (raw) {
				const tree = buildTree(files, '')
				return h(React.Fragment, null, sortedChildren(tree).map((child) => h(TreeRow, {
					key: child.full || child.path,
					node: child,
					depth: 0,
					expandedDirs,
					onToggleDir: toggleDir,
					onOpen,
					activeRel,
					statusMap
				})))
			}

			return h(React.Fragment, null, groups.map((group) => {
				const open = expandedGroups[group.id] !== false
				const tree = buildTree(group.files, group.prefix)
				const roots = sortedChildren(tree)
				return h('div', { className: 'dt-group', key: group.id },
					h('div', { className: 'dt-group-head' },
						h('button', {
							className: 'dt-group-toggle',
							onClick: () => setExpandedGroups((prev) => ({ ...prev, [group.id]: prev[group.id] === false }))
						},
							ICON.chevron(open),
							h('span', null, group.title),
							group.hint ? h('span', { className: 'dt-group-hint' }, group.hint) : null,
							h('span', { className: 'dt-count' },
								group.records && (recordFilter.lifecycle !== 'all' || recordFilter.cls !== 'all')
									? group.files.length + ' / ' + recordFiles.length
									: String(group.files.length)
							)
						),
						group.records
							? h('button', {
								className: 'dt-icon' + (activeFilterCount > 0 || filterOpen ? ' on' : ''),
								title: '筛选记录（lifecycle / class）',
								onClick: (event) => { event.stopPropagation(); setFilterOpen((v) => !v) }
							}, ICON.filter())
							: null
					),
					group.records && filterOpen
						? h('div', { className: 'dt-filter-panel' }, h(RecordFilterBar, {
							filter: recordFilter,
							setFilter: setRecordFilter,
							classes: recordClasses,
							counts: recordFiles.reduce((acc, f) => {
								const lc = lifecycleOf(f.rel)
								if (lc) acc[lc.lifecycle] = (acc[lc.lifecycle] || 0) + 1
								return acc
							}, {})
						}))
						: null,
					open
						? roots.length > 0
							? roots.map((child) => h(TreeRow, {
								key: child.full || child.path,
								node: child,
								depth: 0,
								expandedDirs,
								onToggleDir: toggleDir,
								onOpen,
								activeRel,
								statusMap
							}))
							: h('div', { className: 'dt-empty' }, '（空）')
						: null
				)
			}))
		}
		function Reader(props) {
			const { doc, onBack, onClose, onLink, activeRel, onPin, pinned } = props
			const bodyRef = React.useRef(null)
			const tocRef = React.useRef(null)
			const [outlineOpen, setOutlineOpen] = React.useState(false)
			const headings = React.useMemo(() => parseHeadings(doc.text), [doc.text])
			const lifecycle = lifecycleOf(activeRel)

			React.useEffect(() => {
				if (!outlineOpen) return undefined
				const onDown = (event) => {
					if (tocRef.current && !tocRef.current.contains(event.target)) setOutlineOpen(false)
				}
				window.addEventListener('mousedown', onDown, true)
				return () => window.removeEventListener('mousedown', onDown, true)
			}, [outlineOpen])

			function jump(index) {
				const el = bodyRef.current
				if (!el) return
				const nodes = el.querySelectorAll('h1,h2,h3,h4')
				const target = nodes[index]
				if (target && target.scrollIntoView) target.scrollIntoView({ block: 'start', behavior: 'smooth' })
				setOutlineOpen(false)
			}

			return h('div', { className: 'dt-reader' },
				h('div', { className: 'dt-reader-toolbar' },
					onBack ? h('button', { className: 'dt-icon', title: '返回文档树', onClick: onBack }, ICON.back()) : null,
					h('span', { className: 'dt-reader-title', title: activeRel }, basename(activeRel)),
					lifecycle ? h('span', {
						className: 'dt-chip',
						style: { background: LIFECYCLES[lifecycle.lifecycle].color },
						title: 'records/' + lifecycle.lifecycle + (lifecycle.cls ? '/' + lifecycle.cls : '')
					}, LIFECYCLES[lifecycle.lifecycle].label) : null,
					h('div', { style: { flex: 1 } }),
					onPin
						? h('button', {
							className: 'dt-tool-btn' + (pinned ? ' on' : ''),
							title: pinned ? '取消对照' : '在右侧对照',
							onClick: onPin
						}, ICON.columns(), pinned ? '取消' : '对照')
						: null,
					headings.length > 0
						? h('div', { className: 'dt-toc-wrap', ref: tocRef },
							h('button', {
								className: 'dt-tool-btn' + (outlineOpen ? ' on' : ''),
								title: '大纲',
								onClick: () => setOutlineOpen((v) => !v)
							}, ICON.outline(), '大纲'),
							outlineOpen
								? h('div', { className: 'dt-toc' }, headings.map((heading, index) => h('button', {
									key: index + ':' + heading.text,
									style: { paddingLeft: 8 + (heading.level - 1) * 12 + 'px' },
									onClick: () => jump(index),
									title: heading.text
								}, heading.text)))
								: null
						)
						: null,
					onClose ? h('button', { className: 'dt-icon', title: '关闭文档', onClick: onClose }, ICON.close()) : null
				),
				doc.status ? h('div', { className: 'dt-status', title: doc.status }, 'Status: ' + doc.status) : null,
				h('div', { className: 'dt-reader-scroll', ref: bodyRef },
					h('div', { className: 'dt-md' },
						doc.loading
							? h('div', { className: 'dt-empty' }, '正在读取…')
							: doc.error
								? h('div', { className: 'dt-empty dt-error' }, doc.error)
								: h(MarkdownDelegateProvider, {
									openFile: (path) => onLink(path),
									openExternalLink: (url) => { window.open(url, '_blank', 'noopener,noreferrer') },
									children: h(MarkdownText, { text: doc.text, labels: LABELS, variant: 'body' })
								})
					)
				)
			)
		}
		function DocTreeBody(props) {
			const { sessionId, listDir, readDoc, useProjection } = props
			const cwd = useProjection('workingDirectory')
			const stored = React.useMemo(() => readState(sessionId), [sessionId])
			const [root, setRoot] = React.useState(stored.root || '')
			const [editingRoot, setEditingRoot] = React.useState(false)
			const [rootDraft, setRootDraft] = React.useState(stored.root || '')
			const [phase, setPhase] = React.useState('loading')
			const [error, setError] = React.useState('')
			const [files, setFiles] = React.useState([])
			const [progress, setProgress] = React.useState(0)
			const [reload, setReload] = React.useState(0)
			const [absRoot, setAbsRoot] = React.useState('')
			const [indexMap, setIndexMap] = React.useState(null)
			const [indexProgress, setIndexProgress] = React.useState({ done: 0, total: 0 })
			const [recordFilter, setRecordFilter] = React.useState(stored.recordFilter || { lifecycle: 'all', cls: 'all' })
			const [groupsDef, setGroupsDef] = React.useState(DEFAULT_GROUPS)
			const [statusMap, setStatusMap] = React.useState({})
			const [candidates, setCandidates] = React.useState([])
			const [scanning, setScanning] = React.useState(false)
			const [raw, setRaw] = React.useState(!!stored.raw)
			const [query, setQuery] = React.useState('')
			const [expandedGroups, setExpandedGroups] = React.useState(stored.expandedGroups || { records: false, other: false })
			const [expandedDirs, setExpandedDirs] = React.useState(stored.expandedDirs || {})
			const [activeRel, setActiveRel] = React.useState('')
			const [doc, setDoc] = React.useState(null)
			const [theme, setTheme] = React.useState(stored.theme === 'filesmd' ? 'filesmd' : 'default')
			const [pinnedRel, setPinnedRel] = React.useState('')
			const [pinnedDoc, setPinnedDoc] = React.useState(null)
			const [quickOpen, setQuickOpen] = React.useState(false)
			const [quickQuery, setQuickQuery] = React.useState('')
			const [quickIndex, setQuickIndex] = React.useState(0)
			const [quickMode, setQuickMode] = React.useState('open')
			const pinReqRef = React.useRef(0)
			const [toast, setToast] = useToast()
			const loadIdRef = React.useRef(0)
			const filesRef = React.useRef([])
			const docReqRef = React.useRef(0)
			const readRef = React.useRef(readDoc)
			readRef.current = readDoc
			const rootRef = React.useRef(null)
			const [width, setWidth] = React.useState(0)
			const split = width >= 700
			const pair = split && width >= 700 && !!pinnedRel && !!pinnedDoc
			const pairWide = pair && width >= 1000
			const quickResults = React.useMemo(() => {
				const q = quickQuery.trim().toLowerCase()
				const pool = q
					? files.filter((file) => file.rel.toLowerCase().includes(q) || file.name.toLowerCase().includes(q))
					: files
				return pool.slice(0, 40)
			}, [files, quickQuery])

			React.useEffect(() => {
				const el = rootRef.current
				if (!el || typeof ResizeObserver === 'undefined') return undefined
				const observer = new ResizeObserver((entries) => {
					const entry = entries[0]
					setWidth(entry && entry.contentRect ? entry.contentRect.width : el.clientWidth)
				})
				observer.observe(el)
				setWidth(el.clientWidth)
				return () => observer.disconnect()
			}, [])

			React.useEffect(() => { filesRef.current = files }, [files])

			React.useEffect(() => {
				writeState(sessionId, { root, raw, expandedGroups, expandedDirs, recordFilter, theme })
			}, [sessionId, root, raw, expandedGroups, expandedDirs, recordFilter, theme])

			React.useEffect(() => {
				const controller = new AbortController()
				const loadId = ++loadIdRef.current
				let alive = true
				setPhase('loading')
				setError('')
				setProgress(0)
				setActiveRel('')
				setDoc(null)
				setPinnedRel('')
				setPinnedDoc(null)
				setQuickOpen(false)
				setQuery('')
				;(async () => {
					try {
						const config = await readConfigFile(readRef.current, cwd, root)
						const compiled = compileGroups(config && config.groups) || DEFAULT_GROUPS
						const statuses = config && config.records && config.records.statuses && typeof config.records.statuses === 'object'
							? config.records.statuses
							: {}
						const cfgRoot = config && typeof config.root === 'string' ? normPath(config.root) : ''
						if (!alive || loadId !== loadIdRef.current) return
						setGroupsDef(compiled)
						setStatusMap(statuses)
						let detected = root || cfgRoot
						if (!detected) {
							const discovered = await discoverRoots(listDir, controller.signal, cwd)
							if (!alive || loadId !== loadIdRef.current) return
							setCandidates(discovered)
							detected = discovered.length > 0 ? discovered[0].path : ''
						}
						if (!detected) {
							setPhase('error')
							setError('没有找到 docs 目录。点右上角「扫描」可自动发现候选目录，或手动填写工作区相对路径（如 docs）。')
							return
						}
						if (detected !== root) {
							setRoot(detected)
							writeState(sessionId, { root: detected })
							return
						}
						const found = await walkAll(listDir, detected, controller.signal, (n) => {
							if (alive && loadId === loadIdRef.current) setProgress(n)
						})
						if (!alive || loadId !== loadIdRef.current) return
						setFiles(found)
						setAbsRoot(absPath(cwd, detected, '').replace(/\/+$/, ''))
						setPhase('ready')
					} catch (err) {
						if (!alive || loadId !== loadIdRef.current) return
						setPhase('error')
						setError(errorMessage(err))
					}
				})()
				return () => {
					alive = false
					controller.abort()
				}
			}, [root, sessionId, listDir, reload, cwd])

			React.useEffect(() => {
				if (!absRoot || files.length === 0) {
					setIndexMap(null)
					setIndexProgress({ done: 0, total: 0 })
					return undefined
				}
				let alive = true
				const controller = new AbortController()
				const map = new Map()
				const queue = files.map((f) => f.rel)
				let done = 0
				setIndexMap(null)
				setIndexProgress({ done: 0, total: queue.length })
				const worker = async () => {
					while (alive) {
						const rel = queue.shift()
						if (!rel) return
						try {
							const page = await readRef.current(absRoot + '/' + rel, controller.signal)
							if (alive && page && typeof page.text === 'string') map.set(rel, page.text)
						} catch (error) {
							// unreadable file: leave it out of the text index
						}
						done += 1
						if (alive && (done % 8 === 0 || done === files.length)) {
							setIndexProgress({ done, total: files.length })
						}
					}
				}
				Promise.all([worker(), worker(), worker()]).then(() => {
					if (!alive) return
					setIndexMap(map)
					setIndexProgress({ done: files.length, total: files.length })
				})
				return () => {
					alive = false
					controller.abort()
				}
			}, [files, absRoot])

			function openDoc(rel) {
				const normalized = normalizeRel(rel)
				if (!filesRef.current.some((f) => f.rel === normalized)) {
					setToast('未在文档树中找到：' + normalized)
					return
				}
				setActiveRel(normalized)
				const req = ++docReqRef.current
				setDoc({ text: '', loading: true, error: '', status: '' })
				;(async () => {
					try {
						const page = await readDoc(absRoot ? absRoot + '/' + normalized : absPath(cwd, root, normalized))
						if (req !== docReqRef.current) return
						const text = page && typeof page.text === 'string' ? page.text : ''
						setDoc({ text, loading: false, error: '', status: statusLine(text) })
					} catch (err) {
						if (req !== docReqRef.current) return
						setDoc({ text: '', loading: false, error: errorMessage(err), status: '' })
					}
				})()
			}

			function pinDoc(rel) {
				const normalized = normalizeRel(rel)
				if (!filesRef.current.some((f) => f.rel === normalized)) {
					setToast('未在文档树中找到：' + normalized)
					return
				}
				if (normalized === activeRel) {
					setToast('这篇已在主阅读区')
					return
				}
				setPinnedRel(normalized)
				const req = ++pinReqRef.current
				setPinnedDoc({ text: '', loading: true, error: '', status: '' })
				;(async () => {
					try {
						const page = await readDoc(absRoot ? absRoot + '/' + normalized : absPath(cwd, root, normalized))
						if (req !== pinReqRef.current) return
						const text = page && typeof page.text === 'string' ? page.text : ''
						setPinnedDoc({ text, loading: false, error: '', status: statusLine(text) })
					} catch (err) {
						if (req !== pinReqRef.current) return
						setPinnedDoc({ text: '', loading: false, error: errorMessage(err), status: '' })
					}
				})()
			}

			function unpinDoc() {
				pinReqRef.current += 1
				setPinnedRel('')
				setPinnedDoc(null)
			}

			React.useEffect(() => {
				const onKeyDown = (event) => {
					const mod = event.metaKey || event.ctrlKey
					if (mod && event.key.toLowerCase() === 'k') {
						event.preventDefault()
						setQuickOpen((value) => !value)
						setQuickMode('open')
						setQuickQuery('')
						setQuickIndex(0)
						return
					}
					if (!quickOpen) return
					if (event.key === 'Escape') {
						event.preventDefault()
						setQuickOpen(false)
						return
					}
					if (event.key === 'ArrowDown') {
						event.preventDefault()
						setQuickIndex((index) => Math.min(index + 1, Math.max(quickResults.length - 1, 0)))
						return
					}
					if (event.key === 'ArrowUp') {
						event.preventDefault()
						setQuickIndex((index) => Math.max(index - 1, 0))
						return
					}
					if (event.key === 'Enter') {
						const target = quickResults[quickIndex] || quickResults[0]
						if (!target) return
						event.preventDefault()
						setQuickOpen(false)
						if (quickMode === 'pin') pinDoc(target.rel)
						else openDoc(target.rel)
					}
				}
				window.addEventListener('keydown', onKeyDown)
				return () => window.removeEventListener('keydown', onKeyDown)
			}, [quickOpen, quickResults, quickIndex, quickMode, openDoc])

			function handleLink(path) {
				const target = resolveHref(root, activeRel, path)
				if (!target) return Promise.resolve()
				if (target.external) {
					window.open(target.href, '_blank', 'noopener,noreferrer')
					return Promise.resolve()
				}
				const rel = target.rel
				if (!/\.(md|markdown)$/i.test(rel)) {
					setToast('只支持在文档树内打开 .md：' + rel)
					return Promise.resolve()
				}
				openDoc(rel)
				return Promise.resolve()
			}

			function toggleDir(path) {
				setExpandedDirs((prev) => ({ ...prev, [path]: !prev[path] }))
			}

			function applyRoot() {
				const next = normPath(rootDraft)
				setEditingRoot(false)
				if (!next) {
					setToast('路径不能为空')
					return
				}
				setRoot(next)
				writeState(sessionId, { root: next })
			}

			async function scanRoots() {
				if (scanning) return
				setScanning(true)
				setEditingRoot(true)
				try {
					const found = await discoverRoots(listDir, undefined, cwd)
					const currentRoot = normPath(root)
					const adjusted = found.map((candidate) => candidate.path === currentRoot
						? { ...candidate, score: (candidate.score || 0) + 100, count: filesRef.current.length || candidate.count }
						: candidate)
					adjusted.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
					setCandidates(adjusted)
					if (adjusted.length > 0 && !rootDraft) setRootDraft(adjusted[0].path)
				} catch (error) {
					setToast('扫描失败：' + errorMessage(error))
				} finally {
					setScanning(false)
				}
			}

			const toastEl = toast ? h('div', { className: 'dt-toast' }, toast) : null
			const wrapClass = 'dt-wrap' + (theme === 'filesmd' ? ' dt-filesmd' : '')
			const quickEl = quickOpen
				? h('div', { className: 'dt-quick', onMouseDown: (event) => { if (event.target === event.currentTarget) setQuickOpen(false) } },
					h('div', { className: 'dt-quick-box' },
						h('div', { className: 'dt-quick-input' },
							ICON.command(),
							h('input', {
								autoFocus: true,
								value: quickQuery,
								placeholder: quickMode === 'pin' ? '选择右侧对照文档…' : '快速切换文档…',
								onChange: (event) => { setQuickQuery(event.target.value); setQuickIndex(0) }
							})
						),
						h('div', { className: 'dt-quick-list' },
							quickResults.length === 0
								? h('div', { className: 'dt-quick-empty' }, '没有匹配的文档')
								: quickResults.map((file, index) => h('button', {
									key: file.rel,
									className: 'dt-quick-item' + (index === quickIndex ? ' active' : ''),
									onMouseEnter: () => setQuickIndex(index),
									onClick: () => { setQuickOpen(false); if (quickMode === 'pin') pinDoc(file.rel); else openDoc(file.rel) }
								}, h('span', { className: 'dt-quick-name' }, file.name), h('span', { className: 'dt-quick-dir' }, file.rel)))
						)
					)
				)
				: null

			const headRow = h('div', { className: 'dt-head-row' },
				h('span', { className: 'dt-logo' }, ICON.layers()),
				h('span', { className: 'dt-title' }, '文档树'),
				h('span', {
					className: 'dt-rootpath',
					title: '点击修改文档根目录（自动发现候选）',
					onClick: () => {
						setRootDraft(root)
						if (candidates.length === 0) scanRoots()
						setEditingRoot(true)
					}
				}, root || '未设置'),
				h('div', { className: 'dt-head-actions' },
					h('button', {
						className: 'dt-icon' + (theme === 'filesmd' ? ' on' : ''),
						title: theme === 'filesmd' ? '切回默认风格' : '切换 Files.md 风格',
						onClick: () => setTheme((value) => value === 'filesmd' ? 'default' : 'filesmd')
					}, ICON.palette()),
					h('button', {
						className: 'dt-icon',
						title: '快速切换（Ctrl/Cmd+K）',
						onClick: () => { setQuickMode('open'); setQuickOpen(true); setQuickQuery(''); setQuickIndex(0) }
					}, ICON.command()),
					h('button', {
						className: 'dt-icon' + (scanning ? ' on' : ''),
						title: '扫描文档根目录',
						onClick: scanRoots
					}, ICON.scan()),
					h('button', {
						className: 'dt-icon' + (raw ? ' on' : ''),
						title: raw ? '切换到策展分层' : '切换到原始目录结构',
						onClick: () => setRaw((v) => !v)
					}, ICON.raw()),
					h('button', {
						className: 'dt-icon',
						title: '重新扫描',
						onClick: () => setReload((v) => v + 1)
					}, ICON.refresh())
				)
			)

			const rootEditor = editingRoot
				? h(React.Fragment, null,
					h('div', { className: 'dt-rootedit' },
						h('input', {
							value: rootDraft,
							placeholder: '工作区相对路径，如 docs',
							onChange: (e) => setRootDraft(e.target.value),
							onKeyDown: (e) => { if (e.key === 'Enter') applyRoot() }
						}),
						h('button', { onClick: applyRoot }, '保存')
					),
					h('div', { className: 'dt-candidates' },
						scanning
							? h('div', { className: 'dt-candidates-empty' }, '正在扫描候选目录…')
							: candidates.length === 0
								? h('div', { className: 'dt-candidates-empty' }, '未发现候选，可直接输入路径')
								: candidates.map((candidate) => h('button', {
									key: candidate.path,
									className: 'dt-candidate',
									title: candidate.path,
									onClick: () => setRootDraft(candidate.path)
								},
									h('span', { className: 'dt-candidate-path' }, candidate.path),
									h('span', { className: 'dt-candidate-count' }, candidate.count + ' 篇')
								))
					)
				)
				: null

			const searchRow = h('div', { className: 'dt-search' },
				ICON.search(),
				h('input', {
					value: query,
					placeholder: '搜索路径 · 文件名 · 正文…',
					onChange: (e) => setQuery(e.target.value)
				})
			)

			const header = h('div', { className: 'dt-head' },
				headRow,
				rootEditor,
				(!activeRel || split) ? searchRow : null
			)

			if (phase === 'error') {
				return h('div', { className: wrapClass, ref: rootRef },
					header,
					h('div', { className: 'dt-empty dt-error' }, error || '加载失败'),
					toastEl,
					quickEl
				)
			}

			const indexNote = indexProgress.total > 0 && indexMap === null
				? h('span', null, '索引 ' + indexProgress.done + '/' + indexProgress.total)
				: null

			const listPane = h('div', { className: 'dt-list' },
				h('div', { className: 'dt-list-meta' },
					files.length > 0
						? files.length + ' 篇 Markdown · ' + (raw ? '原始结构' : '策展分层')
						: '正在扫描 ' + (root || 'docs') + '…',
					indexNote
				),
				h('div', { className: 'dt-list-scroll' },
					phase === 'loading'
						? h('div', { className: 'dt-empty' }, '正在扫描 ' + (root || 'docs') + '…' + (progress ? ' 已发现 ' + progress + ' 篇' : ''))
						: h(DocumentTree, {
							files,
							raw,
							expandedGroups,
							setExpandedGroups,
							expandedDirs,
							toggleDir,
							onOpen: openDoc,
							query,
							setQuery,
							activeRel,
							indexMap,
							indexProgress,
							recordFilter,
							setRecordFilter,
							groupsDef,
							statusMap
						})
				)
			)

			const placeholder = h('div', { className: 'dt-placeholder' },
				h('div', { className: 'dt-placeholder-icon' }, ICON.layers()),
				h('div', null, '从左侧文档树选择一篇文档'),
				h('div', { style: { fontSize: 11 } }, '支持正文搜索、记录层筛选与跨文档跳转')
			)

			const primaryReader = activeRel && doc
				? h(Reader, {
					doc,
					activeRel,
					onBack: split ? null : () => { setActiveRel(''); setDoc(null) },
					onClose: () => { setActiveRel(''); setDoc(null) },
					onPin: () => { setQuickMode('pin'); setQuickOpen(true); setQuickQuery(''); setQuickIndex(0) },
					pinned: false,
					onLink: handleLink
				})
				: placeholder
			const pinnedReader = pinnedRel && pinnedDoc
				? h(Reader, {
					doc: pinnedDoc,
					activeRel: pinnedRel,
					onPin: unpinDoc,
					pinned: true,
					onClose: unpinDoc,
					onLink: handleLink
				})
				: null
			const readerPane = h('div', { className: 'dt-reader-pane' + (pair ? ' dt-pair' : '') },
				pair ? h(React.Fragment, null, primaryReader, pinnedReader) : primaryReader
			)

			if (split) {
				return h('div', { className: wrapClass, ref: rootRef },
					header,
					h('div', { className: 'dt-main' }, (pair && !pairWide) ? null : listPane, readerPane),
					toastEl,
					quickEl
				)
			}

			if (activeRel && doc) {
				return h('div', { className: wrapClass, ref: rootRef },
					header,
					h(Reader, {
						doc,
						activeRel,
						onBack: () => { setActiveRel(''); setDoc(null) },
						onLink: handleLink
					}),
					toastEl,
					quickEl
				)
			}

			return h('div', { className: wrapClass, ref: rootRef },
				header,
				h('div', { className: 'dt-main narrow' }, listPane),
				toastEl,
				quickEl
			)
		}
		//#endregion

		//#region registration

		function bindFace(fs, sessionId) {
			return {
				listDir: (path, signal) => fs.list(sessionId, path, signal),
				readDoc: (path, signal) => fs.read(sessionId, path, signal)
			}
		}

		const inject = ['slots', 'sidebarRightTabs', 'remote', 'remote.workspaceFiles']

		function apply(ctx) {
			const fs = createFs(ctx.remote)

			ctx.effect(() => ctx.sidebarRightTabs.register({
				id: ID,
				kind: KIND,
				priority: 'extension',
				keepMounted: true,
				title: () => '文档树',
				guide: [{
					id: 'docs',
					order: 45,
					title: () => '文档树',
					description: () => '按分层浏览 docs/ 与记录层，支持路径搜索与 Markdown 阅读'
				}]
			}), 'doc-tree:type')

			ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
				name: 'sidebar.right.pane.tab',
				key: ID,
				inject: (sessionId) => bindFace(fs, sessionId)
			}, DocTreeBody)), 'doc-tree:body')

			ctx.effect(() => installStyle(), 'doc-tree:css')
		}

		exports.apply = apply
		exports.inject = inject
		return module.exports
	}
})
