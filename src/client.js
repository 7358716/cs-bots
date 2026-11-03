/**
 * cs-bots /client —— Web 页面层（L3）。2026-11-03 按「普通人能操作」重做。
 *
 * ── 三条铁律（都有机械检查守住）────────────────────────────────────────────
 *   1. **绝不使用 `window.prompt` / `confirm` / `alert`**。
 *      依据：官方 DSH 客户端包全量 grep 0 处使用，且存在 sandboxed 渲染 ——
 *      在沙箱视图里这两个 API 被**静默屏蔽**（返回 null/false、不报错），
 *      用户看到的就是「按钮点了没反应」。所有输入改内联表单，所有确认改站内弹窗。
 *      CI 检查 5 会 grep 本文件，命中即 FAIL。
 *   2. **宿主服务只能从 `apply(ctx)` 的 ctx 取**（`ctx.get('uiWorkspace')`）。
 *      以前猜过 `window.__DSH_CTX__` —— 那个永远是 undefined，导致「选目录」静默失效。
 *   3. **每个 Tab 单独包 ErrorBoundary**：一处炸不连累整页。
 *
 * ── 视觉（依据实测几何）───────────────────────────────────────────────────
 *   · 只用官方 14 个主题令牌；浅色下 bg-base/layer-1/layer-2 都是 #fff → 层次靠边框
 *   · brand-primary 是单色（浅黑/深白）→ 主按钮 bg=brand + color=bg-base 自动反色
 *   · 状态色只上「点和字」，不做整块底色
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

    // ── 宿主上下文（apply 时捕获；取代不可靠的全局猜测）────────────────────
    let hostCtx = null
    let hostUiWorkspace = null
    function bindHost(ctx) {
      hostCtx = ctx
      try {
        hostUiWorkspace = ctx?.get?.('uiWorkspace') ?? null
      } catch {
        hostUiWorkspace = null
      }
    }

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
.csb-tabs{display:flex;gap:2px;overflow-x:auto}
.csb-tab{position:relative;padding:9px 13px;border:0;background:transparent;cursor:pointer;white-space:nowrap;
  color:var(--dsw-alias-label-secondary);font-size:13px;font-family:inherit;border-radius:8px 8px 0 0}
.csb-tab:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.csb-tab-on{color:var(--dsw-alias-label-primary);font-weight:500}
.csb-tab-on::after{content:"";position:absolute;left:9px;right:9px;bottom:-1px;height:2px;
  background:var(--dsw-alias-brand-primary);border-radius:2px 2px 0 0}
.csb-body{flex:1;overflow-y:auto;padding:20px 24px 56px;min-height:0}
.csb-wrap{max-width:920px;margin:0 auto}

.csb-bar{display:flex;gap:8px;align-items:center;margin-bottom:16px;flex-wrap:wrap}
.csb-spacer{flex:1}
.csb-in,.csb-sel,.csb-ta{box-sizing:border-box;height:32px;padding:0 10px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
  color:inherit;font-size:13px;font-family:inherit;outline:none}
.csb-in::placeholder,.csb-ta::placeholder{color:var(--dsw-alias-label-secondary)}
.csb-in:focus,.csb-sel:focus,.csb-ta:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.csb-ta{height:auto;min-height:76px;padding:8px 10px;resize:vertical;line-height:1.6}
.csb-grow{flex:1;min-width:140px}
.csb-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:32px;padding:0 13px;
  border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);font-size:12.5px;font-family:inherit;cursor:pointer;white-space:nowrap}
.csb-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.csb-btn:disabled{opacity:.4;cursor:not-allowed}
.csb-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.csb-btn-p{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);border-color:transparent;font-weight:500}
.csb-btn-p:hover{background:var(--dsw-alias-brand-primary);filter:brightness(1.12)}
.csb-btn-d{color:var(--dsw-alias-state-error-primary);
  border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent)}
.csb-btn-d:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}
.csb-btn-s{height:28px;padding:0 10px;font-size:12px}
.csb-btn-x{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:16px;
  line-height:1;cursor:pointer;padding:4px 6px;font-family:inherit}
.csb-btn-x:hover{color:var(--dsw-alias-label-primary)}

.csb-list{display:flex;flex-direction:column;gap:8px}
.csb-card{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:12px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
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
.csb-b-run{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 38%,transparent)}
.csb-b-ok{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 38%,transparent)}
.csb-b-err{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 38%,transparent)}
.csb-b-idle{color:var(--dsw-alias-state-idle-primary)}
.csb-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}
.csb-dot-ok{background:var(--dsw-alias-state-success-primary)}
.csb-dot-err{background:var(--dsw-alias-state-error-primary)}
.csb-dot-run{background:var(--dsw-alias-state-warn-primary)}

.csb-err{padding:10px 12px;border-radius:10px;font-size:12.5px;margin-bottom:14px;line-height:1.6;
  color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-1);
  border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent)}
.csb-note{padding:9px 12px;border-radius:10px;font-size:12.5px;margin-bottom:14px;line-height:1.6;
  color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1)}
.csb-ok{padding:9px 12px;border-radius:10px;font-size:12.5px;margin-bottom:14px;
  color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-bg-layer-1);
  border:1px solid color-mix(in srgb,var(--dsw-alias-state-success-primary) 40%,transparent)}

.csb-empty{display:flex;flex-direction:column;align-items:center;gap:9px;padding:52px 16px;text-align:center}
.csb-empty-i{font-size:24px;opacity:.32;line-height:1}
.csb-empty-t{font-size:13px;color:var(--dsw-alias-label-secondary)}
.csb-empty-h{font-size:11.5px;color:var(--dsw-alias-label-secondary);max-width:400px;line-height:1.7}
.csb-sk{height:56px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);
  background:linear-gradient(90deg,var(--dsw-alias-bg-layer-1) 25%,var(--dsw-alias-bg-layer-2) 37%,var(--dsw-alias-bg-layer-1) 63%);
  background-size:400% 100%;animation:csb-sk 1.3s ease-in-out infinite;margin-bottom:8px}
@keyframes csb-sk{0%{background-position:100% 0}100%{background-position:0 0}}

/* 弹窗与抽屉 */
.csb-mask{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;
  padding:24px;background:color-mix(in srgb,#000 34%,transparent)}
.csb-mask-r{align-items:stretch;justify-content:flex-end;padding:0}
.csb-modal{width:min(520px,100%);max-height:calc(100vh - 48px);display:flex;flex-direction:column;
  border-radius:16px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.csb-modal-w{width:min(760px,100%)}
.csb-drawer{width:min(660px,100%);height:100%;display:flex;flex-direction:column;
  background:var(--dsw-alias-bg-layer-2);border-left:1px solid var(--dsw-alias-border-l1)}
.csb-mhead{flex:none;display:flex;align-items:center;gap:10px;padding:14px 18px;
  border-bottom:1px solid var(--dsw-alias-border-l1)}
.csb-mhead h3{margin:0;font-size:14px;font-weight:600;flex:1}
.csb-mbody{flex:1;overflow-y:auto;padding:16px 18px;min-height:0}
.csb-mfoot{flex:none;display:flex;gap:8px;justify-content:flex-end;padding:12px 18px;
  border-top:1px solid var(--dsw-alias-border-l1)}

.csb-kv{display:grid;grid-template-columns:110px 1fr;gap:8px 14px;font-size:12.5px;margin-bottom:16px}
.csb-k{color:var(--dsw-alias-label-secondary)}
.csb-v{word-break:break-word;font-variant-numeric:tabular-nums}
.csb-pre{white-space:pre-wrap;word-break:break-word;
  font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);font-size:11.5px;line-height:1.65;
  background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;
  padding:11px 13px;max-height:320px;overflow:auto;margin:0}

.csb-sec{margin:26px 0 6px}
.csb-sec:first-child{margin-top:0}
.csb-sec h4{margin:0;font-size:13.5px;font-weight:600;line-height:1.4}
.csb-sec p{margin:4px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}

.csb-fld{margin-bottom:14px}
.csb-fld > label{display:block;font-size:12px;font-weight:500;margin-bottom:5px}
.csb-fld-h{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary);margin-top:5px}

.csb-set{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:24px;align-items:start;
  padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}
.csb-set:last-of-type{border-bottom:0}
.csb-set-l label{display:block;font-size:13px;line-height:1.45;margin-bottom:4px}
.csb-set-d{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.csb-set-c{display:flex;align-items:center;gap:8px;justify-self:end;padding-top:2px}
.csb-num{position:relative;display:inline-flex;align-items:center}
.csb-num .csb-in{width:112px;text-align:right;font-variant-numeric:tabular-nums;padding-right:36px}
.csb-unit{position:absolute;right:10px;font-size:11.5px;color:var(--dsw-alias-label-secondary);pointer-events:none}
.csb-step{width:28px;height:32px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:14px;font-family:inherit}
.csb-step:hover{background:var(--dsw-alias-bg-layer-2)}
.csb-sw{position:relative;width:36px;height:20px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-1);cursor:pointer;flex:none}
.csb-sw::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;
  background:var(--dsw-alias-label-secondary);transition:transform .15s,background .15s}
.csb-sw-on{background:var(--dsw-alias-brand-primary);border-color:transparent}
.csb-sw-on::after{transform:translateX(16px);background:var(--dsw-alias-bg-base)}
.csb-sw-t{font-size:11.5px;color:var(--dsw-alias-label-secondary);min-width:16px}

.csb-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:12px}
.csb-stat{padding:12px 14px;border-radius:14px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.csb-stat-n{font-size:20px;font-weight:600;line-height:1.3;font-variant-numeric:tabular-nums}
.csb-stat-l{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.csb-fold{border:1px solid var(--dsw-alias-border-l1);border-radius:14px;padding:14px 16px;
  background:var(--dsw-alias-bg-base);margin-top:12px}
.csb-cap{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:6px 16px;margin-top:12px}
.csb-cap-i{display:flex;align-items:center;gap:7px;font-size:11.5px;color:var(--dsw-alias-label-secondary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.csb-msg{padding:9px 12px;border-radius:10px;margin-bottom:6px;background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l1)}
.csb-msg-me{background:var(--dsw-alias-bg-layer-2)}
.csb-msg-h{display:flex;align-items:center;gap:7px;margin-bottom:3px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.csb-msg-b{font-size:12.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word}

.csb-tags{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}
.csb-tag{display:inline-flex;align-items:center;gap:6px;min-height:26px;padding:3px 8px;border-radius:6px;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);font-size:11.5px}
.csb-tag-x{border:0;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary);
  font-size:13px;line-height:1;padding:0;font-family:inherit}
.csb-tag-x:hover{color:var(--dsw-alias-state-error-primary)}
.csb-pick{display:flex;flex-direction:column;gap:4px;max-height:220px;overflow-y:auto;
  border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:6px;background:var(--dsw-alias-bg-base)}
.csb-pick-i{display:flex;align-items:center;gap:9px;padding:7px 9px;border-radius:7px;cursor:pointer;font-size:12.5px}
.csb-pick-i:hover{background:var(--dsw-alias-bg-layer-2)}
.csb-pick-i input{accent-color:var(--dsw-alias-brand-primary);margin:0}
.csb-crumb{display:flex;align-items:center;gap:4px;flex-wrap:wrap;font-size:12px;margin-bottom:8px}
.csb-crumb button{border:0;background:transparent;cursor:pointer;color:var(--dsw-alias-label-primary);
  font-size:12px;font-family:inherit;padding:2px 4px;border-radius:4px}
.csb-crumb button:hover{background:var(--dsw-alias-bg-layer-2)}
.csb-crumb span{color:var(--dsw-alias-label-secondary)}
.csb-fslist{display:flex;flex-direction:column;gap:2px;max-height:260px;overflow-y:auto;
  border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:6px;background:var(--dsw-alias-bg-base)}
.csb-fs-i{display:flex;align-items:center;gap:9px;padding:7px 9px;border-radius:7px;cursor:pointer;font-size:12.5px}
.csb-fs-i:hover{background:var(--dsw-alias-bg-layer-2)}
.csb-fs-i-on{background:var(--dsw-alias-bg-layer-2);font-weight:500}
.csb-fs-n{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.csb-steps{display:flex;flex-direction:column;gap:8px}
.csb-step-row{display:flex;gap:8px;align-items:flex-start;padding:10px;border-radius:10px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
.csb-step-n{width:22px;height:22px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;
  font-size:11px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
`

    function installStyles() {
      try {
        const styles = typeof window !== 'undefined' ? window.__DSH_STYLES__ : undefined
        if (styles?.insert) return styles.insert(CSS)
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

    // ── 基建组件 ────────────────────────────────────────────────────────────

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
          console.warn('[cs-bots] 页面出错:', this.props.tab, error)
        } catch {}
      }
      render() {
        if (this.state.error) {
          return h('div', { className: 'csb-err' },
            `「${this.props.tab}」出错了：${String(this.state.error.message || this.state.error)}`,
            h('button', { className: 'csb-btn csb-btn-s', style: { marginLeft: 10 }, onClick: () => this.setState({ error: null }) }, '重试'))
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
    function Section({ title, desc, children }) {
      return h('div', { className: 'csb-sec' },
        h('h4', null, title),
        desc ? h('p', null, desc) : null,
        children)
    }

    /** 站内弹窗：**取代 window.confirm**（沙箱里 confirm 被静默屏蔽）。 */
    function Modal({ title, wide, onClose, footer, children }) {
      useEffect(() => {
        const onKey = (e) => e.key === 'Escape' && onClose?.()
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])
      return h('div', { className: 'csb-mask', onClick: (e) => e.target === e.currentTarget && onClose?.() },
        h('div', { className: `csb-modal${wide ? ' csb-modal-w' : ''}` },
          h('div', { className: 'csb-mhead' }, h('h3', null, title), h('button', { className: 'csb-btn-x', onClick: onClose, 'aria-label': '关闭' }, '×')),
          h('div', { className: 'csb-mbody' }, children),
          footer ? h('div', { className: 'csb-mfoot' }, footer) : null))
    }

    /** 抽屉（右侧滑出，用于详情）。 */
    function Drawer({ title, onClose, children, footer }) {
      useEffect(() => {
        const onKey = (e) => e.key === 'Escape' && onClose?.()
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])
      return h('div', { className: 'csb-mask csb-mask-r', onClick: (e) => e.target === e.currentTarget && onClose?.() },
        h('div', { className: 'csb-drawer' },
          h('div', { className: 'csb-mhead' }, h('h3', null, title), h('button', { className: 'csb-btn-x', onClick: onClose, 'aria-label': '关闭' }, '×')),
          h('div', { className: 'csb-mbody' }, children),
          footer ? h('div', { className: 'csb-mfoot' }, footer) : null))
    }

    /** 二次确认弹窗（取代 confirm），需要用户明确点主按钮。 */
    function ConfirmModal({ title, message, danger, confirmText, onCancel, onConfirm }) {
      const [busy, setBusy] = useState(false)
      return h(Modal, {
        title,
        onClose: onCancel,
        footer: [
          h('button', { key: 'c', className: 'csb-btn', onClick: onCancel }, '取消'),
          h('button', {
            key: 'o',
            className: `csb-btn ${danger ? 'csb-btn-d' : 'csb-btn-p'}`,
            disabled: busy,
            onClick: async () => {
              setBusy(true)
              try {
                await onConfirm()
              } finally {
                setBusy(false)
              }
            },
          }, busy ? '处理中…' : (confirmText ?? '确认')),
        ],
      }, h('div', { style: { fontSize: 12.5, lineHeight: 1.75, whiteSpace: 'pre-wrap' } }, message))
    }

    const ST_TEXT = {
      pending: '待办', in_progress: '进行中', completed: '已完成', blocked: '已终止', deleted: '已删除',
      idle: '空闲', running: '运行中', parked: '已挂起', failed: '失败', retired: '已退役',
    }
    const ST_CLS = {
      in_progress: 'csb-b csb-b-run', completed: 'csb-b csb-b-ok', blocked: 'csb-b csb-b-err',
      deleted: 'csb-b csb-b-err', failed: 'csb-b csb-b-err', retired: 'csb-b csb-b-err',
      parked: 'csb-b csb-b-idle', running: 'csb-b csb-b-run',
    }
    const DOT_CLS = {
      in_progress: 'csb-dot csb-dot-run', running: 'csb-dot csb-dot-run',
      completed: 'csb-dot csb-dot-ok', idle: 'csb-dot csb-dot-ok',
      blocked: 'csb-dot csb-dot-err', deleted: 'csb-dot csb-dot-err',
      failed: 'csb-dot csb-dot-err', retired: 'csb-dot csb-dot-err',
    }
    const Badge = ({ status, children }) => h('span', { className: ST_CLS[status] ?? 'csb-b' }, children ?? ST_TEXT[status] ?? status)
    const Dot = ({ status }) => h('span', { className: DOT_CLS[status] ?? 'csb-dot' })
    const Switch = ({ checked, onChange }) =>
      h('button', {
        type: 'button', role: 'switch', 'aria-checked': checked === true,
        className: `csb-sw${checked ? ' csb-sw-on' : ''}`, onClick: () => onChange(!checked),
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

    // ── 目录选择器（自建，替代宿主原生 picker）──────────────────────────────

    /**
     * 目录浏览器。为什么自建：
     *   `uiWorkspace.pickDirectory()` 在部分环境（Linux/沙箱/无桌面）不可用，
     *   而且它**不支持新建/重命名**。用户明确要求这两项，所以必须有一套自带的。
     * 优先仍尝试原生 picker（能弹就用），失败则完全走自建列表。
     */
    function DirPicker({ value, onChange, onClose }) {
      const [path, setPath] = useState(value || '')
      const [listing, setListing] = useState(null)
      const [err, setErr] = useState(null)
      const [busy, setBusy] = useState(false)
      const [newName, setNewName] = useState('')
      const [renaming, setRenaming] = useState(null)
      const [renameTo, setRenameTo] = useState('')
      const [showHidden, setShowHidden] = useState(false)
      const [verdict, setVerdict] = useState(null)

      const load = useCallback(async (p) => {
        setErr(null)
        setBusy(true)
        try {
          const q = `/fs/list?showHidden=${showHidden ? 1 : 0}${p ? `&path=${encodeURIComponent(p)}` : ''}`
          const d = await call(q)
          setListing(d)
          setPath(d.path)
          // 顺手校验"能不能当 Bot 目录"
          try {
            const v = await call('/fs/validate', { method: 'POST', body: { path: d.path } })
            setVerdict(v.verdict)
          } catch {
            setVerdict(null)
          }
        } catch (e) {
          setErr(e.message)
        } finally {
          setBusy(false)
        }
      }, [showHidden])

      useEffect(() => { load(value || '') }, [load])

      const doMkdir = async () => {
        const n = newName.trim()
        if (!n) return
        setErr(null)
        try {
          const d = await call('/fs/mkdir', { method: 'POST', body: { path, name: n } })
          setNewName('')
          await load(d.path)
        } catch (e) {
          setErr(e.message)
        }
      }
      const doRename = async () => {
        const n = renameTo.trim()
        if (!n || !renaming) return
        setErr(null)
        try {
          await call('/fs/rename', { method: 'POST', body: { path: renaming, name: n } })
          setRenaming(null)
          setRenameTo('')
          await load(path)
        } catch (e) {
          setErr(e.message)
        }
      }
      const tryNative = async () => {
        try {
          const picked = await hostUiWorkspace?.pickDirectory?.()
          if (picked) {
            onChange(picked)
            onClose?.()
          } else {
            setErr('系统目录选择器不可用（这套环境不提供），请用下面的列表选择')
          }
        } catch (e) {
          setErr(`系统目录选择器不可用：${e.message}。请用下面的列表选择`)
        }
      }

      const crumbs = (() => {
        if (!path) return []
        const parts = path.split('/').filter(Boolean)
        const out = [{ label: '/', to: '/' }]
        let acc = ''
        for (const p of parts) {
          acc += `/${p}`
          out.push({ label: p, to: acc })
        }
        return out
      })()

      return h(Drawer, {
        title: '选择工作目录',
        onClose,
        footer: [
          h('button', { key: 'n', className: 'csb-btn', onClick: tryNative }, '用系统选择器'),
          h('div', { key: 's', className: 'csb-spacer' }),
          h('button', { key: 'c', className: 'csb-btn', onClick: onClose }, '取消'),
          h('button', {
            key: 'o', className: 'csb-btn csb-btn-p', disabled: !path,
            onClick: () => { onChange(path); onClose?.() },
          }, '用这个目录'),
        ],
      },
        err ? h('div', { className: 'csb-err' }, err) : null,
        h('div', { className: 'csb-crumb' },
          crumbs.map((c, i) =>
            h('span', { key: c.to, style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
              i > 0 ? h('span', null, '/') : null,
              h('button', { onClick: () => load(c.to) }, c.label)))),
        h('div', { className: 'csb-bar' },
          h('button', { className: 'csb-btn csb-btn-s', disabled: !listing?.parent, onClick: () => load(listing.parent) }, '↑ 上一级'),
          h('button', { className: 'csb-btn csb-btn-s', onClick: () => load('/') }, '根目录'),
          h('button', { className: 'csb-btn csb-btn-s', onClick: () => load('') }, '家目录'),
          h('div', { className: 'csb-spacer' }),
          h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' } },
            h('input', { type: 'checkbox', checked: showHidden, onChange: (e) => { setShowHidden(e.target.checked); load(path) } }),
            '显示隐藏项')),
        busy && !listing ? h(Skeleton, { n: 3 }) : null,
        listing
          ? h('div', { className: 'csb-fslist' },
              (listing.entries ?? []).length === 0
                ? h('div', { className: 'csb-set-d', style: { padding: '12px 9px' } }, '这个目录是空的')
                : null,
              (listing.entries ?? []).map((e) =>
                h('div', { key: e.path, className: 'csb-fs-i' },
                  h('span', { style: { opacity: .55, width: 14, textAlign: 'center' } }, e.kind === 'dir' ? '📁' : '📄'),
                  h('span', {
                    className: 'csb-fs-n',
                    style: { cursor: e.kind === 'dir' ? 'pointer' : 'default' },
                    onClick: () => e.kind === 'dir' && load(e.path),
                  }, e.name),
                  e.kind === 'dir'
                    ? h('button', {
                        className: 'csb-btn csb-btn-s',
                        onClick: () => { setRenaming(e.path); setRenameTo(e.name) },
                      }, '重命名')
                    : null)))
          : null,
        listing?.error ? h('div', { className: 'csb-note', style: { marginTop: 10 } }, '这个目录读不出内容（权限不足），可以往上一级继续找。') : null,

        h(Section, { title: '在这里新建子目录', desc: '例如给这个 Bot 建一个专属目录，避免和别的 Bot 抢文件。' }),
        h('div', { className: 'csb-bar' },
          h('input', {
            className: 'csb-in csb-grow', placeholder: '新目录名（字母数字 . _ -）',
            value: newName, onChange: (e) => setNewName(e.target.value),
            onKeyDown: (e) => e.key === 'Enter' && doMkdir(),
          }),
          h('button', { className: 'csb-btn', disabled: !newName.trim(), onClick: doMkdir }, '新建')),

        renaming
          ? h('div', null,
              h(Section, { title: '重命名目录' }),
              h('div', { className: 'csb-bar' },
                h('input', { className: 'csb-in csb-grow', value: renameTo, onChange: (e) => setRenameTo(e.target.value) }),
                h('button', { className: 'csb-btn csb-btn-p', onClick: doRename }, '确认'),
                h('button', { className: 'csb-btn', onClick: () => { setRenaming(null); setRenameTo('') } }, '取消')))
          : null,

        verdict
          ? h('div', { style: { marginTop: 12 } },
              verdict.errors?.length
                ? h('div', { className: 'csb-err' }, `这个目录不能用作 Bot 工作目录：${verdict.errors.join('；')}`)
                : h('div', { className: 'csb-ok' }, '这个目录可以用作 Bot 工作目录'),
              verdict.warnings?.length
                ? h('div', { className: 'csb-note', style: { marginTop: 8 } }, `提醒：${verdict.warnings.join('；')}`)
                : null)
          : null)
    }

    // ── 任务 ────────────────────────────────────────────────────────────────

    function TaskDrawer({ id, bots, workflows, onClose, onChange }) {
      const { data, loading, error, reload } = useApi(`/tasks/detail?id=${encodeURIComponent(id)}`, [id])
      const [err, setErr] = useState(null)
      const [picking, setPicking] = useState(null) // 'complete' | 'abort'
      const [artifacts, setArtifacts] = useState('')
      const [abortReason, setAbortReason] = useState('需求取消')
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
            h('span', { className: 'csb-k' }, '任务编号'), h('span', { className: 'csb-v csb-mono' }, task.id),
            h('span', { className: 'csb-k' }, '谁在做'), h('span', { className: 'csb-v' }, task.ownerId ? botName(bots, task.ownerId) : '还没人领'),
            h('span', { className: 'csb-k' }, '完成前必须先'), h('span', { className: 'csb-v' }, (task.blockedBy ?? []).length ? task.blockedBy.join('、') : '无'),
            h('span', { className: 'csb-k' }, '交付物'), h('span', { className: 'csb-v' }, (task.artifacts ?? []).join('、') || '—'),
            h('span', { className: 'csb-k' }, '验收结果'), h('span', { className: 'csb-v' }, task.acceptance ? `${task.acceptance.result === 'pass' ? '通过' : '打回'} · ${task.acceptance.by}` : '未验收'),
            task.blockedReason ? h('span', { className: 'csb-k' }, '终止原因') : null,
            task.blockedReason ? h('span', { className: 'csb-v' }, task.blockedReason) : null),
          task.description ? h('div', { className: 'csb-pre', style: { marginBottom: 4 } }, task.description) : null,

          h(Section, { title: '可以做什么', desc: '只有和当前状态相符的动作才会显示。' }),
          h('div', { className: 'csb-bar', style: { marginTop: 10 } },
            h('select', {
              className: 'csb-sel', style: { width: 200 }, value: '',
              onChange: (e) => {
                const ownerId = e.target.value
                if (!ownerId) return
                act(() => call('/tasks/assign', { method: 'POST', body: { id: task.id, expectedRev: task.rev, ownerId } }), '指派')
                e.target.value = ''
              },
            },
              h('option', { value: '' }, '指派给某个 Bot…'),
              (bots ?? []).filter((b) => b.state !== 'retired').map((b) =>
                h('option', { key: b.id, value: b.sessionId }, b.name))),
            task.status === 'pending'
              ? h('button', { className: 'csb-btn csb-btn-p', onClick: () => act(() => upd('claim'), '领取') }, '我来做（领取）')
              : null,
            task.status === 'in_progress'
              ? h('button', { className: 'csb-btn csb-btn-p', onClick: () => { setArtifacts(''); setPicking('complete') } }, '标记完成')
              : null,
            task.status === 'completed'
              ? h('button', { className: 'csb-btn csb-btn-p', onClick: () => act(() => call('/tasks/accept', { method: 'POST', body: { id: task.id, result: 'pass' } }), '验收') }, '验收通过')
              : null,
            task.status === 'blocked' ? h('button', { className: 'csb-btn', onClick: () => act(() => upd('reopen'), '重开') }, '重新打开') : null,
            task.status !== 'blocked' && task.status !== 'deleted'
              ? h('button', { className: 'csb-btn csb-btn-d', onClick: () => { setAbortReason('需求取消'); setPicking('abort') } }, '终止任务')
              : null),

          // 高级：租约（原「续租」按钮，普通人看不懂，收进折叠并解释）
          h(Section, { title: '高级：租约', desc: '租约是「我先占着，别人别抢」的凭据。领取任务默认占 5 分钟，长任务需要隔一会儿点一次「延长」，否则会被自动释放回待办。' }),
          task.status === 'in_progress'
            ? h('div', { className: 'csb-bar', style: { marginTop: 10 } },
                h('span', { className: 'csb-set-d' }, task.lease ? `当前占用到 ${fmt(task.lease.expiresAt)}` : '当前没有租约'),
                h('button', { className: 'csb-btn csb-btn-s', onClick: () => act(() => upd('heartbeat'), '延长') }, '延长 5 分钟'))
            : h('div', { className: 'csb-set-d', style: { marginTop: 10 } }, '任务不在进行中，没有租约。'),

          h(Section, { title: '审计流', desc: `共 ${history.length} 条，最新在前` }),
          history.length === 0
            ? h(Empty, { title: '还没有操作记录' })
            : h('div', { className: 'csb-list', style: { marginTop: 10 } },
                history.slice(-40).reverse().map((ev, i) =>
                  h('div', { key: i, className: 'csb-card', style: { padding: '9px 12px' } },
                    h('div', { className: 'csb-card-main' },
                      h('div', { style: { fontSize: 12.5 } }, `${ev.action ?? '?'} · 第 ${ev.rev ?? '?'} 版`),
                      h('div', { className: 'csb-card-m' }, `${ev.byId ?? '?'} · ${fmt(ev.at)}`)))))
        ) : null,

        // 完成 / 终止 的站内弹窗（取代 prompt）
        picking === 'complete'
          ? h(Modal, {
              title: '标记完成',
              onClose: () => setPicking(null),
              footer: [
                h('button', { key: 'c', className: 'csb-btn', onClick: () => setPicking(null) }, '取消'),
                h('button', {
                  key: 'o', className: 'csb-btn csb-btn-p',
                  onClick: async () => {
                    const list = artifacts.split(',').map((s) => s.trim()).filter(Boolean)
                    if (!list.length) return setErr('必须填写交付物 —— 完成要留证据')
                    setPicking(null)
                    await act(() => upd('complete', { artifacts: list }), '完成')
                  },
                }, '确认完成'),
              ],
            },
            h('div', { className: 'csb-fld' },
              h('label', null, '交付物（必填）'),
              h('input', {
                className: 'csb-in', placeholder: '例如 src/api.js, test/api.test.mjs',
                value: artifacts, onChange: (e) => setArtifacts(e.target.value),
                autoFocus: true,
              }),
              h('div', { className: 'csb-fld-h' }, '多个用英文逗号分隔。这是强制的：不留交付物就不算完成。')))
          : null,

        picking === 'abort'
          ? h(Modal, {
              title: '终止任务',
              onClose: () => setPicking(null),
              footer: [
                h('button', { key: 'c', className: 'csb-btn', onClick: () => setPicking(null) }, '取消'),
                h('button', {
                  key: 'o', className: 'csb-btn csb-btn-d',
                  onClick: async () => {
                    setPicking(null)
                    await act(() => call('/tasks/abort', { method: 'POST', body: { id: task.id, expectedRev: task.rev, reason: abortReason } }), '终止')
                  },
                }, '确认终止'),
              ],
            },
            h('div', { className: 'csb-fld' },
              h('label', null, '终止原因'),
              h('input', { className: 'csb-in', value: abortReason, onChange: (e) => setAbortReason(e.target.value) }),
              h('div', { className: 'csb-fld-h' }, '任务会变成「已终止」并保留在列表里，之后可以重新打开。')))
          : null)
    }

    function botName(bots, sessionId) {
      const b = (bots ?? []).find((x) => x.sessionId === sessionId)
      return b ? b.name : short(sessionId, 16)
    }

    function TasksTab() {
      const [filter, setFilter] = useState('')
      const [subject, setSubject] = useState('')
      const [openId, setOpenId] = useState(null)
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState(null)
      const [completing, setCompleting] = useState(null)
      const [artifacts, setArtifacts] = useState('')
      const { data, loading, error, reload } = useApi(`/tasks${filter ? `?status=${filter}` : ''}`, [filter])
      const { data: rosterData } = useApi('/roster')
      const { data: wfData } = useApi('/library/workflows')
      const bots = rosterData?.bots ?? []
      const workflows = wfData?.workflows ?? []
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
        h(Section, {
          title: '任务板',
          desc: '跨会话共享的一块板：任何会话、任何 Bot 看到的都是同一批任务。完成必须填交付物，否则不算完成。',
        }),
        h('div', { className: 'csb-bar', style: { marginTop: 12 } },
          h('input', {
            className: 'csb-in csb-grow', placeholder: '要做什么？（例如：实现登录接口。回车创建）',
            value: subject, onChange: (e) => setSubject(e.target.value),
            onKeyDown: (e) => e.key === 'Enter' && create(),
          }),
          h('button', { className: 'csb-btn csb-btn-p', disabled: busy || !subject.trim(), onClick: create }, '创建任务'),
          h('select', { className: 'csb-sel', style: { width: 116 }, value: filter, onChange: (e) => setFilter(e.target.value) },
            h('option', { value: '' }, '全部状态'),
            h('option', { value: 'pending' }, '待办'),
            h('option', { value: 'in_progress' }, '进行中'),
            h('option', { value: 'completed' }, '已完成'),
            h('option', { value: 'blocked' }, '已终止'))),
        err ? h('div', { className: 'csb-err' }, err) : null,
        error ? h('div', { className: 'csb-err' }, error) : null,
        loading ? h(Skeleton, { n: 3 }) : null,
        !loading && !error && tasks.length === 0
          ? h(Empty, {
              icon: '◫', title: '还没有任务',
              hint: '在上面输入一句话就能建任务。建好后可以指派给某个 Bot，也可以自己领取来做。',
            })
          : null,
        h('div', { className: 'csb-list' }, tasks.map((t) =>
          h('div', { key: t.id, className: 'csb-card csb-card-c', onClick: () => setOpenId(t.id) },
            h(Dot, { status: t.status }),
            h('div', { className: 'csb-card-main' },
              h('div', { className: 'csb-card-t' }, t.subject),
              h('div', { className: 'csb-card-m' },
                h(Badge, { status: t.status }),
                h('span', null, t.ownerId ? `由 ${botName(bots, t.ownerId)} 负责` : '还没人领'),
                (t.blockedBy ?? []).length ? h('span', null, ` · 等 ${t.blockedBy.length} 个前置任务`) : null,
                h('span', null, ` · 第 ${t.rev} 版`))),
            h('div', { style: { display: 'flex', gap: 6, flex: 'none' }, onClick: (e) => e.stopPropagation() },
              t.status === 'pending'
                ? h('button', { className: 'csb-btn csb-btn-s', disabled: busy, onClick: () => quick(t, 'claim') }, '我来做')
                : null,
              t.status === 'in_progress'
                ? h('button', {
                    className: 'csb-btn csb-btn-s csb-btn-p', disabled: busy,
                    onClick: () => { setCompleting(t); setArtifacts('') },
                  }, '完成')
                : null,
              t.status === 'completed'
                ? h('button', {
                    className: 'csb-btn csb-btn-s', disabled: busy,
                    onClick: () => call('/tasks/accept', { method: 'POST', body: { id: t.id, result: 'pass' } }).then(reload).catch((e) => setErr(e.message)),
                  }, '验收')
                : null)))),
        openId ? h(TaskDrawer, { id: openId, bots, workflows, onClose: () => setOpenId(null), onChange: reload }) : null,
        completing
          ? h(Modal, {
              title: `完成：${completing.subject}`,
              onClose: () => setCompleting(null),
              footer: [
                h('button', { key: 'c', className: 'csb-btn', onClick: () => setCompleting(null) }, '取消'),
                h('button', {
                  key: 'o', className: 'csb-btn csb-btn-p',
                  onClick: async () => {
                    const list = artifacts.split(',').map((s) => s.trim()).filter(Boolean)
                    if (!list.length) return setErr('必须填写交付物')
                    const t = completing
                    setCompleting(null)
                    await quick(t, 'complete', { artifacts: list })
                  },
                }, '确认完成'),
              ],
            },
            h('div', { className: 'csb-fld' },
              h('label', null, '交付物（必填）'),
              h('input', {
                className: 'csb-in', placeholder: '例如 src/api.js, test/api.test.mjs',
                value: artifacts, onChange: (e) => setArtifacts(e.target.value), autoFocus: true,
              }),
              h('div', { className: 'csb-fld-h' }, '多个用英文逗号分隔。')) )
          : null)
    }

    // ── 技能库 / 工作流库 ───────────────────────────────────────────────────

    function SkillsTab() {
      const { data, loading, error, reload } = useApi('/library/skills')
      const [editing, setEditing] = useState(null) // null | {} | skill
      const [confirmDel, setConfirmDel] = useState(null)
      const [err, setErr] = useState(null)
      const skills = data?.skills ?? []

      return h('div', { className: 'csb-wrap' },
        h(Section, {
          title: '技能库',
          desc: '可复用的「怎么做某件事」的说明书。建好后可以在 Bot 的档案里关联，Bot 就能在它自己的工作目录里加载到。',
        }),
        h('div', { className: 'csb-bar', style: { marginTop: 12 } },
          h('button', { className: 'csb-btn csb-btn-p', onClick: () => setEditing({}) }, '新建技能')),
        err ? h('div', { className: 'csb-err' }, err) : null,
        error ? h('div', { className: 'csb-err' }, error) : null,
        loading ? h(Skeleton, { n: 2 }) : null,
        !loading && skills.length === 0
          ? h(Empty, { icon: '◇', title: '技能库是空的', hint: '一个技能就是一段说明：这个 Bot 遇到某类任务时应该怎么做。写一次，多个 Bot 都能用。' })
          : null,
        h('div', { className: 'csb-list' }, skills.map((s) =>
          h('div', { key: s.id, className: 'csb-card' },
            h('div', { className: 'csb-card-main' },
              h('div', { className: 'csb-card-t' }, s.name),
              h('div', { className: 'csb-card-m' },
                s.description ? h('span', null, s.description) : h('span', null, '（无说明）'),
                h('span', null, `· 第 ${s.rev} 版`))),
            h('div', { style: { display: 'flex', gap: 6, flex: 'none' } },
              h('button', { className: 'csb-btn csb-btn-s', onClick: () => setEditing(s) }, '编辑'),
              h('button', { className: 'csb-btn csb-btn-s csb-btn-d', onClick: () => setConfirmDel(s) }, '删除'))))),
        editing
          ? h(SkillEditor, {
              skill: editing, onClose: () => setEditing(null),
              onSaved: () => { setEditing(null); reload() },
              onError: setErr,
            })
          : null,
        confirmDel
          ? h(ConfirmModal, {
              title: '删除技能？',
              message: `「${confirmDel.name}」会从技能库移除。\n已经关联了这个技能的 Bot，下次同步时不会再生成对应的技能文件。`,
              danger: true, confirmText: '删除',
              onCancel: () => setConfirmDel(null),
              onConfirm: async () => {
                try {
                  await call('/library/skills/remove', { method: 'POST', body: { id: confirmDel.id, by: 'ui' } })
                  setConfirmDel(null)
                  reload()
                } catch (e) {
                  setErr(e.message)
                  setConfirmDel(null)
                }
              },
            })
          : null)
    }

    function SkillEditor({ skill, onClose, onSaved, onError }) {
      const isNew = !skill.id
      const [form, setForm] = useState({
        name: skill.name ?? '', description: skill.description ?? '', body: skill.body ?? '',
      })
      const save = async () => {
        try {
          if (isNew) {
            await call('/library/skills', { method: 'POST', body: { ...form, by: 'ui' } })
          } else {
            await call('/library/skills/update', {
              method: 'POST',
              body: { id: skill.id, expectedRev: skill.rev, ...form, by: 'ui' },
            })
          }
          onSaved()
        } catch (e) {
          onError(e.message)
          onClose()
        }
      }
      return h(Modal, {
        title: isNew ? '新建技能' : `编辑技能 · ${skill.name}`,
        wide: true,
        onClose,
        footer: [
          h('button', { key: 'c', className: 'csb-btn', onClick: onClose }, '取消'),
          h('button', { key: 's', className: 'csb-btn csb-btn-p', disabled: !form.name.trim() || !form.body.trim(), onClick: save }, '保存'),
        ],
      },
        h('div', { className: 'csb-fld' },
          h('label', null, '技能名'),
          h('input', {
            className: 'csb-in', value: form.name,
            placeholder: '例如 code-review（会成为目录名，只能用字母数字 . _ -）',
            onChange: (e) => setForm({ ...form, name: e.target.value }),
          }),
          h('div', { className: 'csb-fld-h' }, '这个名字会变成工作目录下的 .agents/skills/<名字>/，所以要短、要英文。')),
        h('div', { className: 'csb-fld' },
          h('label', null, '一句话说明'),
          h('input', {
            className: 'csb-in', value: form.description,
            placeholder: '例如：提交前检查测试覆盖与命名规范',
            onChange: (e) => setForm({ ...form, description: e.target.value }),
          })),
        h('div', { className: 'csb-fld' },
          h('label', null, '技能正文'),
          h('textarea', {
            className: 'csb-ta', style: { minHeight: 220 },
            value: form.body,
            placeholder: '写清楚：什么情况下用它、具体步骤、判断标准、常见坑。',
            onChange: (e) => setForm({ ...form, body: e.target.value }),
          })))
    }

    function WorkflowsTab() {
      const { data, loading, error, reload } = useApi('/library/workflows')
      const [editing, setEditing] = useState(null)
      const [confirmDel, setConfirmDel] = useState(null)
      const [err, setErr] = useState(null)
      const workflows = data?.workflows ?? []

      return h('div', { className: 'csb-wrap' },
        h(Section, {
          title: '工作流库',
          desc: '把「一件事的标准步骤」存下来。Bot 可以关联它，任务也可以关联它 —— 目的是让大家按同一套步骤做事，而不是各做各的。',
        }),
        h('div', { className: 'csb-bar', style: { marginTop: 12 } },
          h('button', { className: 'csb-btn csb-btn-p', onClick: () => setEditing({ steps: [{ title: '' }] }) }, '新建工作流')),
        err ? h('div', { className: 'csb-err' }, err) : null,
        error ? h('div', { className: 'csb-err' }, error) : null,
        loading ? h(Skeleton, { n: 2 }) : null,
        !loading && workflows.length === 0
          ? h(Empty, { icon: '⇉', title: '工作流库是空的', hint: '例如「发布流程」：改版本号 → 跑测试 → 打 tag → 推送。存一次，所有任务都能引用。' })
          : null,
        h('div', { className: 'csb-list' }, workflows.map((w) =>
          h('div', { key: w.id, className: 'csb-card' },
            h('div', { className: 'csb-card-main' },
              h('div', { className: 'csb-card-t' }, w.name),
              h('div', { className: 'csb-card-m' },
                w.description ? h('span', null, w.description) : h('span', null, '（无说明）'),
                h('span', null, `· ${(w.steps ?? []).length} 步`),
                h('span', null, `· 第 ${w.rev} 版`))),
            h('div', { style: { display: 'flex', gap: 6, flex: 'none' } },
              h('button', { className: 'csb-btn csb-btn-s', onClick: () => setEditing(w) }, '编辑'),
              h('button', { className: 'csb-btn csb-btn-s csb-btn-d', onClick: () => setConfirmDel(w) }, '删除'))))),
        editing
          ? h(WorkflowEditor, {
              workflow: editing, onClose: () => setEditing(null),
              onSaved: () => { setEditing(null); reload() },
              onError: setErr,
            })
          : null,
        confirmDel
          ? h(ConfirmModal, {
              title: '删除工作流？',
              message: `「${confirmDel.name}」会从工作流库移除。已经关联它的 Bot 和任务不会自动改，只是引用会失效。`,
              danger: true, confirmText: '删除',
              onCancel: () => setConfirmDel(null),
              onConfirm: async () => {
                try {
                  await call('/library/workflows/remove', { method: 'POST', body: { id: confirmDel.id, by: 'ui' } })
                  setConfirmDel(null)
                  reload()
                } catch (e) {
                  setErr(e.message)
                  setConfirmDel(null)
                }
              },
            })
          : null)
    }

    function WorkflowEditor({ workflow, onClose, onSaved, onError }) {
      const isNew = !workflow.id
      const [form, setForm] = useState({
        name: workflow.name ?? '',
        description: workflow.description ?? '',
        steps: (workflow.steps ?? [{ title: '' }]).map((s) => ({ title: s.title ?? '', detail: s.detail ?? '' })),
      })
      const setStep = (i, patch) => {
        const steps = form.steps.map((s, j) => (j === i ? { ...s, ...patch } : s))
        setForm({ ...form, steps })
      }
      const save = async () => {
        const steps = form.steps.filter((s) => s.title.trim())
        if (!steps.length) return onError('至少要有一个步骤')
        try {
          const body = { name: form.name, description: form.description, steps, by: 'ui' }
          if (isNew) await call('/library/workflows', { method: 'POST', body })
          else await call('/library/workflows/update', { method: 'POST', body: { id: workflow.id, expectedRev: workflow.rev, ...body } })
          onSaved()
        } catch (e) {
          onError(e.message)
          onClose()
        }
      }
      return h(Modal, {
        title: isNew ? '新建工作流' : `编辑工作流 · ${workflow.name}`,
        wide: true,
        onClose,
        footer: [
          h('button', { key: 'c', className: 'csb-btn', onClick: onClose }, '取消'),
          h('button', { key: 's', className: 'csb-btn csb-btn-p', disabled: !form.name.trim(), onClick: save }, '保存'),
        ],
      },
        h('div', { className: 'csb-fld' },
          h('label', null, '工作流名'),
          h('input', {
            className: 'csb-in', value: form.name, placeholder: '例如：发布流程',
            onChange: (e) => setForm({ ...form, name: e.target.value }),
          })),
        h('div', { className: 'csb-fld' },
          h('label', null, '一句话说明'),
          h('input', {
            className: 'csb-in', value: form.description, placeholder: '例如：从改版本号到推 tag 的完整步骤',
            onChange: (e) => setForm({ ...form, description: e.target.value }),
          })),
        h('div', { className: 'csb-fld' },
          h('label', null, '步骤'),
          h('div', { className: 'csb-steps' },
            form.steps.map((s, i) =>
              h('div', { key: i, className: 'csb-step-row' },
                h('div', { className: 'csb-step-n' }, String(i + 1)),
                h('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', gap: 6 } },
                  h('input', {
                    className: 'csb-in', placeholder: `第 ${i + 1} 步做什么`,
                    value: s.title, onChange: (e) => setStep(i, { title: e.target.value }),
                  }),
                  h('input', {
                    className: 'csb-in', placeholder: '补充细节（可空）',
                    value: s.detail, onChange: (e) => setStep(i, { detail: e.target.value }),
                  })),
                h('button', {
                  className: 'csb-btn-x',
                  onClick: () => setForm({ ...form, steps: form.steps.filter((_, j) => j !== i) }),
                  'aria-label': '删除这一步',
                }, '×'))),
            h('button', {
              className: 'csb-btn', style: { alignSelf: 'flex-start' },
              onClick: () => setForm({ ...form, steps: [...form.steps, { title: '', detail: '' }] }),
            }, '+ 加一步'))))
    }

    // ── Bot ─────────────────────────────────────────────────────────────────

    function BotsTab() {
      const { data, loading, error, reload } = useApi('/roster?includeRetired=1')
      const { data: presetData } = useApi('/presets')
      const [form, setForm] = useState({ name: '', cwd: '', preset: '' })
      const [picking, setPicking] = useState(false)
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState(null)
      const [warn, setWarn] = useState(null)
      const [profileFor, setProfileFor] = useState(null)
      const [renaming, setRenaming] = useState(null)
      const [renameTo, setRenameTo] = useState('')
      const [retiring, setRetiring] = useState(null)

      const presets = presetData?.presets ?? []
      const defaultPreset = presetData?.defaultId ?? ''
      const bots = data?.bots ?? []

      const create = async () => {
        if (!form.name.trim() || !form.cwd.trim()) return setErr('名字和工作目录都要填')
        setBusy(true)
        setErr(null)
        setWarn(null)
        try {
          const res = await call('/roster', {
            method: 'POST',
            body: { name: form.name.trim(), cwd: form.cwd.trim(), ...(form.preset ? { preset: form.preset } : {}) },
          })
          setForm({ name: '', cwd: '', preset: '' })
          if (res.warnings?.length) setWarn(res.warnings.join('\n'))
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
          if (!hostUiWorkspace?.openSession) return setErr('当前环境不支持跳转到会话，可在左侧会话列表里找它的名字')
          hostUiWorkspace.openSession({ sessionId: bot.sessionId })
        } catch (e) {
          setErr(`无法打开会话：${e.message}`)
        }
      }

      return h('div', { className: 'csb-wrap' },
        h(Section, {
          title: 'Bot 是什么',
          desc: '一个 Bot = 一个长期存在的成员：有自己的会话、自己的工作目录（决定了它能改哪些文件）、自己的身份和经验。只有「需要长期存在 + 需要独立目录」的角色才值得建 Bot。',
        }),

        h(Section, { title: '新建 Bot' }),
        h('div', { className: 'csb-fld', style: { marginTop: 10 } },
          h('label', null, '名字'),
          h('input', {
            className: 'csb-in', style: { maxWidth: 260 }, placeholder: '例如：后端、前端、测试',
            value: form.name, onChange: (e) => setForm({ ...form, name: e.target.value }),
          })),
        h('div', { className: 'csb-fld' },
          h('label', null, '工作目录'),
          h('div', { className: 'csb-bar', style: { marginBottom: 6 } },
            h('input', {
              className: 'csb-in csb-grow', placeholder: '点右边「选择目录」，或直接粘贴绝对路径',
              value: form.cwd, onChange: (e) => setForm({ ...form, cwd: e.target.value }),
            }),
            h('button', { className: 'csb-btn', onClick: () => setPicking(true) }, '选择目录')),
          h('div', { className: 'csb-fld-h' },
            '这个目录就是它的「写入边界」：它只能改这里面的文件。建议每个 Bot 一个独立目录，避免互相覆盖。')),
        h('div', { className: 'csb-fld' },
          h('label', null, '专家身份（预设）'),
          h('select', {
            className: 'csb-sel', style: { maxWidth: 300 }, value: form.preset,
            onChange: (e) => setForm({ ...form, preset: e.target.value }),
          },
            h('option', { value: '' }, `用默认（${defaultPreset || 'standard'}）`),
            presets.map((p) => h('option', { key: p.id, value: p.id }, p.broken ? `${p.name}（当前不可用）` : (p.description ? `${p.name} —— ${p.description}` : p.name)))),
          h('div', { className: 'csb-fld-h' },
            '预设决定「它是哪类专家」：人格、可用工具都不一样。建好后还能在「档案」里补写更具体的身份与经验。')),
        h('div', { className: 'csb-bar' },
          h('button', { className: 'csb-btn csb-btn-p', disabled: busy, onClick: create }, busy ? '创建中…' : '创建 Bot')),
        err ? h('div', { className: 'csb-err' }, err) : null,
        warn ? h('div', { className: 'csb-note' }, warn) : null,

        h(Section, { title: '所有 Bot', desc: `${bots.filter((b) => b.state !== 'retired').length} 个在用` }),
        loading ? h(Skeleton, { n: 2 }) : null,
        error ? h('div', { className: 'csb-err' }, error) : null,
        !loading && bots.length === 0
          ? h(Empty, { icon: '⬡', title: '还没有 Bot', hint: '先在上面建一个。如果只是临时分工，不用建 Bot —— 直接建任务指派给人就行。' })
          : null,
        h('div', { className: 'csb-list', style: { marginTop: 12 } }, bots.map((b) =>
          h('div', { key: b.id, className: 'csb-card' },
            h(Dot, { status: b.state }),
            h('div', { className: 'csb-card-main' },
              h('div', { className: 'csb-card-t' }, b.name),
              h('div', { className: 'csb-card-m' },
                h(Badge, { status: b.state }),
                h('span', null, b.preset ? `身份：${b.preset}` : '身份：默认'),
                h('span', { className: 'csb-mono' }, b.cwd),
                b.profile?.identity ? h('span', { className: 'csb-b csb-b-ok' }, '已写身份') : null,
                (b.profile?.skills ?? []).length ? h('span', { className: 'csb-b' }, `${b.profile.skills.length} 技能`) : null,
                (b.profile?.memory ?? []).length ? h('span', { className: 'csb-b' }, `${b.profile.memory.length} 记忆`) : null)),
            h('div', { style: { display: 'flex', gap: 6, flex: 'none' } },
              b.state !== 'retired' ? h('button', { className: 'csb-btn csb-btn-s csb-btn-p', onClick: () => setProfileFor(b) }, '档案') : null,
              b.state !== 'retired' ? h('button', { className: 'csb-btn csb-btn-s', onClick: () => openSession(b) }, '打开会话') : null,
              b.state !== 'retired'
                ? h('button', { className: 'csb-btn csb-btn-s', onClick: () => { setRenaming(b); setRenameTo(b.name) } }, '改名')
                : null,
              b.state !== 'retired'
                ? h('button', { className: 'csb-btn csb-btn-s csb-btn-d', onClick: () => setRetiring(b) }, '退役')
                : null)))),

        picking ? h(DirPicker, { value: form.cwd, onChange: (p) => setForm({ ...form, cwd: p }), onClose: () => setPicking(false) }) : null,

        renaming
          ? h(Modal, {
              title: `改名 · ${renaming.name}`,
              onClose: () => setRenaming(null),
              footer: [
                h('button', { key: 'c', className: 'csb-btn', onClick: () => setRenaming(null) }, '取消'),
                h('button', {
                  key: 'o', className: 'csb-btn csb-btn-p',
                  onClick: async () => {
                    const b = renaming
                    setRenaming(null)
                    if (renameTo.trim()) await manage(b, 'rename', { name: renameTo.trim() })
                  },
                }, '保存'),
              ],
            },
            h('div', { className: 'csb-fld' },
              h('label', null, '新名字'),
              h('input', { className: 'csb-in', value: renameTo, onChange: (e) => setRenameTo(e.target.value), autoFocus: true }),
              h('div', { className: 'csb-fld-h' }, '名字在未退役的 Bot 之间必须唯一。')))
          : null,

        retiring
          ? h(ConfirmModal, {
              title: `退役 ${retiring.name}？`,
              message: `退役后：\n· 名字会被释放（别的 Bot 可以用这个名字）\n· 目录名额释放\n· **会话和历史都保留**，不会丢\n\n想彻底清掉会话，请到左侧会话列表里归档它。`,
              danger: true, confirmText: '确认退役',
              onCancel: () => setRetiring(null),
              onConfirm: async () => {
                const b = retiring
                setRetiring(null)
                await manage(b, 'retire', { reason: '在界面上退役' })
              },
            })
          : null,

        profileFor
          ? h(BotProfileDrawer, { bot: profileFor, onClose: () => setProfileFor(null), onChange: reload })
          : null)
    }

    /**
     * Bot 档案：身份 / 经验 / 技能 / 工作流 / 记忆。
     * 全部落到官方机制上（AGENTS.md + .agents/skills），不自造运行时。
     */
    function BotProfileDrawer({ bot, onClose, onChange }) {
      const { data, loading, error, reload } = useApi(`/roster/profile?id=${encodeURIComponent(bot.id)}`, [bot.id, bot.rev])
      const { data: libData } = useApi('/library/skills')
      const { data: wfData } = useApi('/library/workflows')
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
            workflows: Array.isArray(p.workflows) ? [...p.workflows] : [],
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
          setMsg(`已保存${res.memory ? `，同步了 ${res.memory.added} 条记忆` : ''}`)
          reload()
          onChange?.()
        } catch (e) {
          setErr(e.message)
        } finally {
          setBusy(false)
        }
      }

      const libSkills = libData?.skills ?? []
      const libWfs = wfData?.workflows ?? []

      return h(Drawer, {
        title: `档案 · ${bot.name}`,
        onClose,
        footer: [
          h('button', { key: 'r', className: 'csb-btn', onClick: () => { setDraft(null); reload() } }, '重新载入'),
          h('button', { key: 's', className: 'csb-btn csb-btn-p', disabled: busy || !draft, onClick: save }, busy ? '保存中…' : '保存档案'),
        ],
      },
        loading ? h(Skeleton, { n: 2 }) : null,
        error ? h('div', { className: 'csb-err' }, error) : null,
        msg ? h('div', { className: 'csb-ok' }, msg) : null,
        err ? h('div', { className: 'csb-err' }, err) : null,
        data && draft ? h('div', null,
          h('div', { className: 'csb-kv' },
            h('span', { className: 'csb-k' }, '工作目录'), h('span', { className: 'csb-v csb-mono' }, bot.cwd),
            h('span', { className: 'csb-k' }, '专家身份'), h('span', { className: 'csb-v' }, bot.preset ?? '默认'),
            h('span', { className: 'csb-k' }, '档案文件'), h('span', { className: 'csb-v csb-mono' }, data.profilePath ?? '—')),
          data.hasOutside
            ? h('div', { className: 'csb-note' }, '你的 AGENTS.md 里还有手写内容 —— 保存档案不会覆盖它，只改 cs-bots 托管的那一段。')
            : null,

          h(Section, { title: '① 身份', desc: '它是谁。这段话会在每次对话开始前进到它的上下文里。' }),
          h('textarea', {
            className: 'csb-ta', style: { marginTop: 10 },
            placeholder: '例如：你是本项目的后端工程师，负责 API 设计、数据模型与数据库迁移；对 SQL 性能负责；拿不准时先给方案再动手。',
            value: draft.identity, onChange: (e) => setDraft({ ...draft, identity: e.target.value }),
          }),

          h(Section, { title: '② 经验与规矩', desc: '它踩过的坑、你定下的规矩。写在这里的每一条，它每次都会看到。' }),
          h('textarea', {
            className: 'csb-ta', style: { marginTop: 10, minHeight: 100 },
            placeholder: '例如：改数据库结构必须先写迁移；禁止直接 force push；测试必须全绿才算完成。',
            value: draft.experience, onChange: (e) => setDraft({ ...draft, experience: e.target.value }),
          }),

          h(Section, { title: '③ 技能', desc: '从技能库挑，或临时加一个名字。勾选的技能会同步到它自己目录下的 .agents/skills/，别的 Bot 看不到。' }),
          h('div', { className: 'csb-pick', style: { marginTop: 10 } },
            libSkills.length === 0
              ? h('div', { className: 'csb-set-d', style: { padding: '8px 9px' } }, '技能库还是空的 —— 先去「技能库」页建一个')
              : libSkills.map((s) =>
                  h('label', { key: s.id, className: 'csb-pick-i' },
                    h('input', {
                      type: 'checkbox',
                      checked: draft.skills.includes(s.name),
                      onChange: (e) => {
                        const next = e.target.checked
                          ? [...draft.skills, s.name]
                          : draft.skills.filter((x) => x !== s.name)
                        setDraft({ ...draft, skills: next })
                      },
                    }),
                    h('span', null, s.name),
                    s.description ? h('span', { className: 'csb-set-d' }, s.description) : null))),
          h('div', { className: 'csb-bar', style: { marginTop: 8 } },
            h('input', {
              className: 'csb-in csb-grow', placeholder: '也可以直接加一个技能名（会生成空白技能文件）',
              value: skillInput, onChange: (e) => setSkillInput(e.target.value),
              onKeyDown: (e) => {
                if (e.key !== 'Enter') return
                const n = skillInput.trim()
                if (!n || draft.skills.includes(n)) return
                setDraft({ ...draft, skills: [...draft.skills, n] })
                setSkillInput('')
              },
            }),
            h('button', {
              className: 'csb-btn',
              onClick: () => {
                const n = skillInput.trim()
                if (!n || draft.skills.includes(n)) return
                setDraft({ ...draft, skills: [...draft.skills, n] })
                setSkillInput('')
              },
            }, '添加')),
          draft.skills.length
            ? h('div', { className: 'csb-tags', style: { marginTop: 8 } },
                draft.skills.map((s) =>
                  h('span', { key: s, className: 'csb-tag' }, s,
                    h('button', { className: 'csb-tag-x', onClick: () => setDraft({ ...draft, skills: draft.skills.filter((x) => x !== s) }) }, '×'))))
            : null,

          h(Section, { title: '④ 工作流', desc: '这个 Bot 干活时该按哪套步骤。勾选后会写进它的身份说明里。' }),
          h('div', { className: 'csb-pick', style: { marginTop: 10 } },
            libWfs.length === 0
              ? h('div', { className: 'csb-set-d', style: { padding: '8px 9px' } }, '工作流库还是空的 —— 先去「工作流库」页建一个')
              : libWfs.map((w) =>
                  h('label', { key: w.id, className: 'csb-pick-i' },
                    h('input', {
                      type: 'checkbox',
                      checked: draft.workflows.includes(w.name),
                      onChange: (e) => {
                        const next = e.target.checked
                          ? [...draft.workflows, w.name]
                          : draft.workflows.filter((x) => x !== w.name)
                        setDraft({ ...draft, workflows: next })
                      },
                    }),
                    h('span', null, w.name),
                    h('span', { className: 'csb-set-d' }, `${(w.steps ?? []).length} 步`)))),

          h(Section, { title: '⑤ 预制记忆', desc: '它一开始就该知道的事实。会写进身份说明，同时存进记忆服务（按 Bot 隔离，可检索）。' }),
          h('div', { className: 'csb-tags', style: { marginTop: 10 } },
            draft.memory.length === 0 ? h('span', { className: 'csb-set-d' }, '（还没有）') : null,
            draft.memory.map((m, i) =>
              h('span', { key: i, className: 'csb-tag', style: { whiteSpace: 'normal', maxWidth: '100%' } },
                m.length > 60 ? `${m.slice(0, 60)}…` : m,
                h('button', { className: 'csb-tag-x', onClick: () => setDraft({ ...draft, memory: draft.memory.filter((_, j) => j !== i) }) }, '×')))),
          h('div', { className: 'csb-bar' },
            h('input', {
              className: 'csb-in csb-grow', placeholder: '例如：生产数据库只读，任何写操作必须走审批',
              value: memInput, onChange: (e) => setMemInput(e.target.value),
              onKeyDown: (e) => {
                if (e.key !== 'Enter') return
                const n = memInput.trim()
                if (!n) return
                setDraft({ ...draft, memory: [...draft.memory, n] })
                setMemInput('')
              },
            }),
            h('button', {
              className: 'csb-btn',
              onClick: () => {
                const n = memInput.trim()
                if (!n) return
                setDraft({ ...draft, memory: [...draft.memory, n] })
                setMemInput('')
              },
            }, '添加')),

          data.managedText
            ? h('div', null,
                h(Section, { title: '它实际读到的内容', desc: '这就是写进 AGENTS.md 托管段的原文，保存后可在工作目录里查看。' }),
                h('div', { className: 'csb-pre', style: { marginTop: 10 } }, data.managedText))
            : null)
          : null)
    }

    // ── 房间 ────────────────────────────────────────────────────────────────

    function RoomsTab() {
      const { data, loading, error, reload } = useApi('/rooms')
      const { data: rosterData } = useApi('/roster')
      const [active, setActive] = useState(null)
      const [msgs, setMsgs] = useState([])
      const [text, setText] = useState('')
      const [roomName, setRoomName] = useState('')
      const [err, setErr] = useState(null)
      const [editing, setEditing] = useState(null)
      const endRef = useRef(null)

      const bots = rosterData?.bots ?? []
      const rooms = data?.rooms ?? []
      const current = rooms.find((r) => r.id === active)

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

      const create = async () => {
        const n = roomName.trim()
        if (!n) return
        setErr(null)
        try {
          const r = await call('/rooms', { method: 'POST', body: { name: n, members: ['user'] } })
          setRoomName('')
          reload()
          setActive(r.room?.id ?? null)
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
      const member = async (op, sessionId) => {
        if (!sessionId || !active) return
        setErr(null)
        try {
          await call(`/rooms/${op}`, { method: 'POST', body: { roomId: active, sessionId } })
          reload()
        } catch (e) {
          setErr(e.message)
        }
      }

      return h('div', { className: 'csb-wrap' },
        h(Section, {
          title: '房间 = 群聊',
          desc: '你的理解基本对：房间就是一群成员共用的消息流。只比普通群聊多两件事 —— 成员是「会话」，而且消息可以直接转发去唤醒某个 Bot。',
        }),
        h('div', { className: 'csb-bar', style: { marginTop: 12 } },
          h('input', {
            className: 'csb-in csb-grow', placeholder: '新建房间…（例如：发布协调群。回车创建）',
            value: roomName, onChange: (e) => setRoomName(e.target.value),
            onKeyDown: (e) => e.key === 'Enter' && create(),
          }),
          h('button', { className: 'csb-btn csb-btn-p', disabled: !roomName.trim(), onClick: create }, '创建房间')),
        err ? h('div', { className: 'csb-err' }, err) : null,
        error ? h('div', { className: 'csb-err' }, error) : null,
        loading ? h(Skeleton, { n: 2 }) : null,
        !loading && rooms.length === 0
          ? h(Empty, { icon: '◌', title: '还没有房间', hint: '建一个房间，然后把 Bot 拉进来，它们就能在同一个消息流里对话。' })
          : null,
        h('div', { className: 'csb-list' }, rooms.map((r) =>
          h('div', {
            key: r.id, className: `csb-card csb-card-c${active === r.id ? ' csb-card-on' : ''}`,
            onClick: () => setActive(r.id),
          },
            h('div', { className: 'csb-card-main' },
              h('div', { className: 'csb-card-t' }, r.name),
              h('div', { className: 'csb-card-m' },
                h('span', null, `${(r.members ?? []).length} 人`),
                h('span', null, `· ${r.mode === 'admin' ? '管理员模式' : '自由发言'}`),
                h('span', null, `· ${r.seq ?? 0} 条消息`))),
            h('button', {
              className: 'csb-btn csb-btn-s', style: { flex: 'none' },
              onClick: (e) => { e.stopPropagation(); setEditing(r) },
            }, '设置')))),
        current ? h('div', null,
          h(Section, { title: `消息 · ${current.name}`, desc: `${msgs.length} 条。发帖者必须是成员。` }),
          current.notice ? h('div', { className: 'csb-note', style: { marginTop: 10 } }, current.notice) : null,
          h('div', { style: { maxHeight: 420, overflowY: 'auto', margin: '12px 0' } },
            msgs.length === 0 ? h(Empty, { title: '还没有消息' }) : null,
            msgs.slice(-100).map((m) =>
              h('div', { key: m.id, className: `csb-msg${m.from === 'user' || m.from === 'ui' ? ' csb-msg-me' : ''}` },
                h('div', { className: 'csb-msg-h' },
                  h('span', null, `#${m.seq}`),
                  h('span', null, botName(bots, m.from)),
                  m.bodyRef ? h('span', { className: 'csb-b' }, '长正文') : null),
                h('div', { className: 'csb-msg-b' }, m.bodyRef ? `（正文较长，已单独存为：${m.bodyRef}）` : m.text))),
            h('div', { ref: endRef })),
          h('div', { className: 'csb-bar' },
            h('input', {
              className: 'csb-in csb-grow', placeholder: '说点什么…（回车发送）',
              value: text, onChange: (e) => setText(e.target.value),
              onKeyDown: (e) => e.key === 'Enter' && post(),
            }),
            h('button', { className: 'csb-btn csb-btn-p', disabled: !text.trim(), onClick: post }, '发送')),
          h(Section, { title: '成员', desc: '勾选要拉进来的 Bot；勾掉就是移出。' }),
          h('div', { className: 'csb-pick', style: { marginTop: 10 } },
            bots.filter((b) => b.state !== 'retired').length === 0
              ? h('div', { className: 'csb-set-d', style: { padding: '8px 9px' } }, '还没有 Bot —— 先去「Bot」页建一个')
              : bots.filter((b) => b.state !== 'retired').map((b) => {
                  const inRoom = (current.members ?? []).includes(b.sessionId)
                  return h('label', { key: b.id, className: 'csb-pick-i' },
                    h('input', {
                      type: 'checkbox', checked: inRoom,
                      onChange: (e) => member(e.target.checked ? 'join' : 'leave', b.sessionId),
                    }),
                    h('span', null, b.name),
                    h('span', { className: 'csb-set-d' }, inRoom ? '已在房间' : '未加入'))
                })))
          : null,
        editing
          ? h(RoomEditor, {
              room: editing, bots,
              onClose: () => setEditing(null),
              onSaved: () => { setEditing(null); reload() },
              onError: setErr,
            })
          : null)
    }

    function RoomEditor({ room, bots, onClose, onSaved, onError }) {
      const [form, setForm] = useState({
        name: room.name ?? '',
        notice: room.notice ?? '',
        mode: room.mode ?? 'everyone',
      })
      const save = async () => {
        try {
          await call('/rooms/update', {
            method: 'POST',
            body: { roomId: room.id, expectedRev: room.rev, ...form, byId: 'user' },
          })
          onSaved()
        } catch (e) {
          onError(e.message)
          onClose()
        }
      }
      return h(Modal, {
        title: `房间设置 · ${room.name}`,
        onClose,
        footer: [
          h('button', { key: 'c', className: 'csb-btn', onClick: onClose }, '取消'),
          h('button', { key: 's', className: 'csb-btn csb-btn-p', onClick: save }, '保存'),
        ],
      },
        h('div', { className: 'csb-fld' },
          h('label', null, '房间名'),
          h('input', { className: 'csb-in', value: form.name, onChange: (e) => setForm({ ...form, name: e.target.value }) })),
        h('div', { className: 'csb-fld' },
          h('label', null, '发言方式'),
          h('select', {
            className: 'csb-sel', value: form.mode,
            onChange: (e) => setForm({ ...form, mode: e.target.value }),
          },
            h('option', { value: 'everyone' }, '自由发言（所有成员都能说话）'),
            h('option', { value: 'admin' }, '管理员模式（只有管理员能改设置）')),
          h('div', { className: 'csb-fld-h' }, `${(room.members ?? []).length} 个成员，${room.seq ?? 0} 条消息`)),
        h('div', { className: 'csb-fld' },
          h('label', null, '房间公告'),
          h('textarea', {
            className: 'csb-ta', value: form.notice,
            placeholder: '例如：本房间只讨论发布相关事项；发版前 24 小时冻结代码。',
            onChange: (e) => setForm({ ...form, notice: e.target.value }),
          }),
          h('div', { className: 'csb-fld-h' }, '公告会显示在消息列表上方。')))
    }

    // ── 记忆 ────────────────────────────────────────────────────────────────

    const LAYERS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5']
    const LAYER_HINT = { L0: '人格（仅人可改）', L1: '用户偏好', L2: '团队规矩', L3: '分支专属', L4: '任务笔记', L5: '归档' }

    function MemoryTab() {
      const [layer, setLayer] = useState('')
      const [query, setQuery] = useState('')
      const [err, setErr] = useState(null)
      const [adding, setAdding] = useState(false)
      const [newLayer, setNewLayer] = useState('L2')
      const [newContent, setNewContent] = useState('')
      const [ctxPreview, setCtxPreview] = useState(null)
      const [confirmDel, setConfirmDel] = useState(null)
      const path = `/memory${query ? `?query=${encodeURIComponent(query)}` : layer ? `?layer=${layer}` : ''}`
      const { data, loading, error, reload } = useApi(path, [layer, query])
      const entries = data?.entries ?? []
      const act = (p, body) => call(p, { method: 'POST', body }).then(reload).catch((e) => setErr(e.message))

      const add = async () => {
        if (!newContent.trim()) return
        setErr(null)
        try {
          await call('/memory', { method: 'POST', body: { layer: newLayer, content: newContent.trim(), by: 'user' } })
          setNewContent('')
          setAdding(false)
          reload()
        } catch (e) {
          setErr(e.message)
        }
      }

      return h('div', { className: 'csb-wrap' },
        h(Section, {
          title: '记忆',
          desc: 'L0–L3 会一直注入到上下文里（模型每轮都看得到）；L4/L5 按需检索。标了「explicit」的条目是你明确说的，自动整理只能建议、不能改。',
        }),
        h('div', { className: 'csb-bar', style: { marginTop: 12 } },
          h('select', { className: 'csb-sel', style: { width: 176 }, value: layer, onChange: (e) => setLayer(e.target.value) },
            h('option', { value: '' }, '全部层'),
            LAYERS.map((l) => h('option', { key: l, value: l }, `${l} · ${LAYER_HINT[l]}`))),
          h('input', {
            className: 'csb-in csb-grow', placeholder: '搜记忆…',
            value: query, onChange: (e) => setQuery(e.target.value),
          }),
          h('button', { className: 'csb-btn csb-btn-p', onClick: () => setAdding(true) }, '新建条目'),
          h('button', {
            className: 'csb-btn',
            onClick: () => call('/memory/context').then((d) => setCtxPreview(d.text)).catch((e) => setErr(e.message)),
          }, '看注入效果')),
        err ? h('div', { className: 'csb-err' }, err) : null,
        error ? h('div', { className: 'csb-err' }, error) : null,
        loading ? h(Skeleton, { n: 3 }) : null,
        !loading && entries.length === 0
          ? h(Empty, { icon: '◇', title: '还没有记忆条目', hint: '把「事实」和「规矩」写进来，模型每次都能看到。任务笔记这类一次性的放 L4。' })
          : null,
        h('div', { className: 'csb-list' }, entries.map((e) =>
          h('div', { key: e.id, className: 'csb-card' },
            h('div', { className: 'csb-card-main' },
              h('div', { className: 'csb-card-t2' }, e.content),
              h('div', { className: 'csb-card-m' },
                h('span', { className: 'csb-b' }, `${e.layer} ${LAYER_HINT[e.layer] ?? ''}`),
                e.botId ? h('span', { className: 'csb-b' }, `属于 Bot ${short(e.botId, 10)}`) : h('span', { className: 'csb-b' }, '全局'),
                e.explicit ? h('span', { className: 'csb-b csb-b-ok' }, 'explicit') : null,
                e.conflict ? h('span', { className: 'csb-b csb-b-err' }, '与另一条冲突') : null,
                e.archived ? h('span', { className: 'csb-b csb-b-idle' }, '已归档') : null,
                h('span', null, `· 第 ${e.rev} 版`))),
            h('div', { style: { display: 'flex', gap: 6, flex: 'none' } },
              e.archived
                ? h('button', { className: 'csb-btn csb-btn-s', onClick: () => act('/memory/restore', { layer: e.layer, id: e.id }) }, '恢复')
                : h('button', { className: 'csb-btn csb-btn-s', onClick: () => act('/memory/archive', { layer: e.layer, id: e.id, reason: '过时' }) }, '归档'),
              h('button', { className: 'csb-btn csb-btn-s csb-btn-d', onClick: () => setConfirmDel(e) }, '删除'))))),

        adding
          ? h(Modal, {
              title: '新建记忆条目',
              onClose: () => setAdding(false),
              footer: [
                h('button', { key: 'c', className: 'csb-btn', onClick: () => setAdding(false) }, '取消'),
                h('button', { key: 's', className: 'csb-btn csb-btn-p', disabled: !newContent.trim(), onClick: add }, '保存'),
              ],
            },
            h('div', { className: 'csb-fld' },
              h('label', null, '放在哪一层'),
              h('select', { className: 'csb-sel', value: newLayer, onChange: (e) => setNewLayer(e.target.value) },
                LAYERS.filter((l) => l !== 'L0').map((l) => h('option', { key: l, value: l }, `${l} · ${LAYER_HINT[l]}`))),
              h('div', { className: 'csb-fld-h' }, 'L0 是人格层，只能通过配置改，界面不给写。')),
            h('div', { className: 'csb-fld' },
              h('label', null, '内容'),
              h('textarea', {
                className: 'csb-ta', value: newContent,
                placeholder: '例如：本项目只用 pnpm，不用 npm。',
                onChange: (e) => setNewContent(e.target.value),
              }),
              h('div', { className: 'csb-fld-h' }, `${newContent.length} / 600 字符，超长会自动切分存储。`)))
          : null,

        ctxPreview !== null
          ? h(Modal, {
              title: '模型实际看到的记忆',
              wide: true,
              onClose: () => setCtxPreview(null),
              footer: [h('button', { key: 'c', className: 'csb-btn', onClick: () => setCtxPreview(null) }, '关闭')],
            }, h('div', { className: 'csb-pre' }, ctxPreview || '（空）'))
          : null,

        confirmDel
          ? h(ConfirmModal, {
              title: '删除这条记忆？',
              message: `内容：${confirmDel.content.slice(0, 80)}\n\n删除后模型不会再看到它。如果只是想暂时不用，建议「归档」而不是删除。`,
              danger: true, confirmText: '删除',
              onCancel: () => setConfirmDel(null),
              onConfirm: async () => {
                const e = confirmDel
                setConfirmDel(null)
                await act('/memory/remove', { layer: e.layer, id: e.id })
              },
            })
          : null)
    }

    // ── 设置 ────────────────────────────────────────────────────────────────

    const NUM_META = {
      defaultLeaseMs: { scale: 60000, unit: '分钟', step: 1 },
      throttleMs: { scale: 1000, unit: '秒', step: 1 },
      wakeTtlMs: { scale: 3600000, unit: '小时', step: 1 },
      maxWakesPerTarget: { scale: 1, unit: '条', step: 10 },
      memoryEntryMax: { scale: 1, unit: '字符', step: 50 },
    }
    const PLAIN = {
      defaultLeaseMs: { label: '任务占用时长', help: '领取任务后「占着」多久。超过这个时间没动静，任务会自动放回待办，别人可以接手。' },
      throttleMs: { label: '唤醒最小间隔', help: '同一个 Bot 在这段时间内最多被唤醒一次，防止刷屏。' },
      maxWakesPerTarget: { label: '单个 Bot 待处理唤醒上限', help: '排队超过这个数量就丢弃新的，避免堆积。' },
      wakeTtlMs: { label: '唤醒记录保留时长', help: '多久以前的唤醒记录可以清掉。' },
      memoryEntryMax: { label: '单条记忆字数上限', help: '超过就自动切成多条存（不丢内容）。' },
      memorySplitOnOverflow: { label: '超长记忆自动切分', help: '打开：切分存储。关闭：直接拒收。' },
      k1Enabled: { label: '禁止 Bot 阻塞式提问', help: 'Bot 会话里禁用「停下来等人回答」的工具，避免整条消息链被卡住。排查问题时才临时关。' },
    }

    function NumberRow({ id, spec, value, onChange }) {
      const meta = NUM_META[id] ?? { scale: 1, unit: '', step: 1 }
      const disp = Math.round(Number(value) / meta.scale)
      const min = Math.round(spec.min / meta.scale)
      const max = Math.round(spec.max / meta.scale)
      const [raw, setRaw] = useState(String(disp))
      useEffect(() => setRaw(String(disp)), [disp])
      const commit = (n) => {
        if (!Number.isFinite(n) || n < min || n > max) return setRaw(String(disp))
        onChange(Math.round(n * meta.scale))
      }
      const bump = (d) => {
        const next = Math.min(max, Math.max(min, (Number(raw) || disp) + d * meta.step))
        setRaw(String(next))
        commit(next)
      }
      const info = PLAIN[id] ?? {}
      return h('div', { className: 'csb-set' },
        h('div', { className: 'csb-set-l' },
          h('label', null, info.label ?? spec.label ?? id),
          h('div', { className: 'csb-set-d' },
            info.help ?? '',
            ` 默认 ${Math.round(spec.def / meta.scale)} ${meta.unit}，可填 ${min}–${max}。`)),
        h('div', { className: 'csb-set-c' },
          h('button', { className: 'csb-step', onClick: () => bump(-1), 'aria-label': '减少' }, '−'),
          h('span', { className: 'csb-num' },
            h('input', {
              className: 'csb-in', type: 'text', inputMode: 'numeric', value: raw,
              onChange: (e) => setRaw(e.target.value.replace(/[^\d.-]/g, '')),
              onBlur: () => commit(Number(raw)),
              onKeyDown: (e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
                if (e.key === 'Escape') setRaw(String(disp))
              },
            }),
            h('span', { className: 'csb-unit' }, meta.unit)),
          h('button', { className: 'csb-step', onClick: () => bump(1), 'aria-label': '增加' }, '+')))
    }

    function BoolRow({ id, spec, value, onChange }) {
      const info = PLAIN[id] ?? {}
      return h('div', { className: 'csb-set' },
        h('div', { className: 'csb-set-l' },
          h('label', null, info.label ?? spec.label ?? id),
          h('div', { className: 'csb-set-d' }, info.help ?? '')),
        h('div', { className: 'csb-set-c' },
          h(Switch, { checked: value === true, onChange }),
          h('span', { className: 'csb-sw-t' }, value === true ? '开' : '关')))
    }

    function SettingsBody() {
      const { data, loading, error, reload } = useApi('/settings')
      const { data: statusData, reload: reloadStatus } = useApi('/status')
      const { data: libData } = useApi('/library/skills')
      const { data: wfData } = useApi('/library/workflows')
      const [draft, setDraft] = useState({})
      const [msg, setMsg] = useState(null)
      const [err, setErr] = useState(null)
      const [busy, setBusy] = useState(false)
      const [openDiag, setOpenDiag] = useState(false)
      const [resetting, setResetting] = useState(false)

      const specs = data?.specs ?? {}
      const values = data?.values ?? {}
      const svc = statusData?.services ?? {}
      const compat = statusData?.compat ?? null
      const avail = compat?.available ?? {}
      const okCount = Object.values(avail).filter(Boolean).length
      const totalCount = Object.keys(avail).length || 0
      const svcOk = Object.values(svc).filter((v) => v?.available).length
      const svcTotal = Object.keys(svc).length || 0
      const val = (id) => (id in draft ? draft[id] : values[id])
      const dirty = Object.keys(draft).some((k) => String(draft[k]) !== String(values[k]))
      const changedCount = Object.keys(specs).filter((k) => String(values[k]) !== String(specs[k].def)).length

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

        h(Section, { title: '概览', desc: '现在平台里有多少东西在跑。' }),
        h('div', { className: 'csb-stats', style: { marginTop: 12 } },
          [['任务', svc.board?.stats?.total], ['Bot', svc.roster?.stats?.total],
           ['房间', svc.room?.stats?.total], ['记忆', svc.memory?.stats?.total],
           ['技能', (libData?.skills ?? []).length], ['工作流', (wfData?.workflows ?? []).length]]
            .map(([l, n]) => h('div', { key: l, className: 'csb-stat' },
              h('div', { className: 'csb-stat-n' }, n ?? '—'),
              h('div', { className: 'csb-stat-l' }, l)))),

        h(Section, { title: '系统体检', desc: '出问题时把这一段发回开发者，能直接定位。' }),
        h('div', { className: 'csb-fold' },
          h('div', { className: 'csb-bar', style: { marginBottom: 0 } },
            h('span', { className: `csb-dot${svcTotal && svcOk === svcTotal ? ' csb-dot-ok' : svcOk < svcTotal ? ' csb-dot-err' : ''}` }),
            h('span', { className: 'csb-set-d', style: { flex: 1 } },
              totalCount && okCount === totalCount
                ? `一切正常：${totalCount} 项能力全部就绪，${svcTotal} 个服务都在跑。`
                : `${okCount}/${totalCount || '?'} 项能力就绪${okCount < totalCount ? '，部分功能已降级' : ''}。`),
            h('button', { className: 'csb-btn csb-btn-s', onClick: () => setOpenDiag(!openDiag) }, openDiag ? '收起' : '看详情')),
          h('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 10 } },
            Object.entries(avail).map(([k, ok]) =>
              h('span', { key: k, className: `csb-dot${ok ? ' csb-dot-ok' : ' csb-dot-err'}`, title: `${k}：${ok ? '就绪' : '缺失'}` }))),
          openDiag
            ? h('div', null,
                h('div', { className: 'csb-kv', style: { marginTop: 14, marginBottom: 10 } },
                  h('span', { className: 'csb-k' }, 'DSH 版本'), h('span', { className: 'csb-v csb-mono' }, compat?.dshVersion ?? '未探到'),
                  h('span', { className: 'csb-k' }, 'Node 版本'), h('span', { className: 'csb-v csb-mono' }, compat?.node ?? '—'),
                  h('span', { className: 'csb-k' }, '数据目录'), h('span', { className: 'csb-v csb-mono' }, data?.baseDir ?? '—')),
                h('div', { className: 'csb-list' },
                  Object.keys(svc).map((k) =>
                    h('div', { key: k, className: 'csb-card', style: { padding: '9px 12px' } },
                      h('span', { className: `csb-dot${svc[k]?.available ? ' csb-dot-ok' : ' csb-dot-err'}` }),
                      h('div', { className: 'csb-card-main' }, h('div', { style: { fontSize: 12.5 } }, k)),
                      h('span', { className: 'csb-set-d' }, svc[k]?.available ? '正常' : '未装配')))),
                (compat?.missing ?? []).length
                  ? h('div', { className: 'csb-note', style: { marginTop: 12 } }, `缺少：${compat.missing.join('、')}（相关功能降级，但不影响启动）`)
                  : null)
            : null),

        h(Section, { title: '任务与提醒', desc: '影响任务能占多久、以及 Bot 被唤醒的频率。' }),
        TASK_KEYS.filter((k) => specs[k]).map((k) =>
          specs[k].bool
            ? h(BoolRow, { key: k, id: k, spec: specs[k], value: val(k), onChange: (v) => setDraft({ ...draft, [k]: v }) })
            : h(NumberRow, { key: k, id: k, spec: specs[k], value: val(k), onChange: (v) => setDraft({ ...draft, [k]: v }) })),

        h(Section, { title: '记忆与安全', desc: '影响记忆怎么存、Bot 能不能停下来等人回答。' }),
        MEM_KEYS.filter((k) => specs[k]).map((k) =>
          specs[k].bool
            ? h(BoolRow, { key: k, id: k, spec: specs[k], value: val(k), onChange: (v) => setDraft({ ...draft, [k]: v }) })
            : h(NumberRow, { key: k, id: k, spec: specs[k], value: val(k), onChange: (v) => setDraft({ ...draft, [k]: v }) })),

        h('div', { className: 'csb-bar', style: { marginTop: 20 } },
          h('button', { className: 'csb-btn csb-btn-p', disabled: !dirty || busy, onClick: save }, busy ? '保存中…' : dirty ? '保存改动' : '没有改动'),
          h('button', { className: 'csb-btn', disabled: !Object.keys(draft).length, onClick: () => { setDraft({}); setMsg(null); setErr(null) } }, '撤销'),
          h('div', { className: 'csb-spacer' }),
          h('button', { className: 'csb-btn', onClick: () => { reload(); reloadStatus() } }, '刷新')),
        h('div', { className: 'csb-fld-h', style: { marginTop: 8 } }, '这些参数存在数据目录的 settings.json 里；改完要重启 DSH 才真正生效。'),

        h(Section, { title: '维护', desc: '不可撤销的操作，请先核对影响范围。' }),
        h('div', { className: 'csb-set' },
          h('div', { className: 'csb-set-l' },
            h('label', null, '恢复默认参数'),
            h('div', { className: 'csb-set-d' }, `把上面所有参数恢复出厂值。当前有 ${changedCount} 项被改过。只影响参数，不删除任务、Bot、房间或记忆。`)),
          h('div', { className: 'csb-set-c' },
            h('button', { className: 'csb-btn csb-btn-d', onClick: () => setResetting(true) }, '恢复默认'))),

        resetting
          ? h(ConfirmModal, {
              title: '恢复默认参数？',
              message: (() => {
                const changed = Object.keys(specs).filter((k) => String(values[k]) !== String(specs[k].def))
                if (!changed.length) return '当前所有参数都是默认值，无需恢复。'
                return `以下 ${changed.length} 项会变成：\n` +
                  changed.map((k) => `· ${PLAIN[k]?.label ?? k}：${values[k]} → ${specs[k].def}`).join('\n') +
                  '\n\n只改参数，不动业务数据。'
              })(),
              confirmText: '恢复默认',
              onCancel: () => setResetting(false),
              onConfirm: async () => {
                const patch = {}
                for (const [k, s] of Object.entries(specs)) patch[k] = s.def
                try {
                  await call('/settings', { method: 'POST', body: patch })
                  setDraft({})
                  setMsg('已恢复默认参数')
                  reload()
                } catch (e) {
                  setErr(e.message)
                } finally {
                  setResetting(false)
                }
              },
            })
          : null)
    }

    // ── 主面板 ──────────────────────────────────────────────────────────────

    const TABS = [
      { id: 'tasks', label: '任务', Comp: TasksTab },
      { id: 'bots', label: 'Bot', Comp: BotsTab },
      { id: 'rooms', label: '房间', Comp: RoomsTab },
      { id: 'memory', label: '记忆', Comp: MemoryTab },
      { id: 'skills', label: '技能库', Comp: SkillsTab },
      { id: 'workflows', label: '工作流库', Comp: WorkflowsTab },
      { id: 'settings', label: '设置', Comp: SettingsBody },
    ]

    function Workbench() {
      const [tab, setTab] = useState('tasks')
      const current = TABS.find((t) => t.id === tab) ?? TABS[0]
      const Comp = current.Comp
      return h('div', { className: 'csb' },
        h('div', { className: 'csb-head' },
          h('div', { className: 'csb-hrow' },
            h('h2', null, '协作平台'),
            h('span', { className: 'csb-hint' }, '任务 · Bot · 房间 · 记忆 · 技能 · 工作流')),
          h('div', { className: 'csb-tabs', role: 'tablist' },
            TABS.map((t) =>
              h('button', {
                key: t.id, role: 'tab', 'aria-selected': t.id === tab,
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
      bindHost(ctx)
      const disposers = []
      try {
        const d = installStyles()
        if (typeof d === 'function') disposers.push(d)
      } catch {}

      const reg = (label, slot, factory) => {
        try {
          disposers.push(ctx.slots.inject(slot, () => ctx.slots.register(factory(), undefined)))
        } catch (error) {
          try {
            console.warn(`[cs-bots] 注册 ${label} 失败：`, error)
          } catch {}
        }
      }

      // 顺序锁死：main 必须在 panellist 之前
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
      // 设置也挂到官方设置面板
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
    exports.SkillsTab = SkillsTab
    exports.WorkflowsTab = WorkflowsTab
    exports.SettingsBody = SettingsBody
    exports.BotProfileDrawer = BotProfileDrawer
    exports.DirPicker = DirPicker
    exports.Modal = Modal
    exports.ConfirmModal = ConfirmModal
    exports.PANEL_ID = PANEL_ID
    exports.API = API

    return module.exports
  },
})
