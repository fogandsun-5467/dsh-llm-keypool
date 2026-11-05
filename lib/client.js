/**
 * dsh-llm-keypool — browser half: the "轮换池" sidebar entry + panel.
 *
 * The sidebar entry follows the same shell pattern as the installed
 * `@ychris12138/dsh-usage-stats`: `sidebar.footer.action` renders a full-width
 * 42px row (icon + label + right-aligned count) when the sidebar is wide and a
 * 36px round icon when it is collapsed ("rail"). The panel is a fixed overlay
 * using the host's elevated-menu skin (menu colour, r12, prominent shadow).
 *
 * Data comes from the Host half's loopback endpoints (`/api/keypool/*`), so
 * this file contains no business logic and never sees credentials.
 *
 * Bundle format: `window.__ModuleLoader__.load({ id: <package name>, factory })`
 * with React taken from the browser module table (never bundled).
 */
;(function () {
  const installedFlag = '__dshLlmKeypoolClientRegistered'
  if (window[installedFlag] === true) return
  window[installedFlag] = true
  window.__ModuleLoader__.load({
  id: '@nethiel/dsh-llm-keypool',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    const API = '/api/keypool/'
    /** Failure codes the kernel classifies as quota exhaustion (the defaults). */
    const DEFAULT_CODES = ['QUOTA', 'ACCOUNT_QUOTA', 'RATE_LIMIT']

    // #region styles — one scoped stylesheet, injected once, host theme tokens only
    const css = [
      '.kp_layer{flex:none;align-items:center;width:calc(100% + 4px);height:42px;margin:4px -2px;display:flex;position:relative}',
      '.kp_footerButtons{align-items:center;width:100%;display:flex}',
      '.kp_badge{box-sizing:border-box;width:100%;height:42px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:none;border-radius:12px;align-items:center;gap:8px;padding:0 10px 0 8px;font-family:inherit;font-size:14px;display:inline-flex;overflow:hidden}',
      '.kp_badge:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.kp_badge[data-active]{background:var(--dsw-alias-interactive-bg-hover)}',
      '.kp_badgeLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}',
      '.kp_badgeAmount{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;flex:none;margin-left:auto;font-size:12px;font-weight:600;line-height:16px}',
      '.kp_badgeTone{color:var(--dsw-alias-state-success-primary)}',
      '.kp_layer.kp_rail{width:36px;height:36px;margin:0}',
      '.kp_layer.kp_rail .kp_badge{border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;padding:0}',
      '.kp_layer.kp_rail .kp_badgeLabel,.kp_layer.kp_rail .kp_badgeAmount{display:none}',
      '.kp_panel{z-index:100;box-sizing:border-box;border:0;background:var(--dsw-specific-menu,var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-base)));backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent,var(--dsw-shadow-lv2));width:480px;max-width:calc(100vw - 24px);max-height:74vh;border-radius:12px;flex-direction:column;display:flex;position:fixed;bottom:128px;left:12px;overflow:hidden}',
      '.kp_header{box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none;justify-content:space-between;align-items:center;min-height:44px;padding:10px 12px;display:flex}',
      '.kp_headerLeft{align-items:center;gap:8px;display:flex}',
      '.kp_title{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px}',
      '.kp_headerActions{align-items:center;gap:2px;display:flex}',
      '.kp_iconButton{cursor:pointer;width:26px;height:26px;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;border-radius:6px;justify-content:center;align-items:center;padding:0;display:inline-flex}',
      '.kp_iconButton:hover{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}',
      '.kp_body{flex:1;min-height:0;padding:4px 14px 14px;overflow-y:auto}',
      '.kp_section{margin-top:12px}',
      '.kp_sectionTitle{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;margin:0 0 6px}',
      '.kp_kv{display:flex;gap:6px;align-items:baseline;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.kp_kv strong{color:var(--dsw-alias-label-primary);font-weight:500;min-width:0;word-break:break-all}',
      '.kp_chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:12px;margin-top:4px}',
      '.kp_chip{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 8px;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.kp_note{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin:4px 0 0}',
      '.kp_row{display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;margin-bottom:6px}',
      '.kp_rowIndex{color:var(--dsw-alias-label-tertiary);width:16px;text-align:right;font-size:11px;font-variant-numeric:tabular-nums}',
      '.kp_rowLabel{flex:1;min-width:0;color:var(--dsw-alias-label-primary);font-size:12px;font-weight:500;line-height:18px;word-break:break-all}',
      '.kp_rowButton{cursor:pointer;width:24px;height:24px;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;padding:0;font:inherit}',
      '.kp_rowButton:hover{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}',
      '.kp_rowButton:disabled{opacity:.4;cursor:default}',
      '.kp_rowDanger{color:var(--dsw-alias-state-error-primary)}',
      '.kp_addRow{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.kp_select,.kp_input{box-sizing:border-box;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 8px}',
      '.kp_select{max-width:186px}',
      '.kp_input{width:76px}',
      '.kp_primary{cursor:pointer;border:none;border-radius:8px;background:var(--dsw-alias-brand-primary,#247bbf);color:#fff;font:inherit;font-size:12px;font-weight:600;line-height:20px;padding:4px 10px}',
      '.kp_primary:disabled{opacity:.5;cursor:default}',
      '.kp_ghost{cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:20px;padding:4px 10px}',
      '.kp_footer{flex:none;border-top:1px solid var(--dsw-alias-border-l2);padding:10px 14px;display:flex;align-items:center;gap:10px}',
      '.kp_footerPath{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;flex:1;min-width:0;word-break:break-all}',
      '.kp_error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;margin:8px 0 0}',
      '.kp_notice{color:var(--dsw-alias-brand-primary);font-size:12px;line-height:18px;margin:8px 0 0}',
      '.kp_switchRow{display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-top:2px}',
      '.kp_switchRow label{display:flex;gap:6px;align-items:center;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      // ---- quota section ----
      '.kp_quotaRow{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:8px;margin-bottom:6px}',
      '.kp_quotaHead{display:flex;align-items:baseline;gap:8px}',
      '.kp_quotaProvider{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:500;line-height:18px}',
      '.kp_quotaRef{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;margin-left:auto;word-break:break-all;text-align:right}',
      '.kp_quotaLine{display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px;margin-top:6px;color:var(--dsw-alias-label-secondary)}',
      '.kp_quotaLabel{color:var(--dsw-alias-label-tertiary);flex:none;width:58px}',
      '.kp_quotaValue{flex:none;font-variant-numeric:tabular-nums;font-weight:600;min-width:40px;text-align:right}',
      '.kp_quotaBar{flex:1;height:4px;border-radius:999px;background:var(--dsw-alias-border-l2);overflow:hidden;min-width:32px}',
      '.kp_quotaFill{display:block;height:100%;border-radius:999px;background:currentColor}',
      '.kp_quotaLeft{flex:none;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary);min-width:96px;text-align:right}',
      '.kp_toneGood{color:var(--dsw-alias-state-success-primary)}',
      '.kp_toneWarn{color:var(--dsw-alias-state-warn-primary)}',
      '.kp_toneBad{color:var(--dsw-alias-state-error-primary)}',
      '.kp_quotaError{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;margin-top:4px}',
      '.kp_quotaField{display:flex;align-items:center;gap:8px;margin-top:6px}',
      '.kp_quotaFieldName{color:var(--dsw-alias-label-tertiary);font-size:12px;flex:none;width:104px;word-break:break-all}',
      '.kp_inputWide{box-sizing:border-box;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 8px;flex:1;min-width:0}',
    ].join('')
    const tagId = '@nethiel/dsh-llm-keypool/panel.module.css'
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = '@nethiel/dsh-llm-keypool'
      tag.dataset.pluginCss = tagId
      tag.textContent = css
      document.head.appendChild(tag)
    }
    const S = {
      layer: 'kp_layer',
      rail: 'kp_rail',
      footerButtons: 'kp_footerButtons',
      badge: 'kp_badge',
      badgeLabel: 'kp_badgeLabel',
      badgeAmount: 'kp_badgeAmount',
      badgeTone: 'kp_badgeTone',
      panel: 'kp_panel',
      header: 'kp_header',
      headerLeft: 'kp_headerLeft',
      title: 'kp_title',
      headerActions: 'kp_headerActions',
      iconButton: 'kp_iconButton',
      body: 'kp_body',
      section: 'kp_section',
      sectionTitle: 'kp_sectionTitle',
      kv: 'kp_kv',
      chips: 'kp_chips',
      chip: 'kp_chip',
      note: 'kp_note',
      row: 'kp_row',
      rowIndex: 'kp_rowIndex',
      rowLabel: 'kp_rowLabel',
      rowButton: 'kp_rowButton',
      rowDanger: 'kp_rowDanger',
      addRow: 'kp_addRow',
      select: 'kp_select',
      input: 'kp_input',
      primary: 'kp_primary',
      ghost: 'kp_ghost',
      footer: 'kp_footer',
      footerPath: 'kp_footerPath',
      error: 'kp_error',
      notice: 'kp_notice',
      switchRow: 'kp_switchRow',
      quotaRow: 'kp_quotaRow',
      quotaHead: 'kp_quotaHead',
      quotaProvider: 'kp_quotaProvider',
      quotaRef: 'kp_quotaRef',
      quotaLine: 'kp_quotaLine',
      quotaLabel: 'kp_quotaLabel',
      quotaValue: 'kp_quotaValue',
      quotaBar: 'kp_quotaBar',
      quotaFill: 'kp_quotaFill',
      quotaLeft: 'kp_quotaLeft',
      toneGood: 'kp_toneGood',
      toneWarn: 'kp_toneWarn',
      toneBad: 'kp_toneBad',
      quotaError: 'kp_quotaError',
      quotaField: 'kp_quotaField',
      quotaFieldName: 'kp_quotaFieldName',
      inputWide: 'kp_inputWide',
    }
    // #endregion

    /** Fetch JSON from the Host half. */
    async function api(path, init) {
      const response = await fetch(API + path, {
        cache: 'no-store',
        headers: init === undefined ? undefined : { 'content-type': 'application/json' },
        ...init,
      })
      if (!response.ok) {
        let detail = `HTTP ${response.status}`
        try {
          const body = await response.json()
          if (body && typeof body.error === 'string') detail = body.error
        } catch {
          // keep the status text
        }
        throw new Error(detail)
      }
      return response.json()
    }

    const routeText = (route) => (route ? `${route.provider} / ${route.model}` : '')

    /** Milliseconds → "9 分 31 秒" for cooling chips. */
    function remainingText(ms) {
      const total = Math.max(0, Math.round(ms / 1000))
      const minutes = Math.floor(total / 60)
      const seconds = total % 60
      return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`
    }

    /** Clock text for a switch row. */
    function timeText(at) {
      const date = new Date(at)
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
    }

    // ---- quota helpers ----------------------------------------------------

    /** Milliseconds → "3 小时 12 分" for a quota countdown. */
    function quotaDurationText(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
      const total = Math.max(0, Math.round(ms / 1000))
      const hours = Math.floor(total / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      if (hours > 0) return `${hours} 小时 ${minutes} 分`
      if (minutes > 0) return `${minutes} 分`
      return `${total} 秒`
    }

    /**
     * Tone of a *remaining* percentage: plenty left is good, almost nothing
     * left is bad.
     * @param {unknown} percent
     */
    function quotaTone(percent) {
      if (typeof percent !== 'number' || !Number.isFinite(percent)) return ''
      if (percent >= 50) return S.toneGood
      if (percent >= 20) return S.toneWarn
      return S.toneBad
    }

    /** One quota line: label, percentage, bar, countdown. */
    function QuotaLine({ label, percent, remainsMs }) {
      const tone = quotaTone(percent)
      const shown = typeof percent === 'number' && Number.isFinite(percent) ? `${Math.round(percent)}%` : '—'
      const width = typeof percent === 'number' && Number.isFinite(percent)
        ? `${Math.max(0, Math.min(100, percent))}%`
        : '0%'
      return h('div', { className: S.quotaLine }, [
        h('span', { key: 'label', className: S.quotaLabel }, label),
        h('span', { key: 'value', className: `${S.quotaValue} ${tone}` }, shown),
        h('span', { key: 'bar', className: S.quotaBar }, [
          h('i', { key: 'fill', className: S.quotaFill, style: { width } }),
        ]),
        h('span', { key: 'left', className: S.quotaLeft }, quotaDurationText(remainsMs)),
      ])
    }

    /** One provider's quota card. */
    function QuotaCard({ entry, label }) {
      const models = Array.isArray(entry.models) ? entry.models : []
      const title = typeof label === 'string' && label !== '' ? label : entry.provider
      const resetIn = typeof entry.resetAt === 'number' ? entry.resetAt - Date.now() : undefined
      return h('div', { className: S.quotaRow }, [
        h('div', { key: 'head', className: S.quotaHead }, [
          h('span', { key: 'name', className: S.quotaProvider, title: entry.provider }, title),
          entry.ref ? h('span', { key: 'ref', className: S.quotaRef }, entry.ref) : null,
        ]),
        entry.weeklyExhausted === true
          ? h('div', { key: 'spentWeekly', className: `${S.quotaError} ${S.toneBad}` },
            `周额度已用尽 · 本周不再使用，预计 ${quotaDurationText(resetIn)} 后恢复`)
          : (entry.exhausted === true
            ? h('div', { key: 'spent', className: `${S.quotaError} ${S.toneBad}` },
              `5 小时额度已用尽 · 预计 ${quotaDurationText(resetIn)} 后恢复（恢复前自动切走）`)
            : null),
        entry.ok !== true
          ? h('div', { key: 'err', className: S.quotaError }, entry.error ?? '读取失败')
          : models.map((model) => h('div', { key: model.name, style: { marginTop: '2px' } }, [
            model.name !== 'general'
              ? h('div', { key: 'model', className: S.note }, model.name)
              : null,
            h(QuotaLine, {
              key: 'i',
              label: '5 小时',
              percent: model.interval?.percent,
              remainsMs: model.interval?.remainsMs,
            }),
            h(QuotaLine, {
              key: 'w',
              label: '7 天',
              percent: model.weekly?.percent,
              remainsMs: model.weekly?.remainsMs,
            }),
          ])),
      ])
    }

    /** Icon used by both the sidebar entry and the panel header. */
    function KeyIcon({ size }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round',
      }, [
        h('circle', { key: 'c', cx: 8, cy: 8, r: 3.2 }),
        h('path', { key: 'p', d: 'M10.4 10.4 L18 18' }),
        h('path', { key: 't1', d: 'M15.2 15.2 L17.2 13.2' }),
        h('path', { key: 't2', d: 'M17.4 17.4 L19.4 15.4' }),
      ])
    }

    /** One ordered pool row with move/remove controls. */
    function PoolRow({ index, route, total, onMove, onRemove }) {
      return h('div', { className: S.row }, [
        h('span', { key: 'idx', className: S.rowIndex }, String(index + 1)),
        h('span', { key: 'label', className: S.rowLabel }, routeText(route)),
        h('button', {
          key: 'up', type: 'button', className: S.rowButton, title: '上移',
          disabled: index === 0, onClick: () => onMove(index, -1),
        }, '↑'),
        h('button', {
          key: 'down', type: 'button', className: S.rowButton, title: '下移',
          disabled: index === total - 1, onClick: () => onMove(index, 1),
        }, '↓'),
        h('button', {
          key: 'remove', type: 'button', className: `${S.rowButton} ${S.rowDanger}`, title: '移出池子',
          onClick: () => onRemove(index),
        }, '✕'),
      ])
    }

    /** The floating panel. */
    function PoolPanel({ onClose, onSaved }) {
      const [catalog, setCatalog] = useState(null)
      const [draft, setDraft] = useState(null)
      const [status, setStatus] = useState(null)
      const [filePath, setFilePath] = useState('')
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [saving, setSaving] = useState(false)
      const [dirty, setDirty] = useState(false)
      const [providerId, setProviderId] = useState('')
      const [modelId, setModelId] = useState('')
      const [quota, setQuota] = useState(null)
      const [quotaError, setQuotaError] = useState('')
      const [quotaBusy, setQuotaBusy] = useState(false)

      const load = useCallback(async () => {
        setError('')
        try {
          const [catalogBody, configBody] = await Promise.all([api('catalog'), api('config')])
          setCatalog(catalogBody)
          setFilePath(configBody.file ?? '')
          const base = configBody.stored ?? configBody.row ?? { pools: [], cooldownMs: 600000, maxSwitchesPerTurn: 3 }
          const routes = []
          for (const pool of Array.isArray(base.pools) ? base.pools : []) {
            for (const route of Array.isArray(pool.routes) ? pool.routes : []) {
              routes.push({ provider: route.provider, model: route.model })
            }
          }
          const baseCodes = Array.isArray(base.codes) && base.codes.length > 0
            ? base.codes
            : (Array.isArray(configBody.row?.codes) && configBody.row.codes.length > 0 ? configBody.row.codes : DEFAULT_CODES)
          const baseQuota = base.quota ?? configBody.row?.quota ?? {}
          const quotaProviders = {}
          for (const [provider, entry] of Object.entries(baseQuota.providers ?? {})) {
            quotaProviders[provider] = {
              apiKeyEnv: typeof entry?.apiKeyEnv === 'string' ? entry.apiKeyEnv : '',
              baseUrl: typeof entry?.baseUrl === 'string' ? entry.baseUrl : '',
            }
          }
          setDraft({
            routes,
            cooldownMs: typeof base.cooldownMs === 'number' ? base.cooldownMs : 600000,
            maxSwitchesPerTurn: typeof base.maxSwitchesPerTurn === 'number' ? base.maxSwitchesPerTurn : 3,
            preferFirst: base.preferFirst === true,
            codes: baseCodes,
            authTrigger: baseCodes.includes('AUTH'),
            quota: {
              enabled: baseQuota.enabled !== false,
              providers: quotaProviders,
            },
          })
          setDirty(false)
          if (configBody.storedError) setError(`配置文件暂时读不了：${configBody.storedError}`)
        } catch (loadError) {
          setError(`加载失败：${loadError.message}`)
        }
      }, [])

      const refreshStatus = useCallback(async () => {
        try {
          setStatus(await api('status'))
        } catch {
          // status is best-effort; the panel still edits config
        }
      }, [])

      /**
       * Read the quota of every provider in the pool.
       * @param {boolean} [force] bypass the Host-side cache.
       */
      const refreshQuota = useCallback(async (force) => {
        setQuotaBusy(true)
        try {
          const body = await api(force === true ? 'quota?refresh=1' : 'quota')
          setQuota(body)
          setQuotaError('')
        } catch (quotaLoadError) {
          setQuotaError(`额度读取失败：${quotaLoadError.message}`)
        } finally {
          setQuotaBusy(false)
        }
      }, [])

      useEffect(() => { load() }, [load])
      useEffect(() => {
        refreshStatus()
        const timer = setInterval(refreshStatus, 2500)
        return () => clearInterval(timer)
      }, [refreshStatus])
      useEffect(() => {
        refreshQuota(false)
        const timer = setInterval(() => refreshQuota(false), 30000)
        return () => clearInterval(timer)
      }, [refreshQuota])
      useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])

      const providerGroups = useMemo(() => (catalog?.providers ?? []), [catalog])
      /** Provider display names, so a quota card reads "MiniMax" and not "minimax-cn". */
      const providerLabels = useMemo(() => {
        const labels = {}
        for (const provider of providerGroups) {
          if (provider?.id === undefined) continue
          labels[provider.id] = provider.displayName || provider.name || provider.id
        }
        return labels
      }, [providerGroups])
      const activeProvider = providerGroups.find((group) => group.provider === providerId)
      const availableModels = activeProvider?.models ?? []
      const chosenModel = availableModels.some((model) => model.id === modelId) ? modelId : (availableModels[0]?.id ?? '')

      const mutateDraft = (next) => { setDraft(next); setDirty(true); setNotice('') }

      const addRoute = () => {
        if (!draft || !activeProvider || chosenModel === '') return
        const exists = draft.routes.some((route) => route.provider === activeProvider.provider && route.model === chosenModel)
        if (exists) { setNotice('这个组合已经在池子里了'); return }
        mutateDraft({ ...draft, routes: [...draft.routes, { provider: activeProvider.provider, model: chosenModel }] })
      }
      const moveRoute = (index, delta) => {
        if (!draft) return
        const next = draft.routes.slice()
        const target = index + delta
        if (target < 0 || target >= next.length) return
        const [item] = next.splice(index, 1)
        next.splice(target, 0, item)
        mutateDraft({ ...draft, routes: next })
      }
      const removeRoute = (index) => {
        if (!draft) return
        mutateDraft({ ...draft, routes: draft.routes.filter((_, current) => current !== index) })
      }

      const save = async () => {
        if (!draft) return
        setSaving(true)
        setError('')
        setNotice('')
        try {
          const baseCodes = Array.isArray(draft.codes) && draft.codes.length > 0 ? draft.codes : DEFAULT_CODES
          const codes = draft.authTrigger === true
            ? Array.from(new Set([...baseCodes, 'AUTH']))
            : baseCodes.filter((code) => code !== 'AUTH')
          const quotaProviders = {}
          for (const [provider, entry] of Object.entries(draft.quota?.providers ?? {})) {
            const apiKeyEnv = typeof entry?.apiKeyEnv === 'string' ? entry.apiKeyEnv.trim() : ''
            const baseUrl = typeof entry?.baseUrl === 'string' ? entry.baseUrl.trim() : ''
            if (apiKeyEnv === '' && baseUrl === '') continue
            quotaProviders[provider] = {
              ...(apiKeyEnv === '' ? {} : { apiKeyEnv }),
              ...(baseUrl === '' ? {} : { baseUrl }),
            }
          }
          const saved = await api('config', {
            method: 'POST',
            body: JSON.stringify({
              pools: [{ name: '我的轮换池', routes: draft.routes }],
              cooldownMs: Math.max(0, Math.round(Number(draft.cooldownMs) || 0)),
              maxSwitchesPerTurn: Math.max(1, Math.round(Number(draft.maxSwitchesPerTurn) || 3)),
              preferFirst: draft.preferFirst === true,
              codes: codes.length > 0 ? codes : DEFAULT_CODES,
              quota: {
                enabled: draft.quota?.enabled !== false,
                providers: quotaProviders,
              },
            }),
          })
          setDirty(false)
          setNotice(`已保存 ${saved.saved.pools[0].routes.length} 条路由，下一次请求生效`)
          if (typeof onSaved === 'function') onSaved(saved.saved.pools[0].routes.length)
          refreshStatus()
        } catch (saveError) {
          setError(`保存失败：${saveError.message}`)
        } finally {
          setSaving(false)
        }
      }

      const statusBody = status === null
        ? h('p', { className: S.note }, '读取状态中…')
        : h('div', { style: { display: 'grid', gap: '6px' } }, [
          h('div', { key: 'active', className: S.kv }, [
            h('span', { key: 'l' }, '当前路由：'),
            status.active === null
              ? h('span', { key: 'v', className: S.note }, '暂无（还没有请求）')
              : h('strong', { key: 'v' }, routeText(status.active)),
          ]),
          h('div', { key: 'cooling' }, [
            h('div', { key: 'l', className: S.kv }, '冷却中：'),
            h('div', { key: 'chips', className: S.chips }, status.cooling.length === 0
              ? [h('span', { key: 'none', className: S.note }, '无')]
              : status.cooling.map((entry) => h('span', {
                key: entry.provider,
                className: S.chip,
              }, `${entry.provider}（还剩 ${remainingText(entry.remainingMs)}）`))),
          ]),
          status.lastFailure === null
            ? null
            : h('div', { key: 'failure', className: S.note }, `最近一次失败：${status.lastFailure.provider} · ${status.lastFailure.detail}`),
          h('div', { key: 'switches' }, [
            h('div', { key: 'l', className: S.kv }, '最近切换：'),
            status.switches.length === 0
              ? h('p', { key: 'none', className: S.note }, '还没有切换过')
              : status.switches.slice(0, 8).map((entry, index) => h('div', {
                key: `${entry.at}-${index}`,
                className: S.note,
                style: { fontVariantNumeric: 'tabular-nums' },
              }, `${timeText(entry.at)}  ${entry.from} → ${entry.to}`)),
          ]),
        ])

      return ReactDOM.createPortal(
        h('section', { className: S.panel, role: 'dialog', 'aria-label': '多 Key 轮换池' }, [
          h('header', { key: 'header', className: S.header }, [
            h('div', { key: 'left', className: S.headerLeft }, [
              h('span', { key: 'icon', style: { display: 'inline-flex', color: 'var(--dsw-alias-label-tertiary)' } }, h(KeyIcon, { size: 16 })),
              h('span', { key: 'title', className: S.title }, '多 Key 轮换池'),
            ]),
            h('div', { key: 'actions', className: S.headerActions }, [
              h('button', {
                key: 'refresh', type: 'button', className: S.iconButton, title: '刷新', 'aria-label': '刷新',
                onClick: () => { load(); refreshStatus() },
              }, h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }, [
                h('path', { key: 'a', d: 'M20 11a8 8 0 1 0-2.3 5.7' }),
                h('path', { key: 'b', d: 'M20 5v6h-6' }),
              ])),
              h('button', {
                key: 'close', type: 'button', className: S.iconButton, title: '关闭', 'aria-label': '关闭',
                onClick: onClose,
              }, h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }, [
                h('path', { key: 'a', d: 'M6 6l12 12' }),
                h('path', { key: 'b', d: 'M18 6L6 18' }),
              ])),
            ]),
          ]),
          h('div', { key: 'body', className: S.body }, [
            h('section', { key: 'status', className: S.section }, [
              h('h3', { className: S.sectionTitle }, '状态'),
              statusBody,
            ]),
            h('section', { key: 'quota', className: S.section }, [
              h('h3', { className: S.sectionTitle }, '额度'),
              quota === null
                ? h('p', { className: S.note }, '读取额度中…')
                : (quota.enabled === false
                  ? h('p', { className: S.note }, '额度读取已关闭（可在下面打开）。')
                  : h('div', null, [
                    ...(quota.providers ?? []).map((entry) => h(QuotaCard, {
                      key: entry.provider,
                      entry,
                      label: providerLabels[entry.provider],
                    })),
                    (quota.providers ?? []).length === 0
                      ? h('p', { className: S.note }, '池子里还没有供应商，先在上面加一条路由。')
                      : null,
                  ])),
              h('p', { className: S.note, style: { marginTop: '4px' } },
                '切换规则：5 小时额度用尽 → 停用到本窗口结束；周额度用尽 → 本周不再使用，等下周自动恢复。'),
              quotaError === '' ? null : h('p', { className: S.quotaError }, quotaError),
              h('div', { className: S.quotaHead, style: { marginTop: '6px' } }, [
                h('button', {
                  key: 'refresh', type: 'button', className: S.ghost,
                  disabled: quotaBusy,
                  onClick: () => refreshQuota(true),
                }, quotaBusy ? '刷新中…' : '刷新额度'),
                quota && quota.updatedAt
                  ? h('span', { key: 'at', className: S.quotaRef }, `更新于 ${timeText(quota.updatedAt)}`)
                  : null,
              ]),
              draft === null ? null : h('div', { className: S.switchRow, style: { marginTop: '8px' } }, [
                h('label', { key: 'quotaOn', title: '打开后：额度读到 0 的供应商会被提前跳过，直接走下一条路由' }, [
                  h('input', {
                    type: 'checkbox',
                    checked: draft.quota?.enabled !== false,
                    onChange: (event) => mutateDraft({ ...draft, quota: { ...draft.quota, enabled: event.target.checked } }),
                  }),
                  h('span', null, '额度用完自动切换'),
                ]),
              ]),
              draft === null || draft.routes.length === 0 ? null : h('div', { style: { marginTop: '8px' } }, [
                h('div', { className: S.sectionTitle }, '额度来源（可选，默认自动识别）'),
                ...Array.from(new Set(draft.routes.map((route) => route.provider))).map((provider) => h('div', {
                  key: provider,
                  className: S.quotaField,
                }, [
                  h('span', { key: 'name', className: S.quotaFieldName }, provider),
                  h('input', {
                    key: 'ref',
                    className: S.inputWide,
                    placeholder: '凭据引用，如 MINIMAX_CN_API_KEY',
                    value: draft.quota?.providers?.[provider]?.apiKeyEnv ?? '',
                    onChange: (event) => mutateDraft({
                      ...draft,
                      quota: {
                        ...draft.quota,
                        providers: {
                          ...(draft.quota?.providers ?? {}),
                          [provider]: {
                            ...(draft.quota?.providers?.[provider] ?? {}),
                            apiKeyEnv: event.target.value,
                          },
                        },
                      },
                    }),
                  }),
                  h('input', {
                    key: 'url',
                    className: S.inputWide,
                    placeholder: '接口地址（可留空）',
                    value: draft.quota?.providers?.[provider]?.baseUrl ?? '',
                    onChange: (event) => mutateDraft({
                      ...draft,
                      quota: {
                        ...draft.quota,
                        providers: {
                          ...(draft.quota?.providers ?? {}),
                          [provider]: {
                            ...(draft.quota?.providers?.[provider] ?? {}),
                            baseUrl: event.target.value,
                          },
                        },
                      },
                    }),
                  }),
                ])),
              ]),
            ]),
            h('section', { key: 'pool', className: S.section }, [
              h('h3', { className: S.sectionTitle }, `池子（按顺序兜底，共 ${draft ? draft.routes.length : 0} 条）`),
              draft === null
                ? h('p', { className: S.note }, '读取配置中…')
                : (draft.routes.length === 0
                  ? h('p', { className: S.note }, '还没有路由。下面从你已配置的供应商/模型里挑一个加入。')
                  : draft.routes.map((route, index) => h(PoolRow, {
                    key: `${route.provider}#${route.model}`,
                    index,
                    route,
                    total: draft.routes.length,
                    onMove: moveRoute,
                    onRemove: removeRoute,
                  }))),
              draft === null ? null : h('div', { className: S.switchRow, style: { marginTop: '8px' } }, [
                h('label', { key: 'preferFirst', title: '勾选后：总是先用池子里第一条（额度小的先用完），它额度用尽才换下一条，额度刷新后自动切回；不勾选则当前这条能用就不换' }, [
                  h('input', {
                    type: 'checkbox',
                    checked: draft.preferFirst === true,
                    onChange: (event) => mutateDraft({ ...draft, preferFirst: event.target.checked }),
                  }),
                  h('span', null, '优先用第一个套餐（先用额度小的，用完自动换大的）'),
                ]),
              ]),
              draft !== null && draft.routes.length > 0
                ? h('button', {
                  type: 'button', className: S.ghost, style: { marginTop: '2px' },
                  onClick: () => mutateDraft({ ...draft, routes: [] }),
                }, '清空池子')
                : null,
            ]),
            h('section', { key: 'add', className: S.section }, [
              h('h3', { className: S.sectionTitle }, '从已配置的模型里添加'),
              h('div', { className: S.addRow }, [
                h('select', {
                  key: 'provider', className: S.select,
                  value: activeProvider?.provider ?? '',
                  onChange: (event) => { setProviderId(event.target.value); setModelId('') },
                }, [
                  h('option', { key: '', value: '' }, providerGroups.length === 0 ? '没有可用供应商' : '选择供应商'),
                  ...providerGroups.map((group) => h('option', {
                    key: group.provider,
                    value: group.provider,
                  }, `${group.displayName}${group.displayName === group.provider ? '' : `（${group.provider}）`}`)),
                ]),
                h('select', {
                  key: 'model', className: S.select,
                  value: chosenModel,
                  onChange: (event) => setModelId(event.target.value),
                  disabled: availableModels.length === 0,
                }, availableModels.length === 0
                  ? [h('option', { key: '', value: '' }, activeProvider ? '这个供应商没有可用模型' : '先选供应商')]
                  : availableModels.map((model) => h('option', { key: model.id, value: model.id }, model.name))),
                h('button', {
                  key: 'add', type: 'button', className: S.primary,
                  disabled: !activeProvider || chosenModel === '',
                  onClick: addRoute,
                }, '加入池子'),
              ]),
              h('p', { className: S.note }, '列表顺序就是兜底顺序：上一条额度用完，自动换下一条。勾选「优先用第一个套餐」后，有额度就一直用第一条，额度刷新后也会自动切回第一条。'),
            ]),
            h('section', { key: 'params', className: S.section }, [
              h('h3', { className: S.sectionTitle }, '参数'),
              draft === null ? null : h('div', { className: S.switchRow }, [
                h('label', { key: 'cooldown' }, [
                  h('span', null, '失败后冷却（分钟）'),
                  h('input', {
                    className: S.input, type: 'number', min: 0, step: 1,
                    value: Math.round(Number(draft.cooldownMs) / 60000),
                    onChange: (event) => mutateDraft({ ...draft, cooldownMs: Math.max(0, Number(event.target.value) || 0) * 60000 }),
                  }),
                ]),
                h('label', { key: 'max' }, [
                  h('span', null, '每轮最多切换'),
                  h('input', {
                    className: S.input, type: 'number', min: 1, step: 1,
                    value: draft.maxSwitchesPerTurn,
                    onChange: (event) => mutateDraft({ ...draft, maxSwitchesPerTurn: Math.max(1, Number(event.target.value) || 1) }),
                  }),
                ]),
                h('label', { key: 'auth', title: '默认只把额度类错误当成切换条件；勾选后 401/403（key 失效等）也会触发切换' }, [
                  h('input', {
                    type: 'checkbox',
                    checked: draft.authTrigger === true,
                    onChange: (event) => mutateDraft({ ...draft, authTrigger: event.target.checked }),
                  }),
                  h('span', null, '认证失败（401/403）也切换'),
                ]),
              ]),
            ]),
            error === '' ? null : h('p', { key: 'error', className: S.error }, error),
            notice === '' ? null : h('p', { key: 'notice', className: S.notice }, notice),
          ]),
          h('footer', { key: 'footer', className: S.footer }, [
            h('button', {
              key: 'save', type: 'button', className: S.primary,
              disabled: !dirty || saving, onClick: save,
            }, saving ? '保存中…' : (dirty ? '保存' : '已保存')),
            h('span', { key: 'path', className: S.footerPath }, filePath),
          ]),
        ]),
        document.body,
      )
    }

    /** Sidebar footer entry (wide row, or round icon in the rail) + panel. */
    function KeypoolAction({ wide }) {
      const [open, setOpen] = useState(false)
      const [count, setCount] = useState(null)
      const [quotaPercent, setQuotaPercent] = useState(null)

      const readCount = useCallback(async () => {
        try {
          const body = await api('config')
          const base = body.stored ?? body.row
          const routes = []
          for (const pool of Array.isArray(base?.pools) ? base.pools : []) {
            for (const route of Array.isArray(pool.routes) ? pool.routes : []) routes.push(route)
          }
          setCount(routes.length)
        } catch {
          setCount(null)
        }
      }, [])
      useEffect(() => { readCount() }, [readCount])

      /** The lowest remaining quota percentage across the pooled providers. */
      const readQuota = useCallback(async () => {
        try {
          const body = await api('quota')
          const percents = []
          for (const entry of Array.isArray(body.providers) ? body.providers : []) {
            const model = entry.primary
            const percent = model?.interval?.percent ?? model?.weekly?.percent
            if (typeof percent === 'number' && Number.isFinite(percent)) percents.push(percent)
          }
          setQuotaPercent(percents.length === 0 ? null : Math.min(...percents))
        } catch {
          setQuotaPercent(null)
        }
      }, [])
      useEffect(() => {
        readQuota()
        const timer = setInterval(readQuota, 60000)
        return () => clearInterval(timer)
      }, [readQuota])

      const layerClass = wide ? S.layer : `${S.layer} ${S.rail}`
      return h(React.Fragment, null, [
        h('div', { key: 'layer', className: layerClass }, [
          h('div', { key: 'buttons', className: S.footerButtons }, [
            h('button', {
              key: 'badge',
              type: 'button',
              className: S.badge,
              'data-active': open ? '' : undefined,
              'aria-expanded': open,
              'aria-label': '多 Key 轮换池',
              title: '多 Key 轮换池',
              onClick: () => setOpen((value) => !value),
            }, [
              h(KeyIcon, { key: 'icon', size: wide ? 16 : 18 }),
              wide ? h('span', { key: 'label', className: S.badgeLabel }, '轮换池') : null,
              wide
                ? h('span', {
                  key: 'count',
                  className: quotaPercent !== null
                    ? `${S.badgeAmount} ${quotaTone(quotaPercent)}`
                    : (count !== null && count > 0 ? `${S.badgeAmount} ${S.badgeTone}` : S.badgeAmount),
                }, quotaPercent !== null
                  ? `${Math.round(quotaPercent)}%`
                  : (count === null ? '' : (count === 0 ? '未设置' : `${count} 条`)))
                : null,
            ]),
          ]),
        ]),
        open ? h(PoolPanel, { key: 'panel', onClose: () => setOpen(false), onSaved: setCount }) : null,
      ])
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'llm-keypool',
          order: 12,
        }, KeypoolAction))
      },
    }
  },
})
})()