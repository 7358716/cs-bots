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

    // ── 人类身份的统一称谓（2026-11-09）────────────────────────────────────
    // 页面上以前一会儿叫「你」、一会儿叫「用户」、一会儿叫「派活方」，
    // 同一个人三种叫法，读起来像三个角色。统一成 **Boss**：
    //   · HUMAN_LABEL      —— 作为「身份」出现时（谁建的、谁派的、消息发送者）
    //   · HUMAN_SELF_LABEL —— 作为「对自己说话」时（对话里「你」发的那条）
    // 两者都是同一个 Boss，只是语法位置不同；**不要**再引入第三个词。
    const HUMAN_LABEL = 'Boss'
    const HUMAN_SELF_LABEL = 'Boss（你）'

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

    /**
     * 跳到宿主的某个会话（左侧栏那个对话）。
     *
     * ## 为什么要单独包一层（2026-11-09 现场 bug）
     *   官方签名是 **`openSession(sessionId: string)`**（`dsh-client-ui-workspace`
     *   的 `replaceMain` 直接把它当 key 去 `sessions.retain(id)`）。
     *   我们以前传的是 **对象** `{ sessionId }` ⇒ retain 拿到一个对象 ⇒ 抛错 ⇒
     *   被 catch 吞成「宿主不支持自动跳转，已复制会话 ID」。
     *   **那不是宿主不支持，是我们传错了类型。**
     *
     * 另外官方 `sessionLinkState` 的判定是：会话已归档 / 不在会话列表 ⇒ 打不开。
     * 所以这里先判可用性，不可用就把**原因**说出来，而不是一律说「不支持」。
     *
     * @param {string} sessionId
     * @returns {Promise<boolean>} 是否真的跳过去了
     */
    async function tryOpenSession(sessionId) {
      if (!sessionId || typeof sessionId !== 'string') return false
      const svc = hostUiWorkspace
      if (!svc || typeof svc.openSession !== 'function') return false
      try {
        // 官方约定：传字符串 id（不是 { sessionId }）
        const maybe = svc.openSession(sessionId)
        if (maybe && typeof maybe.then === 'function') await maybe
        return true
      } catch (error) {
        // 打不开就把原因带给用户，不要谎称「宿主不支持」
        throw new Error(`打开会话失败：${error?.message ?? error}`)
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
/* 长任务完整表单：两列网格，窄屏（<720px）自动单列 —— 手机上也能填 */
.csb-ltform{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px 16px;
  margin-top:10px;padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;
  background:var(--dsw-alias-bg-l1)}
.csb-ltform .csb-fld{margin-bottom:0}
@media (max-width:720px){.csb-ltform{grid-template-columns:1fr;padding:10px}}
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
/* 来源跳转（契约 §2.5）：从任务详情跳回消息出处时，那条消息要一眼能看见 */
.csb-msg-focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
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

/* 看板视图 */
.csb-kanban{display:flex;gap:12px;overflow-x:auto;padding-bottom:8px}
.csb-kanban-col{flex:1 1 240px;min-width:220px;display:flex;flex-direction:column;
  border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1)}
.csb-kanban-col-h{flex:none;display:flex;align-items:center;gap:7px;padding:10px 12px;
  font-size:12.5px;font-weight:600}
.csb-kanban-body{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding:8px}
.csb-kanban-card{display:block;padding:10px 11px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-base);cursor:pointer}
.csb-kanban-card:hover{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}
.csb-kanban-t{font-size:12.5px;font-weight:500;line-height:1.4;margin-bottom:5px;word-break:break-word}
.csb-kanban-m{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:5px}

/* 改造07：执行阶段徽章（借鉴 Super-agent stage table）
   person = 需人动手（强调色）/ working = 机器推进（常规色）/ idle = 空闲（弱化色） */
.csb-stage{display:inline-flex;align-items:center;height:19px;padding:0 7px;border-radius:5px;
  font-size:10.5px;font-weight:500;border:1px solid var(--dsw-alias-border-l2);
  color:var(--dsw-alias-label-secondary);white-space:nowrap}
.csb-stage-person{color:var(--dsw-alias-state-warn-primary);
  border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 9%,transparent);font-weight:600}
.csb-stage-working{color:var(--dsw-alias-label-primary);
  border-color:var(--dsw-alias-border-l2)}
.csb-stage-idle{color:var(--dsw-alias-label-tertiary);opacity:.8}

/* @提及高亮 */
.csb-at{color:var(--dsw-alias-label-primary);font-weight:600}

/* 目标锚（只读区块，契约 CONTRACT-bots04 §3.2） */
.csb-anchor{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:12px 14px;
  background:var(--dsw-alias-bg-base);margin-top:10px}
.csb-anchor-subj{font-size:15px;font-weight:600;line-height:1.45;margin-bottom:8px;word-break:break-word}
.csb-anchor-meta{display:flex;gap:6px 14px;flex-wrap:wrap;margin-top:8px;
  font-size:11.5px;color:var(--dsw-alias-label-secondary)}
/* 房间消息气泡 hover 才出现「⇢ 建任务」（契约 §3.4） */
.csb-msg-task{opacity:0;transition:opacity .12s}
.csb-msg-row:hover .csb-msg-task{opacity:1}

/* 唤醒失败后的可操作按钮（契约 bots05 §3.2） */
.csb-wake{margin-bottom:10px}
.csb-wake .csb-notice{margin-bottom:6px}

/* 任务变更中心（契约 bots06 §3.1 / §3.3） */
.csb-evolve{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:12px 14px;
  margin-top:10px;background:var(--dsw-alias-bg-base)}
.csb-evolve-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.csb-evolve-head h4{margin:0;font-size:13.5px;font-weight:600;line-height:1.4}
.csb-evolve-head .csb-btn{margin-left:auto}
.csb-evolve-snap{margin-top:10px;padding:9px 12px;border-radius:9px;font-size:12px;line-height:1.6;
  color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);word-break:break-word}
.csb-chg{padding:9px 12px}
.csb-chg-t{font-size:12.5px;line-height:1.7;word-break:break-word}
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
      // path 为 null ⇒ 空转（不请求）。给「条件加载」用：
      // 例如数据页没选文件时不该去请求 `/data/rows?name=null`。
      const [state, setState] = useState({ loading: path != null, data: null, error: null })
      const reload = useCallback(() => {
        if (path === null || path === undefined) {
          setState({ loading: false, data: null, error: null })
          return () => {}
        }
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
        actionLabel: `查看${HUMAN_LABEL}的任务`,
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

    /**
     * 判断一个交付物是不是可点开的网址。
     *
     * 只认 `http(s)://`：`file://`、`javascript:` 一律不算 URL —— 前者在不同机器上无意义，
     * 后者是 XSS 入口。其余一律当本地路径处理（走只读预览）。
     */
    function isUrl(value) {
      if (typeof value !== 'string') return false
      return /^https?:\/\//i.test(value.trim())
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
    /** 改造07：阶段徽章类名（person 强调 / working 常规 / idle 弱化） */
    const stageBadgeCls = (group) => ({
      person: 'csb-stage csb-stage-person',
      working: 'csb-stage csb-stage-working',
      idle: 'csb-stage csb-stage-idle',
    }[group] ?? 'csb-stage')
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

    /**
     * 把文本里的 `@名字` 拆成 React 节点高亮显示。
     * 正则：`/@([\w一-龥-]+)/g` —— 支持中英文、数字、下划线、连字符。
     * 不用 dangerouslySetInnerHTML：我们只做文本节点拆分，不注入 HTML。
     */
    const AT_RE = /@([\w一-龥-]+)/g
    function renderAt(text) {
      const s = String(text ?? '')
      const parts = []
      let last = 0
      let m
      AT_RE.lastIndex = 0
      let i = 0
      while ((m = AT_RE.exec(s)) !== null) {
        if (m.index > last) parts.push(s.slice(last, m.index))
        parts.push(h('span', { key: `a${i++}`, className: 'csb-at' }, `@${m[1]}`))
        last = m.index + m[0].length
      }
      if (last < s.length) parts.push(s.slice(last))
      return parts
    }

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

    /**
     * 任务详情抽屉。
     *
     * `onGotoSource` 是「来源跳转」的跨页签定位回调（契约 §3.2 第 6 条）：
     *   `onGotoSource('team', { sub: 'rooms', roomId, seq })` → 切到房间子页签并定位那条消息。
     *   ⚠️ **必须带 `sub`**：`safeGoTab` 会把旧的 `'rooms'` 映射成主页签 `'team'`，
     *      然后按该页签的**第一个子视图**渲染 ⇒ 落进「Bot 档案」而不是房间。
     * 没有传（例如从成果库打开）时，点击会明确提示「当前页面不支持跨页签跳转」，
     * 绝不假装跳成功。
     */
    function TaskDrawer({ id, bots, workflows, onClose, onChange, onGotoSource }) {
      const { data, loading, error, reload } = useApi(`/tasks/detail?id=${encodeURIComponent(id)}`, [id])
      const [err, setErr] = useState(null)
      const [picking, setPicking] = useState(null) // 'complete' | 'abort'
      const [artifacts, setArtifacts] = useState('')
      const [abortReason, setAbortReason] = useState('需求取消')
      // 进度编辑
      const [progressVal, setProgressVal] = useState('')
      // 依赖链
      const [graph, setGraph] = useState(null)
      const [graphLoading, setGraphLoading] = useState(false)
      const [graphError, setGraphError] = useState(null)
      // 交付物文件预览弹窗
      const [previewPath, setPreviewPath] = useState(null)
      // 预览内容在这里统一取（需求3）：弹窗只是壳，由父组件拉数据，
      // 否则弹窗自己的 effect 只在真实渲染器挂载子组件时才跑，测试桩与边缘场景都取不到内容。
      const [preview, setPreview] = useState(null)
      useEffect(() => {
        if (!previewPath) {
          setPreview(null)
          return undefined
        }
        let alive = true
        setPreview({ loading: true })
        call(`/data/file?path=${encodeURIComponent(previewPath)}`)
          .then((d) => { if (alive) setPreview({ loading: false, data: d }) })
          .catch((e) => { if (alive) setPreview({ loading: false, error: e.message }) })
        return () => { alive = false }
      }, [previewPath])
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

      // 加载依赖链（上游 blockedBy 递归 + 下游 dependents）
      useEffect(() => {
        if (!task) return
        let alive = true
        setGraph(null)
        setGraphError(null)
        setGraphLoading(true)
        call(`/tasks/graph?id=${encodeURIComponent(task.id)}`)
          .then((d) => { if (alive) setGraph(d) })
          .catch((e) => { if (alive) setGraphError(e.message) })
          .finally(() => { if (alive) setGraphLoading(false) })
        return () => { alive = false }
      }, [task?.id])

      const saveProgress = async () => {
        const v = Number(progressVal)
        if (Number.isNaN(v) || v < 0 || v > 100) {
          setErr('进度必须是 0-100 的数字')
          return
        }
        await act(() => upd('edit', { progress: v }), '保存进度')
        setProgressVal('')
      }

      return h(Drawer, { title: task?.subject ?? id, onClose },
        loading ? h(Skeleton, { n: 2 }) : null,
        error ? h('div', { className: 'csb-err' }, error) : null,
        err ? h(ErrBox, { humanized: err, onAction: (c) => errHandlers[c]?.() }) : null,
        task ? h('div', null,
          // ── 快捷跳转条（2026-11-09：「任务栏里跳转不到房间，没有按钮」）──────
          // 以前这些入口散落在各个子面板里，或者根本没有按钮，只能靠人记路径。
          // 现在把三个最常用的跳转放在抽屉最上面，一眼就够得着。
          h('div', { className: 'csb-bar', style: { marginTop: 8, flexWrap: 'wrap' } },
            h('button', {
              type: 'button', className: 'csb-btn csb-btn-s',
              title: '跳到「房间」页签，按这个执行者筛房间',
              onClick: () => {
                const target = task.assignee ?? task.ownerId
                const name = target ? botName(bots, target) : ''
                if (typeof onGotoSource === 'function') {
                  onGotoSource('team', { sub: 'rooms', ...(name ? { filter: name } : {}) })
                } else {
                  setErr('当前页面不支持跨页签跳转，请手动打开房间列表')
                }
              },
            }, '💬 去房间'),
            h('button', {
              type: 'button', className: 'csb-btn csb-btn-s',
              title: '跳到「Bot 档案」看这个执行者的资料',
              onClick: () => {
                if (typeof onGotoSource === 'function') onGotoSource('team', { sub: 'bots' })
                else setErr('当前页面不支持跨页签跳转，请手动打开 Bot 档案')
              },
            }, '🤖 看执行者'),
            h('button', {
              type: 'button', className: 'csb-btn csb-btn-s',
              title: '跳到「成果」页签看产出物',
              onClick: () => {
                if (typeof onGotoSource === 'function') onGotoSource('workspace', { sub: 'artifacts' })
                else setErr('当前页面不支持跨页签跳转，请手动打开成果页')
              },
            }, '📦 看产出物')),
          h('div', { className: 'csb-kv' },
            // ── 5W：谁建的 / 是什么 / 何时 / 在哪做 / 为什么 ──
            // 需求5：表述以「人」为主体——人建的任务就说「用户」，不暴露 Bot 会话 id
            h('span', { className: 'csb-k' }, '谁建的'),
            h('span', { className: 'csb-v' }, task.source === 'human' ? HUMAN_LABEL : (task.createdBy ? botName(bots, task.createdBy) : '智能体')),
            h('span', { className: 'csb-k' }, '来源'),
            h('span', { className: 'csb-v' }, task.source === 'human' ? `${HUMAN_LABEL} 自建` : '智能体分发'),
            h('span', { className: 'csb-k' }, '优先级'), h('span', { className: 'csb-v' }, task.priority !== undefined ? `${task.priority}（${task.priority >= 8 ? '紧急' : '一般'}）` : '未设'),
            h('span', { className: 'csb-k' }, '截止'), h('span', { className: 'csb-v' }, task.dueAt ? fmt(task.dueAt) : '未设'),
            h('span', { className: 'csb-k' }, '状态'), h('span', { className: 'csb-v' }, h(Badge, { status: task.status })),
            // 改造07：执行阶段（借鉴 Super-agent stage table）—— 人一眼看出该谁动
            data?.stageInfo
              ? [
                  h('span', { key: 'se', className: 'csb-k' }, '执行阶段'),
                  h('span', { key: 'sv', className: 'csb-v' },
                    h('span', { className: stageBadgeCls(data.stageInfo.group), title: data.stageInfo.reason }, data.stageInfo.label),
                    data.stageInfo.needsPerson ? h('span', { className: 'csb-b csb-b-run', style: { marginLeft: 8 } }, '需要你处理') : null),
                ]
              : null,
            h('span', { className: 'csb-k' }, '任务编号'), h('span', { className: 'csb-v csb-mono' }, task.id),
            // 改造07 + 2026-11-09：执行者在等你做什么（结构化 Attention）。
            // 只显示**执行者明确提出的问题**（latestReport.attention.question），
            // 绝不把 blockedReason（诊断）冒充成问题 —— 两者混在一起，
            // 人会在「等你回答」里看到一句「端口被占用」而不知道该回什么。
            data?.stageInfo?.stage === 'person/answer' && task.latestReport?.attention?.question
              ? [
                  h('span', { key: 'ae', className: 'csb-k' }, '要你回答'),
                  h('span', { key: 'av', className: 'csb-v', style: { color: 'var(--dsw-alias-text-warn, #b45309)', fontWeight: 600 } },
                    h(CollapsibleText, { text: String(task.latestReport.attention.question), limit: 300 })),
                ]
              : null,
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

          // 改造04：目标锚（只读）+ 补充说明 + 补充历史 + 去对话 + 复制派发文案
          h(TaskAnchorPanel, { taskId: task.id, task, onChange, onGotoSource }),

          h(Section, {
            title: task.status === 'completed'
              ? '已完成 · 要纠错/优化/变更从这里开始'
              : '可以做什么',
            desc: task.status === 'completed'
              ? '已完成不是终点：下面的「变更」区可以重开接着做 / 派生优化单 / 转成长任务。'
              : '指派、完成、验收是 Bot 的职责，不由你操作。这里只有需要你拍板的动作。',
          }),
          h('div', { className: 'csb-bar', style: { marginTop: 10 } },
            task.status === 'pending'
              ? h('button', { className: 'csb-btn csb-btn-p', onClick: () => act(() => upd('claim'), '领取') }, '我来管（领取）')
              : null,
            task.status === 'blocked' ? h('button', { className: 'csb-btn', onClick: () => act(() => upd('reopen'), '重开') }, '重新打开') : null,
            task.status !== 'blocked' && task.status !== 'deleted'
              ? h('button', { className: 'csb-btn csb-btn-d', onClick: () => { setAbortReason('需求取消'); setPicking('abort') } }, '终止任务')
              : null),

          // 改造06（CONTRACT-bots06 §3.1 / §3.3）：变更中心 —— 放在「可以做什么」之后
          h(TaskEvolvePanel, { taskId: task.id, task, onChange }),

          // 高级：租约（原「续租」按钮，普通人看不懂，收进折叠并解释）
          h(Section, { title: '高级：租约', desc: '租约是「我先占着，别人别抢」的凭据。领取任务默认占 5 分钟，长任务需要隔一会儿点一次「延长」，否则会被自动释放回待办。' }),
          task.status === 'in_progress'
            ? h('div', { className: 'csb-bar', style: { marginTop: 10 } },
                h('span', { className: 'csb-set-d' }, task.lease ? `当前占用到 ${fmt(task.lease.expiresAt)}` : '当前没有租约'),
                h('button', { className: 'csb-btn csb-btn-s', onClick: () => act(() => upd('heartbeat'), '延长') }, '延长 5 分钟'))
            : h('div', { className: 'csb-set-d', style: { marginTop: 10 } }, '任务不在进行中，没有租约。'),

          // 进度编辑
          h(Section, { title: '更新进度', desc: `当前 ${task.progress ?? 0}%。填入 0-100 的数字并保存（走 CAS，别人刚改过会提示刷新）。` }),
          h('div', { className: 'csb-bar', style: { marginTop: 10 } },
            h('input', {
              className: 'csb-in', style: { width: 100 }, type: 'number', min: 0, max: 100,
              placeholder: '0-100', value: progressVal,
              onChange: (e) => setProgressVal(e.target.value),
              onKeyDown: (e) => e.key === 'Enter' && saveProgress(),
            }),
            h('button', { className: 'csb-btn csb-btn-p', disabled: progressVal === '', onClick: saveProgress }, '保存进度')),

          // 依赖链
          h(Section, { title: '依赖链', desc: '上游 = 完成前必须先做的；下游 = 等着这个任务完成的。' }),
          graphLoading ? h(Skeleton, { n: 1 }) : null,
          graphError ? h('div', { className: 'csb-err' }, graphError) : null,
          graph
            ? h(DepGraph, { graph, currentId: task.id })
            : null,

          // 需求2：任务对话（进度 + 对话内容 + 去对话跳转），直接放在产出物之前
          h(TaskConversationPanel, { taskId: task.id, task, bots, onGotoSource }),

          // 成果展示
          h(Section, { title: '产出物证据', desc: '任务完成时要带上「做了什么」的凭据（文件路径 / 链接）。' }),
          (task.artifacts ?? []).length === 0
            ? h(Empty, {
                icon: '◈',
                title: '还没有产出物证据',
                hint: task.status === 'completed'
                  ? '这个任务完成了但没带产出物证据 —— 可以点上面「重开」让它补交，或在「变更」区派下去补。'
                  : 'Bot 完成任务时会带上交付物路径/链接，届时会出现在这里（完成前看不到是正常的）。',
              })
            : h('div', { className: 'csb-list', style: { marginTop: 10 } },
                (task.artifacts ?? []).map((a, i) =>
                  h('div', { key: i, className: 'csb-card', style: { padding: '9px 12px' } },
                    h('div', { className: 'csb-card-main' },
                      h('div', { className: 'csb-card-t csb-mono' }, typeof a === 'string' ? a : JSON.stringify(a)),
                      h('div', { className: 'csb-bar', style: { marginTop: 6, gap: 6 } },
                        isUrl(a) ? h('button', {
                          className: 'csb-btn csb-btn-s', style: { height: 24, fontSize: 11.5 },
                          onClick: () => window.open(a, '_blank', 'noopener'),
                        }, '打开链接') : null,
                        !isUrl(a) ? h('button', {
                          className: 'csb-btn csb-btn-s', style: { height: 24, fontSize: 11.5 },
                          onClick: () => setPreviewPath(a),
                        }, '预览文件') : null,
                        h('button', {
                          className: 'csb-btn csb-btn-s', style: { height: 24, fontSize: 11.5 },
                          onClick: async () => { try { await copyText(a) } catch { /* ignore */ } },
                        }, '复制')))))),

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
          : null,
        // 交付物文件预览弹窗（只读；路径由后端安全校验后返回）
        previewPath ? h(FilePreviewModal, {
          path: previewPath,
          loading: !!preview?.loading,
          error: preview?.error ?? null,
          data: preview?.data ?? null,
          onClose: () => setPreviewPath(null),
        }) : null)
    }

    /**
     * 依赖链树状展示。
     *
     * 后端 `GET /tasks/graph?id=` 返回闭包：`nodes[]` + `edges[]`，
     * 边语义是 **`from` 依赖 `to`**（from 的 blockedBy 含 to）。
     *
     *  · 上游：从当前任务出发，沿 from=当前 → to 递归（blockedBy 递归）
     *  · 下游：反向，找 from 指向当前任务的那些，再递归
     *
     * 用 depth 缩进做树状文本；`seen` 集合防环（后端会忽略悬空，但环要前端防）。
     */
    function DepGraph({ graph, currentId }) {
      const nodes = graph?.nodes ?? []
      const edges = graph?.edges ?? []
      const byId = new Map(nodes.map((n) => [n.id, n]))
      const upOf = new Map()   // id → 它依赖的 id 列表
      const downOf = new Map() // id → 依赖它的 id 列表
      for (const e of edges) {
        if (!upOf.has(e.from)) upOf.set(e.from, [])
        upOf.get(e.from).push(e.to)
        if (!downOf.has(e.to)) downOf.set(e.to, [])
        downOf.get(e.to).push(e.from)
      }
      const walk = (id, dir, depth, seen, out) => {
        if (depth > 12 || seen.has(id)) return
        seen.add(id)
        const n = byId.get(id)
        if (!n) return
        out.push({ id, node: n, depth, dir })
        const next = (dir === 'up' ? upOf : downOf).get(id) ?? []
        for (const nid of next) walk(nid, dir, depth + 1, seen, out)
      }
      const upRoots = (upOf.get(currentId) ?? []).slice()
      const downRoots = (downOf.get(currentId) ?? []).slice()
      const ups = []
      const downs = []
      const seenUp = new Set([currentId])
      const seenDown = new Set([currentId])
      for (const r of upRoots) walk(r, 'up', 1, seenUp, ups)
      for (const r of downRoots) walk(r, 'down', 1, seenDown, downs)
      const row = (it) => h('div', {
        key: `${it.dir}:${it.id}:${it.depth}`,
        className: 'csb-set-d',
        style: { paddingLeft: (it.depth - 1) * 16, lineHeight: 1.9 },
      },
        h('span', { className: 'csb-mono' }, `${'└ '.repeat(0)}${it.depth > 1 ? '↳ ' : ''}${it.id}`),
        h('span', null, ' · '),
        h('span', { style: { color: 'var(--dsw-alias-label-primary)' } }, it.node.subject ?? '(无标题)'),
        h('span', null, ' · '),
        h(Badge, { status: it.node.status }),
        it.node.progress !== undefined ? h('span', null, ` · ${it.node.progress}%`) : null)
      const total = ups.length + downs.length
      if (!nodes.length) {
        return h('div', { className: 'csb-note', style: { marginTop: 10 } }, '没有依赖关系。')
      }
      return h('div', { style: { marginTop: 10 } },
        total === 0
          ? h('div', { className: 'csb-note' }, '这个任务没有上游也没有下游（孤立节点）。')
          : null,
        ups.length
          ? h('div', null,
              h('div', { className: 'csb-field-l', style: { marginBottom: 4 } }, `↑ 上游（必须先完成）${ups.length} 个`),
              ups.map(row))
          : null,
        downs.length
          ? h('div', { style: { marginTop: 10 } },
              h('div', { className: 'csb-field-l', style: { marginBottom: 4 } }, `↓ 下游（等这个完成）${downs.length} 个`),
              downs.map(row))
          : null,
        graph?.note ? h('div', { className: 'csb-field-h', style: { marginTop: 8 } }, graph.note) : null)
    }

    function botName(bots, sessionId) {
      const b = (bots ?? []).find((x) => x.sessionId === sessionId)
      return b ? b.name : short(sessionId, 16)
    }

    // ══════════════════════════════════════════════════════════════════════
    // 协作平台改造04：派活 / 补充说明 / 直达对话（契约 CONTRACT-bots04 §3）
    //
    // 设计铁律：
    //   · **唤醒结果必须可见**：sent / skipped / failed 全都要显示，失败带 reason。
    //     「派活了但没唤醒」如果静默，用户会以为 Bot 已经在做，实际任务永远停着。
    //   · **目标锚只读**：目标原文来自创建时，详情页只展示、不就地编辑；
    //     补充说明走 /tasks/note 追加，永不覆盖目标 —— 这正是「长任务不失真」的落点。
    // ══════════════════════════════════════════════════════════════════════

    /**
     * 唤醒失败原因 → 人话（契约 CONTRACT-bots05 §3.1）。
     *
     * `agent-not-live` 是「dsh-web 重启后会话没被加载进宿主 live 注册表」，
     * 不是派活失败 —— 原文直译会让用户以为任务没派出去。`resume-failed:*`
     * 是尝试自动复活时 resume 抛错。其余原因保持后端原文（不猜测）。
     */
    function wakeReasonText(reason) {
      const r = String(reason ?? '')
      if (!r) return ''
      if (r.startsWith('agent-not-live')) return '该 Bot 会话当时没在运行'
      if (r.startsWith('resume-failed')) return '该 Bot 会话启动失败'
      return r
    }

    /** 唤醒结果 → 人话（sent / skipped / pending / failed 全覆盖，失败带原因）。 */
    function wakeLabel(wake) {
      if (!wake) return '未请求唤醒'
      const result = wake.result ?? (wake.ok === false ? 'failed' : 'sent')
      const base = {
        sent: '已唤醒执行者',
        skipped: '未重复唤醒（之前已唤醒过）',
        pending: '已排队，稍后送达',
        failed: '唤醒失败',
      }[result] ?? `唤醒结果：${result}`
      const reason = wake.reason ? `（原因：${wakeReasonText(wake.reason)}）` : ''
      return base + reason
    }

    // ── 会话启动（契约 bots05 §2.2 / §3.3）────────────────────────────────────

    /**
     * 启动一个 Bot 会话：`POST /bots/revive`。
     * target 三选一：`{botId}` / `{sessionId}` / `{all:true}`。
     * 后端约定 `ok:true` 只表示「请求已处理」，是否真的活着看 `live` / `revived` / `reason`。
     */
    async function reviveSession(target) {
      let body = null
      if (target?.all) body = { all: true }
      else if (target?.botId) body = { botId: target.botId }
      else if (target?.sessionId) body = { sessionId: target.sessionId }
      if (!body) throw new Error('缺少 Bot 标识（botId 或 sessionId），无法启动会话')
      return call('/bots/revive', { method: 'POST', body })
    }

    /** 单个启动结果 → 人话（live / revived / reason 都显式显示，不静默）。 */
    function reviveResultText(d) {
      if (!d) return '启动会话：无响应'
      if (d.live) return d.revived ? '该 Bot 会话已启动' : '该 Bot 会话已在线'
      return `启动失败（${d.reason ?? '未知原因'}）`
    }

    /** 全部启动结果 → 人话（复活 N 个 / 已在线 M 个 / 失败 K 个（原因））。 */
    function reviveAllText(d) {
      const revived = d?.revived?.length ?? 0
      const live = d?.live?.length ?? 0
      const failed = d?.failed ?? []
      const reasons = failed.map((f) => `${f?.sessionId ?? '?'}: ${f?.reason ?? '未知原因'}`).join('；')
      return `复活 ${revived} 个 / 已在线 ${live} 个 / 失败 ${failed.length} 个${reasons ? `（${reasons}）` : ''}`
    }

    /**
     * 唤醒结果提示条（失败不静默）。改造05：当失败原因是 `agent-not-live*`，
     * 额外给两个可操作按钮（契约 §3.2）：
     *   · 「启动该 Bot 会话」→ POST /bots/revive（botId 优先，其次 sessionId）
     *   · 「重试唤醒」→ POST /tasks/wake {id}（或调用方自定义 onRetry）
     * 响应 `revived === true`（后端自动复活成功）→ 成功提示追加「（已自动启动该 Bot 会话）」。
     */
    function WakeNotice({ wake, prefix, revived, botId, sessionId, taskId, onRetry }) {
      const [busy, setBusy] = useState(null) // 'revive' | 'retry'
      const [curWake, setCurWake] = useState(null)
      const [retryRevived, setRetryRevived] = useState(false)
      const [extra, setExtra] = useState(null)
      if (!wake && !curWake) return null
      const shown = curWake ?? wake
      const reason = String(shown?.reason ?? '')
      const bad = shown?.ok === false || shown?.result === 'failed'
      const notLive = bad && reason.startsWith('agent-not-live')
      const autoRevived = !bad && (revived === true || retryRevived)

      const doRevive = async () => {
        if (busy) return
        setBusy('revive')
        setExtra(null)
        try {
          const d = await reviveSession(botId ? { botId } : { sessionId })
          setExtra(reviveResultText(d))
        } catch (e) {
          setExtra(`启动会话失败：${e.message}`)
        } finally {
          setBusy(null)
        }
      }

      const doRetry = async () => {
        if (busy) return
        setBusy('retry')
        setExtra(null)
        try {
          let d
          if (typeof onRetry === 'function') {
            d = await onRetry()
          } else {
            if (!taskId) throw new Error('缺少任务 ID，无法重试唤醒')
            d = await call('/tasks/wake', { method: 'POST', body: { id: taskId } })
          }
          if (d?.wake) setCurWake(d.wake)
          if (d?.revived === true) setRetryRevived(true)
          if (!d?.wake) setExtra('已请求重试唤醒，但没有拿到唤醒结果')
        } catch (e) {
          setExtra(`重试唤醒失败：${e.message}`)
        } finally {
          setBusy(null)
        }
      }

      const label = `${prefix ?? ''}${wakeLabel(shown)}${autoRevived ? '（已自动启动该 Bot 会话）' : ''}`
      // ── 按钮可见性（2026-11-09 修复：「我没有看到重试唤醒的按钮」）──────────
      // 原实现只在 `reason.startsWith('agent-not-live')` 时渲染按钮 —— 于是只有
      // 「会话不在线」这一类失败能看到按钮，而**投递被拒收 / 水位没动 / 看护判未消费**
      // 这些同样需要重试的失败，人只能干看着一条红字。用户明确反馈过这一点。
      // 现在的口径：
      //   · 只要这次唤醒「没成功」（bad）⇒ **一定给「重试唤醒」**
      //   · 只有确实是会话不在线（notLive）时才额外给「启动该 Bot 会话」
      //     （不是离线导致的失败，给「启动会话」是误导）
      const canRetry = bad
      return h('div', { className: 'csb-wake' },
        h(Notice, { kind: bad ? 'err' : 'ok' }, label),
        canRetry
          ? h('div', { className: 'csb-bar', style: { marginTop: 6 } },
              notLive
                ? h('button', {
                    className: 'csb-btn csb-btn-s',
                    disabled: busy === 'revive',
                    onClick: doRevive,
                  }, busy === 'revive' ? '启动中…' : '启动该 Bot 会话')
                : null,
              h('button', {
                className: 'csb-btn csb-btn-s csb-btn-p',
                disabled: busy === 'retry',
                onClick: doRetry,
              }, busy === 'retry' ? '重试中…' : '重试唤醒'))
          : null,
        extra ? h('div', { className: 'csb-set-d', style: { marginTop: 6 } }, extra) : null)
    }

    /** 可折叠长文本（目标原文可能很长；等宽字体保留格式）。 */
    function CollapsibleText({ text, mono, limit }) {
      const [open, setOpen] = useState(false)
      const s = String(text ?? '')
      const max = limit ?? 600
      const cut = s.length > max
      return h('div', null,
        h('div', {
          className: mono ? 'csb-pre' : undefined,
          style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
        }, open || !cut ? s : `${s.slice(0, max)}…`),
        cut
          ? h('button', {
              className: 'csb-btn csb-btn-s', style: { marginTop: 6 },
              onClick: () => setOpen((v) => !v),
            }, open ? '收起' : `展开全文（共 ${s.length} 字）`)
          : null)
    }

    /**
     * 交付物文件预览弹窗 —— 只读。
     *
     * 为什么需要它（用户原话：「点任务只能看到交付物地址，无法打开或预览，不人性化」）：
     *   Bot 交付的 `artifacts` 是文件路径，人以前只能看到一串路径文本，
     *   想知道「这到底交付了什么」只能自己去文件系统里翻。现在点一下就能看到内容。
     *
     * 安全：内容由后端 `/data/file` 返回（限 stateDir 内、防穿越、二进制拒绝、大文件截断），
     *   前端只负责展示，**不拼接任何路径**（避免前端自己做穿越）。
     */
    function FilePreviewModal({ path, data, loading, error, onClose }) {
      return h('div', { className: 'csb-modal-backdrop', onClick: onClose },
        h('div', { className: 'csb-modal', onClick: (e) => e.stopPropagation() },
          h('div', { className: 'csb-modal-h' },
            h('span', { className: 'csb-mono' }, path),
            h('button', { className: 'csb-btn csb-btn-s csb-btn-d', onClick: onClose }, '关闭')),
          loading ? h('div', { className: 'csb-note' }, '加载中…') : null,
          error ? h('div', { className: 'csb-err' }, `预览失败：${error}`) : null,
          data?.content != null ? h('div', null,
            h('div', { className: 'csb-note', style: { marginBottom: 8 } },
              `${data.bytes ?? 0} 字节${data.truncated ? ' · 文件过大，已截断到前 100KB' : ''}`),
            h('pre', { className: 'csb-pre', style: { maxHeight: 420, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, data.content)) : null,
          h('div', { className: 'csb-bar', style: { marginTop: 10 } },
            h('button', { className: 'csb-btn csb-btn-s', onClick: () => copyText(data?.content ?? '') }, '复制内容'))))
    }

    /** 平台伪身份：这些值永远不可能是 Bot 会话 id。 */
    const PLATFORM_OWNER_IDS = ['ui', 'user', 'anyone', 'system']

    /**
     * 把任务的「负责人相关字段」解析成一个真正可跳转的 Bot。
     *
     * 为什么需要它（2026-11-06 用户实测报错「该负责人不是本平台的 Bot，无法跳转…定位 ui」）：
     *   - `ownerId` 是**租约持有者**：人会自己 claim（`ui`），或验收时被覆盖；
     *   - `assignee` 才是「这活原本派给谁」；
     *   - 任务可能没有 owner 但创建时填了 assignee。
     * 所以按 **assignee → ownerId → task.ownerId** 顺序找，命中即用；
     * 同时过滤平台伪身份 —— 否则会把 `ui` 当成会话 id 去找，报一句无解的错误。
     *
     * @param {{ task?: object, ownerId?: string|null, bots?: object[] }} input
     * @returns {{
     *   bot: object|null,
     *   tried: string[],
     *   candidates: string[],
     *   onlyPlatform: boolean,
     * }}
     */
    function resolveOwnerBot({ task, ownerId, bots }) {
      const list = Array.isArray(bots) ? bots : []
      const raw = [task?.assignee, ownerId, task?.ownerId]
      const candidates = []
      for (const value of raw) {
        if (typeof value !== 'string' || value.trim() === '') continue
        const v = value.trim()
        if (candidates.includes(v)) continue
        candidates.push(v)
      }
      const tried = candidates.filter((v) => !PLATFORM_OWNER_IDS.includes(v.toLowerCase()))
      for (const value of tried) {
        const found = list.find((b) => b && (b.sessionId === value || b.id === value))
        if (found) return { bot: found, tried, candidates, onlyPlatform: false }
      }
      return { bot: null, tried, candidates, onlyPlatform: tried.length === 0 }
    }

    /**
     * 任务详情 ·「目标锚 + 补充说明」区块（契约 §3.2）。
     *
     * 数据来源：
     *   GET /tasks/brief?id=  → anchor（创建时冻结的原文）+ notes + text
     *   GET /tasks/notes?id=  → 补充历史
     *   GET /roster           → ownerId → sessionId（去对话）
     * 写入：
     *   POST /tasks/note      → 追加补充说明（有执行者时顺带唤醒）
     */
    function TaskAnchorPanel({ taskId, task, onChange, onGotoSource }) {
      const briefQ = useApi(`/tasks/brief?id=${encodeURIComponent(taskId)}`, [taskId])
      const notesQ = useApi(`/tasks/notes?id=${encodeURIComponent(taskId)}`, [taskId])
      const rosterQ = useApi('/roster')
      // 来源跳转（契约 §2.5）：任务详情的「来源」区块数据
      const sourceQ = useApi(`/tasks/source?id=${encodeURIComponent(taskId)}`, [taskId])
      const [noteText, setNoteText] = useState('')
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState(null)
      const [wake, setWake] = useState(null)
      // 改造06：任务结论摘要（/tasks/summary）—— 让人不点进对话就能看到进度和下一步
      const summaryQ = useApi(`/tasks/summary?id=${encodeURIComponent(taskId)}`, [taskId])
      const [revived, setRevived] = useState(false)
      const [saved, setSaved] = useState(null)
      const [copied, setCopied] = useState(null)
      const [jump, setJump] = useState(null)
      // 改造06（CONTRACT-bots06 §3.2）：换负责人弹窗
      const [reassignOpen, setReassignOpen] = useState(false)

      const brief = briefQ.data
      const anchor = brief?.anchor ?? {}
      const notes = notesQ.data?.notes ?? brief?.notes ?? []
      const ownerId = anchor.ownerId ?? task?.ownerId ?? null
      const subject = anchor.subject ?? task?.subject ?? '（无标题）'
      const description = anchor.description ?? task?.description ?? ''
      const writeScopes = anchor.writeScopes ?? task?.writeScopes ?? []
      const blockedBy = anchor.blockedBy ?? task?.blockedBy ?? []
      const bots = rosterQ.data?.bots ?? []
      const hasOwner = Boolean(ownerId)

      /** 复制「可直接发给任意会话」的锚定文案（后端生成，前端不改写）。 */
      const copyBrief = async () => {
        setErr(null)
        setCopied(null)
        try {
          const d = await call(`/tasks/brief?id=${encodeURIComponent(taskId)}`)
          const ok = await copyText(d.text ?? '')
          setCopied(ok
            ? '已复制派发文案，可直接粘贴给任意会话'
            : '复制失败：浏览器不允许自动复制，请到「目标锚」里手动选中复制')
        } catch (e) {
          setErr(`复制派发文案失败：${e.message}`)
        }
      }

      /**
       * 去对话：把「负责人」解析成真正的 Bot 会话，再调宿主 openSession。
       *
       * 为什么不能只看 ownerId（2026-11-06 用户实测报错）：
       *   `ownerId` 是**租约持有者**，人会自己 claim（`ui`）或验收时被覆盖；
       *   而「这活原本派给谁」记在 `assignee` 上。只看 ownerId 就会出现
       *   「任务明明派给了 bot-xxx，点去对话却说『该负责人不是本平台的 Bot』，定位 ui」。
       * ⇒ 按 **assignee → ownerId → anchor.ownerId** 顺序逐个尝试，
       *   并过滤 `ui`/`user`/`anyone` 这类平台伪身份（它们永远不可能是 Bot 会话）。
       */
      const gotoOwner = async () => {
        setErr(null)
        const { bot, candidates, onlyPlatform } = resolveOwnerBot({ task, ownerId, bots })
        if (candidates.length === 0) {
          setErr('这个任务还没有执行者，先派活儿再跳转对话')
          return
        }
        if (!bot) {
          // 说清楚「为什么跳不了」，并给出真正能用的下一步，而不是只报一句无解。
          setJump({
            id: candidates[0],
            hint: onlyPlatform
              ? '这个任务的负责人是平台操作者（你），没有可跳转的 Bot 会话。'
                + '如果它是派给某个 Bot 的，请确认「负责人」字段填的是 Bot 的会话 ID（可在 Bot 页复制）。'
              : '这个任务的负责人不是本平台注册的 Bot（可能已被退役，或是外部会话），无法自动跳转。'
                + '可以复制 ID 到左侧会话列表里手动定位。',
          })
          return
        }
        try {
          if (await tryOpenSession(bot.sessionId ?? ownerId)) return
          const ok = await copyText(bot.sessionId ?? ownerId)
          setJump({
            id: bot.sessionId ?? ownerId,
            hint: ok
              ? '宿主不支持自动跳转，已复制会话 ID，可在左侧会话列表里定位。'
              : '宿主不支持自动跳转，请手动复制下面的会话 ID。',
          })
        } catch (e) {
          setErr(`无法打开会话：${e.message}`)
        }
      }

      /**
       * 来源跳转（契约 §3.2 第 6 条 + §2.5）：
       *
       * 数据由后端如实给出，**不猜、不装成功**：
       *   - `room.exists === false` → 后端数据里已经没有这个房间，按钮禁用，
       *     点击不跳（只提示「来源房间已删除」）。
       *   - `messageExists === false` → 房间还在，但那条消息已经不在了（被清理）：
       *     仍然切到房间页签（人可以在里面手动找），但提示必须说清
       *     「消息 #N 已不在（可能被清理）」，不许假装跳成功。
       *   - 两者都不是 → 正常切页签并定位。
       */
      const gotoSource = () => {
        setErr(null)
        const src = sourceQ.data
        const room = src?.room
        if (!room) {
          setErr('来源信息还没读到，稍后再试')
          return
        }
        const seq = room.seq
        if (room.exists === false) {
          setErr('来源房间已删除')
          return
        }
        if (room.messageExists === false) {
          // 人看到这条提示就知道「跳过去也找不到那条消息」，而不是以为跳成功了
          setErr(`消息 #${seq} 已不在（可能被清理）`)
        }
        // 切到「房间」页签并带上定位参数（§3.2：`onGoto('rooms', { roomId, seq })`）
        // 必须带 sub:'rooms'（2026-11-09 修正）：safeGoTab 会把 'rooms' 映射成 'team'，
        // 不带 sub 就落到首个子视图「Bot 档案」——这就是「跳房间跳到 Bot 页」的根因。
        if (typeof onGotoSource === 'function') onGotoSource('team', { sub: 'rooms', roomId: room.roomId, seq })
        else setErr('当前页面不支持跨页签跳转，请手动打开房间列表')
      }

      /**
       * 手动重试唤醒（2026-11-09，用户原话：「我没有看到重试唤醒的按钮」）。
       *
       * `POST /tasks/wake {id}`：后端会先 ensureLive、再预检投递能力、最后 notify，
       * 成功后还会**清掉上一次的 delivery.error**（见 api.js `clearDeliveryFailure`）。
       * 所以这个按钮不只是「再发一次」——它同时修复了任务的阶段：
       * 之前被失败留痕劫持成「输入投递失败」，点它之后会回到正常阶段。
       *
       * 结果复用 `wake` 状态 + `WakeNotice` 渲染，与其它唤醒路径口径一致；
       * 额外触发 summaryQ.reload，让「执行者」区块立刻反映新的投递状态。
       */
      const retryWake = async () => {
        if (busy) return null
        setBusy('retry-wake')
        setErr(null)
        setWake(null)
        setRevived(false)
        try {
          const d = await call('/tasks/wake', { method: 'POST', body: { id: taskId } })
          setWake(d?.wake ?? null)
          setRevived(d?.revived === true)
          summaryQ.reload()
          onChange?.()
          return d
        } catch (e) {
          setErr(`重试唤醒失败：${e.message}`)
          return null
        } finally {
          setBusy(null)
        }
      }

      /** 追加补充说明：成功后清空、刷新历史、显示唤醒结果。 */
      const sendNote = async () => {
        const text = noteText.trim()
        if (!text || busy) return
        setBusy(true)
        setErr(null)
        setWake(null)
        setRevived(false)
        setSaved(null)
        setCopied(null)
        try {
          const body = { id: taskId, text }
          if (!hasOwner) body.wake = false // 未派活：只保存，不装出「已唤醒」的样子
          const d = await call('/tasks/note', { method: 'POST', body })
          setNoteText('')
          setWake(d?.wake ?? null)
          setRevived(d?.revived === true)
          if (!d?.wake) setSaved(hasOwner ? '补充已保存（本次没有唤醒）' : '补充已保存（未派活，不唤醒）')
          notesQ.reload()
          onChange?.()
        } catch (e) {
          setErr(`保存补充说明失败：${e.message}`)
        } finally {
          setBusy(false)
        }
      }

      return h('div', null,
        h(Section, {
          title: '目标锚（只读）',
          desc: '目标来自创建时原文 · 补充说明只追加不覆盖',
        }),
        briefQ.loading && !task ? h(Skeleton, { n: 1 }) : null,
        briefQ.error ? h('div', { className: 'csb-note' }, `目标锚接口暂不可用：${briefQ.error}（下面用任务当前内容兜底）`) : null,
        h('div', { className: 'csb-anchor' },
          h('div', { className: 'csb-anchor-subj' }, subject),
          description
            ? h(CollapsibleText, { text: description, mono: true })
            : h('div', { className: 'csb-set-d' }, '（创建时没有填写目标描述）'),
          h('div', { className: 'csb-anchor-meta' },
            h('span', null, `边界：${writeScopes.length ? writeScopes.join('、') : '（未限定）'}`),
            h('span', null, `前置：${blockedBy.length ? blockedBy.join('、') : '（无）'}`),
            h('span', null,
              `执行者：${hasOwner ? botName(bots, ownerId) : '未派活'}`,
              h('button', {
                className: 'csb-btn csb-btn-s',
                style: { marginLeft: 8, height: 24, padding: '0 8px', fontSize: 11.5 },
                onClick: () => setReassignOpen(true),
              }, '换负责人')))),

        h('div', { className: 'csb-bar', style: { marginTop: 10 } },
          h('button', { className: 'csb-btn csb-btn-s', onClick: copyBrief }, '复制派发文案'),
          h('button', { className: 'csb-btn csb-btn-s', onClick: gotoOwner }, '去对话'),
          copied ? h('span', { className: 'csb-set-d' }, copied) : null),
        err ? h('div', { className: 'csb-err' }, err) : null,
        wake
          ? h(WakeNotice, {
              wake,
              revived,
              prefix: '补充已保存 · ',
              sessionId: ownerId,
              taskId,
            })
          : null,
        !wake && saved ? h(Notice, { kind: 'ok', onClose: () => setSaved(null) }, saved) : null,

        h(Section, {
          title: '补充说明',
          desc: '只追加、不覆盖目标原文。发送后会把「完整目标原文 + 这条补充」一起送给执行者，长任务也不会跑偏。',
        }),
        h('div', { className: 'csb-fld', style: { marginTop: 10 } },
          h('textarea', {
            className: 'csb-ta',
            placeholder: '例如：别忘了限流；接口文档在 docs/login.md…',
            value: noteText,
            onChange: (e) => setNoteText(e.target.value),
          }),
          h('div', { className: 'csb-bar', style: { marginTop: 8 } },
            h('button', {
              className: 'csb-btn csb-btn-p',
              disabled: busy || !noteText.trim(),
              onClick: sendNote,
            }, busy ? '发送中…' : (hasOwner ? '发送给执行者' : '保存补充（未派活，暂不唤醒）')),
            h('span', { className: 'csb-set-d' }, hasOwner ? '会立即唤醒执行者' : '任务还没有执行者，只保存不唤醒'))),

        h(Section, { title: '补充历史', desc: `${notes.length} 条，按时间从早到晚` }),
        notesQ.error ? h('div', { className: 'csb-note' }, `补充历史读取失败：${notesQ.error}`) : null,
        notesQ.loading ? h(Skeleton, { n: 1 }) : null,
        notes.length === 0
          ? h('div', { className: 'csb-set-d', style: { marginTop: 8 } }, '还没有补充说明。')
          : h('div', { className: 'csb-list', style: { marginTop: 10 } }, notes.map((n, i) =>
              h('div', { key: n.id ?? i, className: 'csb-card', style: { padding: '9px 12px' } },
                h('div', { className: 'csb-card-main' },
                  h('div', { style: { fontSize: 12.5, lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } },
                    h('span', { className: 'csb-mono', style: { marginRight: 6 } }, `[${fmt(n.at)}]`),
                    n.text ?? '',
                    h('span', { className: 'csb-set-d' }, `（${n.by ?? 'ui'}）`)))))),

        // 改造06：换负责人弹窗（Bot 下拉 → POST /tasks/reassign）
        reassignOpen
          ? h(TaskReassignModal, { task, bots, onClose: () => setReassignOpen(false), onChange })
          : null,

        jump
          ? h(Modal, {
              title: '去对话',
              onClose: () => setJump(null),
              footer: [
                h('button', {
                  key: 'c', className: 'csb-btn',
                  onClick: async () => {
                    const ok = await copyText(jump.id)
                    setJump((j) => j && { ...j, hint: ok ? '已复制 ID。' : '请手动选中复制。' })
                  },
                }, '复制 ID'),
                h('button', { key: 'x', className: 'csb-btn csb-btn-p', onClick: () => setJump(null) }, '知道了'),
              ],
            },
            h('p', { className: 'csb-field-h' }, jump.hint),
            h('div', {
              className: 'csb-mono',
              style: { padding: 10, background: 'var(--dsw-alias-bg-layer-2)', borderRadius: 8, wordBreak: 'break-all' },
            }, jump.id))
          : null,

          // ── 来源跳转（契约 §3.2 第 6 条；§2.5 的落地）───────────────────
          //
          // 规则（契约原文，逐条实现，不自作主张）：
          //   room + exists !== false → 按钮「回到消息出处（房间名 #N）」
          //   room + exists === false → 按钮禁用 + 提示「来源房间已删除」
          //   none                    → **不渲染任何来源区块**（人建的任务不占位）
          //   todo/evolve             → 只读一行「来源：<sourceSeq>」
          //   unparsed                → 只读一行 + 后端 reason（绝不渲染跳不动的按钮）
          sourceQ.error
            ? h('div', { className: 'csb-note', style: { marginTop: 10 } }, `来源信息读取失败：${sourceQ.error}`)
            : (() => {
                const src = sourceQ.data
                const kind = src?.kind ?? 'none'
                if (kind === 'none') return null
                if (kind === 'room') {
                  const room = src.room ?? {}
                  const disabled = room.exists === false
                  return h(Section, {
                    title: '来源',
                    desc: '这个任务是从房间消息创建的，可以跳回消息出处。',
                  },
                    h('div', { className: 'csb-bar', style: { marginTop: 10 } },
                      h('button', {
                        className: 'csb-btn csb-btn-s',
                        disabled,
                        onClick: gotoSource,
                      }, disabled
                        ? '回到消息出处（来源房间已删除）'
                        : `回到消息出处（${room.name ?? room.roomId} #${room.seq}）`),
                      room.preview ? h('span', { className: 'csb-set-d' }, `「${room.preview}」`) : null,
                      room.exists === false ? h('span', { className: 'csb-set-d' }, '来源房间已删除') : null,
                      room.messageExists === false
                        ? h('span', { className: 'csb-set-d' }, `消息 #${room.seq} 已不在（可能被清理）`)
                        : null))
                }
                // todo / evolve / unparsed：只读一行 + reason（unparsed 时）
                return h(Section, { title: '来源' },
                  h('div', { className: 'csb-set-d', style: { marginTop: 10 } },
                    `来源：${src?.sourceSeq ?? ''}`,
                    kind === 'unparsed' && src?.reason
                      ? h('div', { className: 'csb-err', style: { marginTop: 6 } }, src.reason)
                      : null))
              })(),

          // ── 任务结论区（需求4）──────────────────────────────────────────
          //
          // 为什么需要它（用户原话：「点任务只能看到交付物地址，无法打开或预览，
          // 另外如果无法跳转对话的话，可以设置成在任务栏展示当前对话的结论，
          // 我需要能看到每一步的进度和结论，决定下一步的方向」）：
          //   人打开任务详情，想知道「现在做到哪了、每一步结论是什么、下一步该做什么」，
          //   但以前只能看到 artifacts 路径 + 一堆状态数字，对话内容要进会话翻。
          //   现在从后端 /tasks/summary 直接拿到进度、每步结论、下一步，
          //   一眼就能决定「这活接下来往哪走」，不用跳转到对话。
          //
          // 没数据时不占位（和 source 的 none 同口径）——空区块比没有区块更烦人。
          (() => {
            const sum = summaryQ.data
            // 没有有效摘要就不渲染区块：空区块比没有区块更烦人（且 `{ok:true}` 无数据时
            // 会渲染出一个只有标题、三条全「—」的壳子，属于误导）。
            // `stageInfo` 也算「有数据」：它是**从任务状态实时推导**的，永远真实存在；
            // 只按 currentProgress/nextStep 判断会让「刚派下来还没写进度」的任务
            // 连阶段都看不到 —— 而那正是人最想知道的时刻。
            if (!sum || (!sum.stageInfo && !sum.currentProgress && !sum.nextStep && !(Array.isArray(sum.stepConclusions) && sum.stepConclusions.length))) return null
            const { currentProgress, stepConclusions, nextStep } = sum
            const progressItems = []
            // ── 当前阶段（改造07 + 2026-11-09）────────────────────────────
            // 结论区是人打开任务详情时**最先扫的那一屏**：
            // 阶段徽标 + 理由，让「现在做到哪一步、该谁动」不用读正文就能判断。
            // 「需要你处理」刻意放在阶段后面 —— 人先看是哪类事，再决定要不要动手。
            if (sum.stageInfo) {
              const si = sum.stageInfo
              progressItems.push(h('div', { key: 'stage', className: 'csb-kv', style: { marginTop: 10 } },
                h('span', { className: 'csb-k' }, '当前阶段'),
                h('span', { className: 'csb-v' },
                  h('span', { className: stageBadgeCls(si.group), title: si.reason }, si.label),
                  si.needsPerson
                    ? h('span', { className: 'csb-b csb-b-run', style: { marginLeft: 8 } }, '需要你处理')
                    : null)))
            }
            // ── 执行者状态（2026-11-09：「显示正在执行中，但我看不到过程」）────
            // 「投递成功」不等于「真的在跑」。把三件事分开说：
            //   会话在不在线 / 最近一次唤醒结果 / 有没有投递失败
            if (sum.executor) {
              const ex = sum.executor
              const wakeText = ex.lastWake
                ? `${ex.lastWake.result ?? '?'}${ex.lastWake.detail ? `（${ex.lastWake.detail}）` : ''}`
                : '还没有唤醒过'
              progressItems.push(h('div', { key: 'exec', className: 'csb-kv', style: { marginTop: 10 } },
                h('span', { className: 'csb-k' }, '执行者'),
                h('span', { className: 'csb-v' },
                  h('span', { className: ex.live ? 'csb-b csb-b-run' : 'csb-b' },
                    ex.live ? '会话在线' : '会话离线（唤醒会先复活）'),
                  h('span', { className: 'csb-set-d', style: { marginLeft: 8 } }, `最近唤醒：${wakeText}`))))
              if (ex.deliveryError) {
                // 2026-11-09：失败不能只是一条红字 —— 人需要「一键重来」。
                // 用户原话：「我没有看到重试唤醒的按钮」。这里给的是同一个动作
                // （POST /tasks/wake），成功后后端会清掉这条失败留痕。
                progressItems.push(h('div', { key: 'execerr', style: { marginTop: 6 } },
                  h('div', { className: 'csb-err' }, `输入投递失败：${ex.deliveryError}`),
                  h('div', { className: 'csb-bar', style: { marginTop: 6 } },
                    h('button', {
                      className: 'csb-btn csb-btn-s csb-btn-p',
                      disabled: busy === 'retry-wake',
                      onClick: retryWake,
                    }, busy === 'retry-wake' ? '重试中…' : '重试唤醒'))))
              }
            }
            if (currentProgress) {
              progressItems.push(h('div', { key: 'p', className: 'csb-kv', style: { marginTop: 10 } },
                h('span', { className: 'csb-k' }, '当前进度'),
                h('span', { className: 'csb-v' }, currentProgress.progressText ?? '—')))
              if (currentProgress.lastNote) {
                progressItems.push(h('div', { key: 'n', className: 'csb-note', style: { marginTop: 6 } },
                  `最近笔记：${currentProgress.lastNote}`))
              }
            }
            if (stepConclusions && stepConclusions.length > 0) {
              progressItems.push(
                h('div', { key: 'c', style: { marginTop: 10 } },
                  h('div', { className: 'csb-k' }, `每步结论（${stepConclusions.length} 条）`),
                  stepConclusions.map((c, i) => h('div', { key: i, className: 'csb-list', style: { marginTop: 6 } },
                    h('div', { className: 'csb-card', style: { padding: '6px 10px' } },
                      h('div', { className: 'csb-card-m', style: { fontSize: 12.5 } },
                        h('span', { className: 'csb-b' }, c.result ?? '—'),
                        h('span', null, ` · ${fmt(c.at ?? '')}`)),
                      c.excerpt
                        ? h('div', { className: 'csb-set-d', style: { marginTop: 4, fontSize: 12.5 } },
                            h(CollapsibleText, { text: c.excerpt, limit: 200 }))
                        : null)))))
            }
            progressItems.push(h('div', { key: 'next', className: 'csb-kv', style: { marginTop: 10 } },
              h('span', { className: 'csb-k' }, '下一步方向'),
              h('span', { className: 'csb-v' }, nextStep ?? '（待队长补充）')))
            return h(Section, {
              title: '任务结论',
              desc: '从唤醒记录与任务笔记提炼。队长可在任务笔记里补充「下一步」以指导后续方向。',
            }, ...progressItems)
          })())
    }

    /**
     * 任务对话（需求2，2026-11-09）。
     *
     * ## 用户的原话（需求2）
     *   「任务栏页面指派bot后，无法追踪任务进度，无法看到产出物，
     *    没有跳转对话也没有对话内容查看」
     *
     * ⇒ 一个面板补齐三件事：**看进度**（来自 /tasks/summary 的 stepConclusions 与 stageInfo）、
     *   **看产出物**（artifacts 直达预览/打开）、**看对话内容**（/tasks/conversation 读执行者会话）。
     *
     * ## 铁律
     *   · **不装成功**：会话读不到（没有执行者 / 宿主没开 sessionPersistence）时，
     *     把 `code` 对应的真话写出来，并给下一步 —— 不是只弹一句「失败」。
     *   · **只读**：这里只渲染，不往执行者会话里写任何东西。
     *   · **消息分层**：user / assistant / tool 三类各自样式，工具调用折叠，
     *     reasoning 只在展开时看 —— 手机上默认不该被思维链淹没。
     */
    function TaskConversationPanel({ taskId, task, bots, onGotoSource }) {
      const convQ = useApi(`/tasks/conversation?id=${encodeURIComponent(taskId)}&limit=40`, [taskId])
      const [open, setOpen] = useState(false)
      const [err, setErr] = useState(null)
      const [expanded, setExpanded] = useState(false)
      const [copied, setCopied] = useState(null)

      const data = convQ.data
      const messages = data?.messages ?? []
      const bot = data?.bot ?? null
      const sessionId = data?.sessionId ?? task?.assignee ?? task?.ownerId ?? null
      // 后端在「没有执行者」时返回 ok:false + code NO_EXECUTOR，call() 会抛错 ——
      // 那不是故障，是正常空态，要按空态呈现。
      const noExecutor = /NO_EXECUTOR/.test(convQ.error ?? '') || /没有执行者/.test(convQ.error ?? '')

      /** 跳到执行者的会话（宿主支持就直接开，不支持则复制 ID 兜底）。 */
      const gotoSession = async () => {
        setErr(null)
        if (!sessionId) {
          setErr('这个任务还没有执行者，先派活再跳转对话')
          return
        }
        try {
          if (await tryOpenSession(sessionId)) return
          const ok = await copyText(sessionId)
          setCopied(ok ? `宿主不支持自动跳转，已复制会话 ID：${sessionId}` : `请手动复制会话 ID：${sessionId}`)
        } catch (e) {
          setErr(`无法打开会话：${e.message}`)
        }
      }

      const roleLabel = (m) => {
        if (m.role === 'user') return HUMAN_SELF_LABEL
        if (m.role === 'assistant') return bot?.name ?? '执行者'
        if (m.role === 'tool') return m.toolName ? `工具 · ${m.toolName}` : '工具'
        return m.role ?? '?'
      }
      // 复用房间消息那套样式（只读渲染，不新造 class）
      const isMe = (m) => m.role === 'user'

      const visible = expanded ? messages : messages.filter((m) => m.kind === 'text' || m.role === 'user')

      return h('div', null,
        h(Section, {
          title: '任务对话',
          desc: bot
            ? `执行者「${bot.name}」的会话记录（最近 ${messages.length} 条${data?.truncated ? '，已截断' : ''}）。`
              + '这里是只读的：要看全部或继续聊，点「去对话」。'
            : '任务派给 Bot 之后，它的执行过程会出现在这里。',
        }, null),

        convQ.loading ? h(Skeleton, { n: 2 }) : null,

        noExecutor
          ? h(Empty, {
              icon: '◌',
              title: '还没有执行者',
              hint: '任务派给 Bot 之后才会有对话记录。先在「可以做什么」里派活，或者用 Bot 页的「派发」把任务交给它。',
            })
          : convQ.error
            ? h('div', { className: 'csb-err' }, `读不到对话：${convQ.error}`)
            : null,

        data && !noExecutor
          ? h('div', null,
              // 进度线索：后端给的阶段与摘要
              h('div', { className: 'csb-anchor-meta', style: { marginTop: 6 } },
                bot ? h('span', null, `执行者：${bot.name}${bot.label ? `（${bot.label}）` : ''}`) : null,
                sessionId ? h('span', { className: 'csb-mono' }, `会话 ${short(sessionId, 18)}`) : null,
                data?.available === false
                  ? h('span', null, `会话不可读：${data.reason ?? '宿主未提供 sessionPersistence'}`)
                  : h('span', null, `${messages.length} 条消息${data?.total ? ` / 共 ${data.total}` : ''}`)),
              h('div', { className: 'csb-bar', style: { marginTop: 8 } },
                h('button', { className: 'csb-btn csb-btn-p csb-btn-s', onClick: gotoSession }, '去对话（打开会话）'),
                h('button', { className: 'csb-btn csb-btn-s', onClick: convQ.reload }, '刷新对话'),
                messages.length > 0
                  ? h('button', {
                      className: `csb-btn csb-btn-s${expanded ? ' csb-btn-p' : ''}`,
                      onClick: () => setExpanded((v) => !v),
                    }, expanded ? '只看对话（隐藏工具/思维链）' : '看全部（含工具调用）')
                  : null),
              copied ? h(Notice, { kind: 'ok', onClose: () => setCopied(null) }, copied) : null,
              err ? h('div', { className: 'csb-err' }, err) : null,

              data?.available === false
                ? h('div', { className: 'csb-note', style: { marginTop: 8 } },
                    '宿主没有开放会话读取能力，所以看不到历史对话。'
                    + '不影响看进度和产出物 —— 或者直接点「去对话」进它的会话里看。')
                : null,

              messages.length === 0 && data?.available !== false
                ? h('div', { className: 'csb-set-d', style: { marginTop: 8 } }, '会话里还没有消息。')
                : h('div', { className: 'csb-list', style: { marginTop: 10 } },
                    visible.map((m, i) =>
                      h('div', { key: i, className: `csb-msg-row${isMe(m) ? ' csb-msg-row-me' : ''}` },
                        h('div', { className: `csb-msg${isMe(m) ? ' csb-msg-me' : ''}` },
                          h('div', { className: 'csb-msg-h' },
                            h('span', { className: 'csb-msg-sender' }, roleLabel(m)),
                            m.kind && m.kind !== 'text' ? h('span', { className: 'csb-b csb-b-idle' }, m.kind) : null),
                          h('div', { className: 'csb-msg-b' }, m.text ?? '')),
                        h('div', { className: 'csb-msg-time' }, m.at ? fmt(m.at) : '')),
                    )))
          : null)
    }


    // ══════════════════════════════════════════════════════════════════════
    // 改造06：任务变更中心（契约 CONTRACT-bots06 §3）
    //
    // 用户原话：「完成的任务应该可以纠错或者优化或者更改或其他变更，变更成长任务」
    //           「任务可以变更负责人」
    //
    // 设计铁律：
    //   · **变更必须有理由**：note 必填（前端也拦，按钮禁用），没有理由的变更不进历史。
    //   · **证据不能丢**：completed 任务 reopen 时内核会清空 artifacts —— 后端先把
    //     「当时的样子」快照进 task-meta.jsonl，前端用 latestSnapshot 明确告诉用户
    //     「上一轮交付物已存档，重开不会丢证据」。
    //   · **已完成不是终点**：completed 时变更区默认展开、标题改成行动指引，
    //     否则用户会以为只能新建任务（这正是用户这次提的问题）。
    // ══════════════════════════════════════════════════════════════════════

    /** 变更动作 → 人话（契约 §2.3 的 kind 全集）。 */
    function evolveActionLabel(kind) {
      switch (String(kind ?? '')) {
        case 'snapshot': return '存档上一轮状态'
        case 'reopen': return '重开'
        case 'followup': return '派生优化单'
        case 'longrun': return '转为长任务'
        case 'reassign': return '换负责人'
        default: return String(kind ?? '变更')
      }
    }

    /**
     * 一条变更记录 → `[时间] 动作 — 说明（by）`（契约 §3.1）。
     * 快照记录没有 note：用「上一轮交付物 N 项」兜底，避免历史里出现空动作。
     */
    function evolveChangeText(ch) {
      const label = evolveActionLabel(ch?.kind)
      let note = typeof ch?.note === 'string' ? ch.note.trim() : ''
      if (!note && ch?.kind === 'snapshot') {
        const arts = Array.isArray(ch?.before?.artifacts) ? ch.before.artifacts : []
        note = `上一轮交付物 ${arts.length} 项`
      }
      if (!note && ch?.kind === 'reassign') note = `${ch?.from ?? '?'} → ${ch?.to ?? '?'}`
      const by = ch?.by ?? ch?.byId ?? 'ui'
      return `[${fmt(ch?.at)}] ${label}${note ? ` — ${note}` : ''}（${by}）`
    }

    /** `POST /tasks/evolve`：三种 mode 的唯一入口（note 必填，前端先拦一次）。 */
    async function postEvolve({ id, mode, note, reopen }) {
      if (!id) throw new Error('缺少任务 ID，无法变更')
      const text = String(note ?? '').trim()
      if (!text) throw new Error('变更说明必填：没有理由的变更不许进历史')
      if (text.length > 4000) throw new Error('变更说明最多 4000 字')
      const body = { id, mode, note: text }
      if (reopen === true) body.reopen = true
      return call('/tasks/evolve', { method: 'POST', body })
    }

    /** `POST /tasks/reassign`：换负责人（expectedRev 走 CAS，防止覆盖别人的改动）。 */
    async function postReassign({ id, ownerId, expectedRev }) {
      if (!id) throw new Error('缺少任务 ID，无法换负责人')
      if (!ownerId) throw new Error('请先选择新的负责人')
      const body = { id, ownerId }
      if (expectedRev !== undefined && expectedRev !== null) body.expectedRev = expectedRev
      return call('/tasks/reassign', { method: 'POST', body })
    }

    /** 唤醒结果 → 接在换负责人成功文案后面（没唤醒就明说，不装成功）。 */
    function reassignWakeText(wake) {
      if (!wake) return '，本次没有请求唤醒'
      return `；${wakeLabel(wake)}`
    }

    /**
     * 变更历史 + 上一轮交付物存档 + 长任务阶段（纯展示：数据全部由 props 给，
     * 便于在无 jsdom 的测试里直接断言文案）。
     */
    function EvolveHistory({ changes, latestSnapshot, longrun, loading, error }) {
      const list = Array.isArray(changes) ? changes : []
      const snap = latestSnapshot ?? null
      const arts = Array.isArray(snap?.artifacts) ? snap.artifacts : []
      const snapText = arts.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join('、')
      const phases = Array.isArray(longrun?.phases) ? longrun.phases : []
      return h('div', null,
        snap
          ? h('div', { className: 'csb-evolve-snap' },
              `上一轮交付物：${snapText || '（当时没有交付物记录）'}（已存档，重开不会丢证据）`,
              snap.status ? h('span', null, ` · 存档时状态：${snap.status}`) : null,
              snap.completedAt ? h('span', null, ` · 完成于：${fmt(snap.completedAt)}`) : null)
          : null,
        phases.length
          ? h('div', { className: 'csb-evolve-snap' },
              `长任务阶段：${phases.map((p, i) => `${i + 1}. ${p}`).join('；')}`)
          : null,
        h(Section, {
          title: `变更历史（${list.length} 条，按时间从早到晚）`,
          desc: '每次重开 / 派生 / 转长任务 / 换负责人都会记在这里，含变更说明。',
        }),
        error ? h('div', { className: 'csb-note' }, `变更历史读取失败：${error}`) : null,
        loading ? h(Skeleton, { n: 1 }) : null,
        list.length === 0
          ? h('div', { className: 'csb-set-d', style: { marginTop: 8 } },
              '还没有变更记录。第一次重开 / 派生 / 转长任务后，这里会留下存档与理由。')
          : h('div', { className: 'csb-list', style: { marginTop: 10 } },
              list.map((ch, i) =>
                h('div', { key: ch?.at ?? i, className: 'csb-card csb-chg' },
                  h('div', { className: 'csb-card-main csb-chg-t' }, evolveChangeText(ch))))))
    }

    /**
     * 任务详情 ·「变更」区块（契约 §3.1 / §3.3）。
     *
     * 位置在「可以做什么」之后；`status === 'completed'` 时**默认展开**，
     * 标题改成行动指引 —— 已完成 ≠ 不能改。
     */
    function TaskEvolvePanel({ taskId, task, onChange }) {
      const changesQ = useApi(`/tasks/changes?id=${encodeURIComponent(taskId)}`, [taskId])
      const [note, setNote] = useState('')
      const [busy, setBusy] = useState(null) // 'reopen' | 'followup' | 'longrun'
      const [err, setErr] = useState(null)
      const [result, setResult] = useState(null)
      const completed = task?.status === 'completed'
      // 已完成任务默认展开（用户看到完成就以为没救了 —— 这里必须先把入口摆出来）
      const [open, setOpen] = useState(completed)

      const changes = changesQ.data?.changes ?? []
      const latestSnapshot = changesQ.data?.latestSnapshot ?? null
      const longrun = changesQ.data?.longrun ?? null

      const run = async (mode) => {
        const text = note.trim()
        if (!text || busy) return
        setBusy(mode)
        setErr(null)
        setResult(null)
        try {
          const d = await postEvolve({ id: taskId, mode, note: text, reopen: mode === 'longrun' })
          if (mode === 'followup') {
            const newId = d?.task?.id ?? d?.newTaskId ?? '新任务'
            setResult(`已派生 ${newId}`)
          } else if (mode === 'longrun') {
            setResult(d?.note ?? '已标记为长任务；后续每次唤醒都会带上阶段清单')
          } else {
            setResult(d?.note ?? '已重开；上一轮交付物已存档，见变更历史')
          }
          setNote('')
          changesQ.reload()
          onChange?.()
        } catch (e) {
          setErr(`变更失败：${e.message}`)
        } finally {
          setBusy(null)
        }
      }

      const disabled = Boolean(busy) || !note.trim()

      const openBody = h('div', { style: { marginTop: 10 } },
        h('div', { className: 'csb-fld' },
          h('label', null, '变更说明（必填）'),
          h('textarea', {
            className: 'csb-ta',
            placeholder: '例如：第 3 条验收标准未满足，接口漏了限流…',
            value: note,
            onChange: (e) => setNote(e.target.value),
          }),
          h('div', { className: 'csb-fld-h' },
            '写清「为什么改」，它会进变更历史。没有说明的变更不许提交。')),
        h('div', { className: 'csb-bar' },
          h('button', {
            className: 'csb-btn csb-btn-p',
            disabled,
            onClick: () => run('reopen'),
          }, busy === 'reopen' ? '重开中…' : '重开（纠错/继续做）'),
          h('button', {
            className: 'csb-btn',
            disabled,
            onClick: () => run('followup'),
          }, busy === 'followup' ? '派生中…' : '派生优化单'),
          h('button', {
            className: 'csb-btn',
            disabled,
            onClick: () => run('longrun'),
          }, busy === 'longrun' ? '标记中…' : '转为长任务')),
        err ? h('div', { className: 'csb-err' }, err) : null,
        result ? h(Notice, { kind: 'ok', onClose: () => setResult(null) }, result) : null,
        h(EvolveHistory, {
          changes,
          latestSnapshot,
          longrun,
          loading: changesQ.loading,
          error: changesQ.error,
        }))

      return h('div', null,
        h(Section, {
          // 契约 §3.3：「已完成 · 要纠错/优化/变更从这里开始」放在「可以做什么」区
          // （见 TaskDrawer），这里是紧接着的变更操作区，标题不重复。
          title: completed ? '变更 · 已完成的任务可以继续改' : '变更（纠错 / 优化 / 转长任务）',
          desc: completed
            ? '这个任务已经完成，但随时可以改：重开接着做、派生一张优化单、或转成长任务。变更说明必填。'
            : '要纠错、优化、或把它变成长任务？写清理由再选一种变更方式。变更说明必填。',
        }),
        h('div', { className: 'csb-evolve' },
          h('div', { className: 'csb-evolve-head' },
            h('h4', null, completed ? '已完成任务可以继续改' : '变更操作'),
            h('button', {
              className: 'csb-btn csb-btn-s',
              onClick: () => setOpen((v) => !v),
            }, open ? '收起变更面板' : '展开变更面板')),
          open
            ? openBody
            : h('div', { className: 'csb-set-d', style: { marginTop: 8 } },
                '变更面板已收起。点「展开变更面板」可以重开 / 派生优化单 / 转长任务。')))
    }

    /**
     * 「换负责人」弹窗（契约 §3.2）。
     *
     * 已完成任务会被后端拦（`TASK_COMPLETED`）——这里不隐藏按钮，而是把
     * 「改走重开 / 派生优化单」的可操作提示显示出来，否则用户只会看到一句报错。
     */
    function TaskReassignModal({ task, bots, onClose, onChange }) {
      const [ownerId, setOwnerId] = useState('')
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState(null)
      const [done, setDone] = useState(null)
      // GET /roster 默认不含 retired，这里再过滤一次：退役 Bot 不可被指派
      const liveBots = (Array.isArray(bots) ? bots : []).filter((b) => b && b.state !== 'retired')
      const current = task?.ownerId ?? task?.assignee ?? null

      const submit = async () => {
        if (!ownerId || busy) return
        setBusy(true)
        setErr(null)
        setDone(null)
        // 换负责人**不传 expectedRev**（2026-11-07 实测修复）：
        //   弹窗打开时拿到的 task 是抽屉里的旧快照；期间若发生「重开/完成/别人改」，
        //   旧 rev 会让后端预检直接抛 BOARD_REV_CONFLICT（用户看到的正是这个错）。
        //   后端处理器**自己** b.get() 拿最新 rev、并在每次 b.update() 里做 CAS，
        //   所以传 stale rev 不增加任何安全性，只会制造假冲突。
        //
        // 真·并发冲突（两次点击撞车）仍由后端 CAS 兜住；这里额外做**一次自动重试**：
        //   刷新抽屉数据 → 重新提交，用户不用手动「刷新后重试」。
        const doSubmit = () => postReassign({ id: task?.id, ownerId })
        try {
          let d
          try {
            d = await doSubmit()
          } catch (e) {
            if (e?.code === 'BOARD_REV_CONFLICT') {
              // 让抽屉重新拉一次最新 task（onChange 会触发 reload），再试一次
              await Promise.resolve(onChange?.())
              d = await doSubmit()
            } else {
              throw e
            }
          }
          const fromName = current ? botName(liveBots.length ? liveBots : bots, current) : '未派人'
          const toName = botName(liveBots, d?.to ?? ownerId)
          setDone(`已从 ${fromName} 换到 ${toName}${reassignWakeText(d?.wake)}`)
          onChange?.()
        } catch (e) {
          if (e?.code === 'TASK_COMPLETED') {
            setErr('任务已完成，不能直接换负责人。'
              + '请先用下方「变更」区的「重开（纠错/继续做）」或「派生优化单」，再换负责人。'
              + `（后端说明：${e.message}）`)
          } else if (e?.code === 'BOARD_REV_CONFLICT') {
            setErr('任务刚被别处改动过（版本冲突），已自动重试仍不成功。'
              + '请关闭弹窗后重新打开再试。'
              + `（后端说明：${e.message}）`)
          } else {
            setErr(`换负责人失败：${e.message}`)
          }
        } finally {
          setBusy(false)
        }
      }

      return h(Modal, {
        title: '换负责人',
        onClose,
        footer: [
          h('button', { key: 'c', className: 'csb-btn', onClick: onClose }, '关闭'),
          h('button', {
            key: 'o',
            className: 'csb-btn csb-btn-p',
            disabled: busy || !ownerId,
            onClick: submit,
          }, busy ? '变更中…' : '确认换人'),
        ],
      },
        h('div', { className: 'csb-field-l' },
          `当前负责人：${current ? botName(liveBots.length ? liveBots : bots, current) : '还没人领'}`),
        h('div', { className: 'csb-fld', style: { marginTop: 10 } },
          h('label', null, '新负责人'),
          liveBots.length === 0
            ? h('div', { className: 'csb-set-d' }, '还没有可指派的 Bot（退役的不算）。去「Bot」页先建一个。')
            : h('select', {
                className: 'csb-sel',
                style: { width: '100%' },
                value: ownerId,
                onChange: (e) => setOwnerId(e.target.value),
              },
                h('option', { value: '' }, '请选择 Bot'),
                liveBots.map((b) => h('option', { key: b.id ?? b.sessionId, value: b.sessionId ?? b.id },
                  `${b.name ?? '(无名)'}${b.state ? ` · ${b.state}` : ''}`))),
          h('div', { className: 'csb-fld-h' },
            '换人会先把原负责人的租约交还，再以新负责人身份领取，并唤醒新负责人。'
            + '已完成的任务会被拦 —— 先重开或派生优化单。')),
        err ? h('div', { className: 'csb-err', style: { marginTop: 10 } }, err) : null,
        done ? h(Notice, { kind: 'ok' }, done) : null)
    }

    /** Bot 页「派任务」：建任务 → 立即指派 → 显示唤醒结果（契约 §3.1）。 */
    function BotAssignModal({ bot, onClose }) {
      const [subject, setSubject] = useState('')
      const [desc, setDesc] = useState('')
      const [priority, setPriority] = useState('')
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState(null)
      const [done, setDone] = useState(null)
      const sessionId = bot?.sessionId ?? ''

      const submit = async () => {
        const s = subject.trim()
        if (!s || busy) return
        setBusy(true)
        setErr(null)
        setDone(null)
        let task = null
        try {
          const body = { subject: s, assignee: sessionId }
          if (desc.trim()) body.description = desc.trim()
          if (priority !== '') body.priority = Number(priority)
          const created = await call('/tasks', { method: 'POST', body })
          task = created?.task ?? null
        } catch (e) {
          setErr(`建任务失败：${e.message}`)
          setBusy(false)
          return
        }
        try {
          const assigned = await call('/tasks/assign', {
            method: 'POST',
            body: { id: task?.id, ownerId: sessionId, expectedRev: task?.rev },
          })
          setDone({
            taskId: task?.id ?? assigned?.task?.id ?? '?',
            wake: assigned?.wake ?? null,
            revived: assigned?.revived === true,
            reviveReason: assigned?.reviveReason ?? null,
          })
          setSubject('')
          setDesc('')
          setPriority('')
        } catch (e) {
          setErr(`任务 ${task?.id ?? ''} 已建，但派活失败：${e.message}`)
        } finally {
          setBusy(false)
        }
      }

      return h(Modal, {
        title: `派任务给「${bot?.name ?? '这个 Bot'}」`,
        onClose,
        footer: [
          h('button', { key: 'c', className: 'csb-btn', onClick: onClose }, done ? '关闭' : '取消'),
          h('button', {
            key: 'o', className: 'csb-btn csb-btn-p',
            disabled: busy || !subject.trim(), onClick: submit,
          }, busy ? '派活中…' : '创建并派活'),
        ],
      },
        h('div', { className: 'csb-fld' },
          h('label', null, '要做什么'),
          h('input', {
            className: 'csb-in', placeholder: '例如：实现登录接口',
            value: subject, onChange: (e) => setSubject(e.target.value), autoFocus: true,
          })),
        h('div', { className: 'csb-fld' },
          h('label', null, '目标 / 标准（会成为不可变的目标锚原文）'),
          h('textarea', {
            className: 'csb-ta', placeholder: '越具体越不容易跑偏：目标、验收标准、边界…',
            value: desc, onChange: (e) => setDesc(e.target.value),
          }),
          h('div', { className: 'csb-fld-h' },
            '创建后立即派给这个 Bot 并唤醒它；唤醒结果（sent / skipped / failed）显示在下面，失败会带原因。')),
        h('div', { className: 'csb-fld' },
          h('label', null, '负责人（已预填这个 Bot）'),
          h('div', { className: 'csb-set-d' }, `${bot?.name ?? '—'} · 会话 ${short(sessionId || '—', 18)}`),
          h('div', { className: 'csb-fld-h' }, '创建后立即派给这个 Bot（ownerId = 它的 sessionId），不需要再手动领取。')),
        h('div', { className: 'csb-fld' },
          h('label', null, '优先级（可选，0-10）'),
          h('input', {
            className: 'csb-in', style: { width: 100 }, type: 'number',
            value: priority, onChange: (e) => setPriority(e.target.value),
          })),
        err ? h('div', { className: 'csb-err' }, err) : null,
        done
          ? h('div', null,
              h('div', { className: 'csb-ok' }, `已建任务 ${done.taskId}，已派给「${bot?.name ?? sessionId}」`),
              done.wake
                ? h(WakeNotice, {
                    wake: done.wake,
                    revived: done.revived,
                    botId: bot?.id,
                    sessionId,
                    taskId: done.taskId,
                  })
                : null,
              done.reviveReason && !done.revived
                ? h('div', { className: 'csb-set-d', style: { marginTop: 6 } },
                    `会话没能自动启动：${wakeReasonText(done.reviveReason)}`)
                : null)
          : null)
    }

    /** Bot 页「发消息」：直接给该 Bot 的会话说话（契约 §3.1 / §2.4）。 */
    function BotMessageModal({ bot, onClose }) {
      const [text, setText] = useState('')
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState(null)
      const [done, setDone] = useState(null)

      const send = async () => {
        const t = text.trim()
        if (!t || busy) return
        setBusy(true)
        setErr(null)
        setDone(null)
        try {
          const d = await call('/bots/message', { method: 'POST', body: { botId: bot?.id, text: t } })
          setDone({
            sessionId: d?.sessionId,
            wake: d?.wake ?? null,
            revived: d?.revived === true,
            text: t,
          })
          setText('')
        } catch (e) {
          setErr(`发送失败：${e.message}`)
        } finally {
          setBusy(false)
        }
      }

      /** 重试唤醒：消息接口没有 taskId，重发一次并换新的 dedupKey（否则同文重发会命中去重）。 */
      const retrySend = async (info) => {
        if (!info?.text) throw new Error('没有可重发的消息')
        return call('/bots/message', {
          method: 'POST',
          body: {
            botId: bot?.id,
            text: info.text,
            dedupKey: `ui-msg-retry:${bot?.id ?? 'unknown'}:${Date.now()}`,
          },
        })
      }

      return h(Modal, {
        title: `给「${bot?.name ?? '这个 Bot'}」发消息`,
        onClose,
        footer: [
          h('button', { key: 'c', className: 'csb-btn', onClick: onClose }, '关闭'),
          h('button', {
            key: 's', className: 'csb-btn csb-btn-p',
            disabled: busy || !text.trim(), onClick: send,
          }, busy ? '发送中…' : '发送'),
        ],
      },
        h('div', { className: 'csb-fld' },
          h('label', null, '消息内容'),
          h('textarea', {
            className: 'csb-ta', placeholder: '例如：先做登录接口，做完回我一声',
            value: text, onChange: (e) => setText(e.target.value),
          }),
          h('div', { className: 'csb-fld-h' },
            `等价于你在这个 Bot 的会话里发一条消息（会话 ${short(bot?.sessionId ?? '—', 18)}）。`)),
        err ? h('div', { className: 'csb-err' }, err) : null,
        done && !done.wake
          ? h('div', { className: 'csb-ok' }, `已送达（会话 ${short(done.sessionId ?? '—', 18)}）`)
          : null,
        done && done.wake
          ? h(WakeNotice, {
              wake: done.wake,
              revived: done.revived,
              prefix: (done.wake.ok === false || done.wake.result === 'failed')
                ? '消息已提交，但 '
                : `已送达（会话 ${short(done.sessionId ?? '—', 18)}） · `,
              botId: bot?.id,
              sessionId: bot?.sessionId,
              onRetry: () => retrySend(done),
            })
          : null)
    }

    /** 房间消息 → 建任务：sourceSeq 幂等，重复点不会建两个（契约 §3.4）。 */
    function RoomTaskCreateModal({ roomId, msg, onClose }) {
      const body = String(msg?.body ?? msg?.text ?? '')
      const seq = msg?.seq
      const sourceSeq = `room:${roomId}:${seq}`
      const firstLine = body.split('\n').map((l) => l.trim()).find(Boolean) ?? '（无标题）'
      const [subject, setSubject] = useState(firstLine.slice(0, 80))
      const [desc, setDesc] = useState(`${body}\n\n出处：房间 ${roomId} · 消息 #${seq}`.trim())
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState(null)
      const [done, setDone] = useState(null)

      const create = async () => {
        const s = subject.trim()
        if (!s || busy) return
        setBusy(true)
        setErr(null)
        setDone(null)
        try {
          const d = await call('/tasks', {
            method: 'POST',
            body: { subject: s, description: desc.trim(), sourceSeq },
          })
          setDone({ id: d?.task?.id ?? '?', sourceSeq })
        } catch (e) {
          setErr(`建任务失败：${e.message}`)
        } finally {
          setBusy(false)
        }
      }

      return h(Modal, {
        title: `从消息 #${seq} 建任务`,
        wide: true,
        onClose,
        footer: [
          h('button', { key: 'c', className: 'csb-btn', onClick: onClose }, done ? '关闭' : '取消'),
          h('button', {
            key: 'o', className: 'csb-btn csb-btn-p',
            disabled: busy || !subject.trim(), onClick: create,
          }, busy ? '创建中…' : '创建任务'),
        ],
      },
        h('div', { className: 'csb-fld' },
          h('label', null, '任务标题（消息正文首行，可改）'),
          h('input', {
            className: 'csb-in', value: subject,
            onChange: (e) => setSubject(e.target.value), autoFocus: true,
          })),
        h('div', { className: 'csb-fld' },
          h('label', null, '任务描述（消息全文 + 出处）'),
          h('textarea', {
            className: 'csb-ta', style: { minHeight: 140 },
            value: desc, onChange: (e) => setDesc(e.target.value),
          })),
        h('div', { className: 'csb-field-h' },
          `来源幂等键：${sourceSeq} —— 同一条消息重复点「建任务」不会建出第二个任务。`),
        err ? h('div', { className: 'csb-err' }, err) : null,
        done
          ? h('div', { className: 'csb-ok' }, `已建任务 ${done.id}（幂等键 ${done.sourceSeq}）`)
          : null)
    }

    /** 需求1：智能体任务子页签——复用 TasksTab，只看 source='ai'。 */
    function AiTasksTab(props) {
      return h(TasksTab, { ...(props ?? {}), sourceFilter: 'ai', key: 'ai' })
    }

    /** 需求1：用户任务子页签——TasksTab 默认就是 human，显式包装保证语义清晰。 */
    function UserTasksTab(props) {
      return h(TasksTab, { ...(props ?? {}), sourceFilter: 'human', key: 'user' })
    }

    /**
     * 任务看板。
     *
     * 需求1（2026-11-08）：任务页**默认只展示人建任务**；智能体自建/分发的任务
     * 走独立子页签（`sourceFilter='ai'`），按状态分类展示。
     *
     * 为什么这样分：人关心的是「我要盯的活」，智能体之间互相派的活是执行细节——
     * 混在一起会让人在看板上看到一堆自己没建过的卡片，反而找不到自己的任务。
     *
     * @param {{ onGoto?: Function, sourceFilter?: 'human'|'ai' }} props
     */
    function TasksTab({ onGoto, sourceFilter = 'human' }) {
      const [filter, setFilter] = useState('')
      const [subject, setSubject] = useState('')
      const [desc, setDesc] = useState('')
      const [priority, setPriority] = useState('')
      const [assignee, setAssignee] = useState('')
      const [showAdv, setShowAdv] = useState(false)
      // ── 长任务一次到位（2026-11-09 需求3）─────────────────────────────────
      // 用户原话：「建任务的时候选择长任务就是长表单一次到位」。
      // 以前只能「先建普通任务 → 再转长任务」，第一步派活时唤醒文案里没有阶段清单，
      // 执行者第一轮就看不到路线。现在勾上就一次性把全部字段填完。
      const [isLong, setIsLong] = useState(false)
      const [phases, setPhases] = useState('')          // 每行一个阶段
      const [reviewer, setReviewer] = useState('')
      const [due, setDue] = useState('')
      const [scopes, setScopes] = useState('')          // 每行一个路径前缀
      const [complexity, setComplexity] = useState('')
      const [requiresPaid, setRequiresPaid] = useState(false)
      const [deps, setDeps] = useState('')
      const [labels, setLabels] = useState('')
      const [milestone, setMilestone] = useState('')
      const [cycleName, setCycleName] = useState('')
      const [estimate, setEstimate] = useState('')
      // 授权依据（mandate.basis）：这是任务级的「权限」——执行者被唤醒时必须知道
      // 「这活是谁批的、凭什么」。不填就不渲染授权段（宁可没有，不编造授权）。
      const [mandateBasis, setMandateBasis] = useState('')
      const [openId, setOpenId] = useState(null)
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState(null)
      // 创建/派活的成功提示（改造04：创建时填了负责人 = 一步派活，wake 结果要 toast 出来）
      const [ok, setOk] = useState(null)
      // 默认只看「需要我管的」；点「看全部」才显示 AI 派发的和已完成的
      const [attentionOnly, setAttentionOnly] = useState(true)
      // 双视图：看板 / 列表
      const [view, setView] = useState('list')
      // 本地过滤：负责人 / 关键词（不改后端 query）
      const [ownerFilter, setOwnerFilter] = useState('')
      const [keyword, setKeyword] = useState('')
      const subjectRef = useRef(null)
      const q = new URLSearchParams()
      if (filter) q.set('status', filter)
      if (attentionOnly && sourceFilter === 'human') q.set('attention', '1')
      // 需求1：按来源分离——human=用户自建，ai=智能体自建/分发
      q.set('source', sourceFilter)
      const qs = q.toString()
      const { data, loading, error, reload } = useApi(`/tasks${qs ? `?${qs}` : ''}`, [filter, attentionOnly, sourceFilter])
      const { data: rosterData } = useApi('/roster')
      const { data: wfData } = useApi('/library/workflows')
      const bots = rosterData?.bots ?? []
      const workflows = wfData?.workflows ?? []
      const tasks = data?.tasks ?? []
      // 本地过滤（不改后端 query）：负责人 + 关键词（subject/description 子串，大小写不敏感）
      const kw = keyword.trim().toLowerCase()
      const filtered = tasks.filter((t) => {
        if (ownerFilter && t.ownerId !== ownerFilter) return false
        if (kw) {
          const inSubj = (t.subject ?? '').toLowerCase().includes(kw)
          const inDesc = (t.description ?? '').toLowerCase().includes(kw)
          if (!inSubj && !inDesc) return false
        }
        return true
      })

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
        setOk(null)
        try {
          const body = { subject: s }
          if (desc.trim()) body.description = desc.trim()
          if (priority !== '') body.priority = Number(priority)
          if (assignee) body.assignee = assignee
          // ── 长任务一次到位（需求3）：全部字段随创建一起提交 ──────────────
          // 后端 POST /tasks 认 `longrun:true` 或非空 `phases` ⇒ 建完即长任务，
          // 阶段清单落 task-meta.jsonl，第一次唤醒就带在锚定原文里。
          if (isLong) {
            body.longrun = true
            const phaseList = phases.split('\n').map((x) => x.trim()).filter(Boolean)
            if (phaseList.length) body.phases = phaseList
            if (reviewer) body.reviewer = reviewer
            if (due) {
              const ts = Date.parse(due)
              if (Number.isFinite(ts)) body.dueAt = ts
            }
            const scopeList = scopes.split('\n').map((x) => x.trim()).filter(Boolean)
            if (scopeList.length) body.writeScopes = scopeList
            if (complexity) body.expectedComplexity = complexity
            if (requiresPaid) body.requiresPaid = true
            const depList = deps.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean)
            if (depList.length) body.blockedBy = depList
            const labelList = labels.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean)
            if (labelList.length) body.labels = labelList
            if (milestone) body.milestone = milestone
            if (cycleName) body.cycle = cycleName
            if (estimate !== '') body.estimate = Number(estimate)
            if (mandateBasis) {
              body.mandateBasis = mandateBasis
              body.mandateSender = 'ui'
            }
          }
          const created = await call('/tasks', { method: 'POST', body })
          const task = created?.task ?? null
          setSubject('')
          setDesc('')
          setPriority('')
          setAssignee('')
          setShowAdv(false)
          setPhases(''); setReviewer(''); setDue(''); setScopes('')
          setComplexity(''); setRequiresPaid(false); setDeps('')
          setLabels(''); setMilestone(''); setCycleName(''); setEstimate(''); setMandateBasis('')
          reload()
          // 改造04 §3.3：选了负责人 = 一步派活；失败不静默，wake 结果如实显示。
          if (assignee && task?.id) {
            try {
              const assigned = await call('/tasks/assign', {
                method: 'POST',
                body: { id: task.id, ownerId: assignee, expectedRev: task.rev },
              })
              setOk({
                text: `任务 ${task.id} 已创建，并派给 ${botName(bots, assignee)}`,
                wake: assigned?.wake ?? null,
                revived: assigned?.revived === true,
                taskId: task.id,
                sessionId: assignee,
              })
              reload()
            } catch (e) {
              setErr(humanizeError(e, errActions, '任务已建，但派活失败：'))
            }
          } else {
            setOk({ text: task?.id ? `任务 ${task.id} 已创建` : '任务已创建' })
          }
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

      const isAi = sourceFilter === 'ai'
      return h('div', { className: 'csb-wrap' },
        h(Section, {
          // 需求1：按来源给不同标题与说明——人只看自己建的，AI 的任务走独立子页签
          title: isAi ? '智能体任务' : `${HUMAN_LABEL}的任务`,
          desc: isAi
            ? `Bot 自行创建或分发的任务，按状态分类。这些是执行细节，平时不用盯；出问题（受阻/失败）时会出现在「${HUMAN_LABEL}的任务」的待处理里。`
            : (attentionOnly
              ? '只看需要你管的（卡住 / 高优先 / 逾期 / 待验收）。智能体自己派发的任务在「智能体任务」子页签。'
              : '全部你建的任务。点下方回到「只看需要我管的」。'),
        }),
        isAi ? null : h('div', { className: 'csb-bar', style: { marginTop: 8 } },
          attentionOnly
            ? h('button', { className: 'csb-btn csb-btn-s', onClick: () => setAttentionOnly(false) }, `看全部${HUMAN_LABEL}的任务`)
            : h('button', { className: 'csb-btn csb-btn-s', onClick: () => setAttentionOnly(true) }, '只看需要我管的')),
        h('div', { className: 'csb-bar', style: { marginTop: 12 } },
          h('input', {
            className: 'csb-in csb-grow', placeholder: isLong
              ? '长任务名称（回车创建）'
              : '要做什么？（例如：实现登录接口。回车创建）',
            value: subject, onChange: (e) => setSubject(e.target.value),
            onKeyDown: (e) => e.key === 'Enter' && create(),
            ref: subjectRef,
          }),
          // 长任务开关：勾上就展开完整表单（一次到位，不再「建完再转」）
          h('label', {
            className: 'csb-bar',
            style: { gap: 4, cursor: 'pointer', margin: 0, whiteSpace: 'nowrap' },
            title: '长任务 = 分阶段推进，每次唤醒都带阶段清单，防止几十轮后目标漂移',
          },
            h('input', {
              type: 'checkbox', checked: isLong,
              onChange: (e) => { setIsLong(e.target.checked); if (e.target.checked) setShowAdv(true) },
            }),
            h('span', { className: 'csb-set-d' }, '长任务'),
          ),
          h('button', { className: 'csb-btn csb-btn-s', onClick: () => setShowAdv((v) => !v) }, showAdv ? '收起' : '更多字段'),
          h('button', { className: 'csb-btn csb-btn-p', disabled: busy || !subject.trim(), onClick: create }, '创建任务'),
          h('select', { className: 'csb-sel', style: { width: 116 }, value: filter, onChange: (e) => setFilter(e.target.value) },
            h('option', { value: '' }, '全部状态'),
            h('option', { value: 'pending' }, '待办'),
            h('option', { value: 'in_progress' }, '进行中'),
            h('option', { value: 'completed' }, '已完成'),
            h('option', { value: 'blocked' }, '已终止'))),
        showAdv
          ? h('div', { className: 'csb-bar', style: { marginTop: 8, flexWrap: 'wrap' } },
              h('input', {
                className: 'csb-in csb-grow', placeholder: '任务描述（目标/标准）',
                value: desc, onChange: (e) => setDesc(e.target.value),
              }),
              h('input', {
                className: 'csb-in', style: { width: 90 }, type: 'number', placeholder: '优先级',
                value: priority, onChange: (e) => setPriority(e.target.value),
              }),
              h('select', { className: 'csb-sel', style: { width: 160 }, value: assignee, onChange: (e) => setAssignee(e.target.value) },
                h('option', { value: '' }, '负责人（自动）'),
                bots.map((b) => h('option', { key: b.id, value: b.sessionId }, b.name))))
          : null,
        // ── 长任务完整表单（需求3：一次到位）────────────────────────────────
        // 覆盖「边界 / 权限 / 路由」三类选项，全部是后端**已支持**的字段：
        //   写入边界 writeScopes · 验收人 reviewer · 依赖 blockedBy
        //   复杂度 expectedComplexity · 是否付费 requiresPaid
        //   截止 dueAt · 标签 labels · 里程碑 milestone · 周期 cycle · 预估 estimate
        isLong
          ? h('div', { className: 'csb-ltform' },
              h('div', { className: 'csb-fld', style: { gridColumn: '1 / -1' } },
                h('label', null, '阶段清单（每行一个阶段，按序推进，不许跳步）'),
                h('textarea', {
                  className: 'csb-ta', style: { minHeight: 92 },
                  placeholder: '范围与验收标准确认\n执行与自测\n交付与复盘',
                  value: phases, onChange: (e) => setPhases(e.target.value),
                }),
                h('div', { className: 'csb-fld-h' },
                  '留空就是默认三阶段；最多 12 个，每个不超过 200 字。阶段清单会写进每次唤醒的「目标锚原文」。')),
              h('div', { className: 'csb-fld' },
                h('label', null, '验收人'),
                h('input', {
                  className: 'csb-in', placeholder: '谁验收（可留空）',
                  value: reviewer, onChange: (e) => setReviewer(e.target.value),
                })),
              h('div', { className: 'csb-fld' },
                h('label', null, '截止时间'),
                h('input', {
                  className: 'csb-in', type: 'datetime-local',
                  value: due, onChange: (e) => setDue(e.target.value),
                })),
              h('div', { className: 'csb-fld' },
                h('label', null, '写入边界（每行一个路径前缀）'),
                h('textarea', {
                  className: 'csb-ta', style: { minHeight: 70 },
                  placeholder: 'src/api/\ndocs/',
                  value: scopes, onChange: (e) => setScopes(e.target.value),
                }),
                h('div', { className: 'csb-fld-h' }, '超出这个范围的写入算越界，是可审计的边界。')),
              h('div', { className: 'csb-fld' },
                h('label', null, '复杂度档位'),
                h('select', {
                  className: 'csb-sel', value: complexity,
                  onChange: (e) => setComplexity(e.target.value),
                },
                  h('option', { value: '' }, '不标（默认按常规处理）'),
                  h('option', { value: 'T0' }, 'T0 一句话问答'),
                  h('option', { value: 'T1' }, 'T1 常规改动'),
                  h('option', { value: 'T2' }, 'T2 跨文件 / 多步'),
                  h('option', { value: 'T3' }, 'T3 架构级')),
                h('div', { className: 'csb-fld-h' }, '档位决定路由：拿不准就往低标，误标付费是浪费钱。')),
              h('div', { className: 'csb-fld' },
                h('label', null, '依赖任务（逗号分隔的任务 id）'),
                h('input', {
                  className: 'csb-in', placeholder: 't-12, t-15',
                  value: deps, onChange: (e) => setDeps(e.target.value),
                }),
                h('div', { className: 'csb-fld-h' }, '依赖没完成，这条不会进「可领」列表。')),
              h('div', { className: 'csb-fld' },
                h('label', null, '标签（逗号分隔）'),
                h('input', {
                  className: 'csb-in', placeholder: 'backend, urgent',
                  value: labels, onChange: (e) => setLabels(e.target.value),
                })),
              h('div', { className: 'csb-fld' },
                h('label', null, '里程碑 / 周期'),
                h('div', { className: 'csb-bar', style: { gap: 6 } },
                  h('input', {
                    className: 'csb-in', placeholder: '里程碑',
                    value: milestone, onChange: (e) => setMilestone(e.target.value),
                  }),
                  h('input', {
                    className: 'csb-in', placeholder: '周期',
                    value: cycleName, onChange: (e) => setCycleName(e.target.value),
                  }))),
              h('div', { className: 'csb-fld' },
                h('label', null, '预估工作量'),
                h('input', {
                  className: 'csb-in', type: 'number', min: 0, placeholder: '数字，可留空',
                  value: estimate, onChange: (e) => setEstimate(e.target.value),
                })),
              h('div', { className: 'csb-fld' },
                h('label', null, '授权依据（执行者据此判断能不能直接动手）'),
                h('select', {
                  className: 'csb-sel', value: mandateBasis,
                  onChange: (e) => setMandateBasis(e.target.value),
                },
                  h('option', { value: '' }, '不记录（UI 建的，不算授权）'),
                  h('option', { value: 'explicit' }, '人明确点名要做（可以直接动手）'),
                  h('option', { value: 'inferred' }, '按规则推断（动手前先确认）'),
                  h('option', { value: 'task-board' }, '任务板派发（管理面正式派活）')),
                h('div', { className: 'csb-fld-h' },
                  '只有明确记录依据时，唤醒文案里才会出现「授权」一段 —— 宁可没有，不编造授权。')),
              h('div', { className: 'csb-fld' },
                h('label', null, '是否值得用付费渠道'),
                h('label', { className: 'csb-bar', style: { gap: 6, cursor: 'pointer' } },
                  h('input', {
                    type: 'checkbox', checked: requiresPaid,
                    onChange: (e) => setRequiresPaid(e.target.checked),
                  }),
                  h('span', null, '允许付费（默认只走免费渠道）')),
                h('div', { className: 'csb-fld-h' }, '只有确实需要强模型时才勾；勾了就是花你的钱。')))
          : null,
        h('div', { className: 'csb-bar', style: { marginTop: 8, flexWrap: 'wrap' } },
          h('button', {
            className: `csb-btn csb-btn-s${view === 'kanban' ? ' csb-btn-p' : ''}`,
            onClick: () => setView('kanban'),
          }, '看板视图'),
          h('button', {
            className: `csb-btn csb-btn-s${view === 'list' ? ' csb-btn-p' : ''}`,
            onClick: () => setView('list'),
          }, '列表视图'),
          h('input', {
            className: 'csb-in csb-grow', placeholder: '搜索任务（标题或描述）…',
            value: keyword, onChange: (e) => setKeyword(e.target.value),
          }),
          h('select', { className: 'csb-sel', style: { width: 140 }, value: ownerFilter, onChange: (e) => setOwnerFilter(e.target.value) },
            h('option', { value: '' }, '全部负责人'),
            bots.map((b) => h('option', { key: b.id, value: b.sessionId }, b.name)))),
        err ? h(ErrBox, { humanized: err, onAction: (c) => errActions[c]?.() }) : null,
        // 改造05：一步派活的唤醒失败 → 直接给「启动该 Bot 会话」「重试唤醒」，不用再翻日志
        ok
          ? h('div', null,
              h(Notice, { kind: 'ok', onClose: () => setOk(null) }, ok.text),
              ok.wake
                ? h(WakeNotice, {
                    wake: ok.wake,
                    revived: ok.revived,
                    taskId: ok.taskId,
                    sessionId: ok.sessionId,
                  })
                : null)
          : null,
        error ? h('div', { className: 'csb-err' }, error) : null,
        loading ? h(Skeleton, { n: 3 }) : null,
        !loading && !error && filtered.length === 0
          ? h(Empty, {
              icon: '◫', title: '还没有任务',
              hint: '在上面输入一句话就能建任务。建好后可以指派给某个 Bot，也可以自己领取来做。',
              action: { label: '新建任务', icon: '✎', onClick: () => subjectRef.current?.focus() },
            })
          : null,
        // 列表视图（保留原有卡片列表）
        !loading && !error && view === 'list'
          ? h('div', { className: 'csb-list' }, filtered.map((t) =>
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
                    : null))))
          : null,
        // 看板视图
        !loading && !error && view === 'kanban'
          ? h('div', { className: 'csb-kanban' },
              [
                { key: 'pending', label: '待办', cls: 'csb-b' },
                { key: 'in_progress', label: '进行中', cls: 'csb-b csb-b-run' },
                { key: 'completed', label: '已完成', cls: 'csb-b csb-b-ok' },
                { key: 'blocked', label: '已终止', cls: 'csb-b csb-b-err' },
              ].map((col) => {
                const colTasks = filtered.filter((t) => t.status === col.key)
                return h('div', { key: col.key, className: 'csb-kanban-col' },
                  h('div', { className: 'csb-kanban-col-h' },
                    h('span', { className: col.cls }, col.label),
                    h('span', { className: 'csb-set-d' }, `${colTasks.length} 个`)),
                  h('div', { className: 'csb-kanban-body' },
                    colTasks.length === 0
                      ? h('div', { className: 'csb-set-d', style: { padding: '8px 4px', fontSize: 11.5 } }, '空')
                      : colTasks.map((t) => {
                          // 改造07：执行阶段徽章（借鉴 Super-agent stage table）
                          const si = t.stageInfo
                          return h('div', { key: t.id, className: 'csb-kanban-card', onClick: () => setOpenId(t.id) },
                            h('div', { className: 'csb-kanban-t' }, t.subject),
                            si ? h('div', { style: { marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap' } },
                              h('span', { className: stageBadgeCls(si.group) }, si.label),
                              si.needsPerson
                                ? h('span', { className: 'csb-b csb-b-run', title: si.reason }, '需你处理')
                                : null) : null,
                            h('div', { className: 'csb-progress' },
                              h('div', { className: 'csb-progress-fill', style: { width: `${Math.max(0, Math.min(100, t.progress ?? 0))}%` } })),
                            h('div', { className: 'csb-kanban-m' },
                              h('span', null, t.ownerId ? botName(bots, t.ownerId) : '还没人领'),
                              h('span', null, `· 优先级 ${t.priority ?? 0}`),
                              (t.blockedBy ?? []).length ? h('span', null, `· 前置 ${t.blockedBy.length}`) : null))
                        })))
              }))
          : null,
        // 任务详情里的「来源跳转」需要跨页签定位能力（契约 §3.2 第 6 条）：透传 onGoto
        openId ? h(TaskDrawer, {
          id: openId, bots, workflows,
          onClose: () => setOpenId(null),
          onChange: reload,
          onGotoSource: onGoto,
        }) : null)
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
      // 把 Bot 会话挂进工作区（2026-11-09）：存量 Bot 从没挂过，永远躺在「未分组」。
      const [attaching, setAttaching] = useState(false)
      const [attachMsg, setAttachMsg] = useState(null)
      // 改造04：Bot 卡片上的「派任务」「发消息」
      const [assignFor, setAssignFor] = useState(null)
      const [msgFor, setMsgFor] = useState(null)
      // 改造05：会话启动结果（live / revived / reason 显式显示）
      const [reviveMsg, setReviveMsg] = useState(null)
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
          if (await tryOpenSession(bot.sessionId)) return
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

      /**
       * 启动单个 Bot 会话（契约 bots05 §3.3）：`POST /bots/revive {botId}`。
       * 注意：后端 `ok:true` 只表示「请求已处理」，必须看 live / revived / reason。
       */
      const reviveOne = async (bot) => {
        setErr(null)
        setReviveMsg(null)
        try {
          const d = await reviveSession({ botId: bot.id })
          setReviveMsg({
            kind: d?.live ? 'ok' : 'err',
            text: `「${bot.name}」：${reviveResultText(d)}`,
          })
          if (d?.live) reload()
        } catch (e) {
          setReviveMsg({ kind: 'err', text: `「${bot.name}」启动会话失败：${e.message}` })
        }
      }

      /**
       * 一键启动全部 Bot 会话（契约 bots05 §3.3）：重启 dsh-web 之后用。
       * 后端串行 ensureLive，返回 revived / live / failed 三个清单。
       */
      const reviveAll = async () => {
        setErr(null)
        setReviveMsg(null)
        setBusy(true)
        try {
          const d = await reviveSession({ all: true })
          const failed = d?.failed ?? []
          setReviveMsg({ kind: failed.length ? 'err' : 'ok', text: reviveAllText(d) })
          if (d?.revived?.length) reload()
        } catch (e) {
          setReviveMsg({ kind: 'err', text: `全部启动失败：${e.message}` })
        } finally {
          setBusy(false)
        }
      }

      /**
       * 把全部 Bot 会话挂进各自工作目录对应的工作区（2026-11-09）。
       *
       * 为什么需要手动点：新建的 Bot 会话现在会自动挂（kernel.attachToWorkspace），
       * 但**存量 Bot**（这个修复之前建的）从来没挂过 —— 于是永远躺在左侧栏「未分组」。
       * 补挂会写宿主的工作区注册表，属于跨插件写操作，不适合在插件装配期偷偷做，
       * 所以做成一个显式按钮：你点，它做，结果如实报。
       */
      const attachWorkspaces = async () => {
        setErr(null)
        setAttachMsg(null)
        setAttaching(true)
        try {
          const d = await call('/roster/attach-workspaces', { method: 'POST', body: {} })
          setAttachMsg({
            kind: d?.failed ? 'err' : 'ok',
            text: d?.note ?? `已挂 ${d?.attached ?? 0} / ${d?.total ?? 0}`,
          })
        } catch (e) {
          setAttachMsg({ kind: 'err', text: `补挂失败：${e.message}` })
        } finally {
          setAttaching(false)
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

        // 改造05 §3.3：重启 dsh-web 后一键把所有 Bot 会话拉起来（否则派活必报 agent-not-live）
        h('div', { className: 'csb-bar', style: { marginTop: 8 } },
          h('button', { className: 'csb-btn', disabled: busy, onClick: reviveAll }, busy ? '启动中…' : '全部启动'),
          h('button', { className: 'csb-btn csb-btn-p', disabled: attaching, onClick: attachWorkspaces },
            attaching ? '补挂中…' : '把会话挂进工作区'),
          h('span', { className: 'csb-set-d' },
            '「全部启动」把 Bot 会话拉起来；「挂进工作区」把它们放进左侧栏各自的工作目录分组'
            + '（存量 Bot 从没挂过，会一直待在「未分组」里）')),
        reviveMsg
          ? h(Notice, { kind: reviveMsg.kind, onClose: () => setReviveMsg(null) }, reviveMsg.text)
          : null,
        attachMsg
          ? h(Notice, { kind: attachMsg.kind, onClose: () => setAttachMsg(null) }, attachMsg.text)
          : null,

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
              b.state !== 'retired' ? h('button', { className: 'csb-btn csb-btn-s', onClick: () => setAssignFor(b) }, '派任务') : null,
              b.state !== 'retired' ? h('button', { className: 'csb-btn csb-btn-s', onClick: () => setMsgFor(b) }, '发消息') : null,
              b.state !== 'retired' ? h('button', { className: 'csb-btn csb-btn-s', onClick: () => reviveOne(b) }, '启动会话') : null,
              b.state !== 'retired' ? h('button', { className: 'csb-btn csb-btn-s', onClick: () => openSession(b) }, '打开会话') : null,
              b.state !== 'retired'
                ? h('button', { className: 'csb-btn csb-btn-s', onClick: () => { setRenaming(b); setRenameTo(b.name) } }, '改名')
                : null,
              b.state !== 'retired'
                ? h('button', { className: 'csb-btn csb-btn-s csb-btn-d', onClick: () => setRetiring(b) }, '退役')
                : null)))),

        picking ? h(DirPicker, { value: form.cwd, onChange: (p) => setForm({ ...form, cwd: p }), onClose: () => setPicking(false) }) : null,

        // 改造04 §3.1：派任务 / 发消息
        assignFor
          ? h(BotAssignModal, { bot: assignFor, onClose: () => setAssignFor(null) })
          : null,
        msgFor
          ? h(BotMessageModal, { bot: msgFor, onClose: () => setMsgFor(null) })
          : null,

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

    /**
     * 房间页签（契约 §3.2）：接收来源跳转的定位参数 `locate = { roomId, seq }`。
     *
     * 机制（不引入路由库、不重排页签）：
     *   - `locate` 变化 → 选中该房间（`active`）并记 `focusSeq`；
     *   - 渲染时给 `focusSeq` 那条消息行加高亮 class（`csb-msg-focus`）
     *     并在消息加载完成后 `scrollIntoView`。
     *
     * 没带 `locate`（普通点击页签）时 `focusSeq` 为 null，行为与改造前逐字一致。
     */
    function RoomsTab({ locate }) {
      const [showArchived, setShowArchived] = useState(false)
      const { data, loading, error, reload } = useApi(`/rooms${showArchived ? '?includeArchived=1' : ''}`, [showArchived])
      const { data: rosterData } = useApi('/roster')
      const [active, setActive] = useState(null)
      // 跨页签定位（契约 §2.5 / §3.2 第 6 条）：要高亮并滚过去的消息 seq
      const [focusSeq, setFocusSeq] = useState(null)
      const [msgs, setMsgs] = useState([])
      const [text, setText] = useState('')
      const [roomName, setRoomName] = useState('')
      const [err, setErr] = useState(null)
      const [ok, setOk] = useState(null)
      const [editing, setEditing] = useState(null)
      const [confirmDel, setConfirmDel] = useState(null)
      const [showBody, setShowBody] = useState(null)
      // 改造04 §3.4：消息气泡 → 建任务（sourceSeq 幂等）
      const [taskFor, setTaskFor] = useState(null)
      // 历史分页：前端切片（后端 sinceSeq 是「向后取」，不是「向前取」，
      // 所以先用全量、前端只渲染末尾 shownCount 条，点「加载更早」递增）
      const [shownCount, setShownCount] = useState(50)
      const endRef = useRef(null)
      const roomNameRef = useRef(null)
      // 高亮行的 DOM 句柄（消息渲染时挂 ref；加载完成后滚动过去）
      const focusSeqRef = useRef(null)

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
        if (active) {
          setShownCount(50)
          loadMsgs(active)
        }
      }, [active, loadMsgs])
      useEffect(() => {
        endRef.current?.scrollIntoView?.({ block: 'end' })
      }, [msgs])

      // 定位参数变化 → 选中房间 + 记 focusSeq（只做这两件事，加载由 active 的 effect 触发）
      useEffect(() => {
        const roomId = locate?.roomId
        const seq = locate?.seq
        if (!roomId) {
          setFocusSeq(null)
          return
        }
        setActive(roomId)
        setFocusSeq(Number.isInteger(seq) && seq > 0 ? seq : null)
      }, [locate])

      // 需求3（用户补充）：从团队卡片「看房间」会带 `{ filter: 团队名 }` ——
      // 用户是超级管理员，房间里可能很多，这里做前端定向过滤，让人一眼看到自己团队的房间。
      const roomFilter = (locate?.filter ?? '').toString().trim()
      const visibleRooms = roomFilter
        ? rooms.filter((r) => (r.name ?? '').toLowerCase().includes(roomFilter.toLowerCase()))
        : rooms

      // 定位到的消息加载出来后：滚过去 + 高亮（§3.2：`scrollIntoView`）
      useEffect(() => {
        if (focusSeq === null) return
        const idx = msgs.findIndex((m) => Number(m?.seq) === focusSeq)
        if (idx < 0) {
          // 消息已不在（可能被清理）：至少把列表滚到底，让人看到最新状态
          endRef.current?.scrollIntoView?.({ block: 'end' })
          return
        }
        // 目标在「加载更早」之前 → 先把窗口开到能看见它，否则滚过去也是空
        setShownCount((n) => Math.max(n, msgs.length - idx))
        focusSeqRef.current?.scrollIntoView?.({ block: 'center' })
      }, [msgs, focusSeq])

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
          // 需求3：从团队卡片跳转过来时带筛选，这里给一个明确的清掉入口
          roomFilter
            ? h('button', { className: 'csb-btn csb-btn-s csb-btn-err', onClick: () => setLocate(null) }, '✕ 清筛选')
            : null,
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

        roomFilter
          ? h('div', { className: 'csb-notice csb-notice-ok', style: { marginTop: 8 } },
            h('span', { className: 'csb-notice-t' }, `筛选房间：包含「${roomFilter}」→ ${visibleRooms.length} 个房间`))
          : null,
        visibleRooms.length === 0 && roomFilter
          ? h(Empty, { icon: '◌', title: '没有匹配的房间', hint: `没有房间名包含「${roomFilter}」。点右上「×」清掉筛选。` })
          : null,
        h('div', { className: 'csb-list' }, visibleRooms.map((r) =>
          h('div', {
            key: r.id, className: `csb-card csb-card-c${active === r.id ? ' csb-card-on' : ''}`,
            onClick: () => { setActive(r.id); setFocusSeq(null) },
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
                  desc: `共 ${msgs.length} 条，当前显示最近 ${Math.min(shownCount, msgs.length)} 条。发帖者必须是成员；你是超级管理员，可以直接看全部内容。`,
                }),
                current.purpose ? h('div', { className: 'csb-note', style: { marginTop: 10 } }, `用途：${current.purpose}`) : null,
                current.notice ? h('div', { className: 'csb-note', style: { marginTop: 10 } }, current.notice) : null,
                h('div', { style: { maxHeight: 460, overflowY: 'auto', margin: '12px 0' } },
                  msgs.length === 0 ? h(Empty, { title: '还没有消息' }) : null,
                  // 「加载更早」：只在还有更早消息时显示（前端切片，零后端改动）
                  msgs.length > shownCount
                    ? h('div', { className: 'csb-bar', style: { justifyContent: 'center', marginBottom: 8 } },
                        h('button', {
                          className: 'csb-btn csb-btn-s',
                          onClick: () => setShownCount((n) => n + 50),
                        }, `加载更早的 50 条（还有 ${msgs.length - shownCount} 条）`))
                    : null,
                  msgs.slice(-shownCount).map((m) => {
                    const body = m.body ?? m.text ?? ''
                    const long = body.length > 300
                    const isMe = m.from === 'user' || m.from === 'ui'
                    // 来源跳转定位（契约 §3.2）：目标消息行高亮
                    const focused = Number(m?.seq) === focusSeq
                    return h('div', {
                      key: m.id,
                      className: `csb-msg-row${isMe ? ' csb-msg-row-me' : ''}${focused ? ' csb-msg-focus' : ''}`,
                      ref: focused ? focusSeqRef : undefined,
                    },
                      h('div', { className: 'csb-msg-h' },
                        h('span', { className: 'csb-msg-sender' }, isMe ? HUMAN_LABEL : botName(bots, m.from)),
                        h('span', null, `#${m.seq}`),
                        m.bodyRef ? h('span', { className: 'csb-b' }, '长正文') : null,
                        m.bodyError ? h('span', { className: 'csb-b csb-b-err' }, '正文读取失败') : null,
                        long
                          ? h('button', {
                              className: 'csb-btn csb-btn-s', style: { marginLeft: 'auto' },
                              onClick: () => setShowBody(m),
                            }, '看全文')
                          : null,
                        h('button', {
                          className: 'csb-btn csb-btn-s csb-msg-task',
                          title: '把这条消息变成任务',
                          onClick: () => setTaskFor({ roomId: active, msg: m }),
                        }, '⇢ 建任务')),
                      h('div', { className: `csb-msg${isMe ? ' csb-msg-me' : ''}` },
                        h('div', { className: 'csb-msg-b' }, renderAt(long ? `${body.slice(0, 300)}…` : body))),
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

        // 改造04 §3.4：消息 → 建任务
        taskFor
          ? h(RoomTaskCreateModal, {
              roomId: taskFor.roomId,
              msg: taskFor.msg,
              onClose: () => setTaskFor(null),
            })
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

    // ── 成果（artifacts 聚合）────────────────────────────────────────────────

    /**
     * 成果 = 任务完成时提交的产出物证据（`task.artifacts`）。
     *
     * 为什么要单独一页：成果原本只在任务详情里作为一行文本出现，
     * 想「最近交了哪些东西」只能一个个任务点开。这里按任务聚合、可按
     * 负责人/状态/关键词筛选，点卡片回任务详情。
     *
     * 数据来自 `GET /artifacts`（契约 CONTRACT-bots03.md §1）。
     */
    function ArtifactsTab({ onGoto }) {
      const [q, setQ] = useState('')
      const [ownerFilter, setOwnerFilter] = useState('')
      const [statusFilter, setStatusFilter] = useState('')
      const [openId, setOpenId] = useState(null)

      const qs = new URLSearchParams()
      if (q.trim()) qs.set('q', q.trim())
      if (ownerFilter) qs.set('ownerId', ownerFilter)
      if (statusFilter) qs.set('status', statusFilter)
      const suffix = qs.toString() ? `?${qs.toString()}` : ''
      const { data, loading, error, reload } = useApi(`/artifacts${suffix}`, [q, ownerFilter, statusFilter])
      const { data: rosterData } = useApi('/roster')
      const bots = rosterData?.bots ?? []
      const items = data?.artifacts ?? []
      const stats = data?.stats ?? { tasks: 0, items: 0 }

      return h('div', { className: 'csb-wrap' },
        h(Section, {
          title: '成果库',
          desc: '任务完成时提交的产出物证据（文件路径、提交号、报告链接…）。按负责人/状态筛选，点卡片回到任务详情。',
        }),
        h('div', { className: 'csb-bar', style: { marginTop: 12, flexWrap: 'wrap' } },
          h('input', {
            className: 'csb-in csb-grow', placeholder: '搜成果：任务标题或产出物路径…',
            value: q, onChange: (e) => setQ(e.target.value),
          }),
          h('select', { className: 'csb-sel', style: { width: 170 }, value: ownerFilter, onChange: (e) => setOwnerFilter(e.target.value) },
            h('option', { value: '' }, '全部负责人'),
            bots.map((b) => h('option', { key: b.id, value: b.sessionId }, b.name))),
          h('select', { className: 'csb-sel', style: { width: 116 }, value: statusFilter, onChange: (e) => setStatusFilter(e.target.value) },
            h('option', { value: '' }, '全部状态'),
            h('option', { value: 'pending' }, '待办'),
            h('option', { value: 'in_progress' }, '进行中'),
            h('option', { value: 'completed' }, '已完成'),
            h('option', { value: 'blocked' }, '已终止'))),

        h('div', { className: 'csb-note', style: { marginTop: 8 } },
          `共 ${stats.tasks} 个任务、${stats.items} 件产出物${data?.note ? ` · ${data.note}` : ''}`),
        error ? h('div', { className: 'csb-err' }, error) : null,
        loading ? h(Skeleton, { n: 3 }) : null,
        !loading && !error && items.length === 0
          ? h(Empty, {
              icon: '◈', title: '还没有成果',
              hint: '任务完成并带上产出物证据（artifacts）后就会出现在这里。先去任务板把任务做完。',
              action: onGoto ? { label: '去看任务板', icon: '◫', onClick: () => onGoto('tasks') } : undefined,
            })
          : null,
        h('div', { className: 'csb-list' }, items.map((a) =>
          h('div', {
            key: a.taskId, className: 'csb-card csb-card-c',
            onClick: () => setOpenId(a.taskId),
          },
            h(Dot, { status: a.status }),
            h('div', { className: 'csb-card-main' },
              h('div', { className: 'csb-card-t' }, a.subject ?? a.taskId),
              h('div', { className: 'csb-card-m' },
                h(Badge, { status: a.status }),
                h('span', null, a.ownerId ? `由 ${botName(bots, a.ownerId)} 负责` : '无负责人'),
                a.accepted === true ? h('span', null, ' · 已验收') : (a.status === 'completed' ? h('span', null, ' · 待验收') : null),
                h('span', null, ` · ${a.taskId}`),
                a.completedAt ? h('span', null, ` · ${fmt(a.completedAt)}`) : null),
              h('div', { className: 'csb-tags', style: { marginTop: 6 } },
                (a.items ?? []).map((it, i) =>
                  h('span', { key: i, className: 'csb-tag csb-mono' }, short(it, 60)))))),
            h('div', { style: { flex: 'none' } },
              h('button', { className: 'csb-btn csb-btn-s', onClick: (e) => { e.stopPropagation(); setOpenId(a.taskId) } }, '看任务')))),
        openId ? h(TaskDrawer, {
          id: openId, bots, workflows: [],
          onClose: () => setOpenId(null),
          onChange: reload,
          onGotoSource: onGoto,
        }) : null)
    }

    // ── PDCA 复盘周期（Cycles）──────────────────────────────────────────────
    const PHASES = ['planned', 'doing', 'checking', 'acting', 'done']
    const PHASE_LABEL = { planned: '计划', doing: '执行', checking: '检查', acting: '改进', done: '完成' }

    /**
     * PDCA 复盘页（需求4，2026-11-08 重做）。
     *
     * ## 用户的要求（原话）
     *   「我要求 pdca 是对用户长任务进行复盘跟进的，人类主导；智能体的 pdca 流程你优化一下，
     *     看看有没有必要或优化，我关心的是用户能否对长任务进行管理，智能体的 pdca 需要定期归纳提升」
     *
     * ## 由此得到的分层
     *
     * | kind | 谁主导 | UI 呈现 | 阶段纪律 |
     * |---|---|---|---|
     * | `human` | **人** | 「我的长任务」分区——默认视图，人跟长任务用 | 五步不可跳 |
     * | `agent` | 智能体 | 「智能体归纳」分区——周期性批量总结用 | 复盘时可一次性提交，自动闭环 |
     *
     * 为什么分两个分区而不是一个列表加筛选：
     * 用户只关心「我对长任务的管理有没有到位」，智能体归纳是后台保鲜机制，
     * 混在一起会让人在 50 条里翻。上层 UI 默认只给 human，agent 折叠在下方。
     *
     * 为什么 agent 可以一次性提交：智能体复盘是批量归纳，让它走 planned→doing 是对事实的虚构；
     * 人需要的是「结论 + 可采纳的标准」。但**归纳本身要定期发生**——由 reviewer 回合计数驱动。
     */
    function CyclesTab() {
      // 需求4：human 与 agent 分开取，默认视图只显示 human（人跟长任务）
      const humanQ = useApi('/cycles?kind=human', [])
      const agentQ = useApi('/cycles?kind=agent', [])
      // 需求4：谁到了该归纳的时候（reviewer 只做被动计数，这里把它变成可点的动作）
      const reviewQ = useApi('/review/status', [])
      const rosterQ = useApi('/roster', [])
      const [taskId, setTaskId] = useState('')
      const [objective, setObjective] = useState('')
      const [agentTaskId, setAgentTaskId] = useState('')
      const [agentObjective, setAgentObjective] = useState('')
      const [expanded, setExpanded] = useState(null)
      const [reviewSummary, setReviewSummary] = useState('')
      const [reviewLessons, setReviewLessons] = useState('')
      const [reviewStandards, setReviewStandards] = useState('')
      const [msg, setMsg] = useState(null)
      const [agentMsg, setAgentMsg] = useState(null)
      const [urgeMsg, setUrgeMsg] = useState(null)
      const act = (p, body) => call(p, { method: 'POST', body })

      const humanCycles = humanQ.data?.items ?? []
      const agentCycles = agentQ.data?.items ?? []
      const dueSessions = reviewQ.data?.status?.dueSessions ?? []
      const reviewInterval = reviewQ.data?.status?.interval ?? null
      const bots = rosterQ.data?.bots ?? []

      /** 人类周期：创建（必须走五步，不许跳）。 */
      const createCycle = async () => {
        if (!taskId.trim() || !objective.trim()) { setMsg('任务 id 与目标都要填'); return }
        try {
          const r = await act('/cycles', { taskId: taskId.trim(), objective: objective.trim(), kind: 'human', by: 'ui' })
          setMsg(`长任务周期 ${r.cycle.id} 已开启（${PHASE_LABEL[r.cycle.phase]}）`)
          setTaskId(''); setObjective('')
          humanQ.reload()
        } catch (e) { setMsg(String(e)) }
      }

      /** 智能体周期：定期归纳用（一次性提交，自动闭环）。 */
      const createAgentCycle = async () => {
        if (!agentTaskId.trim() || !agentObjective.trim()) { setAgentMsg('任务 id 与归纳目标都要填'); return }
        try {
          const r = await act('/cycles', {
            taskId: agentTaskId.trim(),
            objective: agentObjective.trim(),
            kind: 'agent',
            by: 'ui',
          })
          setAgentMsg(`归纳周期 ${r.cycle.id} 已开启（kind=agent，可一次性提交）`)
          setAgentTaskId(''); setAgentObjective('')
          agentQ.reload()
        } catch (e) { setAgentMsg(String(e)) }
      }

      /**
       * 让它归纳（需求4）：把「该归纳了」变成一次真唤醒。
       *
       * 不给智能体开定时器（宿主生命周期不可控），也不让智能体自己改自己的纪律：
       * 这里只是**提醒它去走自己的归纳周期**，归纳出来的建议仍进建议队列等人采纳。
       */
      const urge = async (sessionId) => {
        try {
          const r = await act('/review/urge', { sessionId })
          const name = botName(bots, sessionId)
          setUrgeMsg(`已唤醒「${name}」去做归纳：它会开 kind=agent 周期并一次性提交，建议会进建议队列`)
          reviewQ.reload()
        } catch (e) {
          setUrgeMsg(`提醒「${botName(bots, sessionId)}」失败：${e.message}`)
        }
      }

      /** 推进阶段（仅 human 周期需要；agent 周期复盘后自动闭环）。 */
      const advance = async (c) => {
        const nextPhase = PHASES[PHASES.indexOf(c.phase) + 1]
        if (!nextPhase) return
        try {
          const r = await act('/cycles/advance', { id: c.id, expectedRev: c.rev, phase: nextPhase, by: 'ui' })
          setMsg(`长任务周期 ${c.id} → ${PHASE_LABEL[nextPhase]}`)
          humanQ.reload()
        } catch (e) { setMsg(String(e)) }
      }

      /** 检查（human 周期：人验货）。 */
      const check = async (c, result) => {
        try {
          const r = await act('/cycles/check', { id: c.id, expectedRev: c.rev, result, by: 'ui' })
          setMsg(`长任务周期 ${c.id} 检查 ${result}`)
          humanQ.reload()
        } catch (e) { setMsg(String(e)) }
      }

      /** 复盘（human 周期：留在 acting，人显式确认完成；agent 周期：一次性提交并自动闭环）。 */
      const doReview = async (c, isAgent) => {
        const lessons = reviewLessons.split('\n').filter(Boolean)
        const standards = reviewStandards.split('\n').filter(Boolean).map((line) => {
          const [title, content] = line.split('：').map((s) => s?.trim())
          return { scope: 'global', kind: 'rule', title: title || '未命名', content: content || '' }
        })
        try {
          const r = await act('/cycles/review', {
            id: c.id, expectedRev: c.rev, summary: reviewSummary, lessons, standards, by: 'ui',
          })
          if (isAgent) {
            setAgentMsg(`归纳周期 ${c.id} 已完成，提议 ${r.proposedCount} 条建议`)
            agentQ.reload()
          } else {
            setMsg(`长任务周期 ${c.id} 复盘完成，提议 ${r.proposedCount} 条标准化建议`)
            humanQ.reload()
          }
          setReviewSummary(''); setReviewLessons(''); setReviewStandards('')
        } catch (e) {
          if (isAgent) setAgentMsg(String(e))
          else setMsg(String(e))
        }
      }

      /** 周期卡片（human 与 agent 共用渲染，行为略有差异）。 */
      const renderCycle = (c, isAgent) => {
        const nextPhase = PHASES[PHASES.indexOf(c.phase) + 1]
        const isOpen = expanded === c.id
        const reviewMsg = isAgent ? agentMsg : msg
        return h('div', { key: c.id, className: 'csb-card', style: { marginBottom: 8 } },
          h('div', { className: 'csb-card-main' },
            h('div', { className: 'csb-card-t' },
              h('span', { className: `csb-b ${c.status === 'closed' ? 'csb-b-ok' : 'csb-b-run'}` }, PHASE_LABEL[c.phase] ?? c.phase),
              h('span', {
                className: 'csb-b csb-b-idle',
                style: { marginLeft: 6 },
                title: isAgent ? '智能体归纳周期（复盘可一次性提交）' : `${HUMAN_LABEL} 的长任务周期（五步不可跳）`,
              }, isAgent ? '归纳' : '长任务'),
              ` · ${c.taskId} · ${(c.objective ?? '').slice(0, 40)}`),
            h('div', { className: 'csb-card-m' },
              h('span', null, `状态 ${c.status}`),
              c.progress !== undefined ? h('span', null, ` · 进度 ${c.progress}%`) : null,
              c.rejectCount ? h('span', { className: 'csb-b csb-b-err' }, ` · 驳回 ${c.rejectCount} 次`) : null,
              c.review ? h('span', null, ' · 已复盘') : null)),

          // 操作区：human 周期有完整五步按钮；agent 周期只显示复盘（且复盘即闭环）
          h('div', { className: 'csb-bar', style: { flexWrap: 'wrap' } },
            // human 周期的逐步推进（agent 周期不需要：归纳完自动 done）
            isAgent ? null : nextPhase
              ? h('button', { className: 'csb-btn csb-btn-s', onClick: () => advance(c) }, `→ ${PHASE_LABEL[nextPhase]}`)
              : null,
            isAgent ? null : c.phase === 'checking'
              ? h('button', { className: 'csb-btn csb-btn-s csb-btn-ok', onClick: () => check(c, 'pass') }, '检查通过')
              : null,
            isAgent ? null : c.phase === 'checking'
              ? h('button', { className: 'csb-btn csb-btn-s csb-btn-err', onClick: () => check(c, 'reject') }, '打回')
              : null,
            // 复盘按钮：agent 周期在 acting 阶段直接显示「写归纳」（一次性提交）；human 周期仍需五步走完
            c.phase === 'acting'
              ? h('button', {
                  className: 'csb-btn csb-btn-s',
                  onClick: () => setExpanded(isOpen ? null : c.id),
                }, isOpen ? '收起复盘' : isAgent ? '写归纳' : '写复盘')
              : null),
          isOpen ? h('div', { style: { marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--dsw-alias-border)' } },
            h('div', { className: 'csb-hint', style: { marginBottom: 4 } }, isAgent ? '归纳总结（一次性提交）' : '复盘总结'),
            h('textarea', { className: 'csb-in', style: { width: '100%', minHeight: 60, boxSizing: 'border-box' }, placeholder: isAgent ? '这一轮归纳出了什么结论？' : '这个周期学到了什么？', value: reviewSummary, onChange: (e) => setReviewSummary(e.target.value) }),
            h('div', { className: 'csb-hint', style: { marginTop: 8, marginBottom: 4 } }, '经验教训（每行一条）'),
            h('textarea', { className: 'csb-in', style: { width: '100%', minHeight: 40, boxSizing: 'border-box' }, placeholder: '先写测试再写实现\n接口要先定契约', value: reviewLessons, onChange: (e) => setReviewLessons(e.target.value) }),
            h('div', { className: 'csb-hint', style: { marginTop: 8, marginBottom: 4 } }, '标准化建议（每行一条：标题：内容）'),
            h('textarea', { className: 'csb-in', style: { width: '100%', minHeight: 40, boxSizing: 'border-box' }, placeholder: 'TDD：先写测试再写实现', value: reviewStandards, onChange: (e) => setReviewStandards(e.target.value) }),
            h('button', {
              className: 'csb-btn csb-btn-s',
              style: { marginTop: 6 },
              onClick: () => doReview(c, isAgent),
            }, isAgent ? '提交归纳（自动完成）' : '提交复盘（提议建议）')) : null,
          reviewMsg ? h('div', { className: 'csb-notice csb-notice-ok', style: { marginTop: 4 } }, h('span', { className: 'csb-notice-t' }, reviewMsg)) : null)
      }

      return h('div', { className: 'csb-wrap' },
        h(Section, {
          title: 'PDCA 复盘周期',
          desc: 'PDCA 是给人的长任务做复盘跟进的，人类主导——五步不可跳，这正是「不自欺」的纪律。智能体有自己的归纳周期（周期驱动、自动闭环），折叠在下面。',
        }),

        // ── 我的长任务周期（human）────────────────────────────────────────────
        h('div', { className: 'csb-sec-t' }, `📋 ${HUMAN_LABEL} 的任务周期`),
        h('div', { className: 'csb-set-d' }, '为你的长任务开一个周期。目标原文是「防漂移锚」——复盘时拿它对照，看有没有走偏。'),
        h('div', { className: 'csb-bar', style: { marginTop: 8, flexWrap: 'wrap', gap: 6 } },
          h('input', { className: 'csb-in', style: { width: 120 }, placeholder: '任务 id（t-x）', value: taskId, onChange: (e) => setTaskId(e.target.value) }),
          h('input', { className: 'csb-in', style: { width: 260 }, placeholder: '目标原文（防漂移锚）', value: objective, onChange: (e) => setObjective(e.target.value) }),
          h('button', { className: 'csb-btn csb-btn-s', onClick: createCycle }, '开启周期')),
        msg ? h('div', { className: 'csb-notice csb-notice-ok', style: { marginTop: 8 } }, h('span', { className: 'csb-notice-t' }, msg)) : null,
        humanQ.error ? h('div', { className: 'csb-err' }, humanQ.error) : null,
        humanQ.loading ? h(Skeleton, { n: 3 }) : null,
        humanCycles.length === 0 && !humanQ.loading
          ? h(Empty, { icon: '🔄', title: '还没有长任务周期', hint: '输入任务 id 和目标，点「开启周期」开始。' })
          : h('div', { className: 'csb-list' }, humanCycles.map((c) => renderCycle(c, false))),

        // ── 智能体归纳周期（agent）────────────────────────────────────────────
        h('div', { className: 'csb-sec-t', style: { marginTop: 18 } }, '🤖 智能体归纳周期'),
        h('div', { className: 'csb-set-d' }, '智能体用来做定期归纳提升的周期。与人的周期不同：归纳是批量总结，可以一次性提交，提交后自动完成——不需要人点「完成」，也不需要假装走完五步。'),
        // 到期未归纳的会话：这是「定期归纳」真正被驱动的入口
        dueSessions.length > 0
          ? h('div', { className: 'csb-note', style: { marginTop: 8 } },
              h('div', { className: 'csb-set-d', style: { marginBottom: 6 } },
                `${dueSessions.length} 个会话已累计 ${reviewInterval ?? '?'} 回合以上没归纳了。`
                + '点「让它归纳」唤醒它：它会自己开归纳周期并一次性提交（建议进队列，不会自动改纪律）。'),
              h('div', { className: 'csb-list' },
                dueSessions.map((sid) =>
                  h('div', { key: sid, className: 'csb-card', style: { padding: '8px 10px' } },
                    h('div', { className: 'csb-card-main' },
                      h('div', { className: 'csb-card-t' }, botName(bots, sid)),
                      h('div', { className: 'csb-card-m csb-mono' }, short(sid, 22))),
                    h('button', { className: 'csb-btn csb-btn-s csb-btn-p', onClick: () => urge(sid) }, '让它归纳')))))
          : null,
        urgeMsg ? h('div', { className: 'csb-notice csb-notice-ok', style: { marginTop: 8 } }, h('span', { className: 'csb-notice-t' }, urgeMsg)) : null,
        agentCycles.length === 0
          ? h(Empty, { icon: '🧠', title: '智能体尚未开归纳周期', hint: '智能体通常自动创建归纳周期；如果你要手动触发，填任务 id 和归纳目标。' })
          : h('div', { className: 'csb-list' }, agentCycles.map((c) => renderCycle(c, true))),
        agentMsg ? h('div', { className: 'csb-notice csb-notice-ok', style: { marginTop: 8 } }, h('span', { className: 'csb-notice-t' }, agentMsg)) : null)
    }

    // ── 大/小团队（Teams）────────────────────────────────────────────────────
    /** 管理策略的中文名（与后端 TEAM_ADMIN_POLICIES 逐字对应，避免两边写死不一致）。 */
    const ADMIN_POLICY_LABEL = {
      'lead-only': '仅负责人可管理',
      'any-member': '成员可管理',
      'open': '不限制',
    }
    /** 下拉里的合法取值（顺序即页面顺序：安全 → 宽松 → 逃生阀）。 */
    const ADMIN_POLICY_KEYS = ['lead-only', 'any-member', 'open']
    /** 团队默认策略：人建的团队一律默认「仅负责人可管理」。 */
    const DEFAULT_ADMIN_POLICY = 'lead-only'
    /**
     * 团队页（需求3，2026-11-08 重做）。
     *
     * ## 用户的要求（原话）
     *   「用户创建的团队都是大团队，我当时的概念是大团队用户主导，小团队智能体自行负责，
     *     当前分层后，ui 页面正常只显示用户创建的团队，不需要大小团队的概念，
     *     用户可以跳转查看所有房间，其他的都是这个原则，团队成员应该可以选择，
     *     可以新建 bot，团队负责人要有标识」
     *
     * ## 由此确定的三条设计
     *
     * 1. **上层只显示「用户建的团队」**。智能体自建的小团队不再占用上层版面——
     *    它们是执行细节，要看请走「穿透」。所以本页 `list({ type:'big' })` 过滤，
     *    且 UI 上**完全不出现「大/小」字样**（用户明确说不需要这个概念）。
     *
     * 2. **成员是选择出来的，不是手抄 id**。手抄 36 位 UUID 必然出错（老实现的教训），
     *    所以改多选复选框 + 一键全选/清空。
     *
     * 3. **负责人（队长）必须有显式标识**。用「队长」徽章 + 名字前缀把负责人
     *    从成员列表里区分出来——用户要求「团队负责人要有标识」。
     *
     * ## 管理权限边界（需求：「管理员权限边界从页面控制」）
     *   团队以前没有「谁能管理团队」这个概念——任何人知道 id 就能调
     *   `/teams/remove` 把成员踢掉。现在策略是团队级设置 `adminPolicy`，由页面控制：
     *     - `lead-only`（默认）= 仅负责人可管理
     *     - `any-member`        = 成员可管理
     *     - `open`              = 不限制（逃生阀）
     *   卡片上显示当前策略的中文名 + 一个下拉直接切换（`POST /teams/policy`，带 CAS）。
     *   服务端还会独立执行一条不变量：**负责人（leadId）任何策略下都不能被移出**。
     *
     * ## 跳转房间（用户补充说明）
     *   「跳房间实质是可以穿透房间，看到团队成员的子团队工作内容，或者定向搜索查看，
     *     用户就是超级管理员」
     *   ⇒ 每个团队卡片上有「看房间」入口，跳到房间页并按团队名筛；
     *   房间页本身已支持列出全部房间 + 消息内容查看，超级管理员不受限制。
     */
    function TeamsTab({ onGoto }) {
      // 只取用户建的团队（big）；智能体自建的 small 不上上层
      const listQ = useApi('/teams?type=big', [])
      const rosterQ = useApi('/roster')
      const [name, setName] = useState('')
      const [leadId, setLeadId] = useState('')
      const [purpose, setPurpose] = useState('')
      const [selected, setSelected] = useState([])
      const [msg, setMsg] = useState(null)
      const [busy, setBusy] = useState(false)
      // 每个团队的行内「加成员」待选集合（teamId → 要加的 id 列表）
      const [pendingMembers, setPendingMembers] = useState({})
      // 管理策略：行内草稿（teamId → 下拉当前值）。策略切换是服务端 CAS 写操作，
      // onChange 直接发请求，草稿只用于「请求进行中先显示用户选的值」。
      const [pendingPolicy, setPendingPolicy] = useState({})
      // 策略切换的 toast（本页无 toast 组件，沿用行内 csb-notice + 定时消失）
      const [policyMsg, setPolicyMsg] = useState(null)
      // 定时器必须放 ref：组件每次渲染都会重建函数体，`let` 会被重置成 null，
      // 旧定时器就再也清不掉了（多次快速切换会留下幽灵定时器）。
      const policyTimerRef = useRef(null)
      useEffect(() => () => { if (policyTimerRef.current) clearTimeout(policyTimerRef.current) }, [])
      const flashPolicy = (text) => {
        setPolicyMsg(text)
        if (policyTimerRef.current) clearTimeout(policyTimerRef.current)
        policyTimerRef.current = setTimeout(() => setPolicyMsg(null), 3000)
      }
      const act = (p, body) => call(p, { method: 'POST', body })

      const teams = listQ.data?.items ?? []
      // 后端下发的合法策略（/teams 返回 policies）；万一旧后端没这个字段，就用本地常量兜底
      const policyKeys = listQ.data?.policies?.length ? listQ.data.policies : ADMIN_POLICY_KEYS
      const policyLabel = (key) => ADMIN_POLICY_LABEL[key] ?? `${key}（未知策略）`
      /** 下拉当前应该显示的值：优先行内草稿（用户正在切的），否则服务端的真实策略。 */
      const currentPolicy = (t) => pendingPolicy[t.id] ?? (t.adminPolicy ?? DEFAULT_ADMIN_POLICY)
      // 可用的 Bot（不含已退役）——成员与队长都从这里选
      const bots = (rosterQ.data?.bots ?? []).filter((b) => b.state !== 'retired')
      const botBySession = new Map(bots.map((b) => [b.sessionId, b]))

      const createTeam = async () => {
        if (!name.trim()) { setMsg('团队名必填'); return }
        if (!leadId) { setMsg('必须指定负责人（队长）'); return }
        setBusy(true)
        setMsg(null)
        try {
          const r = await act('/teams', {
            name: name.trim(),
            // 上层一律建「用户主导的团队」；内部类型沿用 big（智能体自建走 small，不在此页）
            type: 'big',
            leadId,
            purpose: purpose.trim() || undefined,
            memberIds: selected,
            // 人建的团队默认「仅负责人可管理」（服务端缺省是 open，为了不破坏既有调用面；
            // 页面是新入口，没有历史包袱，所以在这里给安全默认值）
            adminPolicy: DEFAULT_ADMIN_POLICY,
            by: 'ui',
          })
          setMsg(`团队「${r.team.name}」已创建（负责人：${botBySession.get(leadId)?.name ?? leadId}）`)
          setName(''); setLeadId(''); setPurpose(''); setSelected([])
          listQ.reload()
        } catch (e) { setMsg(String(e.message ?? e)) } finally { setBusy(false) }
      }

      const addMembers = async (t) => {
        const ids = (pendingMembers[t.id] ?? []).filter((id) => !(t.members ?? []).includes(id))
        if (ids.length === 0) { setMsg('先选要加入的 Bot'); return }
        setBusy(true); setMsg(null)
        try {
          let rev = t.rev
          for (const memberId of ids) {
            const r = await act('/teams/add', { id: t.id, expectedRev: rev, memberId, by: 'ui' })
            rev = r.team?.rev ?? rev + 1
          }
          setMsg(`已加入 ${ids.length} 个成员`)
          setPendingMembers((s) => ({ ...s, [t.id]: [] }))
          listQ.reload()
        } catch (e) { setMsg(String(e.message ?? e)) } finally { setBusy(false) }
      }

      const removeMember = async (t, memberId) => {
        setBusy(true); setMsg(null)
        try {
          await act('/teams/remove', { id: t.id, expectedRev: t.rev, memberId, by: 'ui' })
          setMsg(`已移出 ${botBySession.get(memberId)?.name ?? memberId}`)
          listQ.reload()
        } catch (e) { setMsg(String(e.message ?? e)) } finally { setBusy(false) }
      }

      const closeTeam = async (t) => {
        setBusy(true); setMsg(null)
        try {
          await act('/teams/close', { id: t.id, expectedRev: t.rev, by: 'ui' })
          setMsg(`团队「${t.name}」已关闭`)
          listQ.reload()
        } catch (e) { setMsg(String(e.message ?? e)) } finally { setBusy(false) }
      }

      /**
       * 切换「谁能管理这个团队」（需求：管理员权限边界从页面控制）。
       *
       * 用 CAS：带 expectedRev，别人刚改过就 409 打回，不静默覆盖。
       * 失败时把下拉复原成服务端的真实值（`pendingPolicy` 清掉），
       * 否则用户会以为已经改成功了 —— 那是最坏的静默失败。
       */
      const setAdminPolicy = async (t, policy) => {
        if (policy === currentPolicy(t)) return
        setPendingPolicy((s) => ({ ...s, [t.id]: policy }))
        setBusy(true); setMsg(null)
        try {
          const r = await act('/teams/policy', {
            id: t.id, expectedRev: t.rev, adminPolicy: policy, by: 'ui',
          })
          setPendingPolicy((s) => {
            const next = { ...s }
            delete next[t.id]
            return next
          })
          flashPolicy(`「${t.name}」的权限已改为：${policyLabel(r.adminPolicy ?? policy)}`)
          listQ.reload()
        } catch (e) {
          // 复原下拉：显示失败时绝不能让人以为改成功了
          setPendingPolicy((s) => {
            const next = { ...s }
            delete next[t.id]
            return next
          })
          setMsg(String(e.message ?? e))
        } finally { setBusy(false) }
      }

      /** Bot 多选器（成员/队长共用同一个数据源，交互不同）。 */
      const botPicker = (value, onChange, { multiple = false, placeholder = '选择…' } = {}) => {
        if (multiple) {
          return h('div', { className: 'csb-pick' },
            bots.length === 0
              ? h('div', { className: 'csb-set-d', style: { padding: '8px 4px' } }, '还没有可选的 Bot，先去「Bot 档案」新建')
              : bots.map((b) =>
                  h('label', { key: b.sessionId, className: 'csb-pick-i' },
                    h('input', {
                      type: 'checkbox',
                      checked: value.includes(b.sessionId),
                      onChange: (e) => {
                        const next = e.target.checked
                          ? [...value, b.sessionId]
                          : value.filter((x) => x !== b.sessionId)
                        onChange(next)
                      },
                    }),
                    h('span', null, b.name),
                    b.label ? h('span', { className: 'csb-set-d' }, `（${b.label}）`) : null)))
        }
        return h('select', { className: 'csb-sel', style: { width: 220 }, value, onChange: (e) => onChange(e.target.value) },
          h('option', { value: '' }, placeholder),
          bots.map((b) => h('option', { key: b.sessionId, value: b.sessionId }, `${b.name}${b.label ? `（${b.label}）` : ''}`)))
      }

      return h('div', { className: 'csb-wrap' },
        h(Section, {
          title: '团队',
          desc: '你创建的团队。每个团队有负责人（队长）、成员和讨论房间。'
            + '智能体自己组织的临时小组不在这里（点右上角「⚙ 穿透」可查）。',
        }),

        // ── 新建团队 ──────────────────────────────────────────────────────
        h('div', { className: 'csb-bar', style: { marginTop: 10, flexWrap: 'wrap', gap: 6 } },
          h('input', { className: 'csb-in', style: { width: 160 }, placeholder: '团队名', value: name, onChange: (e) => setName(e.target.value) }),
          botPicker(leadId, setLeadId, { placeholder: '选择负责人（队长）…' }),
          h('input', { className: 'csb-in', style: { width: 180 }, placeholder: '用途说明（可选）', value: purpose, onChange: (e) => setPurpose(e.target.value) }),
          h('button', { className: 'csb-btn csb-btn-s', onClick: () => onGoto?.('bots') }, '＋ 新建 Bot')),
        h('div', { className: 'csb-note', style: { marginTop: 8 } }, '团队成员（可多选，也可以建完再添）：'),
        botPicker(selected, setSelected, { multiple: true }),
        h('div', { className: 'csb-bar', style: { marginTop: 8 } },
          h('button', {
            className: 'csb-btn csb-btn-s',
            onClick: () => setSelected(bots.map((b) => b.sessionId)),
          }, '全选'),
          h('button', { className: 'csb-btn csb-btn-s', onClick: () => setSelected([]) }, '清空'),
          h('div', { className: 'csb-spacer' }),
          h('button', {
            className: 'csb-btn csb-btn-p csb-btn-s',
            disabled: busy || !name.trim() || !leadId,
            onClick: createTeam,
          }, busy ? '创建中…' : '创建团队')),

        // 策略切换的 toast：成功才出现，3 秒后自动消失（不挡住下面的团队卡片）
        policyMsg ? h('div', { className: 'csb-notice csb-notice-ok', style: { marginTop: 8 } },
          h('span', { className: 'csb-notice-t' }, policyMsg)) : null,
        msg ? h('div', { className: 'csb-notice csb-notice-ok', style: { marginTop: 8 } }, h('span', { className: 'csb-notice-t' }, msg)) : null,
        listQ.error ? h('div', { className: 'csb-err' }, listQ.error) : null,
        listQ.loading ? h(Skeleton, { n: 3 }) : null,

        // ── 团队列表 ──────────────────────────────────────────────────────
        teams.length === 0 && !listQ.loading
          ? h(Empty, {
              icon: '👥', title: '还没有团队',
              hint: '填团队名、选负责人，点「创建团队」开始。团队建好后可以加成员、看房间。',
            })
          : h('div', { className: 'csb-list' }, teams.map((t) => {
            const members = t.members ?? []
            const leadName = botBySession.get(t.leadId)?.name ?? (t.leadId ? short(t.leadId, 12) : '（未指定）')
            const pending = pendingMembers[t.id] ?? []
            const addable = bots.filter((b) => !members.includes(b.sessionId))
            return h('div', { key: t.id, className: 'csb-card', style: { flexDirection: 'column', alignItems: 'stretch', marginBottom: 8 } },
              h('div', { className: 'csb-card-main' },
                h('div', { className: 'csb-card-t' },
                  t.name,
                  t.status === 'closed' ? h('span', { className: 'csb-b csb-b-idle', style: { marginLeft: 8 } }, '已关闭') : null,
                  t.purpose ? h('span', { className: 'csb-set-d' }, ` · ${t.purpose.slice(0, 40)}`) : null),

                // 管理员权限边界（需求：管理员权限边界从页面控制）
                // 徽章：人要能一眼看出「谁能动这个团队」，所以常驻显示当前策略的中文名。
                h('div', { className: 'csb-card-m' },
                  h('span', { className: 'csb-b csb-b-idle', title: '谁能管理这个团队' },
                    '🔐 权限：',
                    policyLabel(currentPolicy(t)))),

                // 负责人标识（需求3：团队负责人要有标识）
                h('div', { className: 'csb-card-m' },
                  h('span', { className: 'csb-b csb-b-run', title: '团队负责人（队长）' }, '👑 负责人'),
                  h('span', { style: { fontWeight: 600 } }, leadName),
                  h('span', null, ` · 成员 ${members.length} 人`)),

                // 成员列表（负责人单独标出）
                members.length > 0
                  ? h('div', { className: 'csb-card-m', style: { flexWrap: 'wrap' } },
                      members.map((m) => {
                        const b = botBySession.get(m)
                        const isLead = m === t.leadId
                        return h('span', {
                          key: m,
                          className: 'csb-b',
                          style: isLead ? { fontWeight: 600 } : undefined,
                          title: isLead ? '负责人' : undefined,
                        }, `${isLead ? '👑 ' : ''}${b?.name ?? short(m, 12)}`)
                      }))
                  : h('div', { className: 'csb-set-d' }, '还没有成员')),

              // 操作区
              t.status === 'open'
                ? h('div', { style: { marginTop: 10 } },
                    // 管理策略切换（需求：管理员权限边界从页面控制）
                    h('div', { className: 'csb-bar', style: { marginBottom: 8 } },
                      h('span', { className: 'csb-set-d', style: { lineHeight: 2 } }, '谁能管理这个团队：'),
                      h('select', {
                        className: 'csb-sel',
                        style: { width: 160 },
                        value: currentPolicy(t),
                        onChange: (e) => setAdminPolicy(t, e.target.value),
                      }, policyKeys.map((key) =>
                        h('option', { key, value: key }, policyLabel(key))))),
                    // 加成员：Bot 多选
                    addable.length > 0
                      ? h('div', null,
                          h('div', { className: 'csb-pick', style: { maxHeight: 140 } },
                            addable.map((b) =>
                              h('label', { key: b.sessionId, className: 'csb-pick-i' },
                                h('input', {
                                  type: 'checkbox',
                                  checked: pending.includes(b.sessionId),
                                  onChange: (e) => {
                                    const next = e.target.checked
                                      ? [...pending, b.sessionId]
                                      : pending.filter((x) => x !== b.sessionId)
                                    setPendingMembers((s) => ({ ...s, [t.id]: next }))
                                  },
                                }),
                                h('span', null, b.name)))),
                          h('div', { className: 'csb-bar', style: { marginTop: 6 } },
                            h('button', {
                              className: 'csb-btn csb-btn-s', disabled: busy || pending.length === 0,
                              onClick: () => addMembers(t),
                            }, pending.length ? `加入 ${pending.length} 个` : '加入成员')))
                      : h('div', { className: 'csb-set-d' }, '所有 Bot 都已在这个团队里'),

                    // 成员移除（点 ×）
                    members.length > 0
                      ? h('div', { className: 'csb-card-m', style: { marginTop: 6 } },
                          h('span', { className: 'csb-set-d' }, '移出：'),
                          members.map((m) => {
                            const b = botBySession.get(m)
                            return h('button', {
                              key: m,
                              className: 'csb-btn csb-btn-s csb-btn-d',
                              style: { height: 24, fontSize: 11.5 },
                              disabled: busy,
                              onClick: () => removeMember(t, m),
                              title: m === t.leadId ? '这是负责人，移出后团队将没有负责人' : '移出这个成员',
                            }, `× ${b?.name ?? short(m, 10)}`)
                          }))
                      : null,

                    // 跳转房间（用户补充：可以穿透房间看子团队工作内容 / 定向搜索）
                    h('div', { className: 'csb-bar', style: { marginTop: 8 } },
                        h('button', {
                          className: 'csb-btn csb-btn-s',
                          title: '查看这个团队的讨论房间与成员工作内容',
                          // 必须带 sub:'rooms' —— safeGoTab 会把 'rooms' 映射成主页签 'team'，
                          // 不带 sub 就落到该页签的第一个子视图（Bot 档案），这就是
                          // 「点去房间却跳到 Bot 创建页」的真正原因。
                          onClick: () => onGoto?.('team', { sub: 'rooms', filter: t.name }),
                        }, '💬 看房间'),
                        h('button', {
                          className: 'csb-btn csb-btn-s',
                          onClick: () => onGoto?.('bots'),
                        }, '🤖 看 Bot'),
                        h('div', { className: 'csb-spacer' }),
                        h('button', {
                          className: 'csb-btn csb-btn-s csb-btn-d',
                          disabled: busy, onClick: () => closeTeam(t),
                        }, '关闭团队')))
                : null)
          })))
    }

    // ══════════════════════════════════════════════════════════════════════════
    // 团队工作区（需求4：每个团队在左侧栏有工作区的对应）
    // ══════════════════════════════════════════════════════════════════════════
    /**
     * ## 为什么是「页签」而不是原生左侧栏工作区
     *
     * 用户的诉求「每个团队在 DSH 主页面左侧栏有工作区的对应，或者对话」。
     * 实测官方宿主契约后，A 路（低成本、不动宿主）：
     *   - `sidebar.workspaces` 的 kind 是 **single**（单条目）——不能为每个团队注册一条，
     *     强行注册只会把官方会话树挤掉。B 路（每团队一条真实会话）需宿主配合，风险高，
     *     已列待验证，不在本次落地。
     *   - `sidebar.panellist` 的 kind 是 **list**（可多条），但它是左侧**图标按钮条**，
     *     不是工作区列表。
     *   ⇒ 落地方式：左栏点「◈ 协作平台」进面板 → 团队页签下的「工作区」，逐个团队展开
     *     成员 Bot + 各自工作目录 + 房间入口 + 最近任务。这是「能在左侧栏到达」的最小实现。
     *
     * ## 这一页解决什么（对照用户原话）
     *   「团队的管理员其实就是 router 进行分派管理」「可以穿透房间，看到团队成员的子团队工作内容」
     *   ⇒ 每个团队卡片展开后能看到：负责人标识、成员各自 cwd（点一下复制）、
     *     成员的最近任务与产出物线索、直达该团队房间的入口。
     */
    function TeamSpacesTab({ onGoto }) {
      const listQ = useApi('/teams?type=big', [])
      const rosterQ = useApi('/roster')
      // 补挂工作区（2026-11-09）：存量 Bot 的会话从没进过 Workspace，
      // 所以永远躺在左侧栏「未分组」。这里也给一个人能找到的入口 ——
      // 用户是在「工作区」页签找这个功能的，按钮不能只藏在「Bot 档案」里。
      const [attaching, setAttaching] = useState(false)
      const [attachMsg, setAttachMsg] = useState(null)
      const [expanded, setExpanded] = useState({})
      const [copied, setCopied] = useState(null)
      const copyTimerRef = useRef(null)
      useEffect(() => () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current) }, [])
      const reloadBots = () => { try { rosterQ.reload?.() } catch { /* 失败不影响补挂结果 */ } }

      const teams = listQ.data?.items ?? []
      const bots = (rosterQ.data?.bots ?? []).filter((b) => b.state !== 'retired')
      const botBySession = new Map(bots.map((b) => [b.sessionId, b]))

      const attachWorkspaces = async () => {
        setAttachMsg(null)
        setAttaching(true)
        try {
          const d = await call('/roster/attach-workspaces', { method: 'POST', body: {} })
          setAttachMsg({
            kind: d?.failed ? 'err' : 'ok',
            text: d?.note ?? `已挂 ${d?.attached ?? 0} / ${d?.total ?? 0}`,
          })
          reloadBots()
        } catch (e) {
          setAttachMsg({ kind: 'err', text: `补挂失败：${e.message}` })
        } finally {
          setAttaching(false)
        }
      }

      const copyPath = (p) => {
        try {
          navigator.clipboard?.writeText(p)
          setCopied(p)
          if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
          copyTimerRef.current = setTimeout(() => setCopied(null), 2000)
        } catch { /* 剪贴板不可用就算了，路径本身已经显示在页面上 */ }
      }

      /** 团队卡片：收起时一行摘要，展开时是完整工作区视图。 */
      const teamCard = (t) => {
        const open = expanded[t.id] === true
        const lead = botBySession.get(t.leadId)
        const memberBots = (t.members ?? []).map((m) => botBySession.get(m)).filter(Boolean)
        return h('div', { key: t.id, className: 'csb-set-c' },
          h('div', { className: 'csb-row', style: { alignItems: 'center' } },
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('div', { style: { fontWeight: 600 } },
                t.name,
                t.status === 'closed' ? h('span', { className: 'csb-set-d' }, ' （已关闭）') : null),
              h('div', { className: 'csb-set-d' },
                `负责人：${lead?.name ?? t.leadId ?? '（无）'}`,
                `　成员 ${memberBots.length} 个`)),
            h('button', {
              type: 'button',
              className: 'csb-btn csb-btn-s',
              onClick: () => setExpanded((s) => ({ ...s, [t.id]: !open })),
            }, open ? '收起' : '展开工作区')))

        if (!open) return null

        // 展开：负责人 + 每个成员的工作目录
        const rows = []
        if (lead) {
          rows.push(h('div', { key: `lead-${t.leadId}`, className: 'csb-row', style: { alignItems: 'center', paddingTop: 6 } },
            h('span', { className: 'csb-badge', style: { background: 'var(--csb-accent, #2d7ff9)', color: '#fff' } }, '负责人'),
            h('span', { style: { fontWeight: 600, marginLeft: 6 } }, lead.name),
            h('code', {
              className: 'csb-set-d',
              style: { marginLeft: 8, cursor: 'pointer', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              title: '点击复制工作目录',
              onClick: () => copyPath(lead.cwd ?? ''),
            }, copied === lead.cwd ? '✓ 已复制' : (lead.cwd ?? '（无工作目录）'))))
        }
        for (const b of memberBots) {
          rows.push(h('div', { key: `m-${b.sessionId}`, className: 'csb-row', style: { alignItems: 'center', paddingTop: 4 } },
            h('span', { className: 'csb-set-d', style: { width: 42 } }, '成员'),
            h('span', { style: { marginLeft: 6 } }, b.name),
            h('code', {
              className: 'csb-set-d',
              style: { marginLeft: 8, cursor: 'pointer', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              title: '点击复制工作目录',
              onClick: () => copyPath(b.cwd ?? ''),
            }, copied === b.cwd ? '✓ 已复制' : (b.cwd ?? '（无工作目录）'))))
        }
        if (rows.length === 0) {
          rows.push(h('div', { key: 'empty', className: 'csb-set-d', style: { paddingTop: 6 } },
            '这个团队还没有成员。去「团队」页加人，或到「Bot 档案」新建一个 Bot。'))
        }

        return h('div', { style: { paddingTop: 8 } },
          rows,
          h('div', { className: 'csb-row', style: { paddingTop: 10, gap: 8 } },
            h('button', {
              type: 'button', className: 'csb-btn csb-btn-s',
              onClick: () => onGoto?.('team', { sub: 'rooms', teamName: t.name }),
            }, '→ 看团队房间'),
            h('button', {
              type: 'button', className: 'csb-btn csb-btn-s',
              onClick: () => onGoto?.('team', { sub: 'teams' }),
            }, '→ 管理团队')))
      }

      return h('div', { className: 'csb-wrap' },
        h(Section, {
          title: '团队工作区',
          desc: '每个团队在这里有一个工作区：负责人、成员、各自的工作目录，以及直达房间的入口。'
            + '「点左侧 ◈ 协作平台 → 团队 → 工作区」即可到达。',
        },
          // 左侧栏「未分组」的根治按钮 —— 存量 Bot 的会话必须显式挂一次
          h('div', { className: 'csb-bar', style: { marginTop: 8, flexWrap: 'wrap' } },
            h('button', { className: 'csb-btn csb-btn-p', disabled: attaching, onClick: attachWorkspaces },
              attaching ? '补挂中…' : '把 Bot 会话挂进左侧栏工作区'),
            h('span', { className: 'csb-set-d' },
              '新建的 Bot 会自动挂；存量 Bot（改版前建的）点这里补挂一次，'
              + '它们的对话就会出现在左侧栏对应的工作目录分组里，而不是「未分组」')),
          attachMsg
            ? h(Notice, { kind: attachMsg.kind, onClose: () => setAttachMsg(null) }, attachMsg.text)
            : null,
          listQ.error
            ? h('div', { className: 'csb-notice csb-notice-err' }, `读取团队失败：${listQ.error.message ?? listQ.error}`)
            : null,
          teams.length === 0
            ? h('div', { className: 'csb-set-d', style: { padding: '12px 0' } },
                '还没有团队。去「团队」页建一个，这里就会出现它的工作区。')
            : teams.map(teamCard)))
    }

    // ── PDCA 测量（Metrics）───────────────────────────────────────────────────
    function MetricsTab() {
      const statsQ = useApi('/metrics', [])
      const aggQ = useApi('/metrics/aggregate', [])
      const stats = statsQ.data ?? {}
      const byKind = aggQ.data?.byKind ?? {}

      return h('div', { className: 'csb-wrap' },
        h(Section, {
          title: 'PDCA 测量',
          desc: 'PDCA 的「持续优化」没有测量就是空话。这里显示周期/吞吐/驳回率等指标。',
        }),
        h('div', { className: 'csb-kv', style: { marginTop: 10 } },
          h('div', { className: 'csb-kv-i' }, h('span', { className: 'csb-k' }, '总记录'), h('span', { className: 'csb-v' }, String(stats.total ?? 0))),
          h('div', { className: 'csb-kv-i' }, h('span', { className: 'csb-k' }, '事件流'), h('span', { className: 'csb-v' }, String(stats.events ?? 0))),
          h('div', { className: 'csb-kv-i' }, h('span', { className: 'csb-k' }, '首条时间'), h('span', { className: 'csb-v' }, aggQ.data?.firstAt ? new Date(aggQ.data.firstAt).toLocaleString('zh-CN') : '—')),
          h('div', { className: 'csb-kv-i' }, h('span', { className: 'csb-k' }, '末条时间'), h('span', { className: 'csb-v' }, aggQ.data?.lastAt ? new Date(aggQ.data.lastAt).toLocaleString('zh-CN') : '—'))),
        h(Section, { title: '按指标种类', desc: '每种指标各记了多少条。' },
          Object.keys(byKind).length === 0
            ? h(Empty, { title: '还没有测量记录' })
            : h('div', { className: 'csb-kv', style: { marginTop: 8 } },
                Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
                  h('div', { key: k, className: 'csb-kv-i' },
                    h('span', { className: 'csb-k' }, k),
                    h('span', { className: 'csb-v' }, String(v))))),
        h(Section, { title: '驳回率', desc: 'accept_reject / (accept_pass + accept_reject)：越低说明交付质量越高。' },
          h('div', { className: 'csb-kv', style: { marginTop: 8 } },
            h('div', { className: 'csb-kv-i' }, h('span', { className: 'csb-k' }, '验收通过'), h('span', { className: 'csb-v' }, String(byKind.accept_pass ?? 0))),
            h('div', { className: 'csb-kv-i' }, h('span', { className: 'csb-k' }, '验收驳回'), h('span', { className: 'csb-v csb-v-err' }, String(byKind.accept_reject ?? 0))),
            h('div', { className: 'csb-kv-i' }, h('span', { className: 'csb-k' }, '驳回率'),
              h('span', { className: 'csb-v' }, ((byKind.accept_reject ?? 0) + (byKind.accept_pass ?? 0)) === 0 ? '—' :
                `${Math.round((byKind.accept_reject ?? 0) / ((byKind.accept_reject ?? 0) + (byKind.accept_pass ?? 0)) * 100)}%`)),
          )),
        h('div', { className: 'csb-bar', style: { marginTop: 10 } },
          h('button', { className: 'csb-btn csb-btn-s', onClick: statsQ.reload }, '刷新测量'))))
    }

    // ── 数据（只读浏览）──────────────────────────────────────────────────────

    /**
     * 数据浏览 —— 让「数据库」看得见。
     *
     * cs-bots 的存储在零依赖约束下**不是 SQLite**，而是：
     *   事件流 `xxx.jsonl`（真相源，append-only）+ 快照 `xxx.snap.json`（加速恢复）。
     * 这一页把状态目录**直属**的 jsonl/json 文件列出来，点开看行。
     *
     * **只读**：写入一律走域服务的 CAS 校验，不提供任何写接口。
     * 安全：文件名/子目录走后端白名单（拒绝 `..` 穿越）。
     */
    function DataTab() {
      const PAGE = 50
      const [dir, setDir] = useState('')
      const [name, setName] = useState('')
      const [offset, setOffset] = useState(0)
      const filesQ = useApi(`/data/files${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`, [dir])
      const files = filesQ.data?.files ?? []
      const rowsPath = name
        ? `/data/rows?name=${encodeURIComponent(name)}${dir ? `&dir=${encodeURIComponent(dir)}` : ''}&limit=${PAGE}&offset=${offset}`
        : null
      const rowsQ = useApi(rowsPath, [name, dir, offset])
      const rows = rowsQ.data?.rows ?? []
      const total = rowsQ.data?.total ?? 0

      const fileList = h('div', { className: 'csb-list', style: { marginTop: 8 } },
        files.map((f) =>
          h('div', {
            key: f.name,
            className: `csb-card csb-card-c${name === f.name ? ' csb-card-on' : ''}`,
            onClick: () => { setName(f.name); setOffset(0) },
          },
            h('div', { className: 'csb-card-main' },
              h('div', { className: 'csb-card-t csb-mono' }, f.name),
              h('div', { className: 'csb-card-m' },
                h('span', null, `${f.bytes ?? 0} 字节`),
                f.kind === 'jsonl'
                  ? h('span', null, ` · ${f.lines === null ? '行数过多' : `${f.lines} 行`}`)
                  : h('span', null, ' · 快照'),
                f.truncated ? h('span', { className: 'csb-b csb-b-idle' }, ' · 已截断') : null)))))

      const rowList = h('div', { style: { maxHeight: 520, overflowY: 'auto', marginTop: 8 } },
        rows.map((r) =>
          h('div', { key: r._line, className: 'csb-card', style: { padding: '7px 9px', marginBottom: 5 } },
            h('div', { className: 'csb-card-m' },
              h('span', { className: 'csb-mono' }, `#${r._line}`),
              r._parseError ? h('span', { className: 'csb-b csb-b-err' }, 'JSON 解析失败') : null,
              r._truncated ? h('span', { className: 'csb-b csb-b-idle' }, '已截断') : null),
            h('pre', {
              className: 'csb-mono',
              style: { margin: '4px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 11.5 },
            }, r._raw))))

      const pager = h('div', { className: 'csb-bar', style: { marginTop: 8 } },
        h('button', {
          className: 'csb-btn csb-btn-s', disabled: offset <= 0,
          onClick: () => setOffset((o) => Math.max(0, o - PAGE)),
        }, '上一页'),
        h('span', { className: 'csb-set-d' },
          `${total ? offset + 1 : 0}-${Math.min(offset + PAGE, total)} / ${total}`),
        h('button', {
          className: 'csb-btn csb-btn-s', disabled: offset + PAGE >= total,
          onClick: () => setOffset((o) => o + PAGE),
        }, '下一页'))

      const right = !name
        ? h(Empty, { icon: '▤', title: '选一个文件', hint: '左侧点击任意文件，这里会按行显示内容（每行原始 JSON，最多 50 行/页）。' })
        : h('div', null,
            h(Section, { title: `内容 · ${name}`, desc: rowsQ.data?.note ?? ' ' }),
            rowsQ.error ? h('div', { className: 'csb-err' }, rowsQ.error) : null,
            rowsQ.loading ? h(Skeleton, { n: 3 }) : null,
            pager, rowList)

      return h('div', { className: 'csb-wrap' },
        h(Section, {
          title: '数据（只读）',
          desc: 'cs-bots 用 JSONL 事件流 + JSON 快照存储（零第三方依赖，不引入数据库）。'
            + '这里是只读浏览：写入一律走域服务与 CAS 校验，本页不提供任何写操作。',
        }),
        h('div', { className: 'csb-bar', style: { marginTop: 10, flexWrap: 'wrap' } },
          h('input', {
            className: 'csb-in', style: { width: 200 }, placeholder: '子目录（如 rooms / scratch，可空）',
            value: dir, onChange: (e) => { setDir(e.target.value.trim()); setName(''); setOffset(0) },
          }),
          h('button', { className: 'csb-btn csb-btn-s', onClick: filesQ.reload }, '刷新')),
        filesQ.error ? h('div', { className: 'csb-err' }, filesQ.error) : null,
        h('div', { className: 'csb-room-split', style: { marginTop: 12 } },
          h('div', { className: 'csb-room-side', style: { width: 320 } },
            h(Section, { title: '文件', desc: `状态目录：${filesQ.data?.stateDir ?? '—'}` }),
            filesQ.loading ? h(Skeleton, { n: 4 }) : null,
            !filesQ.loading && files.length === 0 ? h(Empty, { title: '没有可浏览的文件' }) : null,
            fileList),
          h('div', { className: 'csb-room-chat' }, right)))
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
    // ══════════════════════════════════════════════════════════════════════════════
    // 改造07：分层架构——6个上层页签 + 穿透入口
    //
    // 上层（人类协作层）：工作台/团队/记忆/技能库/数据/设置
    // 下层（AI基础设施层）：注册表/唤醒桥/存储/路由/验证/建议（穿透访问）
    // ══════════════════════════════════════════════════════════════════════════════
    const TABS = [
      {
        id: 'workspace', label: '工作台',
        subs: [
          { id: 'board', label: `${HUMAN_LABEL}的任务`, Comp: UserTasksTab },
          { id: 'ai-tasks', label: '智能体任务', Comp: AiTasksTab },
          { id: 'cycles', label: '复盘周期', Comp: CyclesTab },
          { id: 'todo', label: '我的待办', Comp: TodoTab },
          { id: 'scratch', label: '便签', Comp: ScratchTab },
          { id: 'artifacts', label: '成果', Comp: ArtifactsTab },
        ],
      },
      {
        id: 'team', label: '团队',
        subs: [
          { id: 'bots', label: 'Bot 档案', Comp: BotsTab },
          { id: 'teams', label: '团队', Comp: TeamsTab },
          // 需求4：每个团队在左侧栏有工作区的对应（A 路：面板内工作区页签）
          { id: 'teamspaces', label: '工作区', Comp: TeamSpacesTab },
          { id: 'rooms', label: '房间', Comp: RoomsTab },
        ],
      },
      {
        id: 'memory', label: '记忆',
        subs: [
          { id: 'facts', label: '事实与偏好', Comp: MemoryTab },
          { id: 'rules', label: '纪律与要求', Comp: DisciplineTab },
          { id: 'prompts', label: '提示词', Comp: PromptsTab },
        ],
      },
      {
        id: 'skills', label: '技能库',
        subs: [
          { id: 'skills', label: '技能', Comp: SkillsTab },
          { id: 'workflows', label: '工作流', Comp: WorkflowsTab },
        ],
      },
      {
        id: 'data', label: '数据',
        subs: [
          { id: 'files', label: '文件浏览', Comp: DataTab },
          { id: 'metrics', label: 'PDCA 测量', Comp: MetricsTab },
        ],
      },
      { id: 'settings', label: '设置', Comp: SettingsBody },
    ]

    /** 取某个页签的视图清单（单页页签返回 [自身]）。 */
    function viewsOf(tab) {
      return tab.subs && tab.subs.length ? tab.subs : [{ id: tab.id, label: tab.label, Comp: tab.Comp }]
    }

    // ══════════════════════════════════════════════════════════════════════════════
    // 改造07：穿透面板（下层 AI 基础设施查看/操作）
    // ══════════════════════════════════════════════════════════════════════════════

    /** 穿透面板区块列表（从 API 拉取） */
    function useDeepDive() {
      const [blocks, setBlocks] = useState([])
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      const reload = useCallback(() => {
        setLoading(true)
        call('/deepdive/blocks')
          .then((d) => { setBlocks(d.blocks ?? []); setError(null) })
          .catch((e) => setError(e.message))
          .finally(() => setLoading(false))
      }, [])
      useEffect(() => { reload() }, [reload])
      return { blocks, loading, error, reload }
    }

    /**
     * 穿透面板——右侧抽屉，显示 6 个下层区块。
     *
     * 每个区块：概览统计 + 操作按钮 + 展开详情。
     * 所有操作走 API，失败显示人话 + 下一步。
     */
    function DeepDivePanel({ onClose }) {
      const { blocks, loading, error, reload } = useDeepDive()
      const [expanded, setExpanded] = useState(null)
      const [detail, setDetail] = useState(null)
      const [detailLoading, setDetailLoading] = useState(false)
      const [detailError, setDetailError] = useState(null)
      const [opBusy, setOpBusy] = useState(null)
      const [opMsg, setOpMsg] = useState(null)

      const openBlock = async (id) => {
        if (expanded === id) {
          setExpanded(null)
          setDetail(null)
          return
        }
        setExpanded(id)
        setDetail(null)
        setDetailError(null)
        setDetailLoading(true)
        try {
          const d = await call(`/deepdive/block/${encodeURIComponent(id)}`)
          setDetail(d)
        } catch (e) {
          setDetailError(e.message)
        } finally {
          setDetailLoading(false)
        }
      }

      const doOp = async (blockId, op, body) => {
        setOpBusy(`${blockId}:${op}`)
        setOpMsg(null)
        try {
          const d = await call(`/deepdive/op`, { method: 'POST', body: { block: blockId, op, ...body } })
          setOpMsg({ ok: true, text: d.text ?? '操作成功' })
          reload()
          if (op === 'replay') openBlock(blockId)
        } catch (e) {
          setOpMsg({ ok: false, text: e.message })
        } finally {
          setOpBusy(null)
        }
      }

      // 数据条目渲染（避免深嵌套三元）
      const renderEntry = ([k, v]) =>
        h('div', { key: k, style: { marginBottom: 8 } },
          h('div', { className: 'csb-field-l' }, k),
          h('pre', { className: 'csb-pre' },
            typeof v === 'string' ? v : JSON.stringify(v, null, 2)))

      // 操作按钮渲染
      const renderOps = (list) =>
        list && list.length > 0
          ? h('div', { style: { marginTop: 12 } },
              h('div', { className: 'csb-field-l' }, '操作'),
              list.map((op) => {
                const busy = opBusy === `${expanded}:${op.id}`
                return h('button', {
                  key: op.id,
                  className: 'csb-btn csb-btn-s',
                  disabled: busy,
                  onClick: () => doOp(expanded, op.id, op.body ?? {}),
                }, busy ? '…' : (op.label ?? op.id))
              }))
          : null

      // 展开详情区块
      const renderDetail = () => {
        if (detailLoading) return h(Skeleton, { n: 3 })
        if (detailError) return h('div', { className: 'csb-err' }, detailError)
        if (!detail) return null
        return h('div', null,
          Object.entries(detail.data ?? {}).map(renderEntry),
          renderOps(detail.operations))
      }

      return h(Drawer, {
        title: '底层工具',
        onClose,
        footer: [
          h('div', { key: 's', className: 'csb-spacer' }),
          h('button', { key: 'c', className: 'csb-btn', onClick: onClose }, '关闭'),
        ],
      },
        loading ? h(Skeleton, { n: 4 }) : null,
        error ? h('div', { className: 'csb-err' }, `穿透面板加载失败：${error}`) : null,
        blocks.length === 0 && !loading
          ? h(Empty, { icon: '🔧', title: '没有底层区块', hint: '可能后端尚未暴露穿透接口' })
          : null,
        blocks.map((b) => {
          const stats = h('div', { className: 'csb-card-m' },
            Object.entries(b.stats ?? {}).map(([k, v]) =>
              h('span', { key: k, className: 'csb-b' }, `${k}: ${v}`)))
          const head = h('div', { className: 'csb-card', style: { cursor: 'pointer' }, onClick: () => openBlock(b.id) },
            h('div', { className: 'csb-card-main' },
              h('div', { className: 'csb-card-t2' }, h('strong', null, b.label ?? b.id)),
              b.description ? h('div', { className: 'csb-card-m' }, b.description) : null,
              stats),
            h('span', { className: 'csb-btn-x' }, expanded === b.id ? '▾' : '▸'))
          const body = expanded === b.id
            ? h('div', { style: { marginTop: 8, padding: '0 4px' } },
                renderDetail(),
                opMsg ? h('div', { className: opMsg.ok ? 'csb-ok' : 'csb-err', style: { marginTop: 8 } }, opMsg.text) : null)
            : null
          return h('div', { key: b.id, style: { marginBottom: 14 } }, head, body)
        }))
    }

    function Workbench() {
      const [tab, setTab] = useState('workspace')
      const [view, setView] = useState(null)
      // 跨页签定位参数（契约 §3.2 第 6 条）：`onGoto('team', { roomId, seq })`
      // 由 goTab 的第二参数带入，RoomsTab 据此选中房间并高亮/滚动到那条消息。
      const [locate, setLocate] = useState(null)
      // 改造07：穿透面板开关
      const [deepOpen, setDeepOpen] = useState(false)
      const current = TABS.find((t) => t.id === tab) ?? TABS[0]
      const views = viewsOf(current)
      const activeView = views.find((v) => v.id === view) ?? views[0]
      const Comp = activeView.Comp

      // 切主页签时把子视图重置为该页签的第一个
      const goTab = (id, opts) => {
        setTab(id)
        setView(null)
        // 定位参数：带 roomId（精确定位一条消息）或带 filter（需求3：定向筛房间）
        setLocate(
          opts && typeof opts === 'object' && (opts.roomId || opts.filter) ? opts : null,
        )
        // 需求4：工作区页签里「看团队房间 / 管理团队」要精确落到子页签
        // （opts.sub = 'rooms' | 'teams'）。只在目标页签确实有这个子视图时才设。
        if (opts && typeof opts === 'object' && typeof opts.sub === 'string') {
          const next = TABS.find((t) => t.id === id)
          const sub = next?.subs?.find((v) => v.id === opts.sub)
          if (sub) setView(sub.id)
        }
      }

      // 兼容旧 goTab 调用：'tasks' → 'workspace', 'bots' → 'team'
      const safeGoTab = (id, opts) => {
        const mapped = ({
          tasks: 'workspace', bots: 'team', rooms: 'team', teams: 'team', artifacts: 'workspace',
        })[id] ?? id
        goTab(mapped, opts)
      }

      return h('div', { className: 'csb' },
        h('div', { className: 'csb-head' },
          h('div', { className: 'csb-hrow' },
            h('h2', null, '协作平台'),
            h('span', { className: 'csb-hint' }, '任务 · 团队 · 记忆 · 技能 · 数据 · 设置'),
            // 改造07：穿透入口（顶部右侧齿轮）
            h('button', {
              className: 'csb-btn csb-btn-s',
              title: '底层工具（AI 基础设施）',
              onClick: () => setDeepOpen(true),
            }, '⚙ 穿透')),
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
            h(Comp, {
              key: `${current.id}:${activeView.id}`,
              onGoto: safeGoTab,
              // 只给房间页签传定位参数（其它页签不消费，传了也无害，但语义要清楚）
              locate: current.id === 'team' && activeView.id === 'rooms' ? locate : undefined,
            })),
          deepOpen ? h(DeepDivePanel, { onClose: () => setDeepOpen(false) }) : null))
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
    exports.ArtifactsTab = ArtifactsTab
    exports.DataTab = DataTab
    exports.MemoryTab = MemoryTab
    exports.SkillsTab = SkillsTab
    exports.WorkflowsTab = WorkflowsTab
    exports.SettingsBody = SettingsBody
    exports.TodoTab = TodoTab
    exports.ScratchTab = ScratchTab
    exports.PromptsTab = PromptsTab
    exports.DisciplineTab = DisciplineTab
    exports.BotProfileDrawer = BotProfileDrawer
    // 改造06（CONTRACT-bots06 §3）：TaskDrawer 交付物预览（需求3）—— 前端测试与跨页签复用都需要它
    exports.TaskDrawer = TaskDrawer
    exports.DirPicker = DirPicker
    exports.Modal = Modal
    exports.ConfirmModal = ConfirmModal
    // 改造04（CONTRACT-bots04 §3）：派活 / 补充说明 / 目标锚 / 房间建任务
    exports.TaskAnchorPanel = TaskAnchorPanel
    exports.BotAssignModal = BotAssignModal
    exports.BotMessageModal = BotMessageModal
    exports.RoomTaskCreateModal = RoomTaskCreateModal
    exports.CollapsibleText = CollapsibleText
    exports.WakeNotice = WakeNotice
    exports.wakeLabel = wakeLabel
    // 改造05（CONTRACT-bots05 §3）：唤醒失败可操作化 / 会话启动
    exports.wakeReasonText = wakeReasonText
    exports.resolveOwnerBot = resolveOwnerBot
    exports.reviveSession = reviveSession
    exports.reviveResultText = reviveResultText
    exports.reviveAllText = reviveAllText
    // 改造06（CONTRACT-bots06 §3）：任务变更中心 / 换负责人
    exports.TaskEvolvePanel = TaskEvolvePanel
    exports.TaskReassignModal = TaskReassignModal
    exports.EvolveHistory = EvolveHistory
    exports.postEvolve = postEvolve
    exports.postReassign = postReassign
    exports.evolveActionLabel = evolveActionLabel
    exports.evolveChangeText = evolveChangeText
    exports.reassignWakeText = reassignWakeText
    // 改造07：分层架构——穿透面板 + 6 上层页签
    exports.DeepDivePanel = DeepDivePanel
    exports.TABS = TABS
    exports.AiTasksTab = AiTasksTab
    exports.UserTasksTab = UserTasksTab
    // 需求2：任务对话面板（进度 + 对话内容 + 去对话）
    exports.TaskConversationPanel = TaskConversationPanel
    // 需求4：PDCA 周期页（human / agent 两类周期）
    exports.CyclesTab = CyclesTab
    // 需求3：团队页（只显示用户建的大团队）
    exports.TeamsTab = TeamsTab
    exports.PANEL_ID = PANEL_ID
    exports.API = API

    return module.exports
  },
})
