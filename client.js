window.__ModuleLoader__.load({
  id: 'dsh-balance-corner',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState } = React
    // Shared with the shell module table, alongside react itself.
    const { createPortal } = require('react-dom')

    /** Dictionary namespace owned by this plugin. */
    const NS = 'dshBalance'
    /** Stable identity of the injected stylesheet. */
    const STYLE_ID = 'dsh-balance-corner/balance.css'
    /** How often the balance is re-read while the chip is on screen. */
    const REFRESH_INTERVAL_MS = 2 * 60 * 1000
    /** A reading younger than this is reused instead of asking the Host again. */
    const FRESH_FOR_MS = 60 * 1000
    /** Session activity re-reads the balance, but never more often than this. */
    const ACTIVITY_STALE_MS = 30 * 1000
    /** Below this total the chip turns into a top-up hint. */
    const LOW_BALANCE = 5
    /** Links used only when the account stream reports none. */
    const FALLBACK_LINKS = {
      usageUrl: 'https://platform.deepseek.com/usage',
      topUpUrl: 'https://platform.deepseek.com/top_up'
    }

    const zh = {
      'aria.ready': 'DeepSeek 余额 {amount}，点击查看用量',
      'aria.low': 'DeepSeek 余额 {amount}，余额不足，点击充值',
      'aria.failed': '余额读取失败，点击重试',
      'tip.balance': '充值余额：{amount}',
      'tip.bonus': '赠金余额：{amount}',
      'tip.bonusNone': '赠金余额：无',
      'tip.updated': '更新于 {time}',
      'tip.stale': '最近一次读取失败，显示的是上次的余额',
      'tip.low': '余额不足（低于 {threshold}），点击去充值',
      'tip.open': '点击查看用量明细',
      'tip.failed': '余额读取失败。点击重试。'
    }

    const en = {
      'aria.ready': 'DeepSeek balance {amount}. Click to open usage.',
      'aria.low': 'DeepSeek balance {amount}. Low balance — click to top up.',
      'aria.failed': 'Balance unavailable. Click to retry.',
      'tip.balance': 'Recharge balance: {amount}',
      'tip.bonus': 'Bonus balance: {amount}',
      'tip.bonusNone': 'Bonus balance: none',
      'tip.updated': 'Updated {time}',
      'tip.stale': 'The last read failed; this is the previous balance',
      'tip.low': 'Low balance (under {threshold}) — click to top up',
      'tip.open': 'Click for usage details',
      'tip.failed': 'Balance unavailable. Click to retry.'
    }

    const css = `
.dshbal_chip{box-sizing:border-box;display:inline-flex;align-items:center;height:28px;padding:0 8px;margin:0;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary,#a9a9a9);font-family:inherit;font-size:12px;font-weight:500;line-height:18px;font-variant-numeric:tabular-nums;white-space:nowrap;cursor:pointer;flex:none;transition:background-color .12s ease,color .12s ease}
.dshbal_chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#e6e6e6)}
.dshbal_chip:active{background:var(--dsw-alias-interactive-bg-active,rgba(255,255,255,.12))}
.dshbal_chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4c9ffe);outline-offset:1px}
.dshbal_chip[data-tone=warn]{color:var(--dsw-alias-state-warn-primary,#d29922)}
.dshbal_chip[data-tone=warn]:hover{background:var(--dsw-alias-state-warn-secondary,rgba(210,153,34,.12))}
.dshbal_chip[data-phase=loading],.dshbal_chip[data-phase=failed]{color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.dshbal_fallback{display:flex;justify-content:flex-end;width:100%;padding:0 3px}
@media (prefers-reduced-motion: reduce){.dshbal_chip{transition:none}}
`

    /** Currency glyph used when Intl cannot format one. */
    function symbolOf(currency) {
      return currency === 'USD' ? '$' : '¥'
    }

    /** Formats one Platform balance string for display, never inventing a zero. */
    function formatAmount(locale, currency, raw) {
      const value = Number(raw)
      if (!Number.isFinite(value)) return symbolOf(currency) + String(raw)
      try {
        return new Intl.NumberFormat(locale, {
          style: 'currency',
          currency,
          currencyDisplay: 'narrowSymbol',
          minimumFractionDigits: 2,
          maximumFractionDigits: 2
        }).format(value)
      } catch {
        return symbolOf(currency) + value.toFixed(2)
      }
    }

    /** @returns the wallet to show: yuan first, then whatever exists. */
    function pickWallet(wallets) {
      if (!Array.isArray(wallets) || wallets.length === 0) return null
      return wallets.find((wallet) => wallet !== null && wallet.currency === 'CNY') ?? wallets[0] ?? null
    }

    /** @returns the summed balance of the given wallets, NaN-free. */
    function totalOf(wallets) {
      if (!Array.isArray(wallets)) return 0
      let total = 0
      for (const wallet of wallets) {
        const value = Number(wallet?.balance)
        if (Number.isFinite(value)) total += value
      }
      return total
    }

    /** Local clock time for the reading, or null when unknown. */
    function formatClock(locale, at) {
      if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return null
      try {
        return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(at))
      } catch {
        return new Date(at).toISOString().slice(11, 16)
      }
    }

    /** The Host release version this page booted from, used as the client identity. */
    function releaseVersion() {
      const boot = globalThis.__DSH_BOOT__
      const version = boot !== null && typeof boot === 'object' && boot.release !== undefined ? boot.release.version : undefined
      return typeof version === 'string' && version !== '' ? version : '0.0.0'
    }

    /**
     * One shared balance reading for every mounted chip, so a re-mounted
     * sidebar reuses the last result instead of asking the Host again.
     * @param read - one reading; resolves the sanitized balance outcome.
     */
    function createBalanceStore(read) {
      let state = { phase: 'idle', wallets: [], bonus: [], links: null, at: null, error: null }
      const listeners = new Set()
      let inflight = null
      let timer = null
      let onFocus = null
      let disposed = false

      const publish = (next) => {
        state = next
        for (const listener of [...listeners]) listener(state)
      }
      const settle = (next) => {
        if (!disposed) publish(next)
      }
      const load = () => {
        if (disposed) return Promise.resolve()
        if (inflight !== null) return inflight
        if (state.phase === 'idle' || state.phase === 'failed') publish({ ...state, phase: 'loading' })
        inflight = Promise.resolve()
          .then(read)
          .then((outcome) => {
            if (outcome === null || outcome === undefined) {
              settle({ phase: 'signed-out', wallets: [], bonus: [], links: null, at: Date.now(), error: null })
              return
            }
            if (outcome.balance !== null && outcome.balance.status === 'ready') {
              settle({
                phase: 'ready',
                wallets: Array.isArray(outcome.balance.value) ? outcome.balance.value : [],
                bonus: Array.isArray(outcome.balance.bonusWallets) ? outcome.balance.bonusWallets : [],
                links: outcome.links,
                at: Date.now(),
                error: null
              })
              return
            }
            settle({ ...state, phase: 'failed', links: outcome.links ?? state.links, at: Date.now(), error: 'not-ready' })
          })
          .catch((error) => {
            const code = error !== null && typeof error === 'object' ? error.code ?? error.message ?? '' : String(error)
            settle({ ...state, phase: 'failed', at: Date.now(), error: String(code) })
          })
          .finally(() => {
            inflight = null
          })
        return inflight
      }
      const refreshIfStale = (minAgeMs) => {
        if (state.at !== null && Date.now() - state.at < minAgeMs && state.phase !== 'failed' && state.phase !== 'idle') return
        void load()
      }
      const start = () => {
        if (timer !== null) return
        timer = setInterval(() => {
          void load()
        }, REFRESH_INTERVAL_MS)
        // Coming back from a top-up page in another window should not wait for the interval.
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          onFocus = () => refreshIfStale(FRESH_FOR_MS)
          window.addEventListener('focus', onFocus)
        }
      }
      const stop = () => {
        if (onFocus !== null && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
          window.removeEventListener('focus', onFocus)
        }
        onFocus = null
        if (timer === null) return
        clearInterval(timer)
        timer = null
      }

      return {
        getSnapshot: () => state,
        subscribe(listener) {
          listeners.add(listener)
          start()
          return () => {
            listeners.delete(listener)
            if (listeners.size === 0) stop()
          }
        },
        refreshIfStale,
        refresh: () => void load(),
        dispose() {
          disposed = true
          stop()
          listeners.clear()
        }
      }
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.account'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-balance: dictionaries')
        ctx.effect(() => {
          if (typeof document === 'undefined') return () => {}
          const existing = document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_ID) + ']')
          if (existing !== null) existing.remove()
          const tag = document.createElement('style')
          tag.dataset.plugin = 'dsh-balance-corner'
          tag.dataset.pluginCss = STYLE_ID
          tag.textContent = css
          document.head.appendChild(tag)
          return () => {
            tag.remove()
          }
        }, 'dsh-balance: styles')

        /**
         * The account row at the sidebar foot: the settings launcher, the
         * connection dot and the update badge. The shell renders it without a
         * trailing slot, so the balance joins the row as its last child.
         * @returns the row element, or null before the sidebar mounts.
         */
        const findAccountRow = () => {
          if (typeof document === 'undefined') return null
          const byClass = document.querySelector('[class*="_triggerRow"]')
          if (byClass !== null) return byClass
          const trigger = document.querySelector('button[aria-haspopup="dialog"]')
          return trigger !== null ? trigger.parentElement : null
        }

        /** Active UI language, read at call time so the request carries the current one. */
        const localeNow = () => {
          const snapshot = typeof ctx.locale.getSnapshot === 'function' ? ctx.locale.getSnapshot() : undefined
          const active = snapshot !== undefined && snapshot !== null ? snapshot.active : undefined
          return typeof active === 'string' && active !== '' ? active : 'en'
        }

        /** The client identity the account Remote methods expect. */
        const clientIdentity = () => ({
          version: releaseVersion(),
          locale: localeNow(),
          timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60
        })

        /** Read both halves of what the chip needs; links come from the account state. */
        const read = async () => {
          const [balance, state] = await Promise.all([
            ctx.remote.account.getBalance(clientIdentity()),
            Promise.resolve()
              .then(() => ctx.remote.account.getState())
              .catch(() => null)
          ])
          if (balance === null || balance === undefined) return null
          if (!balance.ok) throw balance.error ?? new Error('account balance failed')
          // A null outcome is a signed-out account: there is nothing to show.
          if (balance.value === null || balance.value === undefined) return null
          const links = state !== null && state !== undefined && state.ok && state.value !== null && state.value !== undefined ? state.value.links ?? null : null
          return { balance: balance.value, links: links ?? null }
        }

        /**
         * Route prefix under the page's own `<base href>`, the same one the ego
         * plugin's client uses for its `/api/ego/*` calls, so a reverse-proxy
         * mount keeps working.
         * @returns the prefix, or an empty string at the origin root.
         */
        const apiBase = () => {
          try {
            const base = document.querySelector('base[href]')
            if (base === null) return ''
            const path = new URL(base.getAttribute('href') || './', document.baseURI).pathname.replace(/\/+$/, '')
            return path === '/' ? '' : path
          } catch {
            return ''
          }
        }

        /** The agent-browser tab kind the ego plugin registers into the right sidebar. */
        const EGO_PANEL_KIND = 'ego-browser:watch'

        /**
         * Hand the URL to the ego-browser plugin so the page opens in the agent
         * browser (which carries the imported Chrome login), instead of the
         * in-app tab. Reveal its side panel first so the page lands somewhere
         * visible; every step is best effort.
         * @param url - page to open.
         * @returns whether ego accepted the navigation.
         */
        const openInEgoBrowser = async (url) => {
          try {
            const sidebar = typeof ctx.get === 'function' ? ctx.get('sidebarRight') : undefined
            try {
              if (sidebar !== null && sidebar !== undefined && typeof sidebar.openTab === 'function') sidebar.openTab(EGO_PANEL_KIND)
            } catch {}
            const res = await fetch(apiBase() + '/api/ego/navigate', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ url })
            })
            if (!res.ok) return false
            const data = await res.json().catch(() => null)
            return data === null || data.ok !== false
          } catch {
            return false
          }
        }

        /** Open a platform page the way the rest of the client does: in-app tab first. */
        const openUrl = (url) => {
          if (typeof url !== 'string' || url === '') return
          try {
            const sidebar = typeof ctx.get === 'function' ? ctx.get('sidebarRight') : undefined
            const tabs = typeof ctx.get === 'function' ? ctx.get('sidebarRightTabs') : undefined
            if (sidebar !== undefined && sidebar !== null && typeof sidebar.openTab === 'function' && tabs !== undefined && tabs !== null && typeof tabs.get === 'function' && tabs.get('browser') !== undefined) {
              sidebar.openTab('browser', { params: { url } })
              return
            }
          } catch {}
          if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer')
        }

        const store = createBalanceStore(read)
        ctx.effect(() => () => store.dispose(), 'dsh-balance: reading')

        /** The account balance, right-aligned inside the sidebar's account row. */
        function BalanceChip({ wide, t, useSessions }) {
          const translate = typeof t === 'function' ? t : (key) => key
          const [snapshot, setSnapshot] = useState(() => store.getSnapshot())
          const [row, setRow] = useState(null)

          useEffect(() => store.subscribe(setSnapshot), [])
          useEffect(() => {
            store.refreshIfStale(FRESH_FOR_MS)
          }, [])

          // Any session activity may have spent tokens; re-read, at most once a minute.
          const activity = useSessions((state) => {
            if (state === undefined || state === null || state.byId === undefined || state.byId === null) return 0
            let latest = 0
            for (const key in state.byId) {
              const stamp = state.byId[key]?.updatedAt
              if (typeof stamp === 'number' && stamp > latest) latest = stamp
            }
            return latest
          })
          useEffect(() => {
            store.refreshIfStale(ACTIVITY_STALE_MS)
          }, [activity])

          // The row belongs to the shell and can be replaced across re-renders.
          useEffect(() => {
            if (wide === false) {
              setRow(null)
              return () => {}
            }
            let current = findAccountRow()
            setRow(current)
            const timer = setInterval(() => {
              if (current !== null && current.isConnected) return
              current = findAccountRow()
              setRow(current)
            }, 2000)
            return () => clearInterval(timer)
          }, [wide])

          if (snapshot.phase === 'signed-out') return null

          const locale = localeNow()
          const primary = pickWallet(snapshot.wallets)
          const bonus = pickWallet(snapshot.bonus)
          const bonusTotal = totalOf(snapshot.bonus)
          const total = totalOf(snapshot.wallets)
          const low = snapshot.phase === 'ready' && total < LOW_BALANCE

          const shown = primary !== null ? formatAmount(locale, primary.currency, primary.balance) : null
          const bonusShown = bonus !== null ? formatAmount(locale, bonus.currency, bonus.balance) : null
          const clock = formatClock(locale, snapshot.at)
          /** A finished read with no wallet to show is unavailable, not still loading. */
          const unavailable = shown === null && (snapshot.phase === 'failed' || snapshot.phase === 'ready')

          const valueText = shown ?? (unavailable ? '--' : '\u2026')
          const label =
            shown !== null
              ? translate(low ? 'aria.low' : 'aria.ready', { amount: shown })
              : unavailable
                ? translate('aria.failed')
                : translate('aria.ready', { amount: '\u2026' })

          const lines = []
          if (shown !== null) {
            lines.push(translate('tip.balance', { amount: shown }))
            lines.push(bonusTotal > 0 && bonusShown !== null ? translate('tip.bonus', { amount: bonusShown }) : translate('tip.bonusNone'))
            lines.push(snapshot.phase === 'failed' ? translate('tip.stale') : clock === null ? '' : translate('tip.updated', { time: clock }))
            lines.push(low ? translate('tip.low', { threshold: String(LOW_BALANCE) }) : translate('tip.open'))
          } else if (unavailable) {
            lines.push(translate('tip.failed'))
            if (snapshot.error !== null) lines.push(snapshot.error)
          }
          const title = lines.filter((line) => line !== '').join('\n')

          const open = () => {
            if (snapshot.phase === 'failed') {
              store.refresh()
              return
            }
            const links = snapshot.links ?? FALLBACK_LINKS
            const target = low ? links.topUpUrl : links.usageUrl
            // Prefer the agent browser (ego plugin) so the platform page opens
            // with the imported Chrome login; fall back to the in-app tab.
            void openInEgoBrowser(target).then((opened) => {
              if (!opened) openUrl(target)
            })
          }

          const chip = h(
            'button',
            {
              type: 'button',
              className: 'dshbal_chip',
              'data-phase': snapshot.phase,
              'data-tone': low ? 'warn' : undefined,
              title: title === '' ? label : title,
              'aria-label': label,
              onClick: open
            },
            valueText
          )

          if (row !== null && typeof createPortal === 'function') return createPortal(chip, row)
          // Before the account row exists (or if it moved), stay in the footer seat.
          if (row === null && wide !== false) return h('div', { className: 'dshbal_fallback' }, chip)
          return null
        }

        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'dsh-balance',
              order: 50,
              locale: NS
            },
            BalanceChip
          )
        )
      }
    }
  }
})
