// Browser half of dsh-logseq-sync: a "Logseq" section in dsh web Settings.
//
// One form: Logseq account (email + password), sync server, graphs, E2EE password. The
// runtime the CLI needs is downloaded in the background the first time the section opens.
//
// Hand-written in the host's module format (no build step), so the package still installs
// straight from a GitHub tarball. The host's module loader runs the factory with a
// `require` that resolves react to the host's own instance. The section talks only to this
// plugin's API under /dsh-logseq/api/ (see lib/web.js).
window.__ModuleLoader__.load({
  id: 'dsh-logseq-sync',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const { useState, useEffect, useCallback } = React
    const h = React.createElement

    // ---- i18n ---------------------------------------------------------------------------
    const zh = typeof navigator !== 'undefined' && /^zh/i.test(navigator.language || '')
    const T = zh
      ? {
          title: 'Logseq 同步',
          intro: '把 Logseq 图谱同步到这台机器，供 agent 通过 logseq_* 工具读写。',
          runtime: '运行时',
          runtimeReady: '已就绪',
          runtimeMissing: '未下载',
          runtimeDownloading: '下载中',
          runtimeExtracting: '解压中…',
          runtimeFailed: '下载失败',
          download: '下载（约 180MB）',
          retry: '重试',
          account: 'Logseq 账号',
          email: '邮箱',
          password: '密码',
          loggedInAs: '已登录',
          notLoggedIn: '未登录',
          logout: '退出登录',
          server: '同步服务器',
          serverHint: 'https://logseq-sync.example.com',
          graphsAll: '同步账号在服务器上的全部图谱，新建的图谱会自动加入。',
          graphsPinned: '只同步 config.json 里指定的图谱：',
          syncAll: '改为同步全部',
          discovering: '正在读取服务器上的图谱…',
          discoveryFailed: '读取服务器上的图谱失败：',
          e2ee: 'E2EE 密码',
          e2eeHint: '加密图谱需要',
          e2eeKeep: '已保存；留空表示不修改',
          save: '保存',
          saving: '保存中…',
          saved: '已保存，正在按新设置同步',
          status: '同步状态',
          envLocked: '以下设置被环境变量覆盖，这里改了不会生效：',
          readOnly: '只读模式（readOnly）：agent 只能读，不能写',
          needRuntime: '运行时就绪后才能登录',
        }
      : {
          title: 'Logseq sync',
          intro: 'Sync Logseq graphs to this machine so the agent can read and write them through the logseq_* tools.',
          runtime: 'Runtime',
          runtimeReady: 'ready',
          runtimeMissing: 'not downloaded',
          runtimeDownloading: 'downloading',
          runtimeExtracting: 'extracting…',
          runtimeFailed: 'download failed',
          download: 'Download (~180MB)',
          retry: 'Retry',
          account: 'Logseq account',
          email: 'Email',
          password: 'Password',
          loggedInAs: 'Logged in',
          notLoggedIn: 'Not logged in',
          logout: 'Log out',
          server: 'Sync server',
          serverHint: 'https://logseq-sync.example.com',
          graphsAll: 'Every graph of the account on the server is synced; new graphs are added automatically.',
          graphsPinned: 'Only the graphs listed in config.json are synced: ',
          syncAll: 'Sync all instead',
          discovering: 'Reading graphs from the server…',
          discoveryFailed: 'Cannot list graphs on the server: ',
          e2ee: 'E2EE password',
          e2eeHint: 'Needed for encrypted graphs',
          e2eeKeep: 'Saved; leave empty to keep it',
          save: 'Save',
          saving: 'Saving…',
          saved: 'Saved; syncing with the new settings',
          status: 'Sync status',
          envLocked: 'Overridden by environment variables; changes here have no effect:',
          readOnly: 'Read-only mode (readOnly): the agent can read but not write',
          needRuntime: 'Log in after the runtime is ready',
        }

    // ---- API ------------------------------------------------------------------------------
    function apiPath(path) {
      const relative = `dsh-logseq/api/${path}`
      if (typeof document === 'undefined') return `/${relative}`
      return new URL(relative, document.baseURI).pathname
    }
    async function api(path, body) {
      const res = await fetch(apiPath(path), {
        method: body ? 'POST' : 'GET',
        credentials: 'same-origin',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      let data
      try {
        data = await res.json()
      } catch {
        data = {}
      }
      if (!res.ok) {
        const err = new Error(data.error || `HTTP ${res.status}`)
        err.hint = data.hint
        throw err
      }
      return data
    }

    // ---- styles ---------------------------------------------------------------------------
    const CSS = `
.dlq{display:flex;flex-direction:column;gap:18px;max-width:560px;font-size:14px;line-height:1.5;color:inherit}
.dlq *{box-sizing:border-box}
.dlq h2{font-size:18px;font-weight:600;margin:0}
.dlq h3{font-size:14px;font-weight:600;margin:0 0 8px}
.dlq-muted{opacity:.65}
.dlq-small{font-size:12px}
.dlq-group{display:flex;flex-direction:column;gap:10px;padding:14px 16px;border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:10px}
.dlq-field{display:flex;flex-direction:column;gap:4px}
.dlq-field label{font-size:12px;opacity:.75}
.dlq-input{font:inherit;color:inherit;background:color-mix(in srgb,currentColor 4%,transparent);border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:7px;padding:6px 9px;width:100%}
.dlq-input:focus{outline:2px solid color-mix(in srgb,#3b82f6 55%,transparent);outline-offset:0}
.dlq-btn{font:inherit;color:inherit;background:color-mix(in srgb,currentColor 8%,transparent);border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:7px;padding:5px 12px;cursor:pointer;white-space:nowrap}
.dlq-btn:hover:not(:disabled){background:color-mix(in srgb,currentColor 14%,transparent)}
.dlq-btn:disabled{opacity:.5;cursor:default}
.dlq-btn.primary{background:#2563eb;border-color:#2563eb;color:#fff}
.dlq-btn.primary:hover:not(:disabled){background:#1d4ed8}
.dlq-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dlq-err{color:#dc2626;font-size:13px;white-space:pre-wrap}
.dlq-ok{color:#16a34a;font-size:13px}
.dlq-bar{height:6px;border-radius:3px;background:color-mix(in srgb,currentColor 12%,transparent);overflow:hidden;flex:1;min-width:120px}
.dlq-bar>div{height:100%;background:#2563eb;transition:width .3s}
.dlq-chip{font:inherit;font-size:12px;color:inherit;padding:2px 10px;border-radius:999px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);background:none;cursor:pointer}
.dlq-chip.on{background:color-mix(in srgb,#2563eb 18%,transparent);border-color:#2563eb}
.dlq-sync{display:flex;flex-direction:column;gap:4px;font-size:13px}
.dlq-sync code{font-size:12px}
`
    function useStyle() {
      useEffect(() => {
        if (document.getElementById('dlq-style')) return
        const el = document.createElement('style')
        el.id = 'dlq-style'
        el.textContent = CSS
        document.head.appendChild(el)
      }, [])
    }

    function Btn({ kind, ...props }) {
      return h('button', { type: 'button', ...props, className: `dlq-btn ${kind || ''}` })
    }
    function Field({ label, hint, children }) {
      return h('div', { className: 'dlq-field' }, h('label', null, label), children, hint ? h('div', { className: 'dlq-small dlq-muted' }, hint) : null)
    }
    function ErrorText({ error }) {
      if (!error) return null
      return h('div', { className: 'dlq-err', role: 'alert' }, error.message + (error.hint ? `\n${error.hint}` : ''))
    }
    const mb = (n) => (n / 1e6).toFixed(0)

    function RuntimeRow({ rt, onDownload }) {
      if (rt.state === 'ready') return h('div', { className: 'dlq-small dlq-muted' }, `${T.runtime}: ${T.runtimeReady} (Logseq ${rt.version})`)
      if (rt.state === 'preparing') {
        const pct = rt.total ? Math.min(100, Math.round((rt.received / rt.total) * 100)) : 0
        const text = rt.phase === 'extracting' ? T.runtimeExtracting : `${T.runtimeDownloading} ${mb(rt.received)}MB${rt.total ? ` / ${mb(rt.total)}MB` : ''}`
        return h(
          'div',
          { className: 'dlq-row dlq-small' },
          h('span', null, `${T.runtime}: ${text}`),
          h('div', { className: 'dlq-bar' }, h('div', { style: { width: rt.phase === 'extracting' ? '100%' : `${pct}%` } })),
        )
      }
      return h(
        'div',
        { className: 'dlq-row dlq-small' },
        h('span', { className: rt.state === 'error' ? 'dlq-err' : '' }, `${T.runtime}: ${rt.state === 'error' ? `${T.runtimeFailed}: ${rt.error}` : T.runtimeMissing}`),
        h(Btn, { onClick: onDownload }, rt.state === 'error' ? T.retry : T.download),
      )
    }

    const STATE_LABEL = zh
      ? { synced: '已同步', pending: '等待中', downloading: '下载中', starting: '连接中', error: '出错' }
      : { synced: 'synced', pending: 'pending', downloading: 'downloading', starting: 'connecting', error: 'error' }
    function SyncStatus({ status }) {
      if (!status.config.server || !status.auth.loggedIn) return null
      const entries = Object.entries(status.sync || {})
      return h(
        'div',
        { className: 'dlq-group' },
        h('h3', null, T.status),
        status.discoveryError ? h('div', { className: 'dlq-err dlq-small' }, T.discoveryFailed + status.discoveryError) : null,
        !entries.length && !status.discoveryError ? h('div', { className: 'dlq-small dlq-muted' }, T.discovering) : null,
        h(
          'div',
          { className: 'dlq-sync' },
          entries.map(([graph, s]) =>
            h(
              'div',
              { key: graph },
              h('b', null, graph),
              ': ',
              h('span', { className: s.state === 'synced' ? 'dlq-ok' : s.state === 'error' ? 'dlq-err' : '' }, STATE_LABEL[s.state] || s.state),
              s.state === 'synced' && s.pendingLocal ? ` (↑${s.pendingLocal})` : '',
              s.error ? h('div', { className: 'dlq-err dlq-small' }, s.error) : null,
            ),
          ),
        ),
      )
    }

    // ---- section --------------------------------------------------------------------------
    function LogseqSettings() {
      useStyle()
      const [status, setStatus] = useState(null)
      const [loadError, setLoadError] = useState(null)
      const [form, setForm] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [saved, setSaved] = useState(false)

      const refresh = useCallback(async () => {
        try {
          const s = await api('status')
          setStatus(s)
          setLoadError(null)
          return s
        } catch (e) {
          setLoadError(e)
          return null
        }
      }, [])

      // First load: fill the form and start the runtime download if it is missing.
      useEffect(() => {
        refresh().then((s) => {
          if (!s) return
          setForm({ username: '', password: '', server: s.config.server || '', e2eePassword: '' })
          if (s.runtime.state === 'missing') api('runtime/install', {}).then(refresh).catch(() => {})
        })
      }, [refresh])

      // Poll fast while the runtime downloads, slowly otherwise (sync status).
      const preparing = status?.runtime?.state === 'preparing'
      useEffect(() => {
        const t = setInterval(refresh, preparing ? 1500 : 10_000)
        return () => clearInterval(t)
      }, [refresh, preparing])

      if (!status || !form) return h('div', { className: 'dlq' }, h('h2', null, T.title), loadError ? h(ErrorText, { error: loadError }) : h('div', { className: 'dlq-muted' }, '…'))

      const set = (key) => (e) => {
        setSaved(false)
        setForm({ ...form, [key]: e.target.value })
      }
      const runtimeReady = status.runtime.state === 'ready'
      const cfg = status.config

      const run = async (fn) => {
        setBusy(true)
        setError(null)
        try {
          await fn()
        } catch (e) {
          setError(e)
        } finally {
          setBusy(false)
          refresh()
        }
      }

      const save = (e) => {
        e.preventDefault()
        run(async () => {
          setSaved(false)
          if (!status.auth.loggedIn) {
            if (!form.username || !form.password) throw new Error(zh ? '请填写 Logseq 账号的邮箱和密码' : 'Enter the email and password of your Logseq account')
            await api('login', { username: form.username.trim(), password: form.password })
          }
          await api('setup', { server: form.server, e2eePassword: form.e2eePassword })
          setForm({ ...form, password: '', e2eePassword: '' })
          setSaved(true)
        })
      }
      const syncAll = () => run(() => api('setup', { graphs: [] }))
      const logout = () => run(() => api('logout', {}))

      return h(
        'form',
        { className: 'dlq', onSubmit: save },
        h('div', null, h('h2', null, T.title), h('div', { className: 'dlq-muted dlq-small' }, T.intro)),
        h(RuntimeRow, { rt: status.runtime, onDownload: () => run(() => api('runtime/install', {})) }),
        cfg.envOverrides.length ? h('div', { className: 'dlq-err' }, `${T.envLocked} ${cfg.envOverrides.join(', ')}`) : null,
        cfg.readOnly ? h('div', { className: 'dlq-small dlq-muted' }, T.readOnly) : null,

        h(
          'div',
          { className: 'dlq-group' },
          h(
            'div',
            { className: 'dlq-row' },
            h('h3', { style: { margin: 0, marginRight: 'auto' } }, T.account),
            h('span', { className: 'dlq-small dlq-muted' }, status.auth.loggedIn ? `${T.loggedInAs}${status.auth.email ? `: ${status.auth.email}` : ''}` : T.notLoggedIn),
            status.auth.loggedIn ? h(Btn, { onClick: logout, disabled: busy }, T.logout) : null,
          ),
          status.auth.loggedIn
            ? null
            : h(Field, { label: T.email }, h('input', { className: 'dlq-input', type: 'email', autoComplete: 'username', value: form.username, onChange: set('username') })),
          status.auth.loggedIn
            ? null
            : h(
                Field,
                { label: T.password, hint: !runtimeReady ? T.needRuntime : null },
                h('input', { className: 'dlq-input', type: 'password', autoComplete: 'current-password', value: form.password, onChange: set('password'), disabled: !runtimeReady }),
              ),
        ),

        h(
          'div',
          { className: 'dlq-group' },
          h(Field, { label: T.server }, h('input', { className: 'dlq-input', type: 'url', placeholder: T.serverHint, value: form.server, onChange: set('server') })),
          cfg.graphs.length
            ? h(
                'div',
                { className: 'dlq-row dlq-small' },
                h('span', { className: 'dlq-muted' }, T.graphsPinned + cfg.graphs.join(', ')),
                h(Btn, { onClick: syncAll, disabled: busy }, T.syncAll),
              )
            : h('div', { className: 'dlq-small dlq-muted' }, T.graphsAll),
          h(
            Field,
            { label: T.e2ee, hint: cfg.hasE2eePassword ? T.e2eeKeep : T.e2eeHint },
            h('input', { className: 'dlq-input', type: 'password', autoComplete: 'new-password', value: form.e2eePassword, onChange: set('e2eePassword') }),
          ),
        ),

        h(ErrorText, { error }),
        saved && !error ? h('div', { className: 'dlq-ok' }, T.saved) : null,
        h('div', { className: 'dlq-row' }, h(Btn, { kind: 'primary', type: 'submit', disabled: busy }, busy ? T.saving : T.save)),
        h(SyncStatus, { status }),
      )
    }

    // ---- plugin -------------------------------------------------------------------------
    const name = 'dsh-logseq-sync'
    const inject = ['slots']
    function apply(ctx) {
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register({ name: 'settings.section', id: 'logseq', order: 60, label: () => 'Logseq' }, () => h(LogseqSettings)),
      )
    }
    module.exports = { name, inject, apply }
    return module.exports
  },
})
