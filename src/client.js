/**
 * cs-bots /client —— Web 页面层（L3）。
 *
 * 结构（照 `cs-bot-bea` 已验证的官方契约）：
 *   - 入口：`sidebar.panellist`（list 型，与官方 Plugins 同级）
 *   - 主面板：`main`（**keyed**，key 必须等于入口 id）
 *   - **注册顺序锁死：先 main 后 panellist**（`selectPanel(id)` 会校验 main 存在，否则抛错）
 *
 * 纪律：
 *   - **单文件、无相对 require**（浏览器端模块装载不支持相对路径）
 *   - **每个 Tab 单独包 ErrorBoundary**（一处炸不连累整页 —— 这是历史白屏事故的根因）
 *   - **只消费 `/cs-bots/api` 的公开读 API**，绝不直读文件
 *   - 数据来自 HTTP，不在客户端做业务判断
 */

window.__ModuleLoader__.load({
  id: 'cs-bots',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const PANEL_ID = 'cs-bots'
    const API = '/cs-bots/api'
    const NS = 'cs-bots'

    // ── 请求工具 ─────────────────────────────────────────────────────────────

    async function call(path, options) {
      const res = await fetch(API + path, {
        headers: { accept: 'application/json', ...(options?.body ? { 'content-type': 'application/json' } : {}) },
        cache: 'no-store',
        ...options,
        ...(options?.body ? { body: JSON.stringify(options.body) } : {}),
      })
      let data
      try {
        data = await res.json()
      } catch {
        throw new Error(`接口返回非 JSON（HTTP ${res.status}）`)
      }
      if (!data || data.ok === false) {
        throw new Error(data?.reason ?? data?.message ?? `HTTP ${res.status}`)
      }
      return data
    }

    // ── 样式（一次性注入，带 data-plugin 标记便于清理）─────────────────────────

    function installStyles() {
      if (typeof document === 'undefined') return
      const tagId = 'cs-bots/styles'
      if (document.querySelector(`style[data-plugin-css="${tagId}"]`)) return
      const style = document.createElement('style')
      style.dataset.plugin = NS
      style.dataset.pluginCss = tagId
      style.textContent = [
        '.csb-root{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px}',
        '.csb-tabs{display:flex;gap:4px;padding:8px 12px 0;border-bottom:1px solid var(--dsw-alias-border-l2,#e5e5e5);flex:none}',
        '.csb-tab{padding:6px 12px;border:0;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary,#666);border-radius:6px 6px 0 0;font-size:13px}',
        '.csb-tab:hover{background:var(--dsw-alias-bg-layer-2,#f5f5f5)}',
        '.csb-tab-on{color:var(--dsw-alias-label-primary,#111);background:var(--dsw-alias-bg-layer-2,#f5f5f5);font-weight:500}',
        '.csb-body{flex:1;overflow:auto;padding:12px;min-height:0}',
        '.csb-row{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#e5e5e5);margin-bottom:6px}',
        '.csb-row:hover{border-color:var(--dsw-alias-border-l3,#ccc)}',
        '.csb-grow{flex:1;min-width:0}',
        '.csb-title{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.csb-meta{color:var(--dsw-alias-label-tertiary,#999);font-size:11px;margin-top:2px}',
        '.csb-btn{border:1px solid var(--dsw-alias-border-l2,#e5e5e5);background:transparent;border-radius:6px;padding:3px 8px;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary,#666)}',
        '.csb-btn:hover{background:var(--dsw-alias-bg-layer-2,#f5f5f5);color:var(--dsw-alias-label-primary,#111)}',
        '.csb-btn-primary{background:var(--dsw-alias-state-business-primary,#3b82f6);color:#fff;border-color:transparent}',
        '.csb-input,.csb-textarea,.csb-select{width:100%;box-sizing:border-box;padding:6px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#e5e5e5);background:transparent;color:inherit;font-size:13px;font-family:inherit}',
        '.csb-textarea{min-height:56px;resize:vertical}',
        '.csb-err{color:var(--dsw-alias-state-error-primary,#dc2626);padding:10px;border-radius:8px;background:rgba(220,38,38,.08)}',
        '.csb-empty{color:var(--dsw-alias-label-tertiary,#999);padding:24px 8px;text-align:center}',
        '.csb-badge{font-size:10px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#e5e5e5);color:var(--dsw-alias-label-tertiary,#999)}',
        '.csb-badge-run{color:#b45309;border-color:rgba(245,158,11,.33);background:rgba(245,158,11,.07)}',
        '.csb-badge-done{color:#15803d;border-color:rgba(34,197,94,.33);background:rgba(34,197,94,.07)}',
        '.csb-badge-del{color:#b91c1c;border-color:rgba(239,68,68,.33);background:rgba(239,68,68,.07)}',
        '.csb-bar{display:flex;gap:6px;margin-bottom:10px;align-items:center}',
        '.csb-pre{white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,monospace;font-size:12px;background:var(--dsw-alias-bg-layer-2,#f5f5f5);padding:8px;border-radius:6px;max-height:320px;overflow:auto}',
        '.csb-msg{padding:6px 8px;border-radius:6px;margin-bottom:4px}',
        '.csb-msg-user{background:rgba(59,130,246,.1)}',
        '.csb-label{color:var(--dsw-alias-label-tertiary,#999);font-size:11px;margin:6px 0 2px}',
        '.csb-drawer{position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;justify-content:flex-end;z-index:60}',
        '.csb-drawer-body{width:min(560px,100vw);height:100%;overflow:auto;background:var(--dsw-specific-menu,#fff);padding:16px;box-sizing:border-box}',
        '.csb-drawer-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}',
        '.csb-kv{display:grid;grid-template-columns:120px 1fr;gap:4px 10px;font-size:12px;margin:8px 0}',
        '.csb-k{color:var(--dsw-alias-label-tertiary,#999)}',
        '.csb-sec{border-top:1px solid var(--dsw-alias-border-l2,#e5e5e5);margin-top:12px;padding-top:10px}',
        '.csb-field{display:flex;gap:6px;align-items:center;margin-bottom:6px}',
        '.csb-field label{width:130px;flex:none;font-size:12px;color:var(--dsw-alias-label-secondary,#666)}',
      ].join('')
      document.head.appendChild(style)
    }

    // ── ErrorBoundary（**每个 Tab 单独包一层**）─────────────────────────────────

    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error: error }
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
            `「${this.props.tab}」渲染失败：`,
            String(this.state.error.message || this.state.error),
            h(
              'button',
              { className: 'csb-btn', style: { marginLeft: 8 }, onClick: () => this.setState({ error: null }) },
              '重试',
            ),
          )
        }
        return this.props.children
      }
    }

    // ── 通用 ─────────────────────────────────────────────────────────────────

    function useApi(path, deps) {
      const [state, setState] = useState({ loading: true, data: null, error: null })
      const reload = useCallback(() => {
        let alive = true
        setState((s) => ({ ...s, loading: true, error: null }))
        call(path)
          .then((data) => {
            if (alive) setState({ loading: false, data, error: null })
          })
          .catch((error) => {
            if (alive) setState({ loading: false, data: null, error: error.message })
          })
        return () => {
          alive = false
        }
      }, [path])
      useEffect(() => {
        const cancel = reload()
        return cancel
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [reload, ...(deps ?? [])])
      return { ...state, reload }
    }

    function Empty({ text }) {
      return h('div', { className: 'csb-empty' }, text)
    }

    function StatusBadge({ status }) {
      const cls =
        status === 'in_progress'
          ? 'csb-badge csb-badge-run'
          : status === 'completed'
            ? 'csb-badge csb-badge-done'
            : status === 'deleted'
              ? 'csb-badge csb-badge-del'
              : 'csb-badge'
      return h('span', { className: cls }, status)
    }

    // ── Tab 1：任务中心 ──────────────────────────────────────────────────────

    // 任务详情抽屉（穿透）：看全量字段 + 审计流 + 管理动作
    function TaskDrawer({ id, onClose, onChange, bots }) {
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

      return h(
        'div',
        { className: 'csb-drawer', onClick: (e) => e.target === e.currentTarget && onClose() },
        h(
          'div',
          { className: 'csb-drawer-body' },
          h(
            'div',
            { className: 'csb-drawer-head' },
            h('strong', { style: { flex: 1 } }, task?.subject ?? id),
            h('button', { className: 'csb-btn', onClick: onClose }, '关闭'),
          ),
          loading ? h(Empty, { text: '加载中…' }) : null,
          error ? h('div', { className: 'csb-err' }, error) : null,
          err ? h('div', { className: 'csb-err' }, err) : null,
          task
            ? h(
                'div',
                null,
                h(
                  'div',
                  { className: 'csb-kv' },
                  h('span', { className: 'csb-k' }, 'ID'), h('span', null, task.id),
                  h('span', { className: 'csb-k' }, '状态'), h('span', null, h(StatusBadge, { status: task.status })),
                  h('span', { className: 'csb-k' }, 'rev'), h('span', null, String(task.rev)),
                  h('span', { className: 'csb-k' }, '负责人'), h('span', null, task.ownerId ?? '—'),
                  h('span', { className: 'csb-k' }, '租约至'), h('span', null, task.lease ? new Date(task.lease.expiresAt).toLocaleString() : '—'),
                  h('span', { className: 'csb-k' }, '依赖'), h('span', null, (task.blockedBy ?? []).join(', ') || '—'),
                  h('span', { className: 'csb-k' }, '写入范围'), h('span', null, (task.writeScopes ?? []).join(', ') || '—'),
                  h('span', { className: 'csb-k' }, '交付物'), h('span', null, (task.artifacts ?? []).join(', ') || '—'),
                  h('span', { className: 'csb-k' }, '验收'), h('span', null, task.acceptance ? `${task.acceptance.result} by ${task.acceptance.by}` : '—'),
                  h('span', { className: 'csb-k' }, '终止原因'), h('span', null, task.blockedReason ?? '—'),
                ),
                task.description ? h('div', { className: 'csb-pre' }, task.description) : null,

                h('div', { className: 'csb-sec' }, h('div', { className: 'csb-label' }, '管理动作')),
                h(
                  'div',
                  { className: 'csb-bar', style: { flexWrap: 'wrap' } },
                  // 指派：选一个已注册 Bot
                  h(
                    'select',
                    {
                      className: 'csb-select',
                      style: { width: 180 },
                      defaultValue: '',
                      onChange: (e) => {
                        const ownerId = e.target.value
                        if (!ownerId) return
                        act(
                          () =>
                            call('/tasks/assign', {
                              method: 'POST',
                              body: { id: task.id, expectedRev: task.rev, ownerId },
                            }),
                          '指派',
                        )
                        e.target.value = ''
                      },
                    },
                    h('option', { value: '' }, '指派给 Bot…'),
                    (bots ?? []).filter((b) => b.state !== 'retired').map((b) =>
                      h('option', { key: b.id, value: b.sessionId }, `${b.name}（${b.state}）`),
                    ),
                  ),
                  task.status === 'in_progress'
                    ? h('button', { className: 'csb-btn', onClick: () => act(() => call('/tasks/update', { method: 'POST', body: { id: task.id, expectedRev: task.rev, action: 'complete', artifacts: (window.prompt('交付物路径（逗号分隔）') ?? '').split(',').map((x) => x.trim()).filter(Boolean) } }), '完成') }, '完成')
                    : null,
                  task.status === 'in_progress'
                    ? h('button', { className: 'csb-btn', onClick: () => act(() => call('/tasks/update', { method: 'POST', body: { id: task.id, expectedRev: task.rev, action: 'heartbeat' } }), '续租') }, '续租')
                    : null,
                  h('button', {
                    className: 'csb-btn',
                    onClick: () => {
                      const reason = window.prompt('终止原因', '用户终止')
                      if (reason === null) return
                      act(() => call('/tasks/abort', { method: 'POST', body: { id: task.id, expectedRev: task.rev, reason } }), '终止')
                    },
                  }, '终止'),
                  task.status === 'blocked'
                    ? h('button', { className: 'csb-btn', onClick: () => act(() => call('/tasks/update', { method: 'POST', body: { id: task.id, expectedRev: task.rev, action: 'reopen' } }), '重开') }, '重开')
                    : null,
                  h('button', {
                    className: 'csb-btn',
                    onClick: () => {
                      const s2 = window.prompt('新标题', task.subject)
                      if (!s2) return
                      act(() => call('/tasks/edit', { method: 'POST', body: { id: task.id, expectedRev: task.rev, subject: s2 } }), '改标题')
                    },
                  }, '改标题'),
                  task.status !== 'deleted'
                    ? h('button', {
                        className: 'csb-btn',
                        onClick: () => {
                          if (window.confirm('删除（tombstone，可审计不可恢复列表）？')) {
                            act(() => call('/tasks/update', { method: 'POST', body: { id: task.id, expectedRev: task.rev, action: 'delete' } }), '删除')
                          }
                        },
                      }, '删除')
                    : null,
                ),

                h('div', { className: 'csb-sec' }, h('div', { className: 'csb-label' }, `审计流（${history.length} 条）`)),
                history.slice(-30).reverse().map((ev, i) =>
                  h('div', { key: i, className: 'csb-row', style: { fontSize: 11 } },
                    h('div', { className: 'csb-grow' },
                      h('div', null, `${ev.action} · rev ${ev.rev} · ${ev.byId ?? '?'}`),
                      h('div', { className: 'csb-meta' }, ev.at ? new Date(ev.at).toLocaleString() : ''),
                    ),
                  ),
                ),
              )
            : null,
        ),
      )
    }

    function TasksTab() {
      const [filter, setFilter] = useState('')
      const { data, loading, error, reload } = useApi(`/tasks${filter ? `?status=${filter}` : ''}`, [filter])
      const [subject, setSubject] = useState('')
      const [busy, setBusy] = useState(false)
      const [actionError, setActionError] = useState(null)
      const [openId, setOpenId] = useState(null)
      const { data: rosterData } = useApi('/roster')
      const bots = rosterData?.bots ?? []

      const doCreate = async () => {
        const s = subject.trim()
        if (!s) return
        setBusy(true)
        setActionError(null)
        try {
          await call('/tasks', { method: 'POST', body: { subject: s } })
          setSubject('')
          reload()
        } catch (e) {
          setActionError(e.message)
        } finally {
          setBusy(false)
        }
      }

      const doUpdate = async (task, action, extra) => {
        setBusy(true)
        setActionError(null)
        try {
          await call('/tasks/update', {
            method: 'POST',
            body: { id: task.id, expectedRev: task.rev, action, ...(extra ?? {}) },
          })
          reload()
        } catch (e) {
          setActionError(e.message)
        } finally {
          setBusy(false)
        }
      }

      const tasks = data?.tasks ?? []

      return h(
        'div',
        null,
        h(
          'div',
          { className: 'csb-bar' },
          h('input', {
            className: 'csb-input',
            placeholder: '新建任务标题…',
            value: subject,
            onChange: (e) => setSubject(e.target.value),
            onKeyDown: (e) => e.key === 'Enter' && doCreate(),
          }),
          h('button', { className: 'csb-btn csb-btn-primary', disabled: busy, onClick: doCreate }, '新建'),
          h(
            'select',
            { className: 'csb-select', style: { width: 120 }, value: filter, onChange: (e) => setFilter(e.target.value) },
            h('option', { value: '' }, '全部'),
            h('option', { value: 'pending' }, '待办'),
            h('option', { value: 'in_progress' }, '进行中'),
            h('option', { value: 'completed' }, '已完成'),
            h('option', { value: 'blocked' }, '阻塞'),
          ),
        ),
        actionError ? h('div', { className: 'csb-err' }, actionError) : null,
        loading ? h(Empty, { text: '加载中…' }) : null,
        error ? h('div', { className: 'csb-err' }, error) : null,
        !loading && !error && tasks.length === 0 ? h(Empty, { text: '还没有任务' }) : null,
        tasks.map((t) =>
          h(
            'div',
            { key: t.id, className: 'csb-row' },
            h(
              'div',
              {
                className: 'csb-grow',
                style: { cursor: 'pointer' },
                onClick: () => setOpenId(t.id),
                title: '点击查看详情',
              },
              h('div', { className: 'csb-title' }, t.subject),
              h(
                'div',
                { className: 'csb-meta' },
                `${t.id} · rev ${t.rev} · `,
                h(StatusBadge, { status: t.status }),
                t.ownerId ? ` · ${t.ownerId}` : '',
                (t.blockedBy ?? []).length ? ` · 依赖 ${t.blockedBy.length}` : '',
              ),
            ),
            t.status === 'pending'
              ? h('button', { className: 'csb-btn', disabled: busy, onClick: () => doUpdate(t, 'claim') }, '领取')
              : null,
            t.status === 'in_progress'
              ? h(
                  'button',
                  {
                    className: 'csb-btn',
                    disabled: busy,
                    onClick: () => {
                      const artifacts = window.prompt('交付物路径（逗号分隔，必填）')
                      if (artifacts === null) return
                      const list = artifacts
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean)
                      if (!list.length) {
                        setActionError('artifacts 不能为空')
                        return
                      }
                      doUpdate(t, 'complete', { artifacts: list })
                    },
                  },
                  '完成',
                )
              : null,
            t.status === 'completed'
              ? h(
                  'button',
                  {
                    className: 'csb-btn',
                    disabled: busy,
                    onClick: () =>
                      call('/tasks/accept', { method: 'POST', body: { id: t.id, result: 'pass' } })
                        .then(reload)
                        .catch((e) => setActionError(e.message)),
                  },
                  '验收',
                )
              : null,
          ),
        ),
        openId
          ? h(TaskDrawer, {
              id: openId,
              bots,
              onClose: () => setOpenId(null),
              onChange: reload,
            })
          : null,
      )
    }

    // ── Tab 2：房间 ──────────────────────────────────────────────────────────

    function RoomsTab() {
      const { data, loading, error, reload } = useApi('/rooms')
      const [active, setActive] = useState(null)
      const [msgs, setMsgs] = useState([])
      const [text, setText] = useState('')
      const [actionError, setActionError] = useState(null)
      const [roomName, setRoomName] = useState('')
      const [memberId, setMemberId] = useState('')

      const loadMsgs = useCallback((roomId) => {
        call(`/rooms/messages?roomId=${encodeURIComponent(roomId)}`)
          .then((d) => setMsgs(d.messages ?? []))
          .catch((e) => setActionError(e.message))
      }, [])

      useEffect(() => {
        if (active) loadMsgs(active)
      }, [active, loadMsgs])

      const doCreate = async () => {
        const n = roomName.trim()
        if (!n) return
        setActionError(null)
        try {
          await call('/rooms', { method: 'POST', body: { name: n, members: [] } })
          setRoomName('')
          reload()
        } catch (e) {
          setActionError(e.message)
        }
      }

      const doPost = async () => {
        const t = text.trim()
        if (!t || !active) return
        setActionError(null)
        try {
          await call('/rooms/post', { method: 'POST', body: { roomId: active, text: t } })
          setText('')
          loadMsgs(active)
        } catch (e) {
          setActionError(e.message)
        }
      }

      const rooms = data?.rooms ?? []

      return h(
        'div',
        null,
        h(
          'div',
          { className: 'csb-bar' },
          h('input', {
            className: 'csb-input',
            placeholder: '新建房间名…',
            value: roomName,
            onChange: (e) => setRoomName(e.target.value),
            onKeyDown: (e) => e.key === 'Enter' && doCreate(),
          }),
          h('button', { className: 'csb-btn csb-btn-primary', onClick: doCreate }, '建房间'),
        ),
        actionError ? h('div', { className: 'csb-err' }, actionError) : null,
        loading ? h(Empty, { text: '加载中…' }) : null,
        error ? h('div', { className: 'csb-err' }, error) : null,
        !loading && rooms.length === 0 ? h(Empty, { text: '还没有房间' }) : null,
        rooms.map((r) =>
          h(
            'div',
            { key: r.id, className: 'csb-row' },
            h(
              'div',
              { className: 'csb-grow', style: { cursor: 'pointer' }, onClick: () => setActive(r.id) },
              h('div', { className: 'csb-title' }, r.name),
              h('div', { className: 'csb-meta' }, `${r.id} · ${(r.members ?? []).length} 人 · seq ${r.seq ?? 0}`),
            ),
            active === r.id ? h('span', { className: 'csb-badge' }, '当前') : null,
          ),
        ),
        active
          ? h(
              'div',
              { className: 'csb-bar', style: { marginTop: 8 } },
              h('input', {
                className: 'csb-input',
                placeholder: '成员 sessionId',
                value: memberId,
                onChange: (e) => setMemberId(e.target.value),
              }),
              h('button', {
                className: 'csb-btn',
                onClick: () =>
                  call('/rooms/join', { method: 'POST', body: { roomId: active, sessionId: memberId.trim() } })
                    .then(() => { setMemberId(''); reload() })
                    .catch((e) => setActionError(e.message)),
              }, '加入'),
              h('button', {
                className: 'csb-btn',
                onClick: () =>
                  call('/rooms/leave', { method: 'POST', body: { roomId: active, sessionId: memberId.trim() } })
                    .then(() => { setMemberId(''); reload() })
                    .catch((e) => setActionError(e.message)),
              }, '移出'),
            )
          : null,
        active
          ? h(
              'div',
              { style: { marginTop: 14 } },
              h('div', { className: 'csb-label' }, `消息（${active}）`),
              msgs.length === 0 ? h(Empty, { text: '还没有消息' }) : null,
              msgs.slice(-50).map((m) =>
                h(
                  'div',
                  { key: m.id, className: `csb-msg${m.from === 'ui' ? ' csb-msg-user' : ''}` },
                  h('div', { className: 'csb-meta' }, `#${m.seq} ${m.from}${m.bodyRef ? ' · 长文' : ''}`),
                  h('div', { className: 'csb-pre' }, m.bodyRef ? `（长正文，${m.bodyRef}）` : m.text),
                ),
              ),
              h(
                'div',
                { className: 'csb-bar', style: { marginTop: 8 } },
                h('input', {
                  className: 'csb-input',
                  placeholder: '发言…',
                  value: text,
                  onChange: (e) => setText(e.target.value),
                  onKeyDown: (e) => e.key === 'Enter' && doPost(),
                }),
                h('button', { className: 'csb-btn csb-btn-primary', onClick: doPost }, '发送'),
              ),
            )
          : null,
      )
    }

    // ── Tab 3：记忆 ──────────────────────────────────────────────────────────

    function MemoryTab() {
      const [layer, setLayer] = useState('')
      const [query, setQuery] = useState('')
      const path = `/memory${query ? `?query=${encodeURIComponent(query)}` : layer ? `?layer=${layer}` : ''}`
      const { data, loading, error, reload } = useApi(path, [layer, query])
      const [err, setErr] = useState(null)

      const entries = data?.entries ?? []

      return h(
        'div',
        null,
        h(
          'div',
          { className: 'csb-bar' },
          h(
            'select',
            { className: 'csb-select', style: { width: 130 }, value: layer, onChange: (e) => setLayer(e.target.value) },
            h('option', { value: '' }, '全部层'),
            ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'].map((l) => h('option', { key: l, value: l }, l)),
          ),
          h('input', {
            className: 'csb-input',
            placeholder: '检索…',
            value: query,
            onChange: (e) => setQuery(e.target.value),
          }),
        ),
        loading ? h(Empty, { text: '加载中…' }) : null,
        error ? h('div', { className: 'csb-err' }, error) : null,
        !loading && entries.length === 0 ? h(Empty, { text: '没有记忆条目' }) : null,
        err ? h('div', { className: 'csb-err' }, err) : null,
        entries.map((e) =>
          h(
            'div',
            { key: e.id, className: 'csb-row' },
            h(
              'div',
              { className: 'csb-grow' },
              h('div', { className: 'csb-title', style: { whiteSpace: 'normal' } }, e.content),
              h(
                'div',
                { className: 'csb-meta' },
                `${e.layer} · ${e.id} · rev ${e.rev} · ${e.source ?? '?'}`,
                e.explicit ? ' · explicit' : '',
                e.conflict ? ' · [conflict]' : '',
                e.archived ? ' · 已归档' : '',
              ),
            ),
            e.archived
              ? h('button', {
                  className: 'csb-btn',
                  onClick: () =>
                    call('/memory/restore', { method: 'POST', body: { layer: e.layer, id: e.id } })
                      .then(reload)
                      .catch((x) => setErr(x.message)),
                }, '恢复')
              : h('button', {
                  className: 'csb-btn',
                  onClick: () => {
                    const note = window.prompt('归档原因', '过时')
                    if (note === null) return
                    call('/memory/archive', { method: 'POST', body: { layer: e.layer, id: e.id, reason: note } })
                      .then(reload)
                      .catch((x) => setErr(x.message))
                  },
                }, '归档'),
          ),
        ),
      )
    }

    // ── Tab 4：Bot / 平台设置 ────────────────────────────────────────────────

    function BotsTab() {
      const { data, loading, error, reload } = useApi('/roster?includeRetired=1')
      const { data: statusData } = useApi('/status')
      const [name, setName] = useState('')
      const [cwd, setCwd] = useState('')
      const [actionError, setActionError] = useState(null)

      const doCreate = async () => {
        if (!name.trim() || !cwd.trim()) return
        setActionError(null)
        try {
          await call('/roster', { method: 'POST', body: { name: name.trim(), cwd: cwd.trim() } })
          setName('')
          setCwd('')
          reload()
        } catch (e) {
          setActionError(e.message)
        }
      }

      const doManage = async (bot, action, extra) => {
        setActionError(null)
        try {
          await call('/roster/manage', {
            method: 'POST',
            body: { id: bot.id, action, expectedRev: bot.rev, ...(extra ?? {}) },
          })
          reload()
        } catch (e) {
          setActionError(e.message)
        }
      }

      const bots = data?.bots ?? []
      const svc = statusData?.services ?? {}

      return h(
        'div',
        null,
        h('div', { className: 'csb-label' }, '服务状态'),
        h(
          'div',
          { className: 'csb-row', style: { flexWrap: 'wrap' } },
          Object.keys(svc).map((k) =>
            h(
              'span',
              { key: k, className: 'csb-badge', style: { marginRight: 6 } },
              `${k}: ${svc[k]?.available ? '就绪' : '未装'}`,
            ),
          ),
        ),
        h('div', { className: 'csb-label' }, '新建 Bot（cwd 即其写入边界）'),
        h(
          'div',
          { className: 'csb-bar' },
          h('input', {
            className: 'csb-input',
            placeholder: '名字',
            value: name,
            onChange: (e) => setName(e.target.value),
          }),
          h('input', {
            className: 'csb-input',
            placeholder: '绝对路径 cwd',
            value: cwd,
            onChange: (e) => setCwd(e.target.value),
          }),
          h('button', { className: 'csb-btn csb-btn-primary', onClick: doCreate }, '创建'),
        ),
        actionError ? h('div', { className: 'csb-err' }, actionError) : null,
        loading ? h(Empty, { text: '加载中…' }) : null,
        error ? h('div', { className: 'csb-err' }, error) : null,
        !loading && bots.length === 0 ? h(Empty, { text: '还没有 Bot' }) : null,
        bots.map((b) =>
          h(
            'div',
            { key: b.id, className: 'csb-row' },
            h(
              'div',
              { className: 'csb-grow' },
              h('div', { className: 'csb-title' }, b.name),
              h('div', { className: 'csb-meta' }, `${b.state} · ${b.cwd}`),
            ),
            b.state !== 'retired'
              ? h(
                  'button',
                  {
                    className: 'csb-btn',
                    onClick: () => {
                      const n = window.prompt('新名字', b.name)
                      if (n && n.trim()) doManage(b, 'rename', { name: n.trim() })
                    },
                  },
                  '改名',
                )
              : null,
            b.state !== 'retired'
              ? h(
                  'button',
                  {
                    className: 'csb-btn',
                    onClick: () => {
                      if (window.confirm(`退役 ${b.name}？名额与名字将释放。`)) {
                        doManage(b, 'retire', { reason: 'ui' })
                      }
                    },
                  },
                  '退役',
                )
              : h('span', { className: 'csb-badge csb-badge-del' }, 'retired'),
          ),
        ),
      )
    }


    // ── Tab 5：设置（真正生效：写入 settings.json，重启后内核参数改变）──────────

    function SettingsTab() {
      const { data, loading, error, reload } = useApi('/settings')
      const { data: statusData } = useApi('/status')
      const [draft, setDraft] = useState({})
      const [msg, setMsg] = useState(null)
      const [err, setErr] = useState(null)

      const specs = data?.specs ?? {}
      const values = data?.values ?? {}

      const save = async () => {
        setErr(null)
        setMsg(null)
        const patch = {}
        for (const [k, v] of Object.entries(draft)) {
          if (String(v) !== String(values[k])) patch[k] = v
        }
        if (Object.keys(patch).length === 0) {
          setMsg('没有改动')
          return
        }
        try {
          const res = await call('/settings', { method: 'POST', body: patch })
          setMsg(res.note ?? '已保存')
          setDraft({})
          reload()
        } catch (e) {
          setErr(e.message)
        }
      }

      const svc = statusData?.services ?? {}

      return h(
        'div',
        null,
        h('div', { className: 'csb-label' }, '服务健康'),
        h(
          'div',
          { className: 'csb-row', style: { flexWrap: 'wrap' } },
          Object.keys(svc).map((k) =>
            h('span', { key: k, className: 'csb-badge', style: { marginRight: 6 } },
              `${k}: ${svc[k]?.available ? '就绪' : '未装'}`),
          ),
        ),
        h('div', { className: 'csb-label' }, '状态目录'),
        h('div', { className: 'csb-pre' }, data?.baseDir ?? '(未知)'),

        h('div', { className: 'csb-sec' }, h('div', { className: 'csb-label' }, '可调参数（写入 settings.json，重启 DSH 后内核参数生效）')),
        loading ? h(Empty, { text: '加载中…' }) : null,
        error ? h('div', { className: 'csb-err' }, error) : null,
        msg ? h('div', { className: 'csb-row', style: { color: '#15803d' } }, msg) : null,
        err ? h('div', { className: 'csb-err' }, err) : null,
        Object.keys(specs).map((key) => {
          const spec = specs[key]
          const current = key in draft ? draft[key] : values[key]
          if (spec.bool) {
            return h(
              'div',
              { key, className: 'csb-field' },
              h('label', { title: key }, spec.label ?? key),
              h('input', {
                type: 'checkbox',
                checked: current === true,
                onChange: (e) => setDraft({ ...draft, [key]: e.target.checked }),
              }),
            )
          }
          return h(
            'div',
            { key, className: 'csb-field' },
            h('label', { title: `${key}（${spec.min}~${spec.max}）` }, spec.label ?? key),
            h('input', {
              className: 'csb-input',
              type: 'number',
              min: spec.min,
              max: spec.max,
              value: current,
              onChange: (e) => setDraft({ ...draft, [key]: Number(e.target.value) }),
            }),
          )
        }),
        h('div', { className: 'csb-bar', style: { marginTop: 10 } },
          h('button', { className: 'csb-btn csb-btn-primary', onClick: save }, '保存'),
          h('button', { className: 'csb-btn', onClick: () => { setDraft({}); setMsg(null); setErr(null); reload() } }, '重置'),
        ),
        data?.diagnostics?.badKeys?.length
          ? h('div', { className: 'csb-err' }, `设置文件有无效项：${JSON.stringify(data.diagnostics.badKeys)}`)
          : null,
      )
    }

    // ── 主面板 ──────────────────────────────────────────────────────────────

    const TABS = [
      { id: 'tasks', label: '任务', Comp: TasksTab },
      { id: 'rooms', label: '房间', Comp: RoomsTab },
      { id: 'memory', label: '记忆', Comp: MemoryTab },
      { id: 'bots', label: 'Bot', Comp: BotsTab },
      { id: 'settings', label: '设置', Comp: SettingsTab },
    ]

    function Workbench() {
      const [tab, setTab] = useState('tasks')
      const current = TABS.find((t) => t.id === tab) ?? TABS[0]
      const Comp = current.Comp
      return h(
        'div',
        { className: 'csb-root' },
        h(
          'div',
          { className: 'csb-tabs' },
          TABS.map((t) =>
            h(
              'button',
              {
                key: t.id,
                className: `csb-tab${t.id === tab ? ' csb-tab-on' : ''}`,
                onClick: () => setTab(t.id),
              },
              t.label,
            ),
          ),
        ),
        h(
          'div',
          { className: 'csb-body' },
          // **每个 Tab 单独包一层**：一处炸不连累整页
          h(Boundary, { tab: current.label }, h(Comp, { key: current.id })),
        ),
      )
    }

    function PanelIcon() {
      return h('span', { 'aria-hidden': 'true', style: { fontSize: 14 } }, '🤖')
    }

    // ── 装配 ────────────────────────────────────────────────────────────────

    function safeRun(label, fn) {
      try {
        fn()
      } catch (error) {
        try {
          console.warn(`[cs-bots] 注册 ${label} 失败：`, error)
        } catch {}
      }
    }

    function apply(ctx) {
      installStyles()
      const disposers = []

      // 顺序锁死：main 必须先注册（selectPanel 会校验它存在）
      safeRun('main', () => {
        disposers.push(
          ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, Workbench)),
        )
      })

      // 入口：官方 list 型
      safeRun('panellist', () => {
        disposers.push(
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 10, label: () => '协作平台' },
              PanelIcon,
            ),
          ),
        )
      })

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
    exports.RoomsTab = RoomsTab
    exports.MemoryTab = MemoryTab
    exports.BotsTab = BotsTab
    exports.SettingsTab = SettingsTab
    exports.PANEL_ID = PANEL_ID
    exports.API = API

    return module.exports
  },
})
