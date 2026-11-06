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
      if (!data || data.ok === false) {
        const err = new Error(data?.reason ?? data?.message ?? `HTTP ${res.status}`)
        // 后端 code 必须带出来：humanizeError 靠它映射「人话 + 下一步」
        if (data?.code) err.code = data.code
        if (data?.details) err.details = data.details
        throw err
      }
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
.csb-subtabs{display:flex;gap:4px;padding:8px 0 10px;overflow-x:auto;border-top:1px solid var(--dsw-alias-border-l1);margin-top:8px}
.csb-subtab{padding:5px 11px;border-radius:999px;border:1px solid transparent;background:transparent;
  cursor:pointer;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:12.5px;font-family:inherit}
.csb-subtab:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.csb-subtab-on{color:var(--dsw-alias-label-primary);font-weight:500;
  background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.csb-room-split{display:flex;gap:16px;align-items:flex-start}
.csb-room-chat{flex:1;min-width:0}
.csb-room-side{width:280px;flex-shrink:0}
@media(max-width:900px){.csb-room-split{flex-direction:column}.csb-room-side{width:100%}}
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

.csb-field{display:flex;flex-direction:column;gap:5px;margin-bottom:14px}
.csb-field-l{font-size:12.5px;font-weight:500}
.csb-field-h{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.5}
.csb-field-c{display:flex;flex-direction:column;gap:6px}
.csb-notice{display:flex;align-items:center;gap:8px;padding:9px 12px;border-radius:9px;margin-bottom:12px;
  font-size:12.5px;border:1px solid transparent}
.csb-notice-t{flex:1;min-width:0}
.csb-notice-ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);
  border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 35%,transparent)}
.csb-notice-err{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);
  border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent)}
.csb-b-warn{color:var(--dsw-alias-state-warning-primary);
  border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary) 40%,transparent)}
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
.csb-empty-a{margin-top:2px}

/* 可读错误框：人话正文 + 后端原文（折叠）+ 下一步按钮 */
.csb-err-box{padding:10px 12px;border-radius:10px;font-size:12.5px;margin-bottom:14px;line-height:1.6;
  color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-1);
  border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent)}
.csb-err-text{font-weight:500}
.csb-err-raw{margin-top:8px}
.csb-err-raw summary{cursor:pointer;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.csb-err-raw pre{margin:6px 0 0;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;wordBreak:break-all}
.csb-err-box .csb-btn{margin-top:8px}
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
  border:1px solid var(--dsw-alias-border-l1);max-width:78%;display:inline-block}
.csb-msg-me{background:var(--dsw-alias-bg-layer-2);margin-left:auto}
.csb-msg-row{display:flex;flex-direction:column;margin-bottom:8px}
.csb-msg-row-me{align-items:flex-end}
.csb-msg-h{display:flex;align-items:center;gap:7px;margin-bottom:3px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.csb-msg-b{font-size:12.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
.csb-msg-time{font-size:10px;color:var(--dsw-alias-label-tertiary);margin-top:2px}
.csb-msg-sender{font-weight:600}
.csb-progress{height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;margin:4px 0}
.csb-progress-fill{height:100%;background:var(--dsw-alias-label-primary);transition:width .2s}
.csb-kv-progress{display:flex;align-items:center;gap:8px}

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
    /**
     * 空状态：icon + title + hint + 可选的「去建一个」CTA。
     *
     * 为什么必须有 action：只有提示没有按钮的空态等于把用户卡住 ——
     * 他知道该建，但不知道去哪儿建。CTA 直接打开本页的创建表单。
     */
    function Empty({ icon, title, hint, action }) {
      return h('div', { className: 'csb-empty' },
        icon ? h('div', { className: 'csb-empty-i' }, icon) : null,
        h('div', { className: 'csb-empty-t' }, title),
        hint ? h('div', { className: 'csb-empty-h' }, hint) : null,
        action
          ? h('button', {
              className: 'csb-btn csb-btn-p csb-empty-a',
              onClick: action.onClick,
            }, (action.icon ?? '＋') + ' ' + action.label)
          : null)
    }

    /**
     * 错误码 → 人话 + 下一步建议（详见 design/UX-实现规格-v1.md §8）。
     *
     * 8 个 code 全部覆盖；`actionLabel` 是按钮文字，`hint` 是展开后的后端原文说明。
     * 未在表内的 code 走兜底：显示后端原文，不猜建议。
     */
    const ERROR_MAP = {
      BOARD_WIP_EXCEEDED: {
        actionLabel: '查看我的任务',
        text: '你已经在管 N 个任务了（上限 M），先完成或释放一些再接新的',
        hint: 'WIP 超限：同一 Bot 名下进行中的任务数达到上限',
      },
      BOARD_LEASE_HELD: {
        actionLabel: '查看持有者',
        text: '这个任务正由另一个 Bot 在做，等它完成或租约过期',
        hint: '租约被占用：任务上有未过期的租约，持有者不是当前操作者',
      },
      BOARD_NOT_READY: {
        actionLabel: '查看前置任务',
        text: '这个任务的前置任务还没做完，等前置完成才能开始',
        hint: '依赖未完成：blockedBy 里还有未 completed 的任务',
      },
      BOARD_ALREADY_COMPLETED: {
        actionLabel: null,
        text: '这个任务已经完成了，不用再操作',
        hint: '任务已完成：已完成/已删除的任务不能再 claim/complete/block',
      },
      BOARD_DEPENDENCY_CYCLE: {
        actionLabel: '查看依赖图',
        text: '任务之间的依赖关系成了环，检查一下谁依赖谁',
        hint: '依赖成环：blockedBy 构成环，任务永远等不到完成',
      },
      BOARD_REV_CONFLICT: {
        actionLabel: '刷新',
        text: '这个任务刚被别人改过，刷新一下再操作',
        hint: 'rev 不匹配：expectedRev 与当前 rev 不一致（CAS 拒绝静默覆盖）',
      },
      CAS_MISMATCH: {
        actionLabel: '刷新',
        text: '这个任务刚被别人改过，刷新一下再操作',
        hint: 'rev 不匹配：expectedRev 与当前 rev 不一致（CAS 拒绝静默覆盖）',
      },
      BOARD_TASK_DELETED: {
        actionLabel: null,
        text: '这个任务已经被删除了',
        hint: '任务已删除：已删除（tombstone）的任务不能再操作',
      },
      BOARD_APPEND_FAILED: {
        actionLabel: null,
        text: '写入失败了，可能是磁盘或权限问题，请检查状态目录',
        hint: '事件追加失败：拒绝「只改内存不落盘」',
      },
    }

    /**
     * 错误可读映射：后端 code → 人话 + 下一步建议。
     *
     * 为什么：后端 message 只描述「发生了什么」（还夹着 id/rev），
     * 用户看完仍然不知道**接下来该做什么**。高频冲突（WIP 超限、租约占用、
     * rev 冲突）恰恰是最需要下一步的，所以按 code 映射。
     *
     * 后端 message 仍保留在 hint 里 —— 定位信息（哪个任务 / 哪个 Bot）不能丢。
     *
     * `handlers` 由调用点按上下文注入（每个页签的「下一步」不一样：
     * TasksTab 的「查看我的任务」是清除过滤，TaskDrawer 的「刷新」是 reload）。
     */
    function humanizeError(e, handlers, prefix) {
      const code = e?.code ?? e?.data?.code ?? null
      const detail = e?.message ?? e?.data?.reason ?? e?.reason ?? String(e ?? '未知错误')
      const hit = ERROR_MAP[code]
      const out = {
        code: code ?? 'UNKNOWN',
        text: hit ? hit.text : `出错了：${detail}`,
        hint: hit ? hintOf(hit, e) : detail,
        actionLabel: hit?.actionLabel ?? null,
      }
      if (prefix) out.text = `${prefix}${out.text}`
      if (hit?.actionLabel && handlers) {
        const fn = handlers[code]
        if (typeof fn === 'function') out.action = { label: hit.actionLabel, onClick: fn }
      }
      return out
    }

    /** 把后端 details 拼成一行定位信息（如「当前 2 个 / 上限 1 个」）。 */
    function hintOf(hit, e) {
      const d = e?.data?.details ?? e?.details
      if (!d) return hit.hint
      const parts = []
      if (d.limit !== undefined && d.current !== undefined) parts.push(`当前 ${d.current} 个 / 上限 ${d.limit} 个`)
      if (d.ownerId) parts.push(`持有者 ${d.ownerId}`)
      if (d.expectedRev !== undefined && d.rev !== undefined) parts.push(`期望 rev=${d.expectedRev}，实际 rev=${d.rev}`)
      if (d.taskId) parts.push(`任务 ${d.taskId}`)
      return parts.length ? `${hit.hint}（${parts.join('，')}）` : hit.hint
    }

    /** 可读错误框：人话正文 + 后端原文（可展开）+ 下一步按钮。 */
    function ErrBox({ humanized, onAction }) {
      return h('div', { className: 'csb-err-box' },
        h('div', { className: 'csb-err-text' }, humanized.text),
        humanized.hint ? h('details', { className: 'csb-err-raw' },
          h('summary', null, '后端原文'),
          h('pre', null, humanized.hint)) : null,
        humanized.action
          ? h('button', { className: 'csb-btn csb-btn-s', onClick: () => onAction?.(humanized.code) ?? humanized.action.onClick?.() }, humanized.action.label)
          : null)
    }

    function Section({ title, desc, children }) {
      return h('div', { className: 'csb-sec' },
        h('h4', null, title),
        desc ? h('p', null, desc) : null,
        children)
    }

    /** 复制文本（带降级）。失败要**显式告知**，不许静默假装复制成功。 */
    function copyText(text) {
      try {
        if (navigator.clipboard?.writeText) {
          return navigator.clipboard.writeText(text).then(
            () => true,
            () => {
              try {
                const ta = document.createElement('textarea')
                ta.value = text
                ta.style.position = 'fixed'
                ta.style.opacity = '0'
                document.body.appendChild(ta)
                ta.select()
                const ok = document.execCommand('copy')
                document.body.removeChild(ta)
                return ok
              } catch { return false }
            },
          )
        }
        try {
          const ta = document.createElement('textarea')
          ta.value = text
          ta.style.position = 'fixed'
          ta.style.opacity = '0'
          document.body.appendChild(ta)
          ta.select()
          const ok = document.execCommand('copy')
          document.body.removeChild(ta)
          return Promise.resolve(ok)
        } catch { return Promise.resolve(false) }
      } catch { return Promise.resolve(false) }
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
      // 「下一步」按钮的落点（spec §8）
      const errHandlers = {
        BOARD_REV_CONFLICT: reload,
        CAS_MISMATCH: reload,
        BOARD_LEASE_HELD: () => {},
        BOARD_NOT_READY: () => {},
        BOARD_DEPENDENCY_CYCLE: () => {},
      }
      const act = async (fn, label) => {
        setErr(null)
        try {
          await fn()
          reload()
          onChange?.()
        } catch (e) {
          setErr(humanizeError(e, errHandlers, `${label}失败：`))
        }
      }
      const upd = (action, extra) =>
        call('/tasks/update', { method: 'POST', body: { id: task.id, expectedRev: task.rev, action, ...(extra ?? {}) } })

      return h(Drawer, { title: task?.subject ?? id, onClose },
        loading ? h(Skeleton, { n: 2 }) : null,
        error ? h('div', { className: 'csb-err' }, error) : null,
        err ? h(ErrBox, { humanized: err, onAction: (c) => errHandlers[c]?.() }) : null,
        task ? h('div', null,
          h('div', { className: 'csb-kv' },
            // ── 5W：谁建的 / 是什么 / 何时 / 在哪做 / 为什么 ──
            h('span', { className: 'csb-k' }, '谁建的'), h('span', { className: 'csb-v' }, task.createdBy ? botName(bots, task.createdBy) : task.createdBy),
            h('span', { className: 'csb-k' }, '来源'), h('span', { className: 'csb-v' }, task.source === 'ai' ? '智能体自动派发' : '人建的'),
            h('span', { className: 'csb-k' }, '优先级'), h('span', { className: 'csb-v' }, task.priority !== undefined ? `${task.priority}（${task.priority >= 8 ? '紧急' : '一般'}）` : '未设'),
            h('span', { className: 'csb-k' }, '截止'), h('span', { className: 'csb-v' }, task.dueAt ? fmt(task.dueAt) : '未设'),
            h('span', { className: 'csb-k' }, '状态'), h('span', { className: 'csb-v' }, h(Badge, { status: task.status })),
            h('span', { className: 'csb-k' }, '任务编号'), h('span', { className: 'csb-v csb-mono' }, task.id),
            h('span', { className: 'csb-k' }, '谁在做'), h('span', { className: 'csb-v' }, task.ownerId ? botName(bots, task.ownerId) : '还没人领'),
            h('span', { className: 'csb-k' }, '进度'), h('span', { className: 'csb-v csb-kv-progress' },
              h('div', { className: 'csb-progress', style: { flex: 1, minWidth: 80 } },
                h('div', { className: 'csb-progress-fill', style: { width: `${Math.max(0, Math.min(100, task.progress ?? 0))}%` } })),
              h('span', null, `${task.progress ?? 0}%`)),
            h('span', { className: 'csb-k' }, '在哪做'), h('span', { className: 'csb-v' }, (task.writeScopes ?? []).join('、') || '不限'),
            h('span', { className: 'csb-k' }, '完成前必须先'), h('span', { className: 'csb-v' }, (task.blockedBy ?? []).length ? task.blockedBy.join('、') : '无'),
            h('span', { className: 'csb-k' }, '交付物'), h('span', { className: 'csb-v' }, (task.artifacts ?? []).join('、') || '—'),
            h('span', { className: 'csb-k' }, '验收结果'), h('span', { className: 'csb-v' }, task.acceptance ? `${task.acceptance.result === 'pass' ? '通过' : '打回'} · ${task.acceptance.by}` : task.status === 'completed' ? '待验收' : '—'),
            task.blockedReason ? h('span', { className: 'csb-k' }, '终止原因') : null,
            task.blockedReason ? h('span', { className: 'csb-v' }, task.blockedReason) : null),
          task.description ? h('div', { className: 'csb-pre', style: { marginBottom: 4 } }, task.description) : null,

          h(Section, { title: '可以做什么', desc: '指派、完成、验收是 Bot 的职责，不由你操作。这里只有需要你拍板的动作。' }),
          h('div', { className: 'csb-bar', style: { marginTop: 10 } },
            task.status === 'pending'
              ? h('button', { className: 'csb-btn csb-btn-p', onClick: () => act(() => upd('claim'), '领取') }, '我来管（领取）')
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
      // 默认只看「需要我管的」；点「看全部」才显示 AI 派发的和已完成的
      const [attentionOnly, setAttentionOnly] = useState(true)
      const subjectRef = useRef(null)
      const q = new URLSearchParams()
      if (filter) q.set('status', filter)
      if (attentionOnly) q.set('attention', '1')
      const qs = q.toString()
      const { data, loading, error, reload } = useApi(`/tasks${qs ? `?${qs}` : ''}`, [filter, attentionOnly])
      const { data: rosterData } = useApi('/roster')
      const { data: wfData } = useApi('/library/workflows')
      const bots = rosterData?.bots ?? []
      const workflows = wfData?.workflows ?? []
      const tasks = data?.tasks ?? []

      // 「下一步」按钮的落点（spec §8）：按错误码给可执行动作
      const errActions = {
        BOARD_WIP_EXCEEDED: () => { setFilter(''); setAttentionOnly(true) },
        BOARD_REV_CONFLICT: reload,
        CAS_MISMATCH: reload,
        // 查看持有者 / 前置任务 / 依赖图 → 打开任务详情抽屉
        BOARD_LEASE_HELD: (t) => setOpenId(t?.id ?? openId),
        BOARD_NOT_READY: (t) => setOpenId(t?.id ?? openId),
        BOARD_DEPENDENCY_CYCLE: (t) => setOpenId(t?.id ?? openId),
      }

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
          setErr(humanizeError(e, errActions))
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
          setErr(humanizeError(e, { ...errActions, BOARD_LEASE_HELD: () => setOpenId(t.id), BOARD_NOT_READY: () => setOpenId(t.id), BOARD_DEPENDENCY_CYCLE: () => setOpenId(t.id) }))
        } finally {
          setBusy(false)
        }
      }

      return h('div', { className: 'csb-wrap' },
        h(Section, {
          title: '任务板',
          desc: attentionOnly
            ? '只看需要你管的（卡住 / 高优先 / 逾期 / 待验收 / 你建的）。AI 自己派发的任务不在这里，点下方「看全部」穿透查看。'
            : '全部任务（含 AI 自己派发的）。点下方回到「只看需要我管的」。',
        }),
        h('div', { className: 'csb-bar', style: { marginTop: 8 } },
          attentionOnly
            ? h('button', { className: 'csb-btn csb-btn-s', onClick: () => setAttentionOnly(false) }, '看全部任务')
            : h('button', { className: 'csb-btn csb-btn-s', onClick: () => setAttentionOnly(true) }, '只看需要我管的')),
        h('div', { className: 'csb-bar', style: { marginTop: 12 } },
          h('input', {
            className: 'csb-in csb-grow', placeholder: '要做什么？（例如：实现登录接口。回车创建）',
            value: subject, onChange: (e) => setSubject(e.target.value),
            onKeyDown: (e) => e.key === 'Enter' && create(),
            ref: subjectRef,
          }),
          h('button', { className: 'csb-btn csb-btn-p', disabled: busy || !subject.trim(), onClick: create }, '创建任务'),
          h('select', { className: 'csb-sel', style: { width: 116 }, value: filter, onChange: (e) => setFilter(e.target.value) },
            h('option', { value: '' }, '全部状态'),
            h('option', { value: 'pending' }, '待办'),
            h('option', { value: 'in_progress' }, '进行中'),
            h('option', { value: 'completed' }, '已完成'),
            h('option', { value: 'blocked' }, '已终止'))),
        err ? h(ErrBox, { humanized: err, onAction: (c) => errActions[c]?.() }) : null,
        error ? h('div', { className: 'csb-err' }, error) : null,
        loading ? h(Skeleton, { n: 3 }) : null,
        !loading && !error && tasks.length === 0
          ? h(Empty, {
              icon: '◫', title: '还没有任务',
              hint: '在上面输入一句话就能建任务。建好后可以指派给某个 Bot，也可以自己领取来做。',
              action: { label: '新建任务', icon: '✎', onClick: () => subjectRef.current?.focus() },
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
                ? h('button', { className: 'csb-btn csb-btn-s', disabled: busy, onClick: () => quick(t, 'claim') }, '我来管')
                : null)))),
        openId ? h(TaskDrawer, { id: openId, bots, workflows, onClose: () => setOpenId(null), onChange: reload }) : null)
    }

    // ── 技能库 / 工作流库 ───────────────────────────────────────────────────

    const SKILL_SOURCES = [
      { id: 'custom', label: '自建' },
      { id: 'user', label: '用户级' },
      { id: 'project', label: '项目级' },
      { id: 'bundled', label: '系统自带' },
    ]

    /** 技能内容查看弹窗：读 SKILL.md 全文，让用户能直接看到「这个技能到底写了什么」。 */
    function SkillReadModal({ skillId, onClose }) {
      const { data, loading, error } = useApi(`/library/skills/detail?id=${encodeURIComponent(skillId)}`)
      const skill = data?.skill
      return h(Modal, {
        title: skill?.name ?? '技能内容',
        wide: true,
        onClose,
        footer: [h('button', { key: 'c', className: 'csb-btn', onClick: onClose }, '关闭')],
        children: [
          loading ? h(Skeleton, { n: 2 }) : null,
          error ? h('div', { className: 'csb-err' }, error) : null,
          skill ? h('div', null,
            h('div', { className: 'csb-kv', style: { marginBottom: 10 } },
              h('span', { className: 'csb-k' }, '描述'), h('span', { className: 'csb-v' }, skill.description || '—'),
              h('span', { className: 'csb-k' }, '来源'), h('span', { className: 'csb-v' }, skill.source === 'bundled' ? '系统自带' : skill.source === 'custom' ? '自建' : skill.source === 'user' ? '用户级' : '项目级')),
            h('div', { className: 'csb-pre', style: { maxHeight: 400, overflow: 'auto' } }, skill.body || '（空）'))
            : null,
        ],
      })
    }

    function SkillsTab() {
      const [source, setSource] = useState('')
      const qs = new URLSearchParams({ all: '1' })
      if (source) qs.set('source', source)
      const { data, loading, error, reload } = useApi(`/library/skills?${qs.toString()}`, [source])
      const [editing, setEditing] = useState(null) // null | {} | skill
      const [confirmDel, setConfirmDel] = useState(null)
      const [err, setErr] = useState(null)
      const [ok, setOk] = useState(null)
      const [importing, setImporting] = useState(null)
      const [showDirs, setShowDirs] = useState(false)
      const [reading, setReading] = useState(null)
      const skills = data?.skills ?? []

      const toggleEnabled = async (s) => {
        setErr(null)
        try {
          await call('/library/skills/enable', {
            method: 'POST',
            body: { id: s.id, enabled: s.enabled === false, expectedRev: s.rev },
          })
          setOk(s.enabled === false ? '已启用' : '已停用（不删除，只是不再加载）')
          reload()
        } catch (e) {
          setErr(e.message)
        }
      }

      return h('div', { className: 'csb-wrap' },
        h(Section, {
          title: '技能库',
          desc: '可复用的「怎么做某件事」的说明书。建好后可以在 Bot 的档案里关联，Bot 就能在它自己的工作目录里加载到。'
            + '也可以从文件/目录直接导入现成的 SKILL.md。',
        }),
        h('div', { className: 'csb-bar', style: { marginTop: 12 } },
          h('select', {
            className: 'csb-sel', style: { width: 130 }, value: source,
            onChange: (e) => setSource(e.target.value),
          },
          h('option', { value: '' }, '全部来源'),
          SKILL_SOURCES.map((x) => h('option', { key: x.id, value: x.id }, x.label))),
          h('span', { className: 'csb-spacer' }),
          h('button', { className: 'csb-btn', onClick: () => setImporting({ mode: 'paste', text: '', dir: '', items: [] }) }, '导入技能'),
          h('button', { className: 'csb-btn', onClick: () => setShowDirs(true) }, '来源目录'),
          h('button', { className: 'csb-btn csb-btn-p', onClick: () => setEditing({}) }, '新建技能')),
        h(Notice, { kind: 'ok', onClose: () => setOk(null) }, ok),
        err ? h('div', { className: 'csb-err' }, err) : null,
        error ? h('div', { className: 'csb-err' }, error) : null,
        loading ? h(Skeleton, { n: 2 }) : null,
        !loading && skills.length === 0
          ? h(Empty, { icon: '◇', title: '技能库是空的', hint: '一个技能就是一段说明：这个 Bot 遇到某类任务时应该怎么做。写一次，多个 Bot 都能用。' })
          : null,
        reading
          ? h(SkillReadModal, { skillId: reading, onClose: () => setReading(null) })
          : null,
        h('div', { className: 'csb-list' }, skills.map((s) =>
          h('div', { key: s.id, className: 'csb-card' },
            h('div', { className: 'csb-card-main' },
              h('div', { className: 'csb-card-t' }, s.name),
              h('div', { className: 'csb-card-m' },
                h('span', { className: 'csb-b' }, (SKILL_SOURCES.find((x) => x.id === (s.source ?? 'custom')) ?? {}).label ?? '自建'),
                s.enabled === false ? h('span', { className: 'csb-b csb-b-idle' }, '已停用') : null,
                s.description ? h('span', null, s.description) : h('span', null, '（无说明）'),
                h('span', null, `· 第 ${s.rev} 版`))),
            h('div', { style: { display: 'flex', gap: 6, flex: 'none' } },
              h('button', {
                className: 'csb-btn csb-btn-s',
                title: '查看 SKILL.md 内容',
                onClick: () => setReading(s.id),
              }, '看内容'),
              h('button', { className: 'csb-btn csb-btn-s', onClick: () => toggleEnabled(s) }, s.enabled === false ? '启用' : '停用'),
              h('button', { className: 'csb-btn csb-btn-s', onClick: () => setEditing(s) }, '编辑'),
              h('button', { className: 'csb-btn csb-btn-s csb-btn-d', onClick: () => setConfirmDel(s) }, '删除'))))),
        editing
          ? h(SkillEditor, {
              skill: editing, onClose: () => setEditing(null),
              onSaved: () => { setEditing(null); reload() },
              onError: setErr,
            })
          : null,
        showDirs
          ? h(SkillDirsModal, {
              onClose: () => setShowDirs(false),
              onError: setErr,
              onImport: (dir) => {
                setShowDirs(false)
                setImporting({ mode: 'dir', dir, text: '', items: [] })
              },
            })
          : null,
        importing
          ? h(SkillImportModal, {
              state: importing,
              onChange: setImporting,
              onClose: () => setImporting(null),
              onDone: (msg) => { setImporting(null); setOk(msg); reload() },
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


    /** 技能来源目录：登记几个常放技能的目录，以后一键扫描导入。只登记目录，不复制文件。 */
    function SkillDirsModal({ onClose, onError, onImport }) {
      const { data, loading, reload } = useApi('/library/skills/dirs')
      const [dir, setDir] = useState('')
      const [label, setLabel] = useState('')
      const [err, setErr] = useState(null)
      const [busy, setBusy] = useState(false)
      const dirs = data?.dirs ?? []

      const add = async () => {
        const d = dir.trim()
        if (!d) return
        setBusy(true)
        setErr(null)
        try {
          await call('/library/skills/dirs/add', { method: 'POST', body: { dir: d, label: label.trim() || null } })
          setDir('')
          setLabel('')
          reload()
        } catch (e) {
          setErr(e.message)
        } finally {
          setBusy(false)
        }
      }

      const remove = async (target) => {
        setErr(null)
        try {
          await call('/library/skills/dirs/remove', { method: 'POST', body: { dir: target } })
          reload()
        } catch (e) {
          setErr(e.message)
        }
      }

      return h(Modal, {
        title: '技能来源目录',
        wide: true,
        onClose,
        footer: [h('button', { key: 'c', className: 'csb-btn', onClick: onClose }, '关闭')],
      },
        h('p', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } },
          '登记存放技能的目录后，可以随时扫描把它们导进技能库。登记只是「记住这个位置」，不会复制或改动磁盘上的文件。'),
        h('div', { className: 'csb-bar', style: { marginTop: 12 } },
          h('input', {
            className: 'csb-in csb-grow', placeholder: '目录路径，例如 /home/you/.agents/skills',
            value: dir, onChange: (e) => setDir(e.target.value),
            onKeyDown: (e) => e.key === 'Enter' && add(),
          }),
          h('input', {
            className: 'csb-in', style: { width: 140 }, placeholder: '备注名（可选）',
            value: label, onChange: (e) => setLabel(e.target.value),
          }),
          h('button', { className: 'csb-btn csb-btn-p', disabled: busy || !dir.trim(), onClick: add }, '登记')),
        h(Notice, { kind: 'err', onClose: () => setErr(null) }, err),
        loading ? h(Skeleton, { n: 1 }) : null,
        !loading && dirs.length === 0
          ? h(Empty, {
              icon: '⌸',
              title: '还没登记任何目录',
              hint: '把常放技能的地方登记进来，以后改完技能点一下就能重新导入。',
            })
          : null,
        h('div', { className: 'csb-list' }, dirs.map((d) => h('div', { key: d.dir, className: 'csb-card' },
          h('div', { className: 'csb-card-main' },
            h('div', { className: 'csb-card-t' }, d.label || short(d.dir, 50)),
            h('div', { className: 'csb-card-m' },
              h('span', { className: 'csb-mono', style: { fontSize: 11.5 } }, d.dir),
              d.exists === false
                ? h('span', { className: 'csb-b csb-b-err' }, '目录不见了')
                : h('span', { className: 'csb-b csb-b-ok' }, `${d.skillCount ?? 0} 个技能`))),
          h('div', { style: { display: 'flex', gap: 6, flex: 'none' } },
            h('button', {
              className: 'csb-btn csb-btn-s csb-btn-p',
              disabled: d.exists === false,
              onClick: () => onImport(d.dir),
            }, '扫描导入'),
            h('button', { className: 'csb-btn csb-btn-s csb-btn-d', onClick: () => remove(d.dir) }, '取消登记'))))))
    }

    /** 技能导入：两种方式（粘贴 SKILL.md / 扫描目录），导入前先预览。 */
    function SkillImportModal({ state, onChange, onClose, onDone, onError }) {
      const [busy, setBusy] = useState(false)
      const [parsed, setParsed] = useState(null)
      const [scanned, setScanned] = useState(null)
      const [picked, setPicked] = useState([])
      const [mode, setMode] = useState('skip')
      const [err, setErr] = useState(null)

      const parseText = async () => {
        setErr(null)
        setBusy(true)
        try {
          const d = await call('/library/skills/parse', {
            method: 'POST',
            body: { text: state.text ?? '', filename: 'SKILL.md' },
          })
          setParsed(d.parsed)
          setPicked([d.parsed.name])
        } catch (e) {
          setErr(e.message)
          setParsed(null)
        } finally {
          setBusy(false)
        }
      }

      const scanDir = async () => {
        setErr(null)
        setBusy(true)
        try {
          const d = await call('/library/skills/scan', { method: 'POST', body: { dir: state.dir } })
          setScanned(d)
          setPicked((d.items ?? []).map((x) => x.name))
        } catch (e) {
          setErr(e.message)
          setScanned(null)
        } finally {
          setBusy(false)
        }
      }

      const items = () => {
        if (state.mode === 'paste') return parsed ? [parsed] : []
        return (scanned?.items ?? []).filter((x) => picked.includes(x.name))
      }

      const doImport = async () => {
        const list = items()
        if (list.length === 0) {
          setErr('没有可导入的技能')
          return
        }
        setErr(null)
        setBusy(true)
        try {
          const d = await call('/library/skills/import', {
            method: 'POST',
            body: { items: list, mode },
          })
          const r = d.result ?? {}
          const parts = []
          if ((r.created ?? []).length) parts.push(`新增 ${r.created.length} 个`)
          if ((r.updated ?? []).length) parts.push(`覆盖 ${r.updated.length} 个`)
          if ((r.skipped ?? []).length) parts.push(`跳过 ${r.skipped.length} 个（已存在）`)
          if ((r.errors ?? []).length) parts.push(`失败 ${r.errors.length} 个`)
          onDone(parts.length ? `导入完成：${parts.join('，')}` : '没有变化')
        } catch (e) {
          setErr(e.message)
        } finally {
          setBusy(false)
        }
      }

      return h(Modal, {
        title: '导入技能',
        wide: true,
        onClose,
        footer: [
          h('button', { key: 'c', className: 'csb-btn', onClick: onClose }, '取消'),
          h('button', {
            key: 'i',
            className: 'csb-btn csb-btn-p',
            disabled: busy || items().length === 0,
            onClick: doImport,
          }, busy ? '导入中…' : `导入 ${items().length} 个`),
        ],
      },
        h('div', { className: 'csb-bar' },
          h('button', {
            className: `csb-btn csb-btn-s${state.mode === 'paste' ? ' csb-btn-p' : ''}`,
            onClick: () => onChange({ ...state, mode: 'paste' }),
          }, '粘贴 SKILL.md'),
          h('button', {
            className: `csb-btn csb-btn-s${state.mode === 'dir' ? ' csb-btn-p' : ''}`,
            onClick: () => onChange({ ...state, mode: 'dir' }),
          }, '从目录导入')),

        state.mode === 'paste'
          ? h('div', null,
              h(Field, { label: '把 SKILL.md 的内容粘进来', hint: '格式：开头用 --- 包住 name/description，下面是正文' },
                h('textarea', {
                  className: 'csb-ta',
                  style: { minHeight: 200, fontFamily: 'ui-monospace,monospace' },
                  placeholder: '---\nname: deploy-check\ndescription: 部署前检查环境与端口\n---\n\n# 部署前检查\n\n1. 核对环境变量\n2. 核对端口占用',
                  value: state.text ?? '',
                  onChange: (e) => onChange({ ...state, text: e.target.value }),
                })),
              h('button', { className: 'csb-btn', disabled: busy || !(state.text ?? '').trim(), onClick: parseText }, '解析预览'),
              parsed
                ? h('div', { style: { marginTop: 12 } },
                    h('div', { className: 'csb-card-m' },
                      h('span', { className: 'csb-b csb-b-ok' }, '解析成功'),
                      h('span', { className: 'csb-b' }, parsed.name),
                      parsed.tags?.length ? h('span', null, parsed.tags.map((t) => `#${t}`).join(' ')) : null),
                    parsed.description ? h('div', { className: 'csb-field-h', style: { marginTop: 4 } }, parsed.description) : null)
                : null)
          : h('div', null,
              h(Field, { label: '技能目录', hint: '填一个存放技能文件夹的目录，会读出里面每个 SKILL.md' },
                h('input', {
                  className: 'csb-in', placeholder: '/home/you/.agents/skills',
                  value: state.dir ?? '',
                  onChange: (e) => onChange({ ...state, dir: e.target.value }),
                })),
              h('button', { className: 'csb-btn', disabled: busy || !(state.dir ?? '').trim(), onClick: scanDir }, '扫描目录'),
              scanned
                ? h('div', { style: { marginTop: 12 } },
                    h('div', { className: 'csb-field-h' }, `扫描到 ${(scanned.items ?? []).length} 个技能`),
                    h('div', { className: 'csb-list', style: { marginTop: 8 } },
                      (scanned.items ?? []).map((x) => h('label', { key: x.name, className: 'csb-pick-i' },
                        h('input', {
                          type: 'checkbox',
                          checked: picked.includes(x.name),
                          onChange: (e) => {
                            setPicked(e.target.checked
                              ? [...picked, x.name]
                              : picked.filter((n) => n !== x.name))
                          },
                        }),
                        h('span', null, x.name),
                        x.description ? h('span', { className: 'csb-set-d' }, x.description) : null))),
                    (scanned.errors ?? []).length
                      ? h('div', { className: 'csb-field-h', style: { color: 'var(--dsw-alias-state-error-primary)' } },
                          `${scanned.errors.length} 个文件读不出来（会跳过）`)
                      : null)
                : null),

        h(Field, { label: '如果已经有同名技能', hint: '点「导入」前先选好' },
          h('select', {
            className: 'csb-sel', value: mode, onChange: (e) => setMode(e.target.value),
          },
          h('option', { value: 'skip' }, '跳过（保留现有的）'),
          h('option', { value: 'overwrite' }, '覆盖（用导入的替换）'),
          h('option', { value: 'rename' }, '保留两者（新的自动改名）'))),

        err ? h('div', { className: 'csb-err' }, err) : null)
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
      const [sessionPicker, setSessionPicker] = useState(null)
      const nameRef = useRef(null)

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
      /**
       * 打开 Bot 的会话。
       *
       * 为什么不要只甩一句「不支持跳转」：那等于告诉用户「你用不了」，
       * 但实际用户**能**用——只是要自己找。所以：
       *   ① 宿主支持 → 直接跳；
       *   ② 宿主不支持 → 弹窗给出「会话 ID + 怎么复制 + 左侧搜什么」，
       *      并给「复制会话 ID」按钮，让查找变成一步操作。
       */
      const openSession = async (bot) => {
        setErr(null)
        try {
          if (hostUiWorkspace?.openSession) {
            hostUiWorkspace.openSession({ sessionId: bot.sessionId })
            return
          }
          const copied = await copyText(bot.sessionId)
          setSessionPicker({
            bot,
            copied,
            hint: copied
              ? '已复制会话 ID。在左侧会话列表里输入它就能定位到这个 Bot。'
              : '浏览器不允许自动复制，请手动选中下面的 ID 复制。',
            done: () => setSessionPicker(null),
          })
        } catch (e) {
          setErr(`无法打开会话：${e.message}`)
        }
      }

      return h('div', { className: 'csb-wrap' },
        sessionPicker
          ? h(Modal, {
              title: `打开「${sessionPicker.bot.name}」的对话`,
              onClose: () => setSessionPicker(null),
              footer: [
                h('button', {
                  key: 'c', className: 'csb-btn',
                  onClick: async () => {
                    const ok = await copyText(sessionPicker.bot.sessionId)
                    setSessionPicker((sp) => sp && { ...sp, copied: ok, hint: ok ? '已复制会话 ID。' : '请手动选中复制。' })
                  },
                }, sessionPicker.copied ? '再复制一次' : '复制会话 ID'),
                h('button', { key: 'x', className: 'csb-btn csb-btn-p', onClick: () => setSessionPicker(null) }, '知道了'),
              ],
            },
            h('p', { className: 'csb-field-h' }, sessionPicker.hint),
            h('div', { className: 'csb-mono', style: { padding: 10, background: 'var(--dsw-alias-bg-layer-2)', borderRadius: 8, wordBreak: 'break-all' } },
              sessionPicker.bot.sessionId),
            h('p', { className: 'csb-field-h' },
              '它能做的文件范围（工作目录）是：',
              h('span', { className: 'csb-mono' }, sessionPicker.bot.cwd || '—')))
          : null,
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
            ref: nameRef,
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
          ? h(Empty, {
              icon: '⬡', title: '还没有 Bot', hint: '先在上面建一个。如果只是临时分工，不用建 Bot —— 直接建任务指派给人就行。',
              action: { label: '新建 Bot', icon: '✎', onClick: () => nameRef.current?.focus() },
            })
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
      const [memPicker, setMemPicker] = useState(null)

      useEffect(() => {
        if (data && draft === null) {
          const p = data.profile ?? {}
          setDraft({
            title: p.title ?? '',
            identity: p.identity ?? '',
            persona: p.persona ?? '',
            boundaries: p.boundaries ?? '',
            experience: p.experience ?? '',
            skills: Array.isArray(p.skills) ? [...p.skills] : [],
            workflows: Array.isArray(p.workflows) ? [...p.workflows] : [],
            memory: Array.isArray(p.memory) ? [...p.memory] : [],
            disciplineIds: Array.isArray(p.disciplineIds) ? [...p.disciplineIds] : [],
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

          h(Section, { title: '① 岗位名', desc: '一句话说清它是什么角色。会作为档案里的小标题显示。' }),
          h('input', {
            className: 'csb-in', style: { marginTop: 10 },
            placeholder: '例如：后端负责人 / 发布管理员 / 代码审查员',
            value: draft.title, onChange: (e) => setDraft({ ...draft, title: e.target.value }),
          }),

          h(Section, { title: '② 人格与说话方式', desc: '它该用什么性格、什么口吻跟你说话。不填就用默认的。' }),
          h('textarea', {
            className: 'csb-ta', style: { marginTop: 10 },
            placeholder: '例如：说话先给结论再列证据；不确定就明说不知道，不许编；不要用"作为一个 AI"这类腔调。',
            value: draft.persona, onChange: (e) => setDraft({ ...draft, persona: e.target.value }),
          }),

          h(Section, { title: '③ 边界与红线', desc: '绝对不许它做的事。写在这里的每一条都会强约束它。' }),
          h('textarea', {
            className: 'csb-ta', style: { marginTop: 10, minHeight: 90 },
            placeholder: '例如：不许直接改生产数据；未经确认不许删除或推送；不许替我做付费决定。',
            value: draft.boundaries, onChange: (e) => setDraft({ ...draft, boundaries: e.target.value }),
          }),

          h(Section, { title: '④ 身份', desc: '它是谁、负责什么。这段话会在每次对话开始前进到它的上下文里。' }),
          h('textarea', {
            className: 'csb-ta', style: { marginTop: 10 },
            placeholder: '例如：你是本项目的后端工程师，负责 API 设计、数据模型与数据库迁移；对 SQL 性能负责；拿不准时先给方案再动手。',
            value: draft.identity, onChange: (e) => setDraft({ ...draft, identity: e.target.value }),
          }),

          h(Section, { title: '⑤ 经验与规矩', desc: '它踩过的坑、你定下的规矩。写在这里的每一条，它每次都会看到。' }),
          h('textarea', {
            className: 'csb-ta', style: { marginTop: 10, minHeight: 100 },
            placeholder: '例如：改数据库结构必须先写迁移；禁止直接 force push；测试必须全绿才算完成。',
            value: draft.experience, onChange: (e) => setDraft({ ...draft, experience: e.target.value }),
          }),

          h(Section, { title: '⑥ 技能', desc: '从技能库挑，或临时加一个名字。勾选的技能会同步到它自己目录下的 .agents/skills/，别的 Bot 看不到。' }),
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

          h(Section, { title: '⑦ 工作流', desc: '这个 Bot 干活时该按哪套步骤。勾选后会写进它的身份说明里。' }),
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

          h(Section, { title: '⑧ 预制记忆', desc: '它一开始就该知道的事实。会写进身份说明，同时存进记忆服务（按 Bot 隔离，可检索）。' }),
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
            }, '添加'),
            h('button', {
              className: 'csb-btn',
              title: '把记忆库里已有的条目挑出来，勾选后加入这个 Bot 的预制记忆',
              onClick: async () => {
                setErr(null)
                setMemPicker({ loading: true, rows: [], chosen: new Set(), err: null })
                try {
                  const d = await call('/memory?layer=L2')
                  const rows = (d.entries ?? []).map((e) => e.content).filter(Boolean)
                  // 已在 draft 里的，默认灰掉不可选
                  const key = (x) => String(x).trim().replace(/\s+/g, ' ').toLowerCase()
                  const existing = new Set(draft.memory.map(key))
                  const fresh = rows.map((r) => ({ text: r, dup: existing.has(key(r)) }))
                  setMemPicker({ loading: false, rows: fresh, chosen: new Set(), err: null })
                } catch (e) {
                  setMemPicker({ loading: false, rows: [], chosen: new Set(), err: e.message })
                }
              },
            }, '从记忆库导入')),

          // 记忆导入选择弹窗（原来一键全量导入，用户没有选择权 —— 现在必须自己挑）
          memPicker
            ? h(Modal, {
                title: '从记忆库挑几条给这个 Bot',
                wide: true,
                onClose: () => setMemPicker(null),
                footer: [
                  h('button', { key: 'c', className: 'csb-btn', onClick: () => setMemPicker(null) }, '取消'),
                  h('button', {
                    key: 'ok', className: 'csb-btn csb-btn-p',
                    disabled: memPicker.chosen.size === 0,
                    onClick: () => {
                      const chosen = [...memPicker.chosen]
                      setDraft({ ...draft, memory: [...draft.memory, ...chosen] })
                      setMsg(`已加入 ${chosen.length} 条预制记忆`)
                      setMemPicker(null)
                    },
                  }, `加入选中的 ${memPicker.chosen.size} 条`),
                ],
              },
                memPicker.loading
                  ? h(Skeleton, { n: 3 })
                  : (memPicker.err
                      ? h(Notice, { kind: 'err', onClose: () => setMemPicker(null) }, memPicker.err)
                      : memPicker.rows.length === 0
                        ? h(Empty, { icon: '⌸', title: '记忆库里没有条目', hint: '先去「记忆」页加几条，这里才有东西可挑。' })
                        : h('div', { style: { maxHeight: 320, overflowY: 'auto' } },
                            memPicker.rows.map((r, i) =>
                              h('label', {
                                key: i,
                                className: 'csb-check',
                                style: r.dup ? { opacity: 0.5 } : {},
                              },
                                h('input', {
                                  type: 'checkbox',
                                  disabled: r.dup,
                                  checked: !r.dup && memPicker.chosen.has(r.text),
                                  onChange: (e) => {
                                    const next = new Set(memPicker.chosen)
                                    if (e.target.checked) next.add(r.text); else next.delete(r.text)
                                    setMemPicker({ ...memPicker, chosen: next })
                                  },
                                }),
                                h('span', { className: 'csb-check-t' }, r.text.length > 90 ? `${r.text.slice(0, 90)}…` : r.text),
                                r.dup ? h('span', { className: 'csb-b csb-b-idle' }, '已在预制记忆里') : null))))) : null,

          data.managedText
            ? h('div', null,
                h(Section, { title: '它实际读到的内容', desc: '这就是写进 AGENTS.md 托管段的原文，保存后可在工作目录里查看。' }),
                h('div', { className: 'csb-pre', style: { marginTop: 10 } }, data.managedText))
            : null)
          : null)
    }

    // ── 房间 ────────────────────────────────────────────────────────────────

    function RoomsTab() {
      const [showArchived, setShowArchived] = useState(false)
      const { data, loading, error, reload } = useApi(`/rooms${showArchived ? '?includeArchived=1' : ''}`, [showArchived])
      const { data: rosterData } = useApi('/roster')
      const [active, setActive] = useState(null)
      const [msgs, setMsgs] = useState([])
      const [text, setText] = useState('')
      const [roomName, setRoomName] = useState('')
      const [err, setErr] = useState(null)
      const [ok, setOk] = useState(null)
      const [editing, setEditing] = useState(null)
      const [confirmDel, setConfirmDel] = useState(null)
      const [showBody, setShowBody] = useState(null)
      const endRef = useRef(null)
      const roomNameRef = useRef(null)

      const bots = rosterData?.bots ?? []
      const rooms = data?.rooms ?? []
      const current = rooms.find((r) => r.id === active)

      const loadMsgs = useCallback((roomId) => {
        // withBody=1：超级管理员直接把长正文一起拿回来，不用逐条二次请求
        call(`/rooms/messages?roomId=${encodeURIComponent(roomId)}&withBody=1`)
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
          const r = await call('/rooms', { method: 'POST', body: { name: n, members: ['user'], byId: 'user' } })
          setRoomName('')
          setOk('房间已创建')
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
          await call('/rooms/post', { method: 'POST', body: { roomId: active, text: t, from: 'user' } })
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
          await call(`/rooms/${op}`, { method: 'POST', body: { roomId: active, sessionId, byId: 'user' } })
          reload()
        } catch (e) {
          setErr(e.message)
        }
      }

      const archive = async (r, on) => {
        setErr(null)
        try {
          await call(`/rooms/${on ? 'archive' : 'unarchive'}`, {
            method: 'POST', body: { roomId: r.id, expectedRev: r.rev },
          })
          setOk(on ? '已归档（可以随时恢复）' : '已恢复')
          reload()
        } catch (e) {
          setErr(e.message)
        }
      }

      return h('div', { className: 'csb-wrap' },
        h(Section, {
          title: '房间 = 群聊',
          desc: '房间就是一群成员共用的消息流。成员是「会话」，消息可以直接转发去唤醒某个 Bot。'
            + '你是超级管理员：所有房间都能进、都能看全文、都能改设置。',
        }),
        h('div', { className: 'csb-bar', style: { marginTop: 12 } },
          h('input', {
            className: 'csb-in csb-grow', placeholder: '新建房间…（例如：发布协调群。回车创建）',
            value: roomName, onChange: (e) => setRoomName(e.target.value),
            onKeyDown: (e) => e.key === 'Enter' && create(),
            ref: roomNameRef,
          }),
          h('button', {
            className: `csb-btn csb-btn-s${showArchived ? ' csb-btn-p' : ''}`,
            onClick: () => setShowArchived((v) => !v),
          }, showArchived ? '隐藏归档' : '看归档'),
          h('button', { className: 'csb-btn csb-btn-p', disabled: !roomName.trim(), onClick: create }, '创建房间')),

        h(Notice, { kind: 'ok', onClose: () => setOk(null) }, ok),
        h(Notice, { kind: 'err', onClose: () => setErr(null) }, err),
        error ? h('div', { className: 'csb-err' }, error) : null,
        loading ? h(Skeleton, { n: 2 }) : null,
        !loading && rooms.length === 0
          ? h(Empty, {
              icon: '◌', title: '还没有房间',
              hint: '建一个房间，然后把 Bot 拉进来，它们就能在同一个消息流里对话。',
              action: { label: '新建房间', icon: '✎', onClick: () => roomNameRef.current?.focus() },
            })
          : null,

        h('div', { className: 'csb-list' }, rooms.map((r) =>
          h('div', {
            key: r.id, className: `csb-card csb-card-c${active === r.id ? ' csb-card-on' : ''}`,
            onClick: () => setActive(r.id),
          },
            h('div', { className: 'csb-card-main' },
              h('div', { className: 'csb-card-t' }, r.name),
              h('div', { className: 'csb-card-m' },
                r.archivedAt ? h('span', { className: 'csb-b csb-b-idle' }, '已归档') : null,
                h('span', null, `${(r.members ?? []).length} 人`),
                h('span', null, `· ${r.mode === 'admin' ? '管理员模式' : '自由发言'}`),
                h('span', null, `· ${r.seq ?? 0} 条消息`),
                r.purpose ? h('span', null, `· ${r.purpose.slice(0, 30)}`) : null)),
            h('div', { style: { display: 'flex', gap: 6, flex: 'none' } },
              h('button', {
                className: 'csb-btn csb-btn-s',
                onClick: (e) => { e.stopPropagation(); archive(r, !r.archivedAt) },
              }, r.archivedAt ? '恢复' : '归档'),
              h('button', {
                className: 'csb-btn csb-btn-s',
                onClick: (e) => { e.stopPropagation(); setEditing(r) },
              }, '设置'),
              h('button', {
                className: 'csb-btn csb-btn-s csb-btn-d',
                onClick: (e) => { e.stopPropagation(); setConfirmDel(r) },
              }, '删除'))))),

        current
          ? h('div', { className: 'csb-room-split' },
              // ── 中栏：聊天 ──
              h('div', { className: 'csb-room-chat' },
                h(Section, {
                  title: `消息 · ${current.name}`,
                  desc: `${msgs.length} 条全部显示。发帖者必须是成员；你是超级管理员，可以直接看全部内容。`,
                }),
                current.purpose ? h('div', { className: 'csb-note', style: { marginTop: 10 } }, `用途：${current.purpose}`) : null,
                current.notice ? h('div', { className: 'csb-note', style: { marginTop: 10 } }, current.notice) : null,
                h('div', { style: { maxHeight: 460, overflowY: 'auto', margin: '12px 0' } },
                  msgs.length === 0 ? h(Empty, { title: '还没有消息' }) : null,
                  msgs.map((m) => {
                    const body = m.body ?? m.text ?? ''
                    const long = body.length > 300
                    const isMe = m.from === 'user' || m.from === 'ui'
                    return h('div', { key: m.id, className: `csb-msg-row${isMe ? ' csb-msg-row-me' : ''}` },
                      h('div', { className: 'csb-msg-h' },
                        h('span', { className: 'csb-msg-sender' }, botName(bots, m.from)),
                        h('span', null, `#${m.seq}`),
                        m.bodyRef ? h('span', { className: 'csb-b' }, '长正文') : null,
                        m.bodyError ? h('span', { className: 'csb-b csb-b-err' }, '正文读取失败') : null,
                        long
                          ? h('button', {
                              className: 'csb-btn csb-btn-s', style: { marginLeft: 'auto' },
                              onClick: () => setShowBody(m),
                            }, '看全文')
                          : null),
                      h('div', { className: `csb-msg${isMe ? ' csb-msg-me' : ''}` },
                        h('div', { className: 'csb-msg-b' }, long ? `${body.slice(0, 300)}…` : body)),
                      h('div', { className: 'csb-msg-time' }, fmt(m.at)))
                  }),
                  h('div', { ref: endRef }))),
                h('div', { className: 'csb-bar' },
                  h('input', {
                    className: 'csb-in csb-grow', placeholder: '说点什么…（回车发送）',
                    value: text, onChange: (e) => setText(e.target.value),
                    onKeyDown: (e) => e.key === 'Enter' && post(),
                  }),
                  h('button', { className: 'csb-btn csb-btn-p', disabled: !text.trim(), onClick: post }, '发送')),
              // ── 右栏：管理 ──
              h('div', { className: 'csb-room-side' },
                h(Section, { title: '房间信息', desc: '基本信息和设置' }),
                h('div', { className: 'csb-kv', style: { marginTop: 8 } },
                  h('span', { className: 'csb-k' }, '名称'), h('span', { className: 'csb-v' }, current.name),
                  h('span', { className: 'csb-k' }, '模式'), h('span', { className: 'csb-v' }, current.mode === 'admin' ? '管理员模式' : '自由发言'),
                  h('span', { className: 'csb-k' }, '成员'), h('span', { className: 'csb-v' }, `${(current.members ?? []).length} 人`),
                  h('span', { className: 'csb-k' }, '消息数'), h('span', { className: 'csb-v' }, msgs.length),
                  h('span', { className: 'csb-k' }, '管理员'), h('span', { className: 'csb-v' }, current.adminId ? botName(bots, current.adminId) : '—')),
                current.settings?.allowBotAutoPost !== false
                  ? h('div', { className: 'csb-note', style: { marginTop: 8 } }, '✅ 发言后自动唤醒房间内 Bot')
                  : h('div', { className: 'csb-note', style: { marginTop: 8 } }, '⏸️ 已关闭自动唤醒'),
                h('div', { className: 'csb-bar', style: { marginTop: 8 } },
                  h('button', { className: 'csb-btn csb-btn-s', onClick: () => setEditing(current) }, '编辑设置')),
                h(Section, { title: '成员管理', desc: '勾选要拉进来的 Bot' }),
                h('div', { className: 'csb-pick', style: { marginTop: 8 } },
                  bots.filter((b) => b.state !== 'retired').length === 0
                    ? h('div', { className: 'csb-set-d', style: { padding: '8px 9px' } }, '还没有 Bot —— 先去「Bot」页建一个')
                    : bots.filter((b) => b.state !== 'retired').map((b) => {
                        const inRoom = (current.members ?? []).includes(b.sessionId)
                        const role = (current.roles ?? {})[b.sessionId]
                        return h('label', { key: b.id, className: 'csb-pick-i' },
                          h('input', {
                            type: 'checkbox', checked: inRoom,
                            onChange: (e) => member(e.target.checked ? 'join' : 'leave', b.sessionId),
                          }),
                          h('span', null, b.name),
                          h('span', { className: 'csb-set-d' },
                            inRoom ? `已在房间${role ? ` · ${role === 'admin' ? '管理员' : role === 'observer' ? '旁听' : '成员'}` : ''}` : '未加入'))
                        }))))
          : null,

        // 长正文全文
        showBody
          ? h(Modal, {
              title: `第 ${showBody.seq} 条 · 全文`,
              wide: true,
              onClose: () => setShowBody(null),
              footer: [h('button', { key: 'c', className: 'csb-btn', onClick: () => setShowBody(null) }, '关闭')],
            }, h('div', { className: 'csb-pre', style: { whiteSpace: 'pre-wrap' } }, showBody.body ?? showBody.text ?? ''))
          : null,

        editing
          ? h(RoomEditor, {
              room: editing, bots,
              onClose: () => setEditing(null),
              onSaved: () => { setEditing(null); setOk('房间设置已保存'); reload() },
              onError: setErr,
            })
          : null,

        confirmDel
          ? h(ConfirmModal, {
              title: '删除这个房间？',
              message: `「${confirmDel.name}」及其消息会被彻底删除，无法恢复。\n\n如果只是想先停用，用「归档」更安全。`,
              danger: true, confirmText: '彻底删除',
              onCancel: () => setConfirmDel(null),
              onConfirm: async () => {
                const r = confirmDel
                setConfirmDel(null)
                try {
                  await call('/rooms/remove', {
                    method: 'POST',
                    body: { roomId: r.id, expectedRev: r.rev, force: true },
                  })
                  setOk('房间已删除')
                  if (active === r.id) setActive(null)
                  reload()
                } catch (e) {
                  setErr(`${e.message}（如果房间里有消息，必须用强制删除）`)
                }
              },
            })
          : null)
    }

    function RoomEditor({ room, bots, onClose, onSaved, onError }) {
      const [form, setForm] = useState({
        name: room.name ?? '',
        notice: room.notice ?? '',
        purpose: room.purpose ?? '',
        mode: room.mode ?? 'everyone',
        adminId: room.adminId ?? '',
      })
      const [settings, setSettings] = useState({
        allowBotAutoPost: room.settings?.allowBotAutoPost !== false,
        maxBotsPerRound: room.settings?.maxBotsPerRound ?? 3,
        relayEnabled: room.settings?.relayEnabled !== false,
      })
      const save = async () => {
        try {
          await call('/rooms/update', {
            method: 'POST',
            body: {
              roomId: room.id,
              expectedRev: room.rev,
              name: form.name,
              notice: form.notice,
              purpose: form.purpose,
              mode: form.mode,
              adminId: form.adminId || null,
              settings: {
                allowBotAutoPost: settings.allowBotAutoPost,
                maxBotsPerRound: Number(settings.maxBotsPerRound) || 3,
                relayEnabled: settings.relayEnabled,
              },
              byId: 'user',
            },
          })
          onSaved()
        } catch (e) {
          onError(e.message)
          onClose()
        }
      }
      return h(Modal, {
        title: `房间设置 · ${room.name}`,
        wide: true,
        onClose,
        footer: [
          h('button', { key: 'c', className: 'csb-btn', onClick: onClose }, '取消'),
          h('button', { key: 's', className: 'csb-btn csb-btn-p', onClick: save }, '保存'),
        ],
      },
        h(Field, { label: '房间名' },
          h('input', { className: 'csb-in', value: form.name, onChange: (e) => setForm({ ...form, name: e.target.value }) })),
        h(Field, { label: '这个房间是干什么的', hint: '一句话说明用途，方便以后判断消息该发哪里' },
          h('input', {
            className: 'csb-in', value: form.purpose,
            placeholder: '例如：发版前的跨组协调',
            onChange: (e) => setForm({ ...form, purpose: e.target.value }),
          })),
        h(Field, { label: '发言方式' },
          h('select', {
            className: 'csb-sel', value: form.mode,
            onChange: (e) => setForm({ ...form, mode: e.target.value }),
          },
          h('option', { value: 'everyone' }, '自由发言（所有成员都能说话、都能改设置）'),
          h('option', { value: 'admin' }, '管理员模式（只有管理员能改设置）')),
          h('div', { className: 'csb-field-h' }, `${(room.members ?? []).length} 个成员，${room.seq ?? 0} 条消息`)),
        form.mode === 'admin'
          ? h(Field, { label: '管理员是谁', hint: '填会话 ID；留空表示还没指定' },
              h('input', {
                className: 'csb-in', value: form.adminId,
                onChange: (e) => setForm({ ...form, adminId: e.target.value }),
              }))
          : null,
        h(Field, { label: '房间公告', hint: '会显示在消息列表上方，所有进这个房间的人都能看到' },
          h('textarea', {
            className: 'csb-ta', value: form.notice,
            placeholder: '例如：本房间只讨论发布相关事项；发版前 24 小时冻结代码。',
            onChange: (e) => setForm({ ...form, notice: e.target.value }),
          })),
        h('h4', { style: { marginTop: 18 } }, '房间规则'),
        h(Field, { label: '允许 Bot 自己发言', hint: '关掉后只有人能主动发消息，Bot 只能被动回复' },
          h('label', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
            h('input', {
              type: 'checkbox', checked: settings.allowBotAutoPost,
              onChange: (e) => setSettings({ ...settings, allowBotAutoPost: e.target.checked }),
            }), settings.allowBotAutoPost ? '允许' : '不允许')),
        h(Field, { label: '一轮里最多几个 Bot 说话', hint: '防止多个 Bot 抢话刷屏' },
          h('input', {
            className: 'csb-in', type: 'number', min: 1, max: 20, value: settings.maxBotsPerRound,
            onChange: (e) => setSettings({ ...settings, maxBotsPerRound: e.target.value }),
          })),
        h(Field, { label: '允许转发消息去唤醒 Bot', hint: '关掉后这个房间不能做跨房间转发' },
          h('label', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
            h('input', {
              type: 'checkbox', checked: settings.relayEnabled,
              onChange: (e) => setSettings({ ...settings, relayEnabled: e.target.checked }),
            }), settings.relayEnabled ? '允许' : '不允许')))
    }

    // ── 记忆 ────────────────────────────────────────────────────────────────

    const LAYERS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5']
    const LAYER_HINT = { L0: '人格（仅人可改）', L1: '用户偏好', L2: '团队规矩', L3: '分支专属', L4: '任务笔记', L5: '归档' }

    function MemoryTab() {
      const [layer, setLayer] = useState('')
      const [query, setQuery] = useState('')
      const [project, setProject] = useState('*')
      const [stats, setStats] = useState(null)
      const [showArchived, setShowArchived] = useState(false)
      const [err, setErr] = useState(null)
      const [ok, setOk] = useState(null)
      const [adding, setAdding] = useState(false)
      const [newLayer, setNewLayer] = useState('L2')
      const [newContent, setNewContent] = useState('')
      const [newTags, setNewTags] = useState('')
      const [editing, setEditing] = useState(null)
      const [detail, setDetail] = useState(null)
      const [ctxPreview, setCtxPreview] = useState(null)
      const [confirmDel, setConfirmDel] = useState(null)
      const [confirmPurge, setConfirmPurge] = useState(null)
      const [showSug, setShowSug] = useState(false)

      const qs = new URLSearchParams()
      if (query) qs.set('query', query)
      if (layer) qs.set('layer', layer)
      if (project !== '*') qs.set('cwd', project)
      if (showArchived) qs.set('onlyArchived', '1')
      const { data, loading, error, reload } = useApi(`/memory?${qs.toString()}`, [layer, query, showArchived, project])
      const loadStats = useCallback(() => {
        call('/memory/stats').then((d) => setStats(d.stats)).catch(() => {})
      }, [])
      useEffect(() => loadStats(), [loadStats])
      const { data: sugData, reload: reloadSug } = useApi('/suggestions?status=pending')

      const entries = data?.entries ?? []
      const suggestions = sugData?.items ?? []

      const act = (p, body) => call(p, { method: 'POST', body })
        .then(() => { setErr(null); setOk('操作成功'); reload() })
        .catch((e) => setErr(e.message))

      const splitTags = (t) => String(t ?? '').split(/[,，]/).map((x) => x.trim()).filter(Boolean)

      const add = async () => {
        if (!newContent.trim()) return
        setErr(null)
        try {
          await call('/memory', {
            method: 'POST',
            body: {
              layer: newLayer,
              content: newContent.trim(),
              tags: splitTags(newTags),
              by: 'user',
              explicit: true,
            },
          })
          setNewContent('')
          setNewTags('')
          setAdding(false)
          setOk('已添加')
          reload()
        } catch (e) {
          setErr(e.message)
        }
      }

      const openDetail = async (e) => {
        setErr(null)
        try {
          const d = await call(`/memory/detail?id=${encodeURIComponent(e.id)}&layer=${encodeURIComponent(e.layer)}`)
          setDetail(d)
        } catch (ec) {
          setErr(ec.message)
        }
      }

      const saveEdit = async () => {
        setErr(null)
        try {
          await call('/memory/update', {
            method: 'POST',
            body: {
              layer: editing.layer,
              id: editing.id,
              expectedRev: editing.rev,
              content: editing.content,
              tags: splitTags(editing.tagsText),
              explicit: editing.explicit === true,
            },
          })
          setEditing(null)
          setOk('已保存')
          reload()
        } catch (e) {
          setErr(e.message)
        }
      }

      const decideSuggestion = async (sg, accept) => {
        setErr(null)
        try {
          if (accept) {
            await call('/suggestions/accept', { method: 'POST', body: { id: sg.id } })
            setOk('已采纳，内容已写入记忆')
          } else {
            await call('/suggestions/reject', { method: 'POST', body: { id: sg.id, reason: '人工驳回' } })
            setOk('已驳回')
          }
          reload()
          reloadSug()
        } catch (e) {
          setErr(e.message)
        }
      }

      return h('div', { className: 'csb-wrap' },
        h(Section, {
          title: '记忆',
          desc: '越靠上的层越"重"：人格和你明确说的话（L0–L1）永远不丢；L2–L3 常驻注入；'
            + 'L4/L5 只在需要时检索。点任意一条可以看全文、修改、删除。',
        }),

        suggestions.length > 0
          ? h('div', {
              className: 'csb-notice csb-notice-err',
              style: { marginTop: 12, cursor: 'pointer' },
              onClick: () => setShowSug(true),
            },
            h('span', { className: 'csb-notice-t' },
              `有 ${suggestions.length} 条「自动整理建议」等你确认 —— 模型不能直接改你的长期记忆，只能提议。点这里看。`),
            h('span', { className: 'csb-b' }, '去确认'))
          : null,

        h('div', { className: 'csb-bar', style: { marginTop: 12 } },
          h('select', {
            className: 'csb-sel', style: { width: 200 }, value: project,
            onChange: (e) => setProject(e.target.value),
            title: '项目记忆只在对应工作目录里生效，避免 A 项目的事串到 B 项目',
          },
          h('option', { value: '*' }, '全部项目（不做隔离）'),
          Object.entries(stats?.cwd?.byCwd ?? {}).map(([dir, n]) =>
            h('option', { key: dir, value: dir }, `${short(dir, 42)}（${n} 条）`))),
          layer
            ? null
            : null),
        (stats?.cwd?.unassignedActive ?? 0) > 0 && project !== '*'
          ? h('div', { className: 'csb-notice csb-notice-err', style: { marginBottom: 12 } },
              h('span', { className: 'csb-notice-t' },
                `有 ${stats.cwd.unassignedActive} 条历史记忆还不知道属于哪个项目（改造前写的）。`
                + '它们现在不会出现在任何项目视图里 —— 宁可少看见，也不要把别的项目的事串进来。'),
              h('button', {
                className: 'csb-btn csb-btn-s',
                onClick: () => call('/memory/migrate-cwd', { method: 'POST', body: { cwd: project } })
                  .then((d) => {
                    setOk(`已把 ${d.result?.migrated ?? 0} 条历史记忆归到当前项目`)
                    loadStats()
                    reload()
                  })
                  .catch((e) => setErr(e.message)),
              }, '归到当前项目'))
          : null,
        h('div', { className: 'csb-bar' },
          h('select', {
            className: 'csb-sel', style: { width: 176 }, value: layer,
            onChange: (e) => setLayer(e.target.value),
          },
          h('option', { value: '' }, '全部层'),
          LAYERS.map((l) => h('option', { key: l, value: l }, `${l} · ${LAYER_HINT[l]}`))),
          h('input', {
            className: 'csb-in csb-grow', placeholder: '搜记忆…',
            value: query, onChange: (e) => setQuery(e.target.value),
          }),
          h('button', {
            className: `csb-btn csb-btn-s${showArchived ? ' csb-btn-p' : ''}`,
            onClick: () => setShowArchived((v) => !v),
          }, showArchived ? '看有效记忆' : '看归档'),
          h('button', { className: 'csb-btn csb-btn-s', onClick: () => setAdding(true) }, '＋ 新建'),
          h('button', {
            className: 'csb-btn csb-btn-s',
            onClick: () => call(`/memory/context${project !== '*' ? `?cwd=${encodeURIComponent(project)}` : ''}`)
              .then((d) => setCtxPreview(d.text)).catch((e) => setErr(e.message)),
          }, '看注入效果')),

        h(Notice, { kind: 'ok', onClose: () => setOk(null) }, ok),
        h(Notice, { kind: 'err', onClose: () => setErr(null) }, err),
        error ? h('div', { className: 'csb-err' }, error) : null,
        loading ? h(Skeleton, { n: 3 }) : null,
        !loading && entries.length === 0
          ? h(Empty, {
              icon: '◇',
              title: showArchived ? '归档区是空的' : '还没有记忆条目',
              hint: showArchived
                ? '归档的记忆不参与注入，但随时可以恢复。'
                : '把「以后一直有用的事实和规矩」写进来（比如：本项目用 pnpm）。一次性的笔记放 L4。',
              action: showArchived ? null : { label: '新建记忆', icon: '✎', onClick: () => setAdding(true) },
            })
          : null,

        h('div', { className: 'csb-list' }, entries.map((e) =>
          h('div', { key: e.id, className: 'csb-card' },
            h('div', {
              className: 'csb-card-main csb-card-c',
              onClick: () => openDetail(e),
              title: '点开看全文与历史',
            },
              h('div', {
                className: 'csb-card-t2',
                style: { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' },
              }, e.content),
              h('div', { className: 'csb-card-m' },
                h('span', { className: 'csb-b' }, `${e.layer} · ${LAYER_HINT[e.layer] ?? ''}`),
                e.botId ? h('span', { className: 'csb-b' }, `Bot ${short(e.botId, 10)}`) : h('span', { className: 'csb-b' }, '全局'),
                e.explicit ? h('span', { className: 'csb-b csb-b-ok' }, '你说过的') : null,
                e.conflict ? h('span', { className: 'csb-b csb-b-err' }, '与另一条冲突') : null,
                e.archived
                  ? h('span', { className: 'csb-b csb-b-idle' },
                      e.archived?.reason === 'removed' ? '已删除（可恢复）' : '已归档')
                  : null,
                e.splitTotal > 1 ? h('span', { className: 'csb-b' }, `超长切成 ${e.splitTotal} 段`) : null,
                (e.tags ?? []).length ? h('span', null, (e.tags ?? []).map((t) => `#${t}`).join(' ')) : null,
                h('span', null, `· 第 ${e.rev} 版`))),
            h('div', { style: { display: 'flex', gap: 6, flex: 'none' } },
              h('button', {
                className: 'csb-btn csb-btn-s',
                onClick: () => setEditing({
                  ...e,
                  tagsText: (e.tags ?? []).join(', '),
                }),
              }, '改'),
              e.archived
                ? h('button', { className: 'csb-btn csb-btn-s', onClick: () => act('/memory/restore', { layer: e.layer, id: e.id }) }, '恢复')
                : h('button', { className: 'csb-btn csb-btn-s', onClick: () => act('/memory/archive', { layer: e.layer, id: e.id, reason: '过时' }) }, '归档'),
              e.archived
                ? h('button', {
                    className: 'csb-btn csb-btn-s csb-btn-d',
                    title: '从记忆库里彻底抹掉，不可恢复',
                    onClick: () => setConfirmPurge(e),
                  }, '彻底删除')
                : h('button', { className: 'csb-btn csb-btn-s csb-btn-d', onClick: () => setConfirmDel(e) }, '删除'))))),

        // ── 新建 ──
        adding
          ? h(Modal, {
              title: '新建记忆条目',
              onClose: () => setAdding(false),
              footer: [
                h('button', { key: 'c', className: 'csb-btn', onClick: () => setAdding(false) }, '取消'),
                h('button', { key: 's', className: 'csb-btn csb-btn-p', disabled: !newContent.trim(), onClick: add }, '保存'),
              ],
            },
            h(Field, { label: '放在哪一层', hint: '拿不准就选 L2（团队全局）或 L3（本项目）' },
              h('select', {
                className: 'csb-sel', value: newLayer,
                onChange: (e) => setNewLayer(e.target.value),
              }, LAYERS.filter((l) => l !== 'L0').map((l) => h('option', { key: l, value: l }, `${l} · ${LAYER_HINT[l]}`)))),
            h(Field, { label: '内容', hint: `${newContent.length} / 600 字，超长会自动切成多条存（不丢内容）` },
              h('textarea', {
                className: 'csb-ta', value: newContent,
                placeholder: '例如：本项目只用 pnpm，不用 npm。',
                onChange: (e) => setNewContent(e.target.value),
              })),
            h(Field, { label: '标签', hint: '用逗号分隔，方便以后搜' },
              h('input', {
                className: 'csb-in', value: newTags, placeholder: '例如：构建, 依赖',
                onChange: (e) => setNewTags(e.target.value),
              })),
            h('div', { className: 'csb-field-h' },
              '你手动写的内容会标记为「你说过的」——以后自动整理只能建议、不能改它。'))
          : null,

        // ── 编辑 ──
        editing
          ? h(Modal, {
              title: '修改记忆',
              wide: true,
              onClose: () => setEditing(null),
              footer: [
                h('button', { key: 'c', className: 'csb-btn', onClick: () => setEditing(null) }, '取消'),
                h('button', { key: 's', className: 'csb-btn csb-btn-p', onClick: saveEdit }, '保存'),
              ],
            },
            h(Field, { label: `内容（${editing.layer} · ${LAYER_HINT[editing.layer] ?? ''}）` },
              h('textarea', {
                className: 'csb-ta', style: { minHeight: 160 }, value: editing.content,
                onChange: (e) => setEditing({ ...editing, content: e.target.value }),
              })),
            h(Field, { label: '标签' },
              h('input', {
                className: 'csb-in', value: editing.tagsText ?? '',
                onChange: (e) => setEditing({ ...editing, tagsText: e.target.value }),
              })),
            h(Field, { label: '保护级别', hint: '勾上＝你说过的话，自动整理不能改；不勾＝允许模型提议修订' },
              h('label', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                h('input', {
                  type: 'checkbox', checked: editing.explicit === true,
                  onChange: (e) => setEditing({ ...editing, explicit: e.target.checked }),
                }), '这是我说过的话，不许自动改')))
          : null,

        // ── 详情 ──
        detail
          ? h(Drawer, {
              title: '记忆详情',
              onClose: () => setDetail(null),
              footer: [h('button', { key: 'c', className: 'csb-btn', onClick: () => setDetail(null) }, '关闭')],
            },
            h('div', { className: 'csb-card-m', style: { marginBottom: 10 } },
              h('span', { className: 'csb-b' }, `${detail.entry?.layer} · ${LAYER_HINT[detail.entry?.layer] ?? ''}`),
              h('span', { className: 'csb-b' }, `第 ${detail.entry?.rev} 版`),
              detail.entry?.explicit ? h('span', { className: 'csb-b csb-b-ok' }, '你说过的') : null),
            h('div', { className: 'csb-pre', style: { whiteSpace: 'pre-wrap' } }, detail.entry?.content ?? ''),
            h('h4', { style: { marginTop: 18 } }, '修改历史'),
            h('div', { className: 'csb-list' }, (detail.history ?? []).slice(-10).reverse().map((ev, i) =>
              h('div', { key: i, className: 'csb-card', style: { padding: '8px 10px' } },
                h('div', { className: 'csb-card-main' },
                  h('div', { className: 'csb-card-m' },
                    h('span', { className: 'csb-b' }, ev.action ?? '变更'),
                    h('span', null, new Date(ev.at ?? 0).toLocaleString()),
                    h('span', null, `由 ${ev.byId ?? ev.by ?? '未知'}`)))))))
          : null,

        // ── 建议确认 ──
        showSug
          ? h(Modal, {
              title: '自动整理建议',
              wide: true,
              onClose: () => setShowSug(false),
              footer: [h('button', { key: 'c', className: 'csb-btn', onClick: () => setShowSug(false) }, '关闭')],
            },
            h('p', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } },
              '这些是模型整理的「它认为该记住/该改」的条目。你不点采纳，它就不会生效。'),
            suggestions.length === 0
              ? h(Empty, { icon: '✓', title: '没有待确认的建议', hint: '有建议时这里会出现。' })
              : h('div', { className: 'csb-list' }, suggestions.map((sg) => h('div', { key: sg.id, className: 'csb-card' },
                  h('div', { className: 'csb-card-main' },
                    h('div', { className: 'csb-card-t2' }, sg.payload?.content ?? sg.payload?.name ?? sg.payload?.title ?? '（无内容）'),
                    h('div', { className: 'csb-card-m' },
                      h('span', { className: 'csb-b' }, sg.kind),
                      sg.layer ? h('span', { className: 'csb-b' }, sg.layer) : null,
                      sg.reason ? h('span', null, sg.reason) : null,
                      sg.confidence ? h('span', null, `把握 ${Math.round(sg.confidence * 100)}%`) : null)),
                  h('div', { style: { display: 'flex', gap: 6, flex: 'none' } },
                    h('button', { className: 'csb-btn csb-btn-s csb-btn-p', onClick: () => decideSuggestion(sg, true) }, '采纳'),
                    h('button', { className: 'csb-btn csb-btn-s', onClick: () => decideSuggestion(sg, false) }, '驳回'))))))
          : null,

        // ── 注入效果 ──
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
              message: `内容：${confirmDel.content.slice(0, 80)}\n\n`
                + '删除后模型不会再看到它。这条会移进「归档」区保留一段时间，误删还能恢复；'
                + '想彻底抹掉请到归档区点「彻底删除」。',
              danger: true, confirmText: '删除',
              onCancel: () => setConfirmDel(null),
              onConfirm: async () => {
                const e = confirmDel
                setConfirmDel(null)
                await act('/memory/remove', { layer: e.layer, id: e.id })
              },
            })
          : null,

        confirmPurge
          ? h(ConfirmModal, {
              title: '彻底删除，无法恢复',
              message: `内容：${confirmPurge.content.slice(0, 120)}\n\n`
                + '这一步会把这条件目从记忆库里抹掉，模型以后永远看不到它，也不能恢复。\n'
                + '如果里面有你以后还想查的内容，请先用「恢复」拿回来备份。',
              danger: true, confirmText: '我确认，彻底删除',
              onCancel: () => setConfirmPurge(null),
              onConfirm: async () => {
                const e = confirmPurge
                setConfirmPurge(null)
                setErr(null)
                try {
                  await call('/memory/purge', {
                    method: 'POST',
                    body: { layer: e.layer, id: e.id, expectedRev: e.rev },
                  })
                  setOk('已彻底删除')
                  loadStats()
                  reload()
                } catch (ec) {
                  setErr(ec.message)
                }
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

    /** 下拉选择行：用于 options 类型的设置项（如渐进式披露）。 */
    function SelectRow({ id, spec, value, onChange }) {
      return h(Field, { label: spec.label },
        h('select', {
          className: 'csb-sel', style: { width: 180 }, value: String(value),
          onChange: (e) => onChange(e.target.value),
        },
        spec.options.map((o) =>
          h('option', { key: o, value: o }, o))))
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

    /** 记忆自审设置（间隔 + 当前状态）。 */
    function ReviewSettings() {
      const { data, reload } = useApi('/review/status?sessionId=ui')
      const [interval, setInterval] = useState(null)
      const [err, setErr] = useState(null)
      const [ok, setOk] = useState(null)
      const cur = data?.status?.interval
      const val = interval ?? cur ?? ''

      const save = async () => {
        setErr(null)
        try {
          await call('/review/interval', { method: 'POST', body: { interval: Number(val) } })
          setOk('已保存，下个回合起生效')
          setInterval(null)
          reload()
        } catch (e) {
          setErr(e.message)
        }
      }

      return h('div', { style: { marginTop: 12 } },
        h('div', { className: 'csb-bar' },
          h('span', { className: 'csb-set-d' }, '每隔'),
          h('input', {
            className: 'csb-in', type: 'number', min: 1, max: 100000,
            style: { width: 90 }, value: val,
            onChange: (e) => setInterval(e.target.value),
          }),
          h('span', { className: 'csb-set-d' }, '回合提醒一次'),
          h('button', {
            className: 'csb-btn csb-btn-p csb-btn-s',
            disabled: val === '' || String(val) === String(cur),
            onClick: save,
          }, '保存')),
        h('div', { className: 'csb-field-h' },
          '数字越小越频繁（费 token）。一般 10 回合一次就够了；'
          + (cur ? `当前是每 ${cur} 回合。` : '')),
        h(Notice, { kind: 'ok', onClose: () => setOk(null) }, ok),
        h(Notice, { kind: 'err', onClose: () => setErr(null) }, err))
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
      const MEM_ADV_KEYS = ['reviewEnabled', 'reviewInterval', 'reviewMode', 'skillReviewEnabled', 'skillMaxBytes', 'entryDatePrefix', 'keyProgressiveDisclosure', 'keyFullInjectThreshold', 'keyFullInjectCharLimit', 'perTurnWrites', 'writeGuardThreshold', 'perTurnWriteGuard']

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

        h(Section, {
          title: '记忆自审',
          desc: '每聊若干回合，让模型停下来检查一次「有没有该记住的、有没有记错的」。'
            + '它只会**提议**，你在「记忆」页点采纳才真正写进去。',
        }),
        h(ReviewSettings, {}),

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

        h(Section, {
          title: '记忆自审与进化',
          desc: '对照记忆进化的能力逐项补齐。改完保存即生效。',
        }),
        h('div', { style: { marginTop: 12 } },
          MEM_ADV_KEYS.filter((k) => specs[k]).map((k) => {
            if (specs[k].bool) return h(BoolRow, { key: k, id: k, spec: specs[k], value: val(k), onChange: (v) => setDraft({ ...draft, [k]: v }) })
            if (specs[k].options) return h(SelectRow, { key: k, id: k, spec: specs[k], value: val(k), onChange: (v) => setDraft({ ...draft, [k]: v }) })
            return h(NumberRow, { key: k, id: k, spec: specs[k], value: val(k), onChange: (v) => setDraft({ ...draft, [k]: v }) })
          })),

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


    // ══════════════════════════════════════════════════════════════════════
    // v2 新页面（2026-11-05）
    // 设计纪律：不出现 L0/rev/cwd/CAS 等内部术语；空态有引导；破坏操作二次确认；
    //          保存有明确反馈；长文折叠展开。
    // ══════════════════════════════════════════════════════════════════════

    /** 表单行：标签 + 说明 + 控件（人类视角：先说要填什么，再说为什么）。 */
    function Field({ label, hint, children }) {
      return h('div', { className: 'csb-field' },
        h('div', { className: 'csb-field-l' }, label),
        h('div', { className: 'csb-field-c' }, children),
        hint ? h('div', { className: 'csb-field-h' }, hint) : null)
    }

    /** 操作结果提示条（成功/失败都说人话）。 */
    function Notice({ kind, children, onClose }) {
      if (!children) return null
      return h('div', { className: `csb-notice csb-notice-${kind ?? 'ok'}` },
        h('span', { className: 'csb-notice-t' }, children),
        onClose ? h('button', { className: 'csb-btn-x', onClick: onClose, 'aria-label': '关闭' }, '×') : null)
    }

    // ── 待办 ────────────────────────────────────────────────────────────────
    const TRACKS = [
      { id: 'life', label: '生活', hint: '家务、健康、私人事务' },
      { id: 'work', label: '工作', hint: '跨项目的工作事项' },
      { id: 'project', label: '本项目', hint: '跟着当前工作目录走' },
      { id: 'daily', label: '每日', hint: '今天要做的事' },
    ]
    const QUADRANTS = [
      { id: 'q1', label: '重要且紧急', hint: '马上做', color: 'var(--dsw-alias-state-error-primary)' },
      { id: 'q2', label: '重要不紧急', hint: '排计划做', color: 'var(--dsw-alias-state-warning-primary)' },
      { id: 'q3', label: '紧急不重要', hint: '尽快处理或委托', color: 'var(--dsw-alias-state-info-primary)' },
      { id: 'q4', label: '不重要不紧急', hint: '有空再说', color: 'var(--dsw-alias-label-secondary)' },
    ]
    const TODO_STATUS = {
      pending: { label: '待办', cls: 'csb-b' },
      doing: { label: '进行中', cls: 'csb-b csb-b-warn' },
      done: { label: '已完成', cls: 'csb-b csb-b-ok' },
      blocked: { label: '卡住了', cls: 'csb-b csb-b-err' },
      cancelled: { label: '已取消', cls: 'csb-b csb-b-idle' },
    }

    function todayStr() {
      const d = new Date()
      const p = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    }

    function TodoTab() {
      const [track, setTrack] = useState('daily')
      const [showAll, setShowAll] = useState(false)
      const [err, setErr] = useState(null)
      const [ok, setOk] = useState(null)
      const [adding, setAdding] = useState(false)
      const [form, setForm] = useState({ content: '', quadrant: 'q2', due: '', cat: '' })
      const [editing, setEditing] = useState(null)
      const [confirmDel, setConfirmDel] = useState(null)

      const qs = new URLSearchParams({ track })
      if (showAll) qs.set('all', '1')
      const { data, loading, error, reload } = useApi(`/todos?${qs.toString()}`, [track, showAll])
      const todos = data?.items ?? data?.todos ?? []

      const act = (p, body) => call(p, { method: 'POST', body })
        .then(() => { setErr(null); reload() })
        .catch((e) => setErr(e.message))

      const create = async () => {
        if (!form.content.trim()) return
        setErr(null)
        try {
          await call('/todos', {
            method: 'POST',
            body: {
              track,
              content: form.content.trim(),
              quadrant: form.quadrant,
              due: form.due || null,
              cat: form.cat || null,
              ...(track === 'daily' ? { date: todayStr() } : {}),
            },
          })
          setForm({ content: '', quadrant: 'q2', due: '', cat: '' })
          setAdding(false)
          setOk('已添加')
          reload()
        } catch (e) {
          setErr(e.message)
        }
      }

      // 待办 → 任务：待办是个人备忘，任务是要交出去的协作单元。
      // 幂等由服务端 sourceSeq 保证，连点两次不会产生两个任务。
      const promote = async (t) => {
        setErr(null)
        try {
          const out = await call('/todos/promote', { method: 'POST', body: { id: t.id, expectedRev: t.rev } })
          setOk(`已放进协作看板（任务：${out.task?.subject ?? ''}）——去「协作看板」看进度，待办这边标成进行中`)
          reload()
        } catch (e) {
          setErr(e.message)
        }
      }

      const toggleDone = (t) => {
        const next = t.status === 'done' ? 'pending' : 'done'
        act('/todos/update', { id: t.id, expectedRev: t.rev, status: next })
      }

      const saveEdit = async () => {
        try {
          await call('/todos/update', {
            method: 'POST',
            body: {
              id: editing.id,
              expectedRev: editing.rev,
              content: editing.content,
              quadrant: editing.quadrant,
              due: editing.due || null,
              cat: editing.cat || null,
            },
          })
          setEditing(null)
          setOk('已保存')
          reload()
        } catch (e) {
          setErr(e.message)
        }
      }

      const overdue = (t) => t.due && t.status !== 'done' && t.status !== 'cancelled' && t.due < todayStr()

      return h('div', { className: 'csb-wrap' },
        h(Section, {
          title: '我的待办',
          desc: '给自己记的事，四类分开管：生活、工作、本项目、每日。可以标「重要 / 紧急」，逾期自动变红。'
            + '要交给 Bot 或别人做的，点「派下去」就会出现在「协作看板」里。',
        }),
        h('div', { className: 'csb-bar', style: { marginTop: 12 } },
          TRACKS.map((t) => h('button', {
            key: t.id,
            className: `csb-btn csb-btn-s${track === t.id ? ' csb-btn-p' : ''}`,
            title: t.hint,
            onClick: () => setTrack(t.id),
          }, t.label)),
          h('span', { className: 'csb-spacer' }),
          h('button', {
            className: `csb-btn csb-btn-s${showAll ? ' csb-btn-p' : ''}`,
            onClick: () => setShowAll((v) => !v),
          }, showAll ? '只看要关注的' : '全部显示'),
          h('button', { className: 'csb-btn csb-btn-p csb-btn-s', onClick: () => setAdding(true) }, '＋ 新建待办')),

        h(Notice, { kind: 'ok', onClose: () => setOk(null) }, ok),
        h(Notice, { kind: 'err', onClose: () => setErr(null) }, err),
        error ? h('div', { className: 'csb-err' }, error) : null,

        loading ? h(Skeleton, { n: 4 }) : null,
        !loading && todos.length === 0
          ? h(Empty, {
              icon: '☑',
              title: `「${TRACKS.find((t) => t.id === track)?.label}」这类还没有待办`,
              hint: '点右上角「＋ 新建待办」记一件要做的事。逾期的会排在前面。',
              action: { label: '新建待办', icon: '✎', onClick: () => setAdding(true) },
            })
          : null,

        h('div', { className: 'csb-list' }, todos.map((t) => {
          const q = QUADRANTS.find((x) => x.id === t.quadrant) ?? QUADRANTS[3]
          const st = TODO_STATUS[t.status] ?? TODO_STATUS.pending
          const isOverdue = overdue(t)
          return h('div', { key: t.id, className: 'csb-card' },
            h('span', {
              style: {
                width: 4, height: 30, borderRadius: 2, flex: 'none',
                background: q.color, opacity: t.status === 'done' ? 0.35 : 1,
              },
              title: q.label,
            }),
            h('input', {
              type: 'checkbox',
              checked: t.status === 'done',
              onChange: () => toggleDone(t),
              style: { cursor: 'pointer', flex: 'none' },
              'aria-label': '标记完成',
            }),
            h('div', { className: 'csb-card-main' },
              h('div', {
                className: 'csb-card-t2',
                style: t.status === 'done' ? { textDecoration: 'line-through', opacity: 0.55 } : null,
              }, t.content.split('\n')[0]),
              h('div', { className: 'csb-card-m' },
                h('span', { className: st.cls }, st.label),
                h('span', { className: 'csb-b' }, q.label),
                t.cat ? h('span', { className: 'csb-b' }, t.cat) : null,
                t.due
                  ? h('span', { className: isOverdue ? 'csb-b csb-b-err' : 'csb-b' },
                      isOverdue ? `逾期 ${t.due}` : `截止 ${t.due}`)
                  : null)),
            h('div', { style: { display: 'flex', gap: 6, flex: 'none' } },
              t.status === 'done'
                ? null
                : h('button', {
                    className: 'csb-btn csb-btn-s',
                    title: '把它变成一个正式任务，放进协作看板交给 Bot 或别人做',
                    onClick: () => promote(t),
                  }, '派下去'),
              h('button', {
                className: 'csb-btn csb-btn-s',
                onClick: () => setEditing({ ...t }),
              }, '改'),
              h('button', {
                className: 'csb-btn csb-btn-s csb-btn-d',
                onClick: () => setConfirmDel(t),
              }, '删')))
        })),

        adding
          ? h(Modal, {
              title: '新建待办',
              onClose: () => setAdding(false),
              footer: [
                h('button', { key: 'c', className: 'csb-btn', onClick: () => setAdding(false) }, '取消'),
                h('button', { key: 's', className: 'csb-btn csb-btn-p', onClick: create }, '添加'),
              ],
            },
            h(Field, { label: '要做什么' },
              h('textarea', {
                className: 'csb-ta', autoFocus: true, placeholder: '例如：把插件发布流程写成脚本',
                value: form.content, onChange: (e) => setForm({ ...form, content: e.target.value }),
              })),
            h(Field, { label: '重要程度', hint: q2Hint(form.quadrant) },
              h('select', {
                className: 'csb-sel', value: form.quadrant,
                onChange: (e) => setForm({ ...form, quadrant: e.target.value }),
              }, QUADRANTS.map((q) => h('option', { key: q.id, value: q.id }, `${q.label}（${q.hint}）`)))),
            h(Field, { label: '截止日期', hint: '可不填。填了逾期会变红。' },
              h('input', {
                className: 'csb-in', type: 'date', value: form.due,
                onChange: (e) => setForm({ ...form, due: e.target.value }),
              })),
            h(Field, { label: '分类', hint: '可不填，例如「招聘」「报销」' },
              h('input', {
                className: 'csb-in', value: form.cat, placeholder: '分类',
                onChange: (e) => setForm({ ...form, cat: e.target.value }),
              })))
          : null,

        editing
          ? h(Modal, {
              title: '修改待办',
              onClose: () => setEditing(null),
              footer: [
                h('button', { key: 'c', className: 'csb-btn', onClick: () => setEditing(null) }, '取消'),
                h('button', { key: 's', className: 'csb-btn csb-btn-p', onClick: saveEdit }, '保存'),
              ],
            },
            h(Field, { label: '要做什么' },
              h('textarea', {
                className: 'csb-ta', value: editing.content,
                onChange: (e) => setEditing({ ...editing, content: e.target.value }),
              })),
            h(Field, { label: '重要程度' },
              h('select', {
                className: 'csb-sel', value: editing.quadrant,
                onChange: (e) => setEditing({ ...editing, quadrant: e.target.value }),
              }, QUADRANTS.map((q) => h('option', { key: q.id, value: q.id }, `${q.label}（${q.hint}）`)))),
            h(Field, { label: '截止日期' },
              h('input', {
                className: 'csb-in', type: 'date', value: editing.due ?? '',
                onChange: (e) => setEditing({ ...editing, due: e.target.value }),
              })),
            h(Field, { label: '分类' },
              h('input', {
                className: 'csb-in', value: editing.cat ?? '',
                onChange: (e) => setEditing({ ...editing, cat: e.target.value }),
              })))
          : null,

        confirmDel
          ? h(ConfirmModal, {
              title: '删除这条待办？',
              message: `「${confirmDel.content.split('\n')[0]}」删除后无法恢复。如果只是做完了，建议直接勾选完成。`,
              danger: true,
              confirmText: '删除',
              onCancel: () => setConfirmDel(null),
              onConfirm: () => {
                act('/todos/remove', { id: confirmDel.id, expectedRev: confirmDel.rev })
                setConfirmDel(null)
              },
            })
          : null)
    }

    function q2Hint(qid) {
      const q = QUADRANTS.find((x) => x.id === qid)
      return q ? q.hint : ''
    }

    // ── 便签 ────────────────────────────────────────────────────────────────
    function ScratchTab() {
      const { data, loading, error } = useApi('/scratch')
      const [text, setText] = useState('')
      const [dirty, setDirty] = useState(false)
      const [savedAt, setSavedAt] = useState(null)
      const [err, setErr] = useState(null)
      const [ok, setOk] = useState(null)
      const taRef = useRef(null)

      useEffect(() => {
        if (data && !dirty) {
          setText(data.text ?? '')
          setSavedAt(data.updatedAt ?? null)
        }
      }, [data])

      const save = useCallback(async () => {
        setErr(null)
        try {
          const out = await call('/scratch', { method: 'POST', body: { text } })
          setDirty(false)
          setSavedAt(out.updatedAt)
          setOk('已保存')
        } catch (e) {
          setErr(e.message)
        }
      }, [text])

      useEffect(() => {
        const onKey = (e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault()
            save()
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [save])

      const bytes = new Blob([text]).size

      return h('div', { className: 'csb-wrap' },
        h(Section, {
          title: '便签',
          desc: '随手记的地方。想写什么都行，不参与任何自动整理。按 Ctrl+S（Mac 上 ⌘S）保存。',
        }),
        h('div', { className: 'csb-bar', style: { marginTop: 12 } },
          h('span', { className: 'csb-hint', style: { marginLeft: 0 } },
            dirty ? '● 有未保存的修改' : (savedAt ? `上次保存：${new Date(savedAt).toLocaleString()}` : '还没保存过')),
          h('span', { className: 'csb-spacer' }),
          h('span', { className: 'csb-hint', style: { marginLeft: 0 } }, `${(bytes / 1024).toFixed(1)} KB / 512 KB`),
          h('button', {
            className: 'csb-btn csb-btn-p', disabled: !dirty, onClick: save,
          }, '保存')),
        h(Notice, { kind: 'ok', onClose: () => setOk(null) }, ok),
        h(Notice, { kind: 'err', onClose: () => setErr(null) }, err),
        error ? h('div', { className: 'csb-err' }, error) : null,
        loading
          ? h(Skeleton, { n: 1 })
          : h('textarea', {
              ref: taRef,
              className: 'csb-ta',
              style: { minHeight: '60vh', fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', fontSize: 13 },
              placeholder: '在这里随手记…\n\n例如：\n- 明天问小王要测试环境账号\n- 插件发布前记得跑 ci-zero-dep',
              value: text,
              onChange: (e) => {
                setText(e.target.value)
                setDirty(true)
              },
            }))
    }

    // ── 提示词 ──────────────────────────────────────────────────────────────
    function PromptsTab() {
      const [query, setQuery] = useState('')
      const [category, setCategory] = useState('')
      const qs = new URLSearchParams()
      if (query) qs.set('query', query)
      if (category) qs.set('category', category)
      const { data, loading, error, reload } = useApi(`/prompts?${qs.toString()}`, [query, category])
      const [editing, setEditing] = useState(null)
      const [err, setErr] = useState(null)
      const [ok, setOk] = useState(null)
      const [confirmDel, setConfirmDel] = useState(null)
      const [injecting, setInjecting] = useState(null)
      const [showCats, setShowCats] = useState(false)

      const items = data?.items ?? []
      const categories = data?.categories ?? []

      const blank = { name: '', description: '', category: '', tags: '', body: '', enabled: true }

      const save = async () => {
        const body = {
          name: editing.name,
          description: editing.description,
          category: editing.category,
          tags: String(editing.tags ?? '').split(/[,，]/).map((s) => s.trim()).filter(Boolean),
          body: editing.body,
          enabled: editing.enabled !== false,
        }
        try {
          if (editing.id) {
            await call('/prompts/update', { method: 'POST', body: { ...body, id: editing.id, expectedRev: editing.rev } })
          } else {
            await call('/prompts', { method: 'POST', body })
          }
          setEditing(null)
          setOk('已保存')
          reload()
        } catch (e) {
          setErr(e.message)
        }
      }

      const doInject = async (p, mode) => {
        setErr(null)
        try {
          const body = { promptId: p?.id, text: p?.body, sessionId: hostCtx?.sessionId ?? null }
          if (mode === 'once') Object.assign(body, { times: 1, every: 1 })
          if (mode === 'always') Object.assign(body, { times: 0, every: 1 })
          if (mode === 'now') Object.assign(body, { immediate: true })
          await call('/prompts/inject', { method: 'POST', body })
          setOk(mode === 'now' ? '已立即注入（本回合生效）' : '已开始注入')
          setInjecting(null)
        } catch (e) {
          setErr(e.message)
        }
      }

      return h('div', { className: 'csb-wrap' },
        h(Section, {
          title: '提示词',
          desc: '把常用的要求/流程存成模板，需要时一键注入到对话里。三个按钮对应三种最常见的用法。',
        }),
        h('div', { className: 'csb-bar', style: { marginTop: 12 } },
          h('select', {
            className: 'csb-sel', style: { width: 160 }, value: category,
            onChange: (e) => setCategory(e.target.value),
          },
          h('option', { value: '' }, '全部分类'),
          categories.map((c) => h('option', { key: c.name ?? c, value: c.name ?? c }, c.name ?? c))),
          h('input', {
            className: 'csb-in csb-grow', placeholder: '搜提示词…',
            value: query, onChange: (e) => setQuery(e.target.value),
          }),
          h('button', { className: 'csb-btn csb-btn-s', onClick: () => setShowCats(true) }, '分类管理'),
          h('button', { className: 'csb-btn csb-btn-p', onClick: () => setEditing({ ...blank }) }, '＋ 新建提示词')),
        showCats
          ? h(PromptCatsModal, {
              categories,
              onClose: () => setShowCats(false),
              onDone: (msg) => { setShowCats(false); setOk(msg); reload() },
              onError: setErr,
            })
          : null,

        h(Notice, { kind: 'ok', onClose: () => setOk(null) }, ok),
        h(Notice, { kind: 'err', onClose: () => setErr(null) }, err),
        error ? h('div', { className: 'csb-err' }, error) : null,
        loading ? h(Skeleton, { n: 3 }) : null,
        !loading && items.length === 0
          ? h(Empty, {
              icon: '⌘',
              title: '还没有提示词',
              hint: '把「你每次都要说一遍的要求」存成提示词，以后一键注入，不用重复打字。',
              action: { label: '新建提示词', icon: '✎', onClick: () => setEditing({ ...blank }) },
            })
          : null,

        h('div', { className: 'csb-list' }, items.map((p) => h('div', { key: p.id, className: 'csb-card' },
          h('div', { className: 'csb-card-main' },
            h('div', { className: 'csb-card-t2' }, p.name),
            h('div', { className: 'csb-card-m' },
              p.category ? h('span', { className: 'csb-b' }, p.category) : null,
              p.enabled === false ? h('span', { className: 'csb-b csb-b-idle' }, '已停用') : null,
              p.description ? h('span', null, p.description) : null),
            h('div', {
              style: {
                marginTop: 6, fontSize: 12, color: 'var(--dsw-alias-label-secondary)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              },
            }, p.body.split('\n')[0].slice(0, 120))),
          h('div', { style: { display: 'flex', gap: 6, flex: 'none' } },
            h('button', { className: 'csb-btn csb-btn-s', onClick: () => doInject(p, 'once') }, '注入一次'),
            h('button', { className: 'csb-btn csb-btn-s', onClick: () => doInject(p, 'always') }, '持续注入'),
            h('button', { className: 'csb-btn csb-btn-s csb-btn-p', onClick: () => doInject(p, 'now') }, '⚡ 立即'),
            h('button', { className: 'csb-btn csb-btn-s', onClick: () => setEditing({ ...p, tags: (p.tags ?? []).join(', ') }) }, '改'),
            h('button', { className: 'csb-btn csb-btn-s csb-btn-d', onClick: () => setConfirmDel(p) }, '删'))))),

        editing
          ? h(Modal, {
              title: editing.id ? '修改提示词' : '新建提示词',
              wide: true,
              onClose: () => setEditing(null),
              footer: [
                h('button', { key: 'c', className: 'csb-btn', onClick: () => setEditing(null) }, '取消'),
                h('button', { key: 's', className: 'csb-btn csb-btn-p', onClick: save }, '保存'),
              ],
            },
            h(Field, { label: '叫什么', hint: '给自己看的名字，短一点' },
              h('input', {
                className: 'csb-in', autoFocus: true, value: editing.name,
                onChange: (e) => setEditing({ ...editing, name: e.target.value }),
              })),
            h(Field, { label: '一句话说明', hint: '以后翻列表时靠它判断这条是干什么的' },
              h('input', {
                className: 'csb-in', value: editing.description,
                onChange: (e) => setEditing({ ...editing, description: e.target.value }),
              })),
            h(Field, { label: '分类', hint: '留空会自动归到「临时」' },
              h('input', {
                className: 'csb-in', value: editing.category, list: 'csb-cat-list',
                onChange: (e) => setEditing({ ...editing, category: e.target.value }),
              }),
              h('datalist', { id: 'csb-cat-list' }, categories.map((c) => h('option', { key: c.name ?? c, value: c.name ?? c })))),
            h(Field, { label: '标签', hint: '用逗号分隔' },
              h('input', {
                className: 'csb-in', value: editing.tags,
                onChange: (e) => setEditing({ ...editing, tags: e.target.value }),
              })),
            h(Field, { label: '正文', hint: '支持 {{date}} 和 {{time}}，注入时会自动替换成当天日期和时间' },
              h('textarea', {
                className: 'csb-ta',
                style: { minHeight: 220, fontFamily: 'ui-monospace,monospace' },
                value: editing.body,
                onChange: (e) => setEditing({ ...editing, body: e.target.value }),
              })),
            h(Field, { label: '启用状态', hint: '停用后不再出现在列表里，也不会被注入' },
              h('label', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                h('input', {
                  type: 'checkbox', checked: editing.enabled !== false,
                  onChange: (e) => setEditing({ ...editing, enabled: e.target.checked }),
                }), '启用')))
          : null,

        confirmDel
          ? h(ConfirmModal, {
              title: '删除这条提示词？',
              message: `「${confirmDel.name}」删除后无法恢复。如果只是暂时不用，可以改成「停用」。`,
              danger: true,
              confirmText: '删除',
              onCancel: () => setConfirmDel(null),
              onConfirm: () => {
                call('/prompts/remove', { method: 'POST', body: { id: confirmDel.id, expectedRev: confirmDel.rev } })
                  .then(() => { setConfirmDel(null); reload() })
                  .catch((e) => { setConfirmDel(null); setErr(e.message) })
              },
            })
          : null)
    }

    /** 提示词分类管理（「未分类」是兜底，不能删）。 */
    function PromptCatsModal({ categories, onClose, onDone, onError }) {
      const [name, setName] = useState('')
      const [err, setErr] = useState(null)
      const [busy, setBusy] = useState(false)

      const add = async () => {
        const n = name.trim()
        if (!n) return
        setBusy(true)
        setErr(null)
        try {
          await call('/prompts/categories/add', { method: 'POST', body: { name: n } })
          setName('')
          onDone(`已添加分类「${n}」`)
        } catch (e) {
          setErr(e.message)
        } finally {
          setBusy(false)
        }
      }

      const remove = async (cat) => {
        setErr(null)
        try {
          await call('/prompts/categories/remove', { method: 'POST', body: { name: cat.name ?? cat } })
          onDone(`已删除分类「${cat.name ?? cat}」，里面的提示词会移到「未分类」`)
        } catch (e) {
          setErr(e.message)
        }
      }

      return h(Modal, {
        title: '提示词分类',
        onClose,
        footer: [h('button', { key: 'c', className: 'csb-btn', onClick: onClose }, '关闭')],
      },
        h('div', { className: 'csb-bar' },
          h('input', {
            className: 'csb-in csb-grow', placeholder: '新分类名…（回车添加）',
            value: name, onChange: (e) => setName(e.target.value),
            onKeyDown: (e) => e.key === 'Enter' && add(),
          }),
          h('button', { className: 'csb-btn csb-btn-p', disabled: busy || !name.trim(), onClick: add }, '添加')),
        h(Notice, { kind: 'err', onClose: () => setErr(null) }, err),
        h('div', { className: 'csb-list', style: { marginTop: 8 } },
          (categories ?? []).map((c) => {
            const nm = c.name ?? c
            const cnt = c.count ?? 0
            const protectedCat = c.protected === true || nm === '未分类'
            return h('div', { key: nm, className: 'csb-card' },
              h('div', { className: 'csb-card-main' },
                h('div', { className: 'csb-card-t' }, nm),
                h('div', { className: 'csb-card-m' },
                  h('span', { className: 'csb-b' }, `${cnt} 条`),
                  protectedCat ? h('span', { className: 'csb-b csb-b-idle' }, '兜底分类，不能删') : null,
                  c.builtin ? h('span', { className: 'csb-b' }, '系统自带') : null)),
              protectedCat
                ? null
                : h('button', { className: 'csb-btn csb-btn-s csb-btn-d', onClick: () => remove(c) }, '删除'))
          })))
    }

    // ── 纪律 ────────────────────────────────────────────────────────────────
    const DISC_SCOPES = [
      { id: 'global', label: '全局', hint: '所有 Bot、所有项目都遵守' },
      { id: 'workspace', label: '工作区', hint: '只在指定工作目录里生效' },
      { id: 'room', label: '房间', hint: '只在这个房间的协作里生效' },
      { id: 'bot', label: '单个 Bot', hint: '只对某一个 Bot 生效' },
    ]
    const DISC_KINDS = [
      { id: 'rule', label: '纪律', hint: '硬规矩，必须遵守' },
      { id: 'requirement', label: '要求', hint: '交付标准' },
      { id: 'principle', label: '原则', hint: '判断依据' },
      { id: 'style', label: '风格', hint: '说话/写作方式' },
    ]

    function DisciplineTab() {
      const [scope, setScope] = useState('')
      const qs = new URLSearchParams()
      if (scope) qs.set('scope', scope)
      const { data, loading, error, reload } = useApi(`/disciplines?${qs.toString()}`, [scope])
      const [editing, setEditing] = useState(null)
      const [err, setErr] = useState(null)
      const [ok, setOk] = useState(null)
      const [confirmDel, setConfirmDel] = useState(null)
      const [preview, setPreview] = useState(null)

      const items = data?.items ?? []
      const blank = { scope: 'global', scopeId: '', kind: 'rule', title: '', content: '', priority: 0, enabled: true }

      const save = async () => {
        const body = {
          scope: editing.scope,
          scopeId: editing.scope === 'global' ? null : (editing.scopeId || null),
          kind: editing.kind,
          title: editing.title,
          content: editing.content,
          priority: Number(editing.priority) || 0,
          enabled: editing.enabled !== false,
        }
        try {
          if (editing.id) {
            await call('/disciplines/update', {
              method: 'POST',
              body: { ...body, id: editing.id, expectedRev: editing.rev },
            })
          } else {
            await call('/disciplines', { method: 'POST', body })
          }
          setEditing(null)
          setOk('已保存')
          reload()
        } catch (e) {
          setErr(e.message)
        }
      }

      const grouped = DISC_SCOPES.map((s) => ({ ...s, rows: items.filter((i) => i.scope === s.id) }))

      return h('div', { className: 'csb-wrap' },
        h(Section, {
          title: '纪律与要求',
          desc: '把规矩分四层写：全局 → 工作区 → 房间 → 单个 Bot。越具体的越优先，'
            + '同一条规矩写在不同层时，只保留最具体的那条。',
        }),
        h('div', { className: 'csb-bar', style: { marginTop: 12 } },
          h('select', {
            className: 'csb-sel', style: { width: 150 }, value: scope,
            onChange: (e) => setScope(e.target.value),
          },
          h('option', { value: '' }, '全部层级'),
          DISC_SCOPES.map((s) => h('option', { key: s.id, value: s.id }, s.label))),
          h('span', { className: 'csb-spacer' }),
          h('button', {
            className: 'csb-btn csb-btn-s',
            onClick: () => call('/disciplines/resolve').then(setPreview).catch((e) => setErr(e.message)),
          }, '看看实际会执行哪些'),
          h('button', { className: 'csb-btn csb-btn-p', onClick: () => setEditing({ ...blank }) }, '＋ 新建纪律')),

        h(Notice, { kind: 'ok', onClose: () => setOk(null) }, ok),
        h(Notice, { kind: 'err', onClose: () => setErr(null) }, err),
        error ? h('div', { className: 'csb-err' }, error) : null,
        loading ? h(Skeleton, { n: 3 }) : null,
        !loading && items.length === 0
          ? h(Empty, {
              icon: '§',
              title: '还没有任何纪律',
              hint: '先写一条「全局」的，比如「结论先行，给证据」——所有 Bot 都会遵守。',
              action: { label: '新建纪律', icon: '✎', onClick: () => setEditing({ ...blank }) },
            })
          : null,

        grouped.map((g) => g.rows.length === 0 ? null : h('div', { key: g.id, style: { marginTop: 18 } },
          h('div', { className: 'csb-hint', style: { marginLeft: 0, marginBottom: 8 } }, `${g.label} · ${g.hint}`),
          h('div', { className: 'csb-list' }, g.rows.map((d) => h('div', { key: d.id, className: 'csb-card' },
            h('div', { className: 'csb-card-main' },
              h('div', { className: 'csb-card-t2' }, d.title),
              h('div', { className: 'csb-card-m' },
                h('span', { className: 'csb-b' }, (DISC_KINDS.find((k) => k.id === d.kind) ?? {}).label ?? d.kind),
                d.priority ? h('span', { className: 'csb-b' }, `优先级 ${d.priority}`) : null,
                d.enabled === false ? h('span', { className: 'csb-b csb-b-idle' }, '已停用') : null,
                d.scopeId ? h('span', { className: 'csb-b' }, d.scopeId) : null),
              h('div', {
                style: { marginTop: 6, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
              }, d.content.slice(0, 140) + (d.content.length > 140 ? '…' : ''))),
            h('div', { style: { display: 'flex', gap: 6, flex: 'none' } },
              h('button', {
                className: 'csb-btn csb-btn-s',
                onClick: () => call('/disciplines/update', {
                  method: 'POST',
                  body: { id: d.id, expectedRev: d.rev, enabled: d.enabled === false },
                }).then(reload).catch((e) => setErr(e.message)),
              }, d.enabled === false ? '启用' : '停用'),
              h('button', { className: 'csb-btn csb-btn-s', onClick: () => setEditing({ ...d }) }, '改'),
              h('button', { className: 'csb-btn csb-btn-s csb-btn-d', onClick: () => setConfirmDel(d) }, '删'))))))),

        editing
          ? h(Modal, {
              title: editing.id ? '修改纪律' : '新建纪律',
              wide: true,
              onClose: () => setEditing(null),
              footer: [
                h('button', { key: 'c', className: 'csb-btn', onClick: () => setEditing(null) }, '取消'),
                h('button', { key: 's', className: 'csb-btn csb-btn-p', onClick: save }, '保存'),
              ],
            },
            h(Field, { label: '管到哪一层' },
              h('select', {
                className: 'csb-sel', value: editing.scope,
                onChange: (e) => setEditing({ ...editing, scope: e.target.value }),
              }, DISC_SCOPES.map((s) => h('option', { key: s.id, value: s.id }, `${s.label}——${s.hint}`)))),
            editing.scope !== 'global'
              ? h(Field, {
                  label: editing.scope === 'workspace' ? '工作目录' : (editing.scope === 'room' ? '房间 ID' : 'Bot ID'),
                  hint: '留空表示这条先不绑定具体对象',
                },
                h('input', {
                  className: 'csb-in', value: editing.scopeId ?? '',
                  onChange: (e) => setEditing({ ...editing, scopeId: e.target.value }),
                }))
              : null,
            h(Field, { label: '属于哪一类' },
              h('select', {
                className: 'csb-sel', value: editing.kind,
                onChange: (e) => setEditing({ ...editing, kind: e.target.value }),
              }, DISC_KINDS.map((k) => h('option', { key: k.id, value: k.id }, `${k.label}——${k.hint}`)))),
            h(Field, { label: '一句话标题', hint: '短标题，用来去重：同名时只保留最具体那条' },
              h('input', {
                className: 'csb-in', autoFocus: true, value: editing.title,
                onChange: (e) => setEditing({ ...editing, title: e.target.value }),
              })),
            h(Field, { label: '具体内容' },
              h('textarea', {
                className: 'csb-ta', style: { minHeight: 140 }, value: editing.content,
                onChange: (e) => setEditing({ ...editing, content: e.target.value }),
              })),
            h(Field, { label: '优先级', hint: '数字越大越靠前；一般留 0 就行' },
              h('input', {
                className: 'csb-in', type: 'number', value: editing.priority,
                onChange: (e) => setEditing({ ...editing, priority: e.target.value }),
              })))
          : null,

        preview
          ? h(Modal, {
              title: '实际会执行的纪律',
              wide: true,
              onClose: () => setPreview(null),
              footer: [h('button', { key: 'c', className: 'csb-btn', onClick: () => setPreview(null) }, '关闭')],
            },
            h('p', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } },
              `合并后共 ${preview.items?.length ?? 0} 条`
              + (preview.dropped ? `，有 ${preview.dropped} 条因同名或超预算被折叠` : '')
              + (preview.truncated ? '（已按预算裁剪）' : '')),
            h('pre', {
              style: {
                whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace,monospace', fontSize: 12,
                background: 'var(--dsw-alias-bg-layer-2)', padding: 12, borderRadius: 8,
                maxHeight: '50vh', overflow: 'auto',
              },
            }, preview.text || '（当前没有任何生效的纪律）'))
          : null,

        confirmDel
          ? h(ConfirmModal, {
              title: '删除这条纪律？',
              message: `「${confirmDel.title}」删除后无法恢复。如果只是暂时不用，可以点「停用」。`,
              danger: true,
              confirmText: '删除',
              onCancel: () => setConfirmDel(null),
              onConfirm: () => {
                call('/disciplines/remove', { method: 'POST', body: { id: confirmDel.id, expectedRev: confirmDel.rev } })
                  .then(() => { setConfirmDel(null); reload() })
                  .catch((e) => { setConfirmDel(null); setErr(e.message) })
              },
            })
          : null)
    }

    // ── 主面板 ──────────────────────────────────────────────────────────────

    /**
     * 页签结构 —— **严格对齐原架构（v0.1.1）：7 个页签，不新增**。
     *
     * 为什么 v2 的能力不各开一个页签（这条写死在这里，防止以后又长回去）：
     *   原架构的页签只有两种：①**协作对象**（任务/Bot/房间）——多个、有生命周期、
     *   要点进去看详情；②**配置资产**（技能库/工作流库/设置）——配一次、被多处引用。
     *   待办/便签/纪律/提示词都不是独立对象，而是既有对象的**视图或属性**，
     *   所以只能挂在既有页签下做子视图。
     *
     * 归并口径（一句人话）：
     *   任务   = 要做的活（看板=协作单元，待办=个人备忘，便签=随手记）
     *   Bot    = 谁来做
     *   房间   = 在哪商量
     *   记忆   = AI 该知道什么（记忆=事实，纪律=规矩，提示词=指令模板）
     *   技能库 = 怎么做
     *   工作流 = 按什么步骤做
     *   设置   = 平台怎么跑
     *
     * `subs` 为空 = 单页（不渲染子页签行）；长度 > 1 才显示子页签。
     */
    const TABS = [
      {
        id: 'tasks', label: '任务',
        subs: [
          { id: 'board', label: '协作看板', Comp: TasksTab },
          { id: 'todo', label: '我的待办', Comp: TodoTab },
          { id: 'scratch', label: '便签', Comp: ScratchTab },
        ],
      },
      { id: 'bots', label: 'Bot', Comp: BotsTab },
      { id: 'rooms', label: '房间', Comp: RoomsTab },
      {
        id: 'memory', label: '记忆',
        subs: [
          { id: 'facts', label: '事实与偏好', Comp: MemoryTab },
          { id: 'rules', label: '纪律与要求', Comp: DisciplineTab },
          { id: 'prompts', label: '提示词', Comp: PromptsTab },
        ],
      },
      { id: 'skills', label: '技能库', Comp: SkillsTab },
      { id: 'workflows', label: '工作流库', Comp: WorkflowsTab },
      { id: 'settings', label: '设置', Comp: SettingsBody },
    ]

    /** 取某个页签的视图清单（单页页签返回 [自身]）。 */
    function viewsOf(tab) {
      return tab.subs && tab.subs.length ? tab.subs : [{ id: tab.id, label: tab.label, Comp: tab.Comp }]
    }

    function Workbench() {
      const [tab, setTab] = useState('tasks')
      const [view, setView] = useState(null)
      const current = TABS.find((t) => t.id === tab) ?? TABS[0]
      const views = viewsOf(current)
      const activeView = views.find((v) => v.id === view) ?? views[0]
      const Comp = activeView.Comp

      // 切主页签时把子视图重置为该页签的第一个，避免"停在任务→便签，切到记忆还是便签"
      const goTab = (id) => {
        setTab(id)
        setView(null)
      }

      return h('div', { className: 'csb' },
        h('div', { className: 'csb-head' },
          h('div', { className: 'csb-hrow' },
            h('h2', null, '协作平台'),
            h('span', { className: 'csb-hint' }, '任务 · Bot · 房间 · 记忆 · 技能 · 工作流 · 设置')),
          h('div', { className: 'csb-tabs', role: 'tablist' },
            TABS.map((t) =>
              h('button', {
                key: t.id, role: 'tab', 'aria-selected': t.id === tab,
                className: `csb-tab${t.id === tab ? ' csb-tab-on' : ''}`,
                onClick: () => goTab(t.id),
              }, t.label))),
          views.length > 1
            ? h('div', { className: 'csb-subtabs', role: 'tablist' },
                views.map((v) =>
                  h('button', {
                    key: v.id, role: 'tab', 'aria-selected': v.id === activeView.id,
                    className: `csb-subtab${v.id === activeView.id ? ' csb-subtab-on' : ''}`,
                    onClick: () => setView(v.id),
                  }, v.label)))
            : null),
        h('div', { className: 'csb-body' },
          h(Boundary, { tab: `${current.label}/${activeView.label}` },
            h(Comp, { key: `${current.id}:${activeView.id}` }))))
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
    exports.TodoTab = TodoTab
    exports.ScratchTab = ScratchTab
    exports.PromptsTab = PromptsTab
    exports.DisciplineTab = DisciplineTab
    exports.BotProfileDrawer = BotProfileDrawer
    exports.DirPicker = DirPicker
    exports.Modal = Modal
    exports.ConfirmModal = ConfirmModal
    exports.PANEL_ID = PANEL_ID
    exports.API = API

    return module.exports
  },
})
