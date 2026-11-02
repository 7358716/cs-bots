/**
 * cs-bots /client —— Web 页面层（L3）。
 *
 * ── 契约（官方 + cs-bot-bea 已验证范例）────────────────────────────────────
 *   · 入口 `sidebar.panellist`（list 型）→ 主面板 `main`（**keyed**，key = 入口 id）
 *   · **注册顺序锁死：先 main 后 panellist**（selectPanel 校验 main 存在）
 *   · 设置页**同时**挂到官方 `settings.section`（系统设置里也能找到）
 *   · 单文件、无相对 require；每个 Tab 单独包 ErrorBoundary
 *
 * ── 视觉（2026-11-03 重做，依据实测几何）─────────────────────────────────
 *   · 只用官方 14 个主题令牌；**浅色下 bg-base/layer-1/layer-2 都是 #fff**，
 *     所以表面靠 0.5–1px 边框区分层次，不靠底色
 *   · `brand-primary` 是**单色**（浅黑/深白）→ 主按钮用 bg=brand + color=bg-base 自动反色
 *   · 状态色**只上"点和字"，不上"块"**（禁整块红底/绿进度条）
 *   · 字阶 13/12/11；间距 4·8·12·16·24·32
 */

window.__ModuleLoader__.load({
  id: 'cs-bots',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const PANEL_ID = 'cs-bots'
    const API = '/cs-bots/api'

    // ── 请求 ────────────────────────────────────────────────────────────────

    async function call(path, options) {
      const hasBody = options?.body !== undefined
      const res = await fetch(API + path, {
        headers: { accept: 'application/json', ...(hasBody ? { 'content-type': 'application/json' } : {}) },
        cache: 'no-store',
        ...options,
        ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
      })
      let data
      try {
        data = await res.json()
      } catch {
        throw new Error(`接口返回非 JSON（HTTP ${res.status}）`)
      }
      if (!data || data.ok === false) throw new Error(data?.reason ?? data?.message ?? `HTTP ${res.status}`)
      return data
    }

    // ── 样式 ────────────────────────────────────────────────────────────────

    const CSS = `
.csb{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;
  color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}
.csb-head{flex:none;padding:16px 24px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.csb-hrow{display:flex;align-items:baseline;gap:10px;margin-bottom:14px}
.csb-hrow h2{margin:0;font-size:16px;font-weight:600;letter-spacing:-.01em}
.csb-hint{color:var(--dsw-alias-label-secondary);font-size:12px;margin-left:auto}
.csb-tabs{display:flex;gap:2px}
.csb-tab{position:relative;padding:9px 13px;border:0;background:transparent;cursor:pointer;
  color:var(--dsw-alias-label-secondary);font-size:13px;font-family:inherit;
  border-radius:8px 8px 0 0;transition:color .12s,background .12s}
.csb-tab:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.csb-tab-on{color:var(--dsw-alias-label-primary);font-weight:500}
.csb-tab-on::after{content:"";position:absolute;left:9px;right:9px;bottom:-1px;height:2px;
  background:var(--dsw-alias-brand-primary);border-radius:2px 2px 0 0}
.csb-body{flex:1;overflow-y:auto;padding:20px 24px 48px;min-height:0}
.csb-wrap{max-width:880px;margin:0 auto}

.csb-bar{display:flex;gap:8px;align-items:center;margin-bottom:16px;flex-wrap:wrap}
.csb-spacer{flex:1}

.csb-in,.csb-sel,.csb-ta{box-sizing:border-box;height:32px;padding:0 10px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
  color:inherit;font-size:13px;font-family:inherit;outline:none;transition:border-color .12s}
.csb-in::placeholder,.csb-ta::placeholder{color:var(--dsw-alias-label-secondary)}
.csb-in:focus,.csb-sel:focus,.csb-ta:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.csb-ta{height:auto;min-height:72px;padding:8px 10px;resize:vertical;line-height:1.6}
.csb-grow{flex:1;min-width:140px}

.csb-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:32px;padding:0 13px;
  border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);font-size:12.5px;font-family:inherit;cursor:pointer;
  white-space:nowrap;transition:background .12s,opacity .12s}
.csb-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.csb-btn:disabled{opacity:.4;cursor:not-allowed}
.csb-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.csb-btn-p{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);border-color:transparent;font-weight:500}
.csb-btn-p:hover{background:var(--dsw-alias-brand-primary);filter:brightness(1.12)}
.csb-btn-d{color:var(--dsw-alias-state-error-primary);
  border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent)}
.csb-btn-d:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}
.csb-btn-s{height:28px;padding:0 10px;font-size:12px}

.csb-list{display:flex;flex-direction:column;gap:8px}
.csb-card{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:12px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);transition:border-color .12s}
.csb-card:hover{border-color:var(--dsw-alias-border-l2)}
.csb-card-c{cursor:pointer}
.csb-card-c:hover{background:var(--dsw-alias-bg-layer-2)}
.csb-card-on{border-color:var(--dsw-alias-brand-primary)}
.csb-card-main{flex:1;min-width:0}
.csb-card-t{font-weight:500;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.csb-card-t2{font-weight:500;line-height:1.5;white-space:normal;word-break:break-word}
.csb-card-m{display:flex;align-items:center;gap:7px;flex-wrap:wrap;
  color:var(--dsw-alias-label-secondary);font-size:11.5px;margin-top:4px}
.csb-mono{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px}

.csb-b{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:5px;
  font-size:11px;font-weight:500;border:1px solid var(--dsw-alias-border-l2);
  color:var(--dsw-alias-label-secondary);white-space:nowrap}
.csb-b-run{color:var(--dsw-alias-state-warn-primary);
  border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 38%,transparent)}
.csb-b-ok{color:var(--dsw-alias-state-success-primary);
  border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 38%,transparent)}
.csb-b-err{color:var(--dsw-alias-state-error-primary);
  border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 38%,transparent)}
.csb-b-idle{color:var(--dsw-alias-state-idle-primary)}

.csb-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}
.csb-dot-ok{background:var(--dsw-alias-state-success-primary)}
.csb-dot-err{background:var(--dsw-alias-state-error-primary)}
.csb-dot-run{background:var(--dsw-alias-state-warn-primary)}

.csb-err{padding:10px 12px;border-radius:10px;font-size:12.5px;margin-bottom:14px;line-height:1.6;
  color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-1);
  border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent)}
.csb-note{padding:9px 12px;border-radius:10px;font-size:12.5px;margin-bottom:14px;line-height:1.6;
  color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base);
  border:1px solid var(--dsw-alias-border-l1)}
.csb-ok{padding:9px 12px;border-radius:10px;font-size:12.5px;margin-bottom:14px;
  color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-bg-layer-1);
  border:1px solid color-mix(in srgb,var(--dsw-alias-state-success-primary) 40%,transparent)}

.csb-empty{display:flex;flex-direction:column;align-items:center;gap:9px;padding:52px 16px;text-align:center}
.csb-empty-i{font-size:24px;opacity:.32;line-height:1}
.csb-empty-t{font-size:13px;color:var(--dsw-alias-label-secondary)}
.csb-empty-h{font-size:11.5px;color:var(--dsw-alias-label-secondary);max-width:380px;line-height:1.7}
.csb-sk{height:56px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);
  background:linear-gradient(90deg,var(--dsw-alias-bg-layer-1) 25%,var(--dsw-alias-bg-layer-2) 37%,var(--dsw-alias-bg-layer-1) 63%);
  background-size:400% 100%;animation:csb-sk 1.3s ease-in-out infinite;margin-bottom:8px}
@keyframes csb-sk{0%{background-position:100% 0}100%{background-position:0 0}}

.csb-mask{position:fixed;inset:0;z-index:60;display:flex;justify-content:flex-end;
  background:color-mix(in srgb,#000 32%,transparent)}
.csb-drawer{width:min(620px,100vw);height:100%;display:flex;flex-direction:column;
  background:var(--dsw-alias-bg-layer-2);border-left:1px solid var(--dsw-alias-border-l1)}
.csb-dhead{flex:none;display:flex;align-items:center;gap:10px;padding:16px 20px;
  border-bottom:1px solid var(--dsw-alias-border-l1)}
.csb-dhead h3{margin:0;font-size:14px;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.csb-dbody{flex:1;overflow-y:auto;padding:18px 20px 32px;min-height:0}

.csb-kv{display:grid;grid-template-columns:110px 1fr;gap:8px 14px;font-size:12.5px;margin-bottom:16px}
.csb-k{color:var(--dsw-alias-label-secondary)}
.csb-v{word-break:break-word;font-variant-numeric:tabular-nums}
.csb-pre{white-space:pre-wrap;word-break:break-word;
  font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);font-size:11.5px;line-height:1.65;
  background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;
  padding:11px 13px;max-height:360px;overflow:auto;margin:0}

.csb-sec{margin:26px 0 4px}
.csb-sec h4{margin:0;font-size:14px;font-weight:600;line-height:1.4}
.csb-sec p{margin:4px 0 0;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary)}

.csb-set{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:24px;align-items:start;
  padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}
.csb-set:last-of-type{border-bottom:0}
.csb-set-l label{display:block;font-size:13px;line-height:1.45;margin-bottom:4px}
.csb-set-d{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.csb-set-c{display:flex;align-items:center;gap:8px;justify-self:end;padding-top:2px}
.csb-set-c .csb-in{width:112px;text-align:right;font-variant-numeric:tabular-nums;padding-right:34px}
.csb-num{position:relative;display:inline-flex;align-items:center}
.csb-unit{position:absolute;right:10px;font-size:11.5px;color:var(--dsw-alias-label-secondary);pointer-events:none}
.csb-step{width:28px;height:32px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;
  font-size:14px;line-height:1;font-family:inherit}
.csb-step:hover{background:var(--dsw-alias-bg-layer-2)}

.csb-sw{position:relative;width:36px;height:20px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-1);cursor:pointer;transition:background .15s;flex:none}
.csb-sw::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;
  background:var(--dsw-alias-label-secondary);transition:transform .15s,background .15s}
.csb-sw-on{background:var(--dsw-alias-brand-primary);border-color:transparent}
.csb-sw-on::after{transform:translateX(16px);background:var(--dsw-alias-bg-base)}
.csb-sw-t{font-size:11.5px;color:var(--dsw-alias-label-secondary);min-width:16px}

.csb-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:12px;margin-bottom:6px}
.csb-stat{padding:12px 14px;border-radius:16px;border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-1)}
.csb-stat-n{font-size:20px;font-weight:600;line-height:1.3;font-variant-numeric:tabular-nums}
.csb-stat-l{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:2px}

.csb-fold{border:1px solid var(--dsw-alias-border-l1);border-radius:16px;padding:14px 16px;
  background:var(--dsw-alias-bg-base);margin-top:12px}
.csb-diag{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.csb-diag-t{font-size:12px;color:var(--dsw-alias-label-secondary)}
.csb-dots{display:flex;gap:4px;flex-wrap:wrap;max-width:100%}
.csb-cap{display:grid;grid-template-columns:repeat(auto-fill,minmax(186px,1fr));gap:6px 16px;margin-top:12px}
.csb-cap-i{display:flex;align-items:center;gap:7px;font-size:11.5px;
  color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.csb-msg{padding:9px 12px;border-radius:10px;margin-bottom:6px;background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l1)}
.csb-msg-me{background:var(--dsw-alias-bg-layer-2)}
.csb-msg-h{display:flex;align-items:center;gap:7px;margin-bottom:3px;font-size:11px;
  color:var(--dsw-alias-label-secondary)}
.csb-msg-b{font-size:12.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word}

.csb-tags{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}
.csb-tag{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;border-radius:6px;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);font-size:11.5px}
.csb-tag button{border:0;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary);
  font-size:13px;line-height:1;padding:0;font-family:inherit}
.csb-tag button:hover{color:var(--dsw-alias-state-error-primary)}

.csb-fld{margin-bottom:14px}
.csb-fld > label{display:block;font-size:12px;font-weight:500;margin-bottom:5px}
.csb-fld .csb-set-d{margin-top:5px}
`

    function installStyles() {
      try {
        const s = typeof window !== 'undefined' ? window.__DSH_STYLES__ : undefined
        if (s?.insert) return s.insert(CSS)
      } catch {}
      try {
        const id = 'cs-bots/styles'
        if (document.querySelector(`style[data-plugin-css="${id}"]`)) return () => {}
        const el = document.createElement('style')
        el.dataset.plugin = 'cs-bots'
        el.dataset.pluginCss = id
        el.textContent = CSS
        document.head.appendChild(el)
        return () => el.remove()
      } catch {
        return () => {}
      }
    }

    // ── 基建 ────────────────────────────────────────────────────────────────

    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error }
      }
      componentDidCatch(error) {
        try {
          console.warn('[cs-bots] tab crashed:', this.props.tab, error)
        } catch {}
      }
      render() {
        if (this.state.error) {
          return h(
            'div',
            { className: 'csb-err' },
            `「${this.props.tab}」渲染出错：${String(this.state.error.message || this.state.error)}`,
            h('button', { className: 'csb-btn csb-btn-s', style: { marginLeft: 10 }, onClick: () => this.setState({ error: null }) }, '重试'),
          )
        }
        return this.props.children
      }
    }

    function useApi(path, deps) {
      const [state, setState] = useState({ loading: true, data: null, error: null })
      const reload = useCallback(() => {
        let alive = true
        setState((s) => ({ ...s, loading: true, error: null }))
        call(path)
          .then((d) => alive && setState({ loading: false, data: d, error: null }))
          .catch((e) => alive && setState({ loading: false, data: null, error: e.message }))
        return () => {
          alive = false
        }
      }, [path])
      useEffect(() => reload(), [reload, ...(deps ?? [])])
      return { ...state, reload }
    }

    function Skeleton({ n }) {
      return h('div', null, Array.from({ length: n ?? 3 }, (_, i) => h('div', { key: i, className: 'csb-sk' })))
    }

    function Empty({ icon, title, hint }) {
      return h('div', { className: 'csb-empty' },
        icon ? h('div', { className: 'csb-empty-i' }, icon) : null,
        h('div', { className: 'csb-empty-t' }, title),
        hint ? h('div', { className: 'csb-empty-h' }, hint) : null)
    }

    function Section({ title, desc }) {
      return h('div', { className: 'csb-sec' }, h('h4', null, title), desc ? h('p', null, desc) : null)
    }

    const ST_TEXT = {
      pending: '待办', in_progress: '进行中', completed: '已完成', blocked: '已终止', deleted: '已删除',
      idle: '空闲', running: '运行中', parked: '已挂起', failed: '失败', retired: '已退役',
    }
    const ST_CLS = {
      in_progress: 'csb-b csb-b-run', completed: 'csb-b csb-b-ok',
      blocked: 'csb-b csb-b-err', deleted: 'csb-b csb-b-err', failed: 'csb-b csb-b-err', retired: 'csb-b csb-b-err',
      parked: 'csb-b csb-b-idle', running: 'csb-b csb-b-run',
    }
    const DOT_CLS = {
      in_progress: 'csb-dot csb-dot-run', running: 'csb-dot csb-dot-run',
      completed: 'csb-dot csb-dot-ok', idle: 'csb-dot csb-dot-ok',
      blocked: 'csb-dot csb-dot-err', deleted: 'csb-dot csb-dot-err',
      failed: 'csb-dot csb-dot-err', retired: 'csb-dot csb-dot-err',
    }
    const Badge = ({ status, children }) =>
      h('span', { className: ST_CLS[status] ?? 'csb-b' }, children ?? ST_TEXT[status] ?? status)
    const Dot = ({ status }) => h('span', { className: DOT_CLS[status] ?? 'csb-dot' })

    const Switch = ({ checked, onChange }) =>
      h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked === true,
        className: `csb-sw${checked ? ' csb-sw-on' : ''}`,
        onClick: () => onChange(!checked),
      })

    const fmt = (v) => {
      if (!v) return '—'
      try {
        return new Date(v).toLocaleString('zh-CN', { hour12: false })
      } catch {
        return String(v)
      }
    }
    const short = (s, n) => (typeof s === 'string' && s.length > (n ?? 14) ? `${s.slice(0, n ?? 14)}…` : String(s ?? '—'))

    function Drawer({ title, onClose, children }) {
      useEffect(() => {
        const k = (e) => e.key === 'Escape' && onClose()
        window.addEventListener('keydown', k)
        return () => window.removeEventListener('keydown', k)
      }, [onClose])
      return h('div', { className: 'csb-mask', onClick: (e) => e.target === e.currentTarget && onClose() },
        h('div', { className: 'csb-drawer' },
          h('div', { className: 'csb-dhead' },
            h('h3', null, title),
            h('button', { className: 'csb-btn csb-btn-s', onClick: onClose }, '关闭')),
          h('div', { className: 'csb-dbody' }, children)))
    }

    // ── 任务 ────────────────────────────────────────────────────────────────

    function TaskDrawer({ id, bots, onClose, onChange }) {
      const { data, loading, error, reload } = useApi(`/tasks/detail?id=${encodeURIComponent(id)}`, [id])
      const [err, setErr] = useState(null)
      const task = data?.task
      const history = data?.history ?? []
      const act = async (fn, label) => {
        setErr(null)
        try {
          await fn()
          reload()
          onChange?.()
        } catch (e) {
          setErr(`${label}失败：${e.message}`)
        }
      }
      const upd = (action, extra) =>
        call('/tasks/update', { method: 'POST', body: { id: task.id, expectedRev: task.rev, action, ...(extra ?? {}) } })

      return h(Drawer, { title: task?.subject ?? id, onClose },
        loading ? h(Skeleton, { n: 2 }) : null,
        error ? h('div', { className: 'csb-err' }, error) : null,
        err ? h('div', { className: 'csb-err' }, err) : null,
        task ? h('div', null,
          h('div', { className: 'csb-kv' },
            h('span', { className: 'csb-k' }, '状态'), h('span', { className: 'csb-v' }, h(Badge, { status: task.status })),
            h('span', { className: 'csb-k' }, 'ID'), h('span', { className: 'csb-v csb-mono' }, task.id),
            h('span', { className: 'csb-k' }, '版本'), h('span', { className: 'csb-v' }, `rev ${task.rev}`),
            h('span', { className: 'csb-k' }, '负责人'), h('span', { className: 'csb-v csb-mono' }, task.ownerId ?? '—'),
            h('span', { className: 'csb-k' }, '租约至'), h('span', { className: 'csb-v' }, task.lease ? fmt(task.lease.expiresAt) : '—'),
            h('span', { className: 'csb-k' }, '依赖'), h('span', { className: 'csb-v' }, (task.blockedBy ?? []).join(', ') || '—'),
            h('span', { className: 'csb-k' }, '交付物'), h('span', { className: 'csb-v' }, (task.artifacts ?? []).join(', ') || '—'),
            h('span', { className: 'csb-k' }, '验收'), h('span', { className: 'csb-v' }, task.acceptance ? `${task.acceptance.result} · ${task.acceptance.by}` : '—'),
            task.blockedReason ? h('span', { className: 'csb-k' }, '终止原因') : null,
            task.blockedReason ? h('span', { className: 'csb-v' }, task.blockedReason) : null),
          task.description ? h('div', { className: 'csb-pre', style: { marginBottom: 4 } }, task.description) : null,
          h(Section, { title: '管理动作', desc: '指派会给目标会话发一条唤醒消息；终止会置为已终止并留原因。' }),
          h('div', { className: 'csb-bar', style: { marginTop: 10 } },
            h('select', {
              className: 'csb-sel',
              style: { width: 196 },
              value: '',
              onChange: (e) => {
                const ownerId = e.target.value
                if (!ownerId) return
                act(() => call('/tasks/assign', { method: 'POST', body: { id: task.id, expectedRev: task.rev, ownerId } }), '指派')
                e.target.value = ''
              },
            },
              h('option', { value: '' }, '指派给…'),
              (bots ?? []).filter((b) => b.state !== 'retired').map((b) =>
                h('option', { key: b.id, value: b.sessionId }, `${b.name} · ${ST_TEXT[b.state] ?? b.state}`))),
            task.status === 'in_progress' ? h('button', { className: 'csb-btn', onClick: () => act(() => upd('heartbeat'), '续租') }, '续租') : null,
            task.status === 'in_progress'
              ? h('button', {
                  className: 'csb-btn csb-btn-p',
                  onClick: () => {
                    const raw = window.prompt('交付物路径（逗号分隔，必填）')
                    if (raw === null) return
                    const list = raw.split(',').map((s) => s.trim()).filter(Boolean)
                    if (!list.length) return setErr('交付物不能为空 —— 完成必须留证据')
                    act(() => upd('complete', { artifacts: list }), '完成')
                  },
                }, '完成')
              : null,
            task.status === 'completed'
              ? h('button', { className: 'csb-btn csb-btn-p', onClick: () => act(() => call('/tasks/accept', { method: 'POST', body: { id: task.id, result: 'pass' } }), '验收') }, '验收通过')
              : null,
            task.status === 'blocked' ? h('button', { className: 'csb-btn', onClick: () => act(() => upd('reopen'), '重开') }, '重开') : null,
            h('button', {
              className: 'csb-btn',
              onClick: () => {
                const s = window.prompt('新标题', task.subject)
                if (s && s.trim()) act(() => call('/tasks/edit', { method: 'POST', body: { id: task.id, expectedRev: task.rev, subject: s.trim() } }), '改标题')
              },
            }, '改标题'),
            task.status !== 'blocked' && task.status !== 'deleted'
              ? h('button', {
                  className: 'csb-btn csb-btn-d',
                  onClick: () => {
                    const r = window.prompt('终止原因', '需求取消')
                    if (r === null) return
                    act(() => call('/tasks/abort', { method: 'POST', body: { id: task.id, expectedRev: task.rev, reason: r } }), '终止')
                  },
                }, '终止')
              : null),
          h(Section, { title: '审计流', desc: `${history.length} 条事件，最新在前` }),
          history.length === 0
            ? h(Empty, { title: '没有审计记录' })
            : h('div', { className: 'csb-list', style: { marginTop: 10 } },
                history.slice(-40).reverse().map((ev, i) =>
                  h('div', { key: i, className: 'csb-card', style: { padding: '9px 12px' } },
                    h('div', { className: 'csb-card-main' },
                      h('div', { style: { fontSize: 12.5 } }, `${ev.action ?? '?'} · rev ${ev.rev ?? '?'}`),
                      h('div', { className: 'csb-card-m' }, `${ev.byId ?? '?'} · ${fmt(ev.at)}`)))))
        ) : null)
    }

    function TasksTab() {
      const [filter, setFilter] = useState('')
      const [subject, setSubject] = useState('')
      const [openId, setOpenId] = useState(null)
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState(null)
      const { data, loading, error, reload } = useApi(`/tasks${filter ? `?status=${filter}` : ''}`, [filter])
      const { data: rosterData } = useApi('/roster')
      const bots = rosterData?.bots ?? []
      const tasks = data?.tasks ?? []

      const create = async () => {
        const s = subject.trim()
        if (!s) return
        setBusy(true)
        setErr(null)
        try {
          await call('/tasks', { method: 'POST', body: { subject: s } })
          setSubject('')
          reload()
        } catch (e) {
          setErr(e.message)
        } finally {
          setBusy(false)
        }
      }
      const quick = async (t, action, extra) => {
        setBusy(true)
        setErr(null)
        try {
          await call('/tasks/update', { method: 'POST', body: { id: t.id, expectedRev: t.rev, action, ...(extra ?? {}) } })
          reload()
        } catch (e) {
          setErr(e.message)
        } finally {
          setBusy(false)
        }
      }

      return h('div', { className: 'csb-wrap' },
        h('div', { className: 'csb-bar' },
          h('input', {
            className: 'csb-in csb-grow',
            placeholder: '新建任务…（回车创建）',
            value: subject,
            onChange: (e) => setSubject(e.target.value),
            onKeyDown: (e) => e.key === 'Enter' && create(),
          }),
          h('button', { className: 'csb-btn csb-btn-p', disabled: busy || !subject.trim(), onClick: create }, '新建'),
          h('select', { className: 'csb-sel', style: { width: 108 }, value: filter, onChange: (e) => setFilter(e.target.value) },
            h('option', { value: '' }, '全部状态'),
            h('option', { value: 'pending' }, '待办'),
            h('option', { value: 'in_progress' }, '进行中'),
            h('option', { value: 'completed' }, '已完成'),
            h('option', { value: 'blocked' }, '已终止'))),
        err ? h('div', { className: 'csb-err' }, err) : null,
        error ? h('div', { className: 'csb-err' }, error) : null,
        loading ? h(Skeleton, { n: 3 }) : null,
        !loading && !error && tasks.length === 0
          ? h(Empty, { icon: '◫', title: '还没有任务', hint: '任务板是跨会话共享的：任何会话、任何 Bot 都看到同一块板。任务必须带交付物才能完成。' })
          : null,
        h('div', { className: 'csb-list' }, tasks.map((t) =>
          h('div', { key: t.id, className: 'csb-card csb-card-c', onClick: () => setOpenId(t.id) },
            h(Dot, { status: t.status }),
            h('div', { className: 'csb-card-main' },
              h('div', { className: 'csb-card-t' }, t.subject),
              h('div', { className: 'csb-card-m' },
                h(Badge, { status: t.status }),
                h('span', { className: 'csb-mono' }, t.id),
                h('span', null, `rev ${t.rev}`),
                t.ownerId ? h('span', null, `· ${short(t.ownerId, 12)}`) : null,
                (t.blockedBy ?? []).length ? h('span', null, `· 依赖 ${t.blockedBy.length}`) : null)),
            h('div', { style: { display: 'flex', gap: 6, flex: 'none' }, onClick: (e) => e.stopPropagation() },
              t.status === 'pending' ? h('button', { className: 'csb-btn csb-btn-s', disabled: busy, onClick: () => quick(t, 'claim') }, '领取') : null,
              t.status === 'in_progress'
                ? h('button', {
                    className: 'csb-btn csb-btn-s csb-btn-p',
                    disabled: busy,
                    onClick: () => {
                      const raw = window.prompt('交付物路径（逗号分隔，必填）')
                      if (raw === null) return
                      const list = raw.split(',').map((s) => s.trim()).filter(Boolean)
                      if (!list.length) return setErr('交付物不能为空')
                      quick(t, 'complete', { artifacts: list })
                    },
                  }, '完成')
                : null,
              t.status === 'completed'
                ? h('button', { className: 'csb-btn csb-btn-s', disabled: busy, onClick: () => call('/tasks/accept', { method: 'POST', body: { id: t.id, result: 'pass' } }).then(reload).catch((e) => setErr(e.message)) }, '验收')
                : null)))),
        openId ? h(TaskDrawer, { id: openId, bots, onClose: () => setOpenId(null), onChange: reload }) : null)
    }

    // ── Bot：含档案（身份/经验/技能/预制记忆）────────────────────────────────

    function BotProfileDrawer({ bot, onClose, onChange }) {
      const { data, loading, error, reload } = useApi(`/roster/profile?id=${encodeURIComponent(bot.id)}`, [bot.id, bot.rev])
      const [draft, setDraft] = useState(null)
      const [msg, setMsg] = useState(null)
      const [err, setErr] = useState(null)
      const [busy, setBusy] = useState(false)
      const [skillInput, setSkillInput] = useState('')
      const [memInput, setMemInput] = useState('')

      useEffect(() => {
        if (data && draft === null) {
          const p = data.profile ?? {}
          setDraft({
            identity: p.identity ?? '',
            experience: p.experience ?? '',
            skills: Array.isArray(p.skills) ? [...p.skills] : [],
            memory: Array.isArray(p.memory) ? [...p.memory] : [],
          })
        }
      }, [data, draft])

      const save = async () => {
        setBusy(true)
        setErr(null)
        setMsg(null)
        try {
          const res = await call('/roster/profile', {
            method: 'POST',
            body: { id: bot.id, expectedRev: data?.bot?.rev ?? bot.rev, profile: draft },
          })
          setMsg(`已写入 AGENTS.md${res.memory ? `，同步 ${res.memory.added} 条预制记忆` : ''}`)
          reload()
          onChange?.()
        } catch (e) {
          setErr(e.message)
        } finally {
          setBusy(false)
        }
      }

      const addSkill = () => {
        const n = skillInput.trim()
        if (!n) return
        if (draft.skills.includes(n)) return setErr('该技能已存在')
        setErr(null)
        setDraft({ ...draft, skills: [...draft.skills, n] })
        setSkillInput('')
      }
      const addMem = () => {
        const n = memInput.trim()
        if (!n) return
        setErr(null)
        setDraft({ ...draft, memory: [...draft.memory, n] })
        setMemInput('')
      }

      return h(Drawer, { title: `档案 · ${bot.name}`, onClose },
        loading ? h(Skeleton, { n: 2 }) : null,
        error ? h('div', { className: 'csb-err' }, error) : null,
        msg ? h('div', { className: 'csb-ok' }, msg) : null,
        err ? h('div', { className: 'csb-err' }, err) : null,
        data ? h('div', null,
          h('div', { className: 'csb-kv' },
            h('span', { className: 'csb-k' }, '工作目录'), h('span', { className: 'csb-v csb-mono' }, bot.cwd),
            h('span', { className: 'csb-k' }, '预设'), h('span', { className: 'csb-v' }, bot.preset ?? '默认（宿主 standard）'),
            h('span', { className: 'csb-k' }, '会话'), h('span', { className: 'csb-v csb-mono' }, bot.sessionId),
            h('span', { className: 'csb-k' }, '档案文件'), h('span', { className: 'csb-v csb-mono' }, data.profilePath ?? '—'),
            data.hasOutside ? h('span', { className: 'csb-k' }, '注意') : null,
            data.hasOutside ? h('span', { className: 'csb-v' }, 'AGENTS.md 里还有你手写的内容，保存不会覆盖它') : null),

          h(Section, { title: '身份', desc: '决定"它是谁"。写入 Bot 工作目录下 AGENTS.md 的托管段，官方的 agent-instructions 会在会话首次请求前自动加载。' }),
          draft ? h('div', { style: { marginTop: 10 } },
            h('textarea', {
              className: 'csb-ta',
              placeholder: '例如：你是本项目的后端工程师，负责 API 设计、数据模型与迁移；对 SQL 性能负责；不确定时先给方案再动手。',
              value: draft.identity,
              onChange: (e) => setDraft({ ...draft, identity: e.target.value }),
            }),
            h('div', { className: 'csb-set-d', style: { marginTop: 5 } }, `${draft.identity.length} / 4000 字符`)) : null,

          draft ? h('div', null,
            h(Section, { title: '经验与规矩', desc: '决定"怎么做"。踩过的坑、约定俗成的做法、禁止事项都写这里 —— 它会每轮都在上下文里。' }),
            h('textarea', {
              className: 'csb-ta',
              style: { marginTop: 10, minHeight: 96 },
              placeholder: '例如：改 schema 必须先写迁移；禁止直接 force push；测试必须跑 bash test/run-all.sh 全绿才算完成。',
              value: draft.experience,
              onChange: (e) => setDraft({ ...draft, experience: e.target.value }),
            }),
            h('div', { className: 'csb-set-d', style: { marginTop: 5 } }, `${draft.experience.length} / 8000 字符`),

            h(Section, { title: '技能', desc: '技能文件写到 <工作目录>/.agents/skills/<名>/SKILL.md，宿主按项目根自动发现 —— 只对这个 Bot 可见。' }),
            h('div', { className: 'csb-tags', style: { marginTop: 10 } },
              draft.skills.length === 0 ? h('span', { className: 'csb-set-d' }, '（还没有技能）') : null,
              draft.skills.map((s) =>
                h('span', { key: s, className: 'csb-tag' }, s,
                  h('button', { onClick: () => setDraft({ ...draft, skills: draft.skills.filter((x) => x !== s) }) }, '×')))),
            h('div', { className: 'csb-bar' },
              h('input', {
                className: 'csb-in csb-grow',
                placeholder: '技能名（字母数字 . _ -）',
                value: skillInput,
                onChange: (e) => setSkillInput(e.target.value),
                onKeyDown: (e) => e.key === 'Enter' && addSkill(),
              }),
              h('button', { className: 'csb-btn', onClick: addSkill }, '添加')),

            h(Section, { title: '预制记忆', desc: '这个 Bot 一开始就该知道的事实。会写进 AGENTS.md，同时存进记忆服务（带 botId，可检索可审计）。' }),
            h('div', { className: 'csb-tags', style: { marginTop: 10 } },
              draft.memory.length === 0 ? h('span', { className: 'csb-set-d' }, '（还没有预制记忆）') : null,
              draft.memory.map((m, i) =>
                h('span', { key: i, className: 'csb-tag', style: { height: 'auto', padding: '4px 9px', whiteSpace: 'normal' } },
                  m.length > 60 ? `${m.slice(0, 60)}…` : m,
                  h('button', { onClick: () => setDraft({ ...draft, memory: draft.memory.filter((_, j) => j !== i) }) }, '×')))),
            h('div', { className: 'csb-bar' },
              h('input', {
                className: 'csb-in csb-grow',
                placeholder: '例如：生产库只读，任何写操作必须走审批',
                value: memInput,
                onChange: (e) => setMemInput(e.target.value),
                onKeyDown: (e) => e.key === 'Enter' && addMem(),
              }),
              h('button', { className: 'csb-btn', onClick: addMem }, '添加')),

            h('div', { className: 'csb-bar', style: { marginTop: 20 } },
              h('button', { className: 'csb-btn csb-btn-p', disabled: busy, onClick: save }, busy ? '保存中…' : '保存档案'),
              h('button', { className: 'csb-btn', onClick: () => setDraft(null) }, '重新载入')),

            data.managedText
              ? h('div', null,
                  h(Section, { title: '当前 AGENTS.md 托管段', desc: '这就是 Bot 实际会读到的内容' }),
                  h('div', { className: 'csb-pre', style: { marginTop: 10 } }, data.managedText))
              : null)
          : null)
        : null)
    }

    function BotsTab() {
      const { data, loading, error, reload } = useApi('/roster?includeRetired=1')
      const { data: presetData } = useApi('/presets')
      const [form, setForm] = useState({ name: '', cwd: '', preset: '' })
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState(null)
      const [note, setNote] = useState(null)
      const [profileFor, setProfileFor] = useState(null)

      const presets = presetData?.presets ?? []
      const defaultPreset = presetData?.defaultId ?? ''
      const bots = data?.bots ?? []

      const uiWorkspace = (() => {
        try {
          return window.__DSH_CTX__?.get?.('uiWorkspace')
        } catch {
          return undefined
        }
      })()

      const pickDir = async () => {
        try {
          const picked = await uiWorkspace?.pickDirectory?.()
          if (picked) setForm((f) => ({ ...f, cwd: picked }))
          else setNote('目录选择器不可用或被取消 —— 可直接输入绝对路径')
        } catch (e) {
          setNote(`目录选择器不可用：${e.message}（可手动输入绝对路径）`)
        }
      }

      const create = async () => {
        if (!form.name.trim() || !form.cwd.trim()) return setErr('名字与工作目录都必填')
        setBusy(true)
        setErr(null)
        setNote(null)
        try {
          await call('/roster', {
            method: 'POST',
            body: { name: form.name.trim(), cwd: form.cwd.trim(), ...(form.preset ? { preset: form.preset } : {}) },
          })
          setForm({ name: '', cwd: '', preset: '' })
          reload()
        } catch (e) {
          setErr(e.message)
        } finally {
          setBusy(false)
        }
      }

      const manage = async (bot, action, extra) => {
        setErr(null)
        try {
          await call('/roster/manage', { method: 'POST', body: { id: bot.id, action, expectedRev: bot.rev, ...(extra ?? {}) } })
          reload()
        } catch (e) {
          setErr(e.message)
        }
      }
      const openSession = (bot) => {
        try {
          uiWorkspace?.openSession?.({ sessionId: bot.sessionId })
        } catch (e) {
          setNote(`无法打开会话：${e.message}`)
        }
      }

      const presetHint = (() => {
        const p = presets.find((x) => x.id === (form.preset || defaultPreset))
        return p?.description ?? '预设决定人格与工具面；不选则用宿主默认预设。'
      })()

      return h('div', { className: 'csb-wrap' },
        h(Section, { title: '新建 Bot', desc: '一个 Bot = 一个持久会话 + 一个独立工作目录。目录同时是它的写入边界。' }),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 } },
          h('input', {
            className: 'csb-in', style: { width: 150 }, placeholder: '名字',
            value: form.name, onChange: (e) => setForm({ ...form, name: e.target.value }),
          }),
          h('input', {
            className: 'csb-in csb-grow', placeholder: '工作目录（绝对路径）',
            value: form.cwd, onChange: (e) => setForm({ ...form, cwd: e.target.value }),
          }),
          h('button', { className: 'csb-btn', onClick: pickDir }, '选目录'),
          h('select', {
            className: 'csb-sel', style: { width: 176 }, value: form.preset,
            onChange: (e) => setForm({ ...form, preset: e.target.value }),
          },
            h('option', { value: '' }, `预设：默认${defaultPreset ? `（${defaultPreset}）` : ''}`),
            presets.map((p) => h('option', { key: p.id, value: p.id }, p.broken ? `${p.name}（不可用）` : p.name))),
          h('button', { className: 'csb-btn csb-btn-p', disabled: busy, onClick: create }, '创建')),
        h('div', { className: 'csb-set-d', style: { marginTop: 8 } }, presetHint),
        err ? h('div', { className: 'csb-err', style: { marginTop: 12 } }, err) : null,
        note ? h('div', { className: 'csb-note', style: { marginTop: 12 } }, note) : null,

        h(Section, { title: 'Bot 列表', desc: `${bots.filter((b) => b.state !== 'retired').length} 个在用。点「档案」可给它预设身份、经验、技能与记忆。` }),
        loading ? h(Skeleton, { n: 2 }) : null,
        error ? h('div', { className: 'csb-err' }, error) : null,
        !loading && bots.length === 0
          ? h(Empty, { icon: '⬡', title: '还没有 Bot', hint: 'Bot 适合"长期存在 + 需要独立目录"的角色。一次性分工用 subagent 即可，不必建 Bot。' })
          : null,
        h('div', { className: 'csb-list', style: { marginTop: 12 } }, bots.map((b) =>
          h('div', { key: b.id, className: 'csb-card' },
            h(Dot, { status: b.state }),
            h('div', { className: 'csb-card-main' },
              h('div', { className: 'csb-card-t' }, b.name),
              h('div', { className: 'csb-card-m' },
                h(Badge, { status: b.state }),
                h('span', null, b.preset ? `预设 ${b.preset}` : '预设 默认'),
                h('span', { className: 'csb-mono' }, b.cwd),
                b.profile?.identity ? h('span', { className: 'csb-b csb-b-ok' }, '已设身份') : null,
                (b.profile?.skills ?? []).length ? h('span', { className: 'csb-b' }, `${b.profile.skills.length} 技能`) : null,
                (b.profile?.memory ?? []).length ? h('span', { className: 'csb-b' }, `${b.profile.memory.length} 预制记忆`) : null)),
            h('div', { style: { display: 'flex', gap: 6, flex: 'none' } },
              b.state !== 'retired' ? h('button', { className: 'csb-btn csb-btn-s', onClick: () => setProfileFor(b) }, '档案') : null,
              b.state !== 'retired' ? h('button', { className: 'csb-btn csb-btn-s', onClick: () => openSession(b) }, '会话') : null,
              b.state !== 'retired'
                ? h('button', {
                    className: 'csb-btn csb-btn-s',
                    onClick: () => {
                      const n = window.prompt('新名字', b.name)
                      if (n && n.trim()) manage(b, 'rename', { name: n.trim() })
                    },
                  }, '改名')
                : null,
              b.state !== 'retired'
                ? h('button', {
                    className: 'csb-btn csb-btn-s csb-btn-d',
                    onClick: () => {
                      if (window.confirm(`退役「${b.name}」？\n\n会释放名字与目录名额，但会话与历史保留。`)) manage(b, 'retire', { reason: 'ui' })
                    },
                  }, '退役')
                : null)))),
        profileFor ? h(BotProfileDrawer, { bot: profileFor, onClose: () => setProfileFor(null), onChange: reload }) : null)
    }

    // ── 房间 ────────────────────────────────────────────────────────────────

    function RoomsTab() {
      const { data, loading, error, reload } = useApi('/rooms')
      const [active, setActive] = useState(null)
      const [msgs, setMsgs] = useState([])
      const [text, setText] = useState('')
      const [roomName, setRoomName] = useState('')
      const [memberId, setMemberId] = useState('')
      const [err, setErr] = useState(null)
      const endRef = useRef(null)

      const loadMsgs = useCallback((roomId) => {
        call(`/rooms/messages?roomId=${encodeURIComponent(roomId)}`)
          .then((d) => setMsgs(d.messages ?? []))
          .catch((e) => setErr(e.message))
      }, [])
      useEffect(() => {
        if (active) loadMsgs(active)
      }, [active, loadMsgs])
      useEffect(() => {
        endRef.current?.scrollIntoView?.({ block: 'end' })
      }, [msgs])

      const rooms = data?.rooms ?? []
      const current = rooms.find((r) => r.id === active)

      const create = async () => {
        const n = roomName.trim()
        if (!n) return
        setErr(null)
        try {
          await call('/rooms', { method: 'POST', body: { name: n, members: ['ui'] } })
          setRoomName('')
          reload()
        } catch (e) {
          setErr(e.message)
        }
      }
      const post = async () => {
        const t = text.trim()
        if (!t || !active) return
        setErr(null)
        try {
          await call('/rooms/post', { method: 'POST', body: { roomId: active, text: t } })
          setText('')
          loadMsgs(active)
        } catch (e) {
          setErr(e.message)
        }
      }
      const member = async (op) => {
        if (!memberId.trim() || !active) return
        setErr(null)
        try {
          await call(`/rooms/${op}`, { method: 'POST', body: { roomId: active, sessionId: memberId.trim() } })
          setMemberId('')
          reload()
        } catch (e) {
          setErr(e.message)
        }
      }

      return h('div', { className: 'csb-wrap' },
        h('div', { className: 'csb-bar' },
          h('input', {
            className: 'csb-in csb-grow', placeholder: '新建房间…（回车创建）',
            value: roomName, onChange: (e) => setRoomName(e.target.value),
            onKeyDown: (e) => e.key === 'Enter' && create(),
          }),
          h('button', { className: 'csb-btn csb-btn-p', disabled: !roomName.trim(), onClick: create }, '建房间')),
        err ? h('div', { className: 'csb-err' }, err) : null,
        error ? h('div', { className: 'csb-err' }, error) : null,
        loading ? h(Skeleton, { n: 2 }) : null,
        !loading && rooms.length === 0
          ? h(Empty, { icon: '◌', title: '还没有房间', hint: '房间是多人消息流，消息确定性落盘（不经模型转手），因此可审计。' })
          : null,
        h('div', { className: 'csb-list' }, rooms.map((r) =>
          h('div', {
            key: r.id,
            className: `csb-card csb-card-c${active === r.id ? ' csb-card-on' : ''}`,
            onClick: () => setActive(r.id),
          },
            h('div', { className: 'csb-card-main' },
              h('div', { className: 'csb-card-t' }, r.name),
              h('div', { className: 'csb-card-m' },
                h('span', null, `${(r.members ?? []).length} 人`),
                h('span', null, `seq ${r.seq ?? 0}`),
                h('span', { className: 'csb-mono' }, r.id)))))),
        current ? h('div', null,
          h(Section, { title: `消息 · ${current.name}`, desc: `${msgs.length} 条；发帖者必须是房间成员（UI 的 id 是 ui）` }),
          h('div', { style: { maxHeight: 400, overflowY: 'auto', margin: '12px 0' } },
            msgs.length === 0 ? h(Empty, { title: '还没有消息' }) : null,
            msgs.slice(-80).map((m) =>
              h('div', { key: m.id, className: `csb-msg${m.from === 'ui' ? ' csb-msg-me' : ''}` },
                h('div', { className: 'csb-msg-h' },
                  h('span', null, `#${m.seq}`),
                  h('span', { className: 'csb-mono' }, short(m.from, 16)),
                  m.bodyRef ? h('span', { className: 'csb-b' }, '长正文') : null),
                h('div', { className: 'csb-msg-b' }, m.bodyRef ? `（长正文已落旁路：${m.bodyRef}）` : m.text))),
            h('div', { ref: endRef })),
          h('div', { className: 'csb-bar' },
            h('input', {
              className: 'csb-in csb-grow', placeholder: '发言…（回车发送）',
              value: text, onChange: (e) => setText(e.target.value),
              onKeyDown: (e) => e.key === 'Enter' && post(),
            }),
            h('button', { className: 'csb-btn csb-btn-p', disabled: !text.trim(), onClick: post }, '发送')),
          h('div', { className: 'csb-bar' },
            h('input', {
              className: 'csb-in csb-grow', placeholder: '成员 sessionId',
              value: memberId, onChange: (e) => setMemberId(e.target.value),
            }),
            h('button', { className: 'csb-btn', disabled: !memberId.trim(), onClick: () => member('join') }, '加入'),
            h('button', { className: 'csb-btn', disabled: !memberId.trim(), onClick: () => member('leave') }, '移出')))
          : null)
    }

    // ── 记忆 ────────────────────────────────────────────────────────────────

    const LAYERS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5']
    const LAYER_HINT = { L0: '人格（仅人可改）', L1: '用户偏好', L2: '团队规矩', L3: '分支专属', L4: '任务笔记', L5: '归档' }

    function MemoryTab() {
      const [layer, setLayer] = useState('')
      const [query, setQuery] = useState('')
      const [err, setErr] = useState(null)
      const path = `/memory${query ? `?query=${encodeURIComponent(query)}` : layer ? `?layer=${layer}` : ''}`
      const { data, loading, error, reload } = useApi(path, [layer, query])
      const entries = data?.entries ?? []
      const act = (p, body) => call(p, { method: 'POST', body }).then(reload).catch((e) => setErr(e.message))

      return h('div', { className: 'csb-wrap' },
        h('div', { className: 'csb-bar' },
          h('select', { className: 'csb-sel', style: { width: 168 }, value: layer, onChange: (e) => setLayer(e.target.value) },
            h('option', { value: '' }, '全部层'),
            LAYERS.map((l) => h('option', { key: l, value: l }, `${l} · ${LAYER_HINT[l]}`))),
          h('input', {
            className: 'csb-in csb-grow', placeholder: '检索记忆…',
            value: query, onChange: (e) => setQuery(e.target.value),
          })),
        err ? h('div', { className: 'csb-err' }, err) : null,
        error ? h('div', { className: 'csb-err' }, error) : null,
        loading ? h(Skeleton, { n: 3 }) : null,
        !loading && entries.length === 0
          ? h(Empty, { icon: '◇', title: '没有记忆条目', hint: 'L0–L3 常驻注入；L4/L5 按需召回。explicit 条目受保护：自动整理只能建议，不能改。' })
          : null,
        h('div', { className: 'csb-list' }, entries.map((e) =>
          h('div', { key: e.id, className: 'csb-card' },
            h('div', { className: 'csb-card-main' },
              h('div', { className: 'csb-card-t2' }, e.content),
              h('div', { className: 'csb-card-m' },
                h('span', { className: 'csb-b' }, e.layer),
                h('span', { className: 'csb-mono' }, e.id),
                h('span', null, `rev ${e.rev}`),
                e.botId ? h('span', { className: 'csb-b' }, `Bot ${short(e.botId, 10)}`) : null,
                e.explicit ? h('span', { className: 'csb-b csb-b-ok' }, 'explicit') : null,
                e.conflict ? h('span', { className: 'csb-b csb-b-err' }, 'conflict') : null,
                e.archived ? h('span', { className: 'csb-b csb-b-idle' }, '已归档') : null)),
            e.archived
              ? h('button', { className: 'csb-btn csb-btn-s', onClick: () => act('/memory/restore', { layer: e.layer, id: e.id }) }, '恢复')
              : h('button', {
                  className: 'csb-btn csb-btn-s',
                  onClick: () => {
                    const r = window.prompt('归档原因', '过时')
                    if (r === null) return
                    act('/memory/archive', { layer: e.layer, id: e.id, reason: r })
                  },
                }, '归档')))))
    }

    // ── 设置（按实测几何：行高 76、内容吃满、组间距 32）────────────────────

    const NUM_META = {
      defaultLeaseMs: { scale: 60000, unit: '分钟', step: 1 },
      throttleMs: { scale: 1000, unit: '秒', step: 1 },
      wakeTtlMs: { scale: 3600000, unit: '小时', step: 1 },
      maxWakesPerTarget: { scale: 1, unit: '条', step: 10 },
      memoryEntryMax: { scale: 1, unit: '字符', step: 50 },
    }

    function NumberRow({ id, spec, value, onChange }) {
      const meta = NUM_META[id] ?? { scale: 1, unit: '', step: 1 }
      const disp = Math.round(Number(value) / meta.scale)
      const min = Math.round(spec.min / meta.scale)
      const max = Math.round(spec.max / meta.scale)
      const [raw, setRaw] = useState(String(disp))
      const [bad, setBad] = useState(false)

      useEffect(() => {
        setRaw(String(disp))
        setBad(false)
      }, [disp])

      const commit = (n) => {
        if (!Number.isFinite(n) || n < min || n > max) {
          setBad(true)
          return
        }
        setBad(false)
        onChange(Math.round(n * meta.scale))
      }
      const bump = (d) => {
        const next = Math.min(max, Math.max(min, (Number(raw) || disp) + d * meta.step))
        setRaw(String(next))
        commit(next)
      }

      return h('div', { className: 'csb-set' },
        h('div', { className: 'csb-set-l' },
          h('label', null, spec.label ?? id),
          h('div', { className: 'csb-set-d' },
            `默认 ${Math.round(spec.def / meta.scale)} ${meta.unit}（范围 ${min}–${max} ${meta.unit}）${bad ? ' · 取值超出范围，已还原' : ''}`)),
        h('div', { className: 'csb-set-c' },
          h('button', { className: 'csb-step', onClick: () => bump(-1), 'aria-label': '减少' }, '−'),
          h('span', { className: 'csb-num' },
            h('input', {
              className: 'csb-in',
              type: 'text',
              inputMode: 'numeric',
              value: raw,
              style: bad ? { borderColor: 'var(--dsw-alias-state-error-primary)' } : undefined,
              onChange: (e) => {
                const v = e.target.value.replace(/[^\d.-]/g, '')
                setRaw(v)
              },
              onBlur: () => {
                const n = Number(raw)
                if (!Number.isFinite(n) || n < min || n > max) {
                  setRaw(String(disp))
                  setBad(false)
                  return
                }
                commit(n)
              },
              onKeyDown: (e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
                if (e.key === 'Escape') {
                  setRaw(String(disp))
                  setBad(false)
                }
              },
            }),
            h('span', { className: 'csb-unit' }, meta.unit)),
          h('button', { className: 'csb-step', onClick: () => bump(1), 'aria-label': '增加' }, '+')))
    }

    function BoolRow({ id, spec, value, onChange }) {
      return h('div', { className: 'csb-set' },
        h('div', { className: 'csb-set-l' },
          h('label', null, spec.label ?? id),
          h('div', { className: 'csb-set-d' }, id === 'k1Enabled'
            ? 'Bot 会话禁用阻塞式提问。关掉会让投递链有被堵风险，仅在排查时临时关闭。'
            : id === 'memorySplitOnOverflow'
              ? '超过单条上限时自动切分存储（而不是拒收），拼回无损。'
              : spec.label ?? id)),
        h('div', { className: 'csb-set-c' },
          h(Switch, { checked: value === true, onChange }),
          h('span', { className: 'csb-sw-t' }, value === true ? '开' : '关')))
    }

    function SettingsBody() {
      const { data, loading, error, reload } = useApi('/settings')
      const { data: statusData, reload: reloadStatus } = useApi('/status')
      const [draft, setDraft] = useState({})
      const [msg, setMsg] = useState(null)
      const [err, setErr] = useState(null)
      const [busy, setBusy] = useState(false)
      const [openDiag, setOpenDiag] = useState(false)

      const specs = data?.specs ?? {}
      const values = data?.values ?? {}
      const svc = statusData?.services ?? {}
      const compat = statusData?.compat ?? null
      const avail = compat?.available ?? {}
      const okCount = Object.values(avail).filter(Boolean).length
      const totalCount = Object.keys(avail).length || 0
      const svcOk = Object.values(svc).filter((v) => v?.available).length
      const svcTotal = Object.keys(svc).length || 0
      const dirty = Object.keys(draft).some((k) => String(draft[k]) !== String(values[k]))
      const val = (id) => (id in draft ? draft[id] : values[id])

      const save = async () => {
        const patch = {}
        for (const [k, v] of Object.entries(draft)) if (String(v) !== String(values[k])) patch[k] = v
        if (!Object.keys(patch).length) return
        setBusy(true)
        setErr(null)
        setMsg(null)
        try {
          const res = await call('/settings', { method: 'POST', body: patch })
          setMsg(res.note ?? '已保存')
          setDraft({})
          reload()
        } catch (e) {
          setErr(e.message)
        } finally {
          setBusy(false)
        }
      }

      const TASK_KEYS = ['defaultLeaseMs', 'throttleMs', 'maxWakesPerTarget', 'wakeTtlMs']
      const MEM_KEYS = ['memoryEntryMax', 'memorySplitOnOverflow', 'k1Enabled']

      return h('div', { className: 'csb-wrap' },
        loading ? h(Skeleton, { n: 3 }) : null,
        error ? h('div', { className: 'csb-err' }, error) : null,
        msg ? h('div', { className: 'csb-ok' }, msg) : null,
        err ? h('div', { className: 'csb-err' }, err) : null,

        h(Section, { title: '运行状态', desc: '当前平台规模与各域服务健康。' }),
        h('div', { className: 'csb-stats', style: { marginTop: 12 } },
          [['任务', svc.board?.stats?.total], ['Bot', svc.roster?.stats?.total], ['房间', svc.room?.stats?.total], ['记忆', svc.memory?.stats?.total]]
            .map(([l, n]) => h('div', { key: l, className: 'csb-stat' },
              h('div', { className: 'csb-stat-n' }, n ?? '—'),
              h('div', { className: 'csb-stat-l' }, l)))),
        h('div', { className: 'csb-fold' },
          h('div', { className: 'csb-diag' },
            h('span', { className: `csb-dot${svcOk === svcTotal && svcTotal > 0 ? ' csb-dot-ok' : svcTotal && svcOk < svcTotal ? ' csb-dot-err' : ''}` }),
            h('span', { className: 'csb-diag-t', style: { flex: 1 } },
              svcTotal && svcOk === svcTotal
                ? `${okCount} 项能力全部就绪。`
                : `${okCount}/${totalCount || '?'} 项能力就绪${totalCount && okCount < totalCount ? '，部分功能降级' : ''}。`),
            h('span', { className: 'csb-diag-t' }, `${okCount}/${totalCount} 就绪 · ${svcOk}/${svcTotal} 服务正常`),
            h('button', { className: 'csb-btn csb-btn-s', onClick: () => setOpenDiag(!openDiag) }, openDiag ? '收起 ▴' : '查看详情 ▾')),
          h('div', { className: 'csb-dots', style: { marginTop: 10 } },
            Object.entries(avail).map(([k, ok]) =>
              h('span', { key: k, className: `csb-dot${ok ? ' csb-dot-ok' : ' csb-dot-err'}`, title: `${k}：${ok ? '就绪' : '缺失'}` }))),
          openDiag
            ? h('div', null,
                h('div', { className: 'csb-kv', style: { marginTop: 14, marginBottom: 10 } },
                  h('span', { className: 'csb-k' }, 'DSH 版本'), h('span', { className: 'csb-v csb-mono' }, compat?.dshVersion ?? '未探到'),
                  h('span', { className: 'csb-k' }, 'Node'), h('span', { className: 'csb-v csb-mono' }, compat?.node ?? '—'),
                  h('span', { className: 'csb-k' }, '状态目录'), h('span', { className: 'csb-v csb-mono' }, data?.baseDir ?? '—')),
                h('div', { className: 'csb-list' },
                  Object.keys(svc).map((k) =>
                    h('div', { key: k, className: 'csb-card', style: { padding: '9px 12px' } },
                      h('span', { className: `csb-dot${svc[k]?.available ? ' csb-dot-ok' : ' csb-dot-err'}` }),
                      h('div', { className: 'csb-card-main' }, h('div', { style: { fontSize: 12.5 } }, k)),
                      h('span', { className: 'csb-set-d' }, svc[k]?.available ? '正常' : '未装配')))),
                (compat?.missing ?? []).length
                  ? h('div', { className: 'csb-note', style: { marginTop: 12 } }, `缺少能力：${compat.missing.join('、')}（相关功能已降级，不影响宿主启动）`)
                  : h('div', { className: 'csb-cap' },
                      Object.entries(avail).map(([k, ok]) =>
                        h('div', { key: k, className: 'csb-cap-i' },
                          h('span', { className: `csb-dot${ok ? ' csb-dot-ok' : ' csb-dot-err'}` }),
                          h('span', null, k)))))
            : null),

        h(Section, { title: '任务板与唤醒', desc: '影响任务的领取、超时回收，以及唤醒的节流与保留。' }),
        TASK_KEYS.filter((k) => specs[k]).map((k) =>
          specs[k].bool
            ? h(BoolRow, { key: k, id: k, spec: specs[k], value: val(k), onChange: (v) => setDraft({ ...draft, [k]: v }) })
            : h(NumberRow, { key: k, id: k, spec: specs[k], value: val(k), onChange: (v) => setDraft({ ...draft, [k]: v }) })),

        h(Section, { title: '记忆与安全', desc: '影响记忆的容量、切分策略，以及 Bot 会话的工具闸门。' }),
        MEM_KEYS.filter((k) => specs[k]).map((k) =>
          specs[k].bool
            ? h(BoolRow, { key: k, id: k, spec: specs[k], value: val(k), onChange: (v) => setDraft({ ...draft, [k]: v }) })
            : h(NumberRow, { key: k, id: k, spec: specs[k], value: val(k), onChange: (v) => setDraft({ ...draft, [k]: v }) })),

        h('div', { className: 'csb-bar', style: { marginTop: 20 } },
          h('button', { className: 'csb-btn csb-btn-p', disabled: !dirty || busy, onClick: save }, busy ? '保存中…' : dirty ? '保存改动' : '无改动'),
          h('button', { className: 'csb-btn', disabled: !Object.keys(draft).length, onClick: () => { setDraft({}); setMsg(null); setErr(null) } }, '撤销'),
          h('div', { className: 'csb-spacer' }),
          h('button', { className: 'csb-btn', onClick: () => { reload(); reloadStatus() } }, '刷新')),
        h('div', { className: 'csb-set-d', style: { marginTop: 8 } }, '以上参数写入状态目录的 settings.json；内核级参数需重启 DSH 生效。'),

        h(Section, { title: '危险操作', desc: '以下操作立即生效、无法撤销。请在确认前核对影响范围。' }),
        h('div', { className: 'csb-set' },
          h('div', { className: 'csb-set-l' },
            h('label', null, '重置为默认值'),
            h('div', { className: 'csb-set-d' }, '把全部可调参数恢复为出厂默认。只影响 settings.json，不删除任务、Bot、房间或记忆数据。')),
          h('div', { className: 'csb-set-c' },
            h('button', {
              className: 'csb-btn csb-btn-d',
              onClick: async () => {
                const changed = Object.keys(specs).filter((k) => String(values[k]) !== String(specs[k].def))
                const detail = changed.length
                  ? changed.map((k) => `${specs[k].label ?? k}：${values[k]} → ${specs[k].def}`).join('\n')
                  : '（当前没有改动过的项）'
                if (!window.confirm(`重置为默认值？\n\n${detail}`)) return
                const patch = {}
                for (const [k, s] of Object.entries(specs)) patch[k] = s.def
                try {
                  await call('/settings', { method: 'POST', body: patch })
                  setDraft({})
                  setMsg(`已重置 ${changed.length} 项为默认值`)
                  reload()
                } catch (e) {
                  setErr(e.message)
                }
              },
            }, '重置默认值'))) )
    }

    // ── 主面板 ──────────────────────────────────────────────────────────────

    const TABS = [
      { id: 'tasks', label: '任务', Comp: TasksTab },
      { id: 'bots', label: 'Bot', Comp: BotsTab },
      { id: 'rooms', label: '房间', Comp: RoomsTab },
      { id: 'memory', label: '记忆', Comp: MemoryTab },
      { id: 'settings', label: '设置', Comp: SettingsTab },
    ]

    function SettingsTab() {
      return h(SettingsBody)
    }

    function Workbench() {
      const [tab, setTab] = useState('tasks')
      const current = TABS.find((t) => t.id === tab) ?? TABS[0]
      const Comp = current.Comp
      return h('div', { className: 'csb' },
        h('div', { className: 'csb-head' },
          h('div', { className: 'csb-hrow' },
            h('h2', null, '协作平台'),
            h('span', { className: 'csb-hint' }, '任务板 · Bot · 房间 · 记忆')),
          h('div', { className: 'csb-tabs', role: 'tablist' },
            TABS.map((t) =>
              h('button', {
                key: t.id,
                role: 'tab',
                'aria-selected': t.id === tab,
                className: `csb-tab${t.id === tab ? ' csb-tab-on' : ''}`,
                onClick: () => setTab(t.id),
              }, t.label)))),
        h('div', { className: 'csb-body' },
          h(Boundary, { tab: current.label }, h(Comp, { key: current.id }))))
    }

    function PanelIcon() {
      return h('span', { 'aria-hidden': 'true', style: { fontSize: 14 } }, '◈')
    }

    function apply(ctx) {
      const disposers = []
      try {
        const d = installStyles()
        if (typeof d === 'function') disposers.push(d)
      } catch {}

      try {
        disposers.push(ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, Workbench)))
      } catch (error) {
        try {
          console.warn('[cs-bots] 注册 main 失败：', error)
        } catch {}
      }
      try {
        disposers.push(
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 10, label: () => '协作平台' }, PanelIcon)),
        )
      } catch (error) {
        try {
          console.warn('[cs-bots] 注册 panellist 失败：', error)
        } catch {}
      }
      // 设置页同时挂到官方设置面板
      try {
        disposers.push(
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register({ name: 'settings.section', id: 'cs-bots', order: 60, label: () => '协作平台' }, SettingsBody)),
        )
      } catch (error) {
        try {
          console.warn('[cs-bots] 注册 settings.section 失败（不影响主面板）：', error)
        } catch {}
      }

      return function () {
        for (let i = disposers.length - 1; i >= 0; i -= 1) {
          try {
            if (typeof disposers[i] === 'function') disposers[i]()
          } catch {}
        }
      }
    }

    exports.apply = apply
    exports.inject = ['slots', 'layout']
    exports.Workbench = Workbench
    exports.Boundary = Boundary
    exports.TasksTab = TasksTab
    exports.BotsTab = BotsTab
    exports.RoomsTab = RoomsTab
    exports.MemoryTab = MemoryTab
    exports.SettingsTab = SettingsTab
    exports.SettingsBody = SettingsBody
    exports.BotProfileDrawer = BotProfileDrawer
    exports.PANEL_ID = PANEL_ID
    exports.API = API

    return module.exports
  },
})
