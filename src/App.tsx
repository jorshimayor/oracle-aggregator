import { useState, useEffect, useCallback, useRef, useId } from 'react'
import {
  useAccount, useReadContract, useWriteContract,
  useWaitForTransactionReceipt, useSwitchChain,
} from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import { erc20Abi, parseUnits, formatUnits } from 'viem'
import { arcTestnet, arc } from 'viem/chains'
import type { Chain } from 'viem'
import { toast } from 'sonner'
import {
  ArrowRight, Lock, TrendingUp, BarChart3,
  RefreshCw, Globe, Activity, ChevronDown, ExternalLink,
} from 'lucide-react'

// ── Network ──────────────────────────────────────────────────────────────────
type Network = 'testnet' | 'mainnet'

const CHAINS: Record<Network, { chain: Chain; chainId: number; usdc: `0x${string}`; label: string; explorer: string }> = {
  testnet: {
    chain: arcTestnet,
    chainId: arcTestnet.id,
    usdc: (import.meta.env.VITE_USDC_TESTNET as `0x${string}` | undefined) ?? '0x3600000000000000000000000000000000000001',
    label: 'Arc Testnet',
    explorer: 'https://explorer.testnet.arc.io',
  },
  mainnet: {
    chain: arc,
    chainId: arc.id,
    usdc: '0x3600000000000000000000000000000000000000',
    label: 'Arc Mainnet',
    explorer: 'https://explorer.arc.io',
  },
}

// Contract addresses from env (set at build time)
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
const CONTRACTS: Record<Network, { vault: string; oracle: string; rateLock: string }> = {
  testnet: {
    vault: (import.meta.env.VITE_TESTNET_VAULT as string | undefined) ?? '',
    oracle: (import.meta.env.VITE_TESTNET_PUSH_ORACLE as string | undefined) ?? '',
    rateLock: (import.meta.env.VITE_TESTNET_RATELOCK as string | undefined) ?? '',
  },
  mainnet: {
    vault: (import.meta.env.VITE_MAINNET_VAULT as string | undefined) ?? '',
    oracle: (import.meta.env.VITE_MAINNET_PUSH_ORACLE as string | undefined) ?? '',
    rateLock: (import.meta.env.VITE_MAINNET_RATELOCK as string | undefined) ?? '',
  },
}
/* eslint-enable @typescript-eslint/no-unsafe-assignment */

// USD/NGN bytes32 — right-padded ASCII
const USD_NGN_PAIR = '0x5553442f4e474e00000000000000000000000000000000000000000000000000' as `0x${string}`

// ── ABIs ──────────────────────────────────────────────────────────────────────
const VAULT_ABI = [
  { name: 'deposit', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'usdcAmount', type: 'uint256' }], outputs: [] },
  { name: 'withdraw', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'sharesToBurn', type: 'uint256' }], outputs: [] },
  { name: 'shares', type: 'function', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'totalShares', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'availableBalance', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const

const ORACLE_ABI = [
  { name: 'latestData', type: 'function', stateMutability: 'view', inputs: [{ name: 'pair', type: 'bytes32' }], outputs: [{ name: 'rate1e8', type: 'uint256' }, { name: 'updatedAt', type: 'uint256' }] },
] as const

const RATELOCK_ABI = [
  { name: 'openLock', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'pair', type: 'bytes32' }, { name: 'usdcIn', type: 'uint256' }, { name: 'lockedRate1e8', type: 'uint256' }, { name: 'expiry', type: 'uint64' }, { name: 'payoutTo', type: 'address' }], outputs: [{ name: 'id', type: 'uint256' }] },
  { name: 'settle', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'id', type: 'uint256' }], outputs: [] },
  { name: 'quotePremium', type: 'function', stateMutability: 'view', inputs: [{ name: 'usdcIn', type: 'uint256' }, { name: 'pair', type: 'bytes32' }], outputs: [{ type: 'uint256' }] },
  { name: 'nextId', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'locks', type: 'function', stateMutability: 'view', inputs: [{ name: 'id', type: 'uint256' }], outputs: [{ name: 'pair', type: 'bytes32' }, { name: 'usdcIn', type: 'uint256' }, { name: 'lockedRate1e8', type: 'uint256' }, { name: 'lockedLocal', type: 'uint256' }, { name: 'reserved', type: 'uint256' }, { name: 'expiry', type: 'uint64' }, { name: 'taker', type: 'address' }, { name: 'payoutTo', type: 'address' }, { name: 'status', type: 'uint8' }] },
] as const

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt6 = (v: bigint) => Number(formatUnits(v, 6)).toFixed(2)
const fmtRate = (r: bigint) => (Number(r) / 1e8).toFixed(2)
const fmtNum = (n: number, dp = 2) => n.toFixed(dp)
const explorerTx = (hash: string, net: Network) => `${CHAINS[net].explorer}/tx/${hash}`

// ── Oracle aggregator types ───────────────────────────────────────────────────
interface OracleQuote {
  source: string
  price: number
  updatedAt: number
  confidence?: number
  staleSecs?: number
  error?: string
}

interface AggregatedPrice {
  pair: string
  network: Network
  bestPrice: number
  bestSource: string
  quotes: OracleQuote[]
  fetchedAt: number
}

// ── API URL ───────────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? ''

// ── Browser-side oracle aggregation (used when API_BASE is empty) ─────────────
// Mirrors the server's free sources so prices display on the static Netlify deploy.
type FxCacheEntry = { data: Record<string, number>; ts: number }
let erCache: FxCacheEntry | null = null
let fawazCache: FxCacheEntry | null = null
const BROWSER_TTL = 300_000 // 5 min

async function browserFetchErApi(): Promise<Record<string, number>> {
  if (erCache && Date.now() - erCache.ts < BROWSER_TTL) return erCache.data
  const r = await fetch('https://open.er-api.com/v6/latest/USD')
  if (!r.ok) throw new Error(`ExchangeRate-API ${r.status}`)
  const j = await r.json() as { rates: Record<string, number> }
  erCache = { data: j.rates, ts: Date.now() }
  return j.rates
}

async function browserFetchFawaz(): Promise<Record<string, number>> {
  if (fawazCache && Date.now() - fawazCache.ts < BROWSER_TTL) return fawazCache.data
  const r = await fetch('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json')
  if (!r.ok) throw new Error(`Fawaz ${r.status}`)
  const j = await r.json() as { usd: Record<string, number> }
  fawazCache = { data: j.usd, ts: Date.now() }
  return j.usd
}

async function browserFetchDia(quoteCurrency: string): Promise<number | null> {
  const supported = new Set(['NGN', 'EUR', 'GBP', 'BRL', 'JPY', 'CHF'])
  if (!supported.has(quoteCurrency)) return null
  const r = await fetch(`https://api.diadata.org/v1/rwa/Fiat/${quoteCurrency}-USD`)
  if (!r.ok) return null
  const j = await r.json() as { Price: number }
  return j.Price > 0 ? 1 / j.Price : null
}

async function browserAggregatePair(pair: string, network: Network): Promise<AggregatedPrice> {
  const nowSec = Math.floor(Date.now() / 1000)
  const [, quote] = pair.split('/')
  const isFx = ['NGN','KES','GHS','ZAR','EGP','TZS','UGX','XOF'].includes(quote ?? '')

  const quotes: OracleQuote[] = []

  if (isFx && quote) {
    const q = quote.toLowerCase()
    await Promise.allSettled([
      browserFetchErApi().then(rates => {
        const price = rates[quote]
        if (price) quotes.push({ source: 'ExchangeRate-API', price, updatedAt: nowSec, staleSecs: 0 })
      }),
      browserFetchFawaz().then(rates => {
        const price = rates[q]
        if (price) quotes.push({ source: 'Fawaz Currency API', price, updatedAt: nowSec, staleSecs: 0 })
      }),
      browserFetchDia(quote).then(price => {
        if (price) quotes.push({ source: 'DIA', price, updatedAt: nowSec, staleSecs: 0 })
      }),
    ])
  } else {
    // Crypto pairs: try CoinGecko public API (no key needed)
    const cgId: Record<string, string> = { 'ETH/USD': 'ethereum', 'BTC/USD': 'bitcoin', 'LINK/USD': 'chainlink', 'USDC/USD': 'usd-coin' }
    const id = cgId[pair]
    if (id) {
      try {
        const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`)
        if (r.ok) {
          const j = await r.json() as Record<string, { usd: number }>
          const price = j[id]?.usd
          if (price) quotes.push({ source: 'CoinGecko', price, updatedAt: nowSec, staleSecs: 0 })
        }
      } catch { /* silent */ }
    }
  }

  if (quotes.length === 0) return { pair, network, bestPrice: 0, bestSource: 'none', quotes: [{ source: 'none', price: 0, updatedAt: 0, error: 'no sources available' }], fetchedAt: nowSec }

  const sorted = [...quotes].filter(q => q.price > 0).sort((a, b) => a.price - b.price)
  const mid = sorted[Math.floor(sorted.length / 2)] ?? sorted[0]
  return { pair, network, bestPrice: mid?.price ?? 0, bestSource: mid?.source ?? 'none', quotes, fetchedAt: nowSec }
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
type Tab = 'prices' | 'vault' | 'lock' | 'settle'

// ── Tooltip ───────────────────────────────────────────────────────────────────
// Accessible: shows on hover (desktop) and tap/focus (mobile). Positioned above
// the trigger. Keyboard-friendly: visible on focus, dismissed on Escape.
function Tooltip({ content, children }: { content: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const ref = useRef<HTMLSpanElement>(null)

  // Close on Escape or outside click
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onOutside = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onOutside)
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onOutside) }
  }, [open])

  return (
    <span
      ref={ref}
      className="relative inline-flex items-center"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onClick={() => setOpen(v => !v)}
    >
      {children}
      <span
        role="tooltip"
        id={id}
        aria-hidden={!open}
        className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 w-52 -translate-x-1/2 rounded-xl px-3 py-2 text-xs leading-relaxed text-center transition-all duration-150"
        style={{
          background: 'rgba(15,23,42,0.97)',
          border: '1px solid rgba(172,198,233,0.18)',
          color: '#cbd5e1',
          boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
          opacity: open ? 1 : 0,
          transform: `translateX(-50%) translateY(${open ? '0px' : '4px'})`,
          backdropFilter: 'blur(12px)',
          whiteSpace: 'normal',
        }}
      >
        {content}
        {/* Arrow */}
        <span
          className="absolute left-1/2 top-full -translate-x-1/2 block"
          style={{
            width: 0, height: 0,
            borderLeft: '6px solid transparent',
            borderRight: '6px solid transparent',
            borderTop: '6px solid rgba(15,23,42,0.97)',
          }}
        />
      </span>
    </span>
  )
}

// ── Tab descriptions (shown as tooltips on the tab bar) ───────────────────────
const TAB_TIPS: Record<Tab, string> = {
  prices: 'Live FX and crypto rates aggregated from 7 oracle sources — DIA, Chainlink, Pyth, ExchangeRate-API, and more. Refreshes every 30s.',
  vault:  'Deposit USDC into the liquidity pool to earn premiums from rate-lock takers. Withdraw your share anytime. Your share grows as locks settle in your favour.',
  lock:   'Lock in today\'s USD/NGN exchange rate for up to 30 days. Pay a small premium and receive the difference if the rate moves against you at settlement.',
  settle: 'After a lock expires, settle it to receive your payout. The contract compares the locked rate to the current on-chain oracle rate and pays the difference.',
}

// ════════════════════════════════════════════════════════════════════════════════
// NetworkToggle
// ════════════════════════════════════════════════════════════════════════════════
function NetworkToggle({ network, onChange }: { network: Network; onChange: (n: Network) => void }) {
  return (
    <div className="flex items-center gap-1 rounded-xl p-1" style={{ background: 'var(--surface-muted)' }}>
      {(['testnet', 'mainnet'] as Network[]).map(n => (
        <button
          key={n}
          onClick={() => onChange(n)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition"
          style={{
            background: network === n ? 'var(--surface-strong)' : 'transparent',
            color: network === n ? 'var(--ink)' : 'var(--subtle)',
            boxShadow: network === n ? '0 1px 4px rgba(0,0,0,0.25)' : 'none',
          }}
        >
          <Globe size={12} />
          {n === 'testnet' ? 'Testnet' : 'Mainnet'}
          {n === 'mainnet' && <span className="text-[9px] px-1 rounded" style={{ background: 'rgba(186,43,76,0.25)', color: '#fca5a5' }}>LIVE</span>}
        </button>
      ))}
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════════
// WrongChainBanner
// ════════════════════════════════════════════════════════════════════════════════
function WrongChainBanner({ network }: { network: Network }) {
  const { chainId } = useAccount()
  const { switchChain, isPending } = useSwitchChain()
  const target = CHAINS[network].chainId
  if (chainId === target) return null
  return (
    <div className="mb-4 flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium"
      style={{ background: 'rgba(186,43,76,0.18)', border: '1px solid var(--danger)', color: '#fca5a5' }}>
      <span style={{ color: 'var(--danger)' }}>Switch to {CHAINS[network].label} to transact.</span>
      <button
        onClick={() => switchChain({ chainId: target })}
        disabled={isPending}
        className="ml-auto rounded-lg px-3 py-1 text-xs font-semibold transition"
        style={{ background: 'var(--danger)', color: '#fff' }}>
        {isPending ? 'Switching…' : 'Switch Network'}
      </button>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════════
// OracleDashboard — the main prices tab
// ════════════════════════════════════════════════════════════════════════════════
const FX_PAIRS   = ['USD/NGN', 'USD/KES', 'USD/GHS', 'USD/ZAR', 'USD/EGP', 'USD/TZS', 'USD/UGX', 'USD/XOF']
const CRYPTO_PAIRS = ['ETH/USD', 'BTC/USD', 'LINK/USD', 'USDC/USD']

// Source colours: each oracle gets a distinct accent
const SOURCE_COLORS: Record<string, string> = {
  'PushRateOracle':     '#acc6e9', // arc blue
  'Chainlink':          '#375bd2', // chainlink navy
  'DIA':                '#e87a41', // DIA orange
  'Pyth':               '#9945ff', // pyth purple
  'ExchangeRate-API':   '#8dd89f', // green
  'Fawaz Currency API': '#f0c040', // gold
  'CurrencyAPI Mirror': '#a0a0c0', // muted
  'CoinGecko':          '#8df5c6', // coingecko mint
}
function sourceColor(s: string) { return SOURCE_COLORS[s] ?? 'var(--accent)' }

// Decimals to show for a given quote currency
function pairDp(pair: string) {
  const q = pair.split('/')[1] ?? ''
  if (['ZAR', 'TZS', 'UGX', 'XOF'].includes(q)) return 0
  if (['NGN', 'KES', 'EGP'].includes(q)) return 2
  return 4 // crypto
}

function PairRow({ pair, network, isSelected, onSelect }: { pair: string; network: Network; isSelected: boolean; onSelect: () => void }) {
  const [data, setData] = useState<AggregatedPrice | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      if (API_BASE) {
        // Server available — use REST API
        const encoded = pair.replace('/', '-')
        const res = await fetch(`${API_BASE}/price/${encoded}?network=${network}`)
        if (res.ok) setData(await res.json() as AggregatedPrice)
      } else {
        // Static deploy — aggregate directly in the browser
        const result = await browserAggregatePair(pair, network)
        setData(result)
      }
    } catch { /* silent */ }
    finally { setLoading(false) }
  }, [pair, network])

  // eslint-disable-next-line react/set-state-in-effect -- async data fetch, state update is intentional
  useEffect(() => { void refresh() }, [refresh])

  // Auto-refresh every 30s
  useEffect(() => {
    const t = setInterval(() => { void refresh() }, 30_000)
    return () => clearInterval(t)
  }, [refresh])

  const [base, quote] = pair.split('/')
  const dp = pairDp(pair)
  const validQuotes = data?.quotes.filter(q => q.price > 0 && !q.error) ?? []
  const spread = validQuotes.length >= 2
    ? ((Math.max(...validQuotes.map(q => q.price)) - Math.min(...validQuotes.map(q => q.price))) / (data?.bestPrice ?? 1) * 100).toFixed(2)
    : null

  return (
    <div
      className="rounded-xl p-4 cursor-pointer transition"
      onClick={onSelect}
      style={{
        background: isSelected ? 'var(--surface-strong)' : 'var(--surface)',
        border: `1px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}`,
      }}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="display font-bold text-base" style={{ color: 'var(--ink)' }}>{base}</span>
          <span className="text-xs" style={{ color: 'var(--subtle)' }}>/{quote}</span>
        </div>
        <div className="flex items-center gap-2">
          {/* source dots */}
          {validQuotes.map(q => (
            <span key={q.source} title={q.source} className="w-2 h-2 rounded-full" style={{ background: sourceColor(q.source) }} />
          ))}
          {loading && <RefreshCw size={12} className="animate-spin" style={{ color: 'var(--subtle)' }} />}
          <ChevronDown size={14} style={{ color: 'var(--subtle)', transform: isSelected ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
        </div>
      </div>

      <div className="flex items-end justify-between">
        <div>
          <p className="display text-2xl font-semibold tabular" style={{ color: 'var(--ink)' }}>
            {data?.bestPrice ? fmtNum(data.bestPrice, dp) : '—'}
          </p>
          <p className="text-xs mt-0.5" style={{ color: sourceColor(data?.bestSource ?? '') }}>
            {data?.bestSource ?? 'loading…'}
          </p>
        </div>
        <div className="text-right">
          {spread && (
            <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(172,198,233,0.12)', color: 'var(--accent)' }}>
              ±{spread}% spread
            </span>
          )}
          <p className="text-xs mt-1" style={{ color: 'var(--subtle)' }}>
            {data ? `${validQuotes.length}/${data.quotes.length} sources` : ''}
          </p>
        </div>
      </div>

      {/* Source breakdown (expanded) */}
      {isSelected && data && (
        <div className="mt-3 pt-3 space-y-2" style={{ borderTop: '1px solid var(--border)' }}>
          <p className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: 'var(--subtle)', letterSpacing: '0.08em' }}>All sources</p>
          {data.quotes.map(q => (
            <div key={q.source} className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: q.error ? 'var(--danger)' : sourceColor(q.source) }} />
                <span style={{ color: q.error ? 'var(--subtle)' : 'var(--ink-2)' }}>{q.source}</span>
                {q.source === 'PushRateOracle' && <span className="text-[9px] px-1 rounded" style={{ background: 'rgba(172,198,233,0.15)', color: 'var(--accent)' }}>on-chain</span>}
                {q.source === 'Chainlink' && <span className="text-[9px] px-1 rounded" style={{ background: 'rgba(55,91,210,0.2)', color: '#7fa8f7' }}>Ethereum</span>}
                {q.source === 'DIA' && <span className="text-[9px] px-1 rounded" style={{ background: 'rgba(232,122,65,0.15)', color: '#e87a41' }}>decentralized</span>}
                {q.source === 'Pyth' && <span className="text-[9px] px-1 rounded" style={{ background: 'rgba(153,69,255,0.15)', color: '#9945ff' }}>pull model</span>}
              </div>
              <div className="text-right">
                {q.error ? (
                  <span style={{ color: 'var(--subtle)' }}>{q.error.slice(0, 45)}</span>
                ) : (
                  <>
                    <span className="tabular font-semibold" style={{ color: q.source === data.bestSource ? 'var(--success)' : 'var(--ink-2)' }}>
                      {fmtNum(q.price, dp)}
                    </span>
                    {q.staleSecs !== undefined && (
                      <span className="ml-2" style={{ color: q.staleSecs > 3600 ? 'var(--danger)' : 'var(--subtle)' }}>
                        {q.staleSecs < 60 ? `${q.staleSecs}s` : `${Math.floor(q.staleSecs / 60)}m`} ago
                      </span>
                    )}
                    {q.confidence !== undefined && q.confidence > 0 && (
                      <span className="ml-2" style={{ color: 'var(--subtle)' }}>±{fmtNum(q.confidence, dp)}</span>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function OracleDashboard({ network }: { network: Network }) {
  const [selected, setSelected] = useState<string | null>('USD/NGN')
  const [showCrypto, setShowCrypto] = useState(false)

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 mb-2">
        <Activity size={14} style={{ color: 'var(--accent)' }} />
        <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--subtle)', letterSpacing: '0.08em' }}>Live Rates · USD Base</p>
        <span className="ml-auto text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(141,216,159,0.12)', color: 'var(--success)' }}>30s</span>
      </div>

      {/* Category tabs */}
      <div className="flex gap-1 p-1 rounded-xl" style={{ background: 'var(--surface-muted)' }}>
        {[false, true].map(isCrypto => (
          <button key={String(isCrypto)} onClick={() => setShowCrypto(isCrypto)}
            className="flex-1 py-1.5 rounded-lg text-xs font-semibold transition"
            style={{ background: showCrypto === isCrypto ? 'var(--surface-strong)' : 'transparent', color: showCrypto === isCrypto ? 'var(--ink)' : 'var(--subtle)' }}>
            {isCrypto ? 'Crypto' : 'FX / African'}
          </button>
        ))}
      </div>

      {(showCrypto ? CRYPTO_PAIRS : FX_PAIRS).map(pair => (
        <PairRow
          key={pair}
          pair={pair}
          network={network}
          isSelected={selected === pair}
          onSelect={() => setSelected(selected === pair ? null : pair)}
        />
      ))}

      {/* Source legend */}
      <div className="rounded-xl p-3 mt-1" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <p className="text-xs font-semibold mb-2" style={{ color: 'var(--ink-2)' }}>Oracle sources</p>
        <div className="flex flex-wrap gap-x-3 gap-y-1.5">
          {Object.entries(SOURCE_COLORS).map(([name, color]) => (
            <span key={name} className="flex items-center gap-1 text-xs" style={{ color: 'var(--subtle)' }}>
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
              {name}
            </span>
          ))}
        </div>
      </div>

      {/* API hint */}
      <div className="rounded-xl p-3 text-xs" style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--subtle)' }}>
        <p className="font-semibold mb-1" style={{ color: 'var(--ink-2)' }}>Public Price API</p>
        <code style={{ color: 'var(--accent)' }}>GET /price/USD-NGN?network={network}</code>
        <p className="mt-1">WebSocket: <code style={{ color: 'var(--accent)' }}>ws://oracle.pesarc.xyz/ws</code></p>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════════
// VaultPanel
// ════════════════════════════════════════════════════════════════════════════════
function VaultPanel({ network }: { network: Network }) {
  const { address, chainId } = useAccount()
  const { switchChain } = useSwitchChain()
  const [amount, setAmount] = useState('')
  const [mode, setMode] = useState<'deposit' | 'withdraw'>('deposit')
  const chainId_ = CHAINS[network].chainId
  const USDC = CHAINS[network].usdc
  const VAULT = CONTRACTS[network].vault as `0x${string}`

  const { data: usdcBalance, refetch: refetchBalance } = useReadContract({
    address: USDC, abi: erc20Abi, functionName: 'balanceOf',
    args: address ? [address] : undefined, chainId: chainId_,
    query: { enabled: !!address },
  })
  const { data: myShares, refetch: refetchShares } = useReadContract({
    address: VAULT || undefined, abi: VAULT_ABI, functionName: 'shares',
    args: address ? [address] : undefined, chainId: chainId_,
    query: { enabled: !!address && !!VAULT },
  })
  const { data: totalShares } = useReadContract({
    address: VAULT || undefined, abi: VAULT_ABI, functionName: 'totalShares',
    chainId: chainId_, query: { enabled: !!VAULT },
  })
  const { data: availBal } = useReadContract({
    address: VAULT || undefined, abi: VAULT_ABI, functionName: 'availableBalance',
    chainId: chainId_, query: { enabled: !!VAULT },
  })
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: USDC, abi: erc20Abi, functionName: 'allowance',
    args: address && VAULT ? [address, VAULT] : undefined,
    chainId: chainId_, query: { enabled: !!address && !!VAULT },
  })

  const { writeContract, data: txHash, isPending, reset } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash })

  const parsedAmount = amount ? parseUnits(amount, 6) : 0n
  const needsApproval = mode === 'deposit' && allowance !== undefined && parsedAmount > allowance

  const handleAction = useCallback(() => {
    if (!address) return
    if (chainId !== chainId_) { switchChain({ chainId: chainId_ }); return }
    if (!VAULT) { toast.error('Vault not deployed on this network yet.'); return }
    if (mode === 'deposit') {
      if (needsApproval) {
        writeContract({ address: USDC, abi: erc20Abi, functionName: 'approve', args: [VAULT, parsedAmount] })
      } else {
        writeContract({ address: VAULT, abi: VAULT_ABI, functionName: 'deposit', args: [parsedAmount] })
      }
    } else {
      const sharesToBurn = parsedAmount * 1_000_000_000_000n
      writeContract({ address: VAULT, abi: VAULT_ABI, functionName: 'withdraw', args: [sharesToBurn] })
    }
  }, [address, chainId, chainId_, mode, parsedAmount, needsApproval, USDC, VAULT, switchChain, writeContract])

  if (isSuccess) {
    void refetchBalance(); void refetchShares(); void refetchAllowance()
    toast.success(<span>Done! <a href={explorerTx(txHash!, network)} target="_blank" rel="noopener" className="underline">View on explorer</a></span>)
    reset()
  }

  const lpShareValue = myShares && totalShares && availBal && totalShares > 0n
    ? (myShares * availBal) / totalShares : 0n

  return (
    <div className="space-y-4">
      {!VAULT && (
        <div className="rounded-xl p-3 text-xs text-center" style={{ background: 'rgba(186,43,76,0.1)', color: '#fca5a5', border: '1px solid var(--danger)' }}>
          LiquidityVault not deployed on {CHAINS[network].label} yet.
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <StatCard label="Your USDC" value={usdcBalance !== undefined ? `${fmt6(usdcBalance)} USDC` : '—'} />
        <StatCard label="Your Pool Value" value={myShares !== undefined ? `${fmt6(lpShareValue)} USDC` : '—'} />
      </div>
      {availBal !== undefined && (
        <p className="text-xs" style={{ color: 'var(--subtle)' }}>
          Pool available: <span className="tabular" style={{ color: 'var(--muted)' }}>{fmt6(availBal)} USDC</span>
        </p>
      )}
      <div className="flex rounded-xl overflow-hidden" style={{ background: 'var(--surface-muted)' }}>
        {(['deposit', 'withdraw'] as const).map(m => (
          <button key={m} onClick={() => setMode(m)}
            className="flex-1 py-2 text-sm font-semibold capitalize transition"
            style={{ background: mode === m ? 'var(--accent)' : 'transparent', color: mode === m ? '#0d1b2f' : 'var(--muted)' }}>
            {m}
          </button>
        ))}
      </div>
      <AmountInput value={amount} onChange={setAmount} label="USDC amount" placeholder="0.00" />
      <ActionButton
        onClick={handleAction} isPending={isPending} isConfirming={isConfirming}
        disabled={!parsedAmount}
        label={needsApproval ? 'Approve USDC' : mode === 'deposit' ? 'Deposit to Pool' : 'Withdraw from Pool'}
      />
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════════
// LockPanel
// ════════════════════════════════════════════════════════════════════════════════
function LockPanel({ network }: { network: Network }) {
  const { address, chainId } = useAccount()
  const { switchChain } = useSwitchChain()
  const [usdcIn, setUsdcIn] = useState('')
  const [days, setDays] = useState('7')
  const chainId_ = CHAINS[network].chainId
  const USDC = CHAINS[network].usdc
  const RATELOCK = CONTRACTS[network].rateLock as `0x${string}`
  const ORACLE = CONTRACTS[network].oracle as `0x${string}`

  const { data: oracleData } = useReadContract({
    address: ORACLE || undefined, abi: ORACLE_ABI, functionName: 'latestData',
    args: [USD_NGN_PAIR], chainId: chainId_,
    query: { enabled: !!ORACLE, refetchInterval: 30_000 },
  })
  const currentRate = oracleData?.[0] ?? 0n
  const updatedAt = oracleData?.[1] ?? 0n
  const parsedUsdcIn = usdcIn ? parseUnits(usdcIn, 6) : 0n
  const { data: premium } = useReadContract({
    address: RATELOCK || undefined, abi: RATELOCK_ABI, functionName: 'quotePremium',
    args: parsedUsdcIn > 0n ? [parsedUsdcIn, USD_NGN_PAIR] : undefined,
    chainId: chainId_, query: { enabled: !!RATELOCK && parsedUsdcIn > 0n },
  })
  const lockedLocal = parsedUsdcIn > 0n && currentRate > 0n
    ? (parsedUsdcIn * currentRate) / 100_000_000n : 0n
  const totalNeeded = parsedUsdcIn + (premium ?? 0n)
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: USDC, abi: erc20Abi, functionName: 'allowance',
    args: address && RATELOCK ? [address, RATELOCK] : undefined,
    chainId: chainId_, query: { enabled: !!address && !!RATELOCK },
  })
  const needsApproval = allowance !== undefined && totalNeeded > allowance && totalNeeded > 0n

  const { writeContract, data: txHash, isPending, reset } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash })

  const handleAction = useCallback(() => {
    if (!address) return
    if (chainId !== chainId_) { switchChain({ chainId: chainId_ }); return }
    if (!RATELOCK) { toast.error('RateLock not deployed on this network yet.'); return }
    if (needsApproval) {
      writeContract({ address: USDC, abi: erc20Abi, functionName: 'approve', args: [RATELOCK, totalNeeded] })
    } else {
      const expiry = BigInt(Math.floor(Date.now() / 1000) + parseInt(days) * 86400)
      writeContract({ address: RATELOCK, abi: RATELOCK_ABI, functionName: 'openLock', args: [USD_NGN_PAIR, parsedUsdcIn, currentRate, expiry, address] })
    }
  }, [address, chainId, chainId_, needsApproval, parsedUsdcIn, currentRate, days, totalNeeded, USDC, RATELOCK, switchChain, writeContract])

  if (isSuccess) {
    void refetchAllowance()
    toast.success(<span>Lock opened! <a href={explorerTx(txHash!, network)} target="_blank" rel="noopener" className="underline">View on explorer <ExternalLink size={12} className="inline" /></a></span>)
    reset()
  }

  const [clockSec, setClockSec] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const t = setInterval(() => setClockSec(Math.floor(Date.now() / 1000)), 30_000)
    return () => clearInterval(t)
  }, [])
  const ageMinutes = updatedAt > 0n ? Math.floor((clockSec - Number(updatedAt)) / 60) : null

  return (
    <div className="space-y-4">
      {!RATELOCK && (
        <div className="rounded-xl p-3 text-xs text-center" style={{ background: 'rgba(186,43,76,0.1)', color: '#fca5a5', border: '1px solid var(--danger)' }}>
          RateLock not deployed on {CHAINS[network].label} yet.
        </div>
      )}
      <div className="rounded-xl p-4" style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}>
        <p className="text-xs uppercase tracking-widest mb-1" style={{ color: 'var(--subtle)', letterSpacing: '0.08em' }}>On-Chain Rate · USD/NGN</p>
        <p className="display text-3xl font-semibold" style={{ color: 'var(--ink)' }}>
          {currentRate > 0n ? `₦${fmtRate(currentRate)}` : '—'}
          <span className="text-base font-normal ml-2" style={{ color: 'var(--subtle)' }}>per USDC</span>
        </p>
        {ageMinutes !== null && (
          <p className="text-xs mt-1" style={{ color: ageMinutes > 120 ? 'var(--danger)' : 'var(--subtle)' }}>
            Updated {ageMinutes < 1 ? '< 1 min' : `${ageMinutes} min`} ago
            {ageMinutes > 120 && ' · stale'}
          </p>
        )}
      </div>
      <AmountInput value={usdcIn} onChange={setUsdcIn} label="Amount to lock (USDC)" placeholder="0.00" />
      <div>
        <label className="text-xs mb-1 block" style={{ color: 'var(--subtle)' }}>Lock duration</label>
        <div className="flex gap-2">
          {['1', '7', '30'].map(d => (
            <button key={d} onClick={() => setDays(d)}
              className="flex-1 py-2 rounded-xl text-sm font-semibold transition"
              style={{ background: days === d ? 'var(--accent)' : 'var(--surface-muted)', color: days === d ? '#0d1b2f' : 'var(--muted)', border: '1px solid var(--border)' }}>
              {d}d
            </button>
          ))}
        </div>
      </div>
      {parsedUsdcIn > 0n && currentRate > 0n && (
        <div className="rounded-xl p-4 space-y-2 text-sm" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <PreviewRow label="Guaranteed local value" value={`₦${fmt6(lockedLocal)}`} highlight />
          <PreviewRow label="Premium" value={premium !== undefined ? `${fmt6(premium)} USDC` : '…'} />
          <PreviewRow label="Total needed" value={premium !== undefined ? `${fmt6(totalNeeded)} USDC` : '…'} />
          <PreviewRow label="Locked rate" value={`₦${fmtRate(currentRate)}/USDC`} />
        </div>
      )}
      <ActionButton onClick={handleAction} isPending={isPending} isConfirming={isConfirming}
        disabled={!parsedUsdcIn || !currentRate}
        label={needsApproval ? 'Approve USDC' : 'Open Lock'}
      />
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════════
// SettlePanel (unchanged logic, network-aware)
// ════════════════════════════════════════════════════════════════════════════════
function LockRow({ id, network }: { id: bigint; network: Network }) {
  const { chainId } = useAccount()
  const { switchChain } = useSwitchChain()
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000))
  const chainId_ = CHAINS[network].chainId
  const RATELOCK = CONTRACTS[network].rateLock as `0x${string}`
  const ORACLE = CONTRACTS[network].oracle as `0x${string}`

  useEffect(() => {
    const t = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 60_000)
    return () => clearInterval(t)
  }, [])

  const { data: lock } = useReadContract({
    address: RATELOCK || undefined, abi: RATELOCK_ABI, functionName: 'locks',
    args: [id], chainId: chainId_, query: { enabled: !!RATELOCK },
  })
  const { data: oracleData } = useReadContract({
    address: ORACLE || undefined, abi: ORACLE_ABI, functionName: 'latestData',
    args: [USD_NGN_PAIR], chainId: chainId_,
    query: { enabled: !!ORACLE, refetchInterval: 30_000 },
  })

  const { writeContract, data: txHash, isPending, reset } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash })

  if (isSuccess) {
    toast.success(<span>Lock #{id.toString()} settled! <a href={explorerTx(txHash!, network)} target="_blank" rel="noopener" className="underline">View <ExternalLink size={12} className="inline" /></a></span>)
    reset()
  }

  if (!lock) return null
  const [, usdcIn, lockedRate1e8, lockedLocal, , expiry, , , status] = lock
  if (status !== 0) return null

  const canSettle = BigInt(nowSec) >= expiry
  const expiryDate = new Date(Number(expiry) * 1000).toLocaleDateString()
  const currentRate = oracleData?.[0] ?? 0n
  const projPayout = currentRate > 0n ? (lockedLocal * 100_000_000n) / currentRate : 0n
  const cap = usdcIn + ((usdcIn * 1000n) / 10000n)
  const cappedPayout = projPayout > cap ? cap : projPayout

  return (
    <div className="rounded-xl p-4 space-y-3" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-medium" style={{ color: 'var(--subtle)' }}>Lock #{id.toString()} · USD/NGN</p>
          <p className="display text-lg font-semibold mt-0.5" style={{ color: 'var(--ink)' }}>{fmt6(usdcIn)} USDC locked</p>
        </div>
        <span className="text-xs px-2 py-1 rounded-full font-medium"
          style={{ background: canSettle ? 'rgba(141,216,159,0.15)' : 'rgba(172,198,233,0.12)', color: canSettle ? 'var(--success)' : 'var(--accent)' }}>
          {canSettle ? 'Ready' : 'Pending'}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div><p style={{ color: 'var(--subtle)' }}>Locked rate</p><p className="tabular font-semibold mt-0.5" style={{ color: 'var(--ink-2)' }}>₦{fmtRate(lockedRate1e8)}</p></div>
        <div><p style={{ color: 'var(--subtle)' }}>Current rate</p><p className="tabular font-semibold mt-0.5" style={{ color: 'var(--ink-2)' }}>{currentRate > 0n ? `₦${fmtRate(currentRate)}` : '—'}</p></div>
        <div><p style={{ color: 'var(--subtle)' }}>Expires</p><p className="tabular font-semibold mt-0.5" style={{ color: 'var(--ink-2)' }}>{expiryDate}</p></div>
        <div><p style={{ color: 'var(--subtle)' }}>Est. payout</p><p className="tabular font-semibold mt-0.5" style={{ color: 'var(--success)' }}>{currentRate > 0n ? `${fmt6(cappedPayout)} USDC` : '—'}</p></div>
      </div>
      <ActionButton
        onClick={() => { if (chainId !== chainId_) { switchChain({ chainId: chainId_ }); return } writeContract({ address: RATELOCK, abi: RATELOCK_ABI, functionName: 'settle', args: [id] }) }}
        isPending={isPending} isConfirming={isConfirming} disabled={!canSettle}
        label={canSettle ? 'Settle Lock' : `Settles ${expiryDate}`} compact
      />
    </div>
  )
}

function SettlePanel({ network }: { network: Network }) {
  const { address } = useAccount()
  const [lockId, setLockId] = useState('')
  const chainId_ = CHAINS[network].chainId
  const RATELOCK = CONTRACTS[network].rateLock as `0x${string}`

  const { data: nextId } = useReadContract({
    address: RATELOCK || undefined, abi: RATELOCK_ABI, functionName: 'nextId',
    chainId: chainId_, query: { enabled: !!RATELOCK, refetchInterval: 10_000 },
  })
  const ids: bigint[] = nextId !== undefined ? Array.from({ length: Number(nextId) }, (_, i) => BigInt(i)) : []
  const displayIds = lockId && !isNaN(parseInt(lockId)) ? [BigInt(parseInt(lockId))] : ids

  if (!address) return (
    <div className="flex flex-col items-center justify-center py-12 gap-3 text-center" style={{ color: 'var(--subtle)' }}>
      <Lock size={32} style={{ opacity: 0.4 }} />
      <p className="text-sm">Connect your wallet to see locks.</p>
    </div>
  )

  return (
    <div className="space-y-4">
      <div>
        <label className="text-xs mb-1 block" style={{ color: 'var(--subtle)' }}>Filter by lock ID (optional)</label>
        <input type="number" min="0" value={lockId} onChange={e => setLockId(e.target.value)} placeholder="0"
          className="w-full rounded-xl px-4 py-3 text-sm outline-none transition"
          style={{ background: 'var(--surface-muted)', color: 'var(--ink)', border: '1px solid var(--border)' }} />
      </div>
      {!RATELOCK ? (
        <div className="rounded-xl p-4 text-sm text-center" style={{ background: 'var(--surface)', color: 'var(--subtle)' }}>
          RateLock not deployed on {CHAINS[network].label} yet.
        </div>
      ) : displayIds.length === 0 ? (
        <div className="rounded-xl p-4 text-sm text-center" style={{ background: 'var(--surface)', color: 'var(--subtle)' }}>No open locks found.</div>
      ) : (
        <div className="space-y-3">
          {displayIds.map(id => <LockRow key={id.toString()} id={id} network={network} />)}
        </div>
      )}
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════════
// Shared components
// ════════════════════════════════════════════════════════════════════════════════
function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl p-3" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <p className="text-xs mb-1" style={{ color: 'var(--subtle)' }}>{label}</p>
      <p className="tabular font-semibold text-sm" style={{ color: 'var(--ink)' }}>{value}</p>
    </div>
  )
}
function PreviewRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span style={{ color: 'var(--subtle)' }}>{label}</span>
      <span className="tabular font-semibold" style={{ color: highlight ? 'var(--success)' : 'var(--ink-2)' }}>{value}</span>
    </div>
  )
}
function AmountInput({ value, onChange, label, placeholder }: { value: string; onChange: (v: string) => void; label: string; placeholder: string }) {
  return (
    <div>
      <label className="text-xs mb-1 block" style={{ color: 'var(--subtle)' }}>{label}</label>
      <div className="flex items-center rounded-xl overflow-hidden" style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}>
        <input type="number" min="0" step="0.01" value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
          className="flex-1 bg-transparent px-4 py-3 text-lg font-semibold outline-none tabular" style={{ color: 'var(--ink)' }} />
        <span className="px-4 text-sm font-medium" style={{ color: 'var(--subtle)' }}>USDC</span>
      </div>
    </div>
  )
}
function ActionButton({ onClick, isPending, isConfirming, disabled, label, compact }: {
  onClick: () => void; isPending: boolean; isConfirming: boolean; disabled: boolean; label: string; compact?: boolean
}) {
  const busy = isPending || isConfirming
  return (
    <button onClick={onClick} disabled={disabled || busy}
      className={`w-full ${compact ? 'py-2.5 text-sm' : 'py-3.5 text-base'} rounded-xl font-semibold transition flex items-center justify-center gap-2`}
      style={{ background: disabled || busy ? 'var(--surface-muted)' : 'var(--accent)', color: disabled || busy ? 'var(--subtle)' : '#0d1b2f', cursor: disabled || busy ? 'not-allowed' : 'pointer' }}>
      {busy ? <RefreshCw size={16} className="animate-spin" /> : <ArrowRight size={16} />}
      {isPending ? 'Confirm in wallet…' : isConfirming ? 'Confirming…' : label}
    </button>
  )
}

// ════════════════════════════════════════════════════════════════════════════════
// WebSocket status indicator
// ════════════════════════════════════════════════════════════════════════════════
function WsStatus({ apiBase }: { apiBase: string }) {
  const [connected, setConnected] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    if (!apiBase) return // static deploy — no WS server
    const wsUrl = apiBase.replace(/^http/, 'ws') + '/ws'
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws
    ws.onopen = () => setConnected(true)
    ws.onclose = () => setConnected(false)
    ws.onerror = () => setConnected(false)
    return () => { ws.close() }
  }, [apiBase])

  if (!apiBase) return null
  return (
    <span className="flex items-center gap-1 text-xs" style={{ color: connected ? 'var(--success)' : 'var(--subtle)' }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: connected ? 'var(--success)' : 'var(--border)' }} />
      {connected ? 'WS live' : 'WS off'}
    </span>
  )
}

// ════════════════════════════════════════════════════════════════════════════════
// App root
// ════════════════════════════════════════════════════════════════════════════════
const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'prices', label: 'Prices',    icon: <Activity size={16} /> },
  { id: 'vault',  label: 'Fund Pool', icon: <BarChart3 size={16} /> },
  { id: 'lock',   label: 'Open Lock', icon: <Lock size={16} /> },
  { id: 'settle', label: 'Settle',    icon: <TrendingUp size={16} /> },
]

export default function App() {
  const [tab, setTab] = useState<Tab>('prices')
  const [network, setNetwork] = useState<Network>('testnet')
  const { isConnected } = useAccount()

  return (
    <div className="min-h-dvh flex flex-col" style={{ background: 'var(--bg-gradient)' }}>
      <header className="flex items-center justify-between px-4 py-4 max-w-lg mx-auto w-full gap-3">
        <div className="min-w-0">
          <h1 className="display text-xl font-bold" style={{ color: 'var(--ink)', letterSpacing: '-0.02em' }}>PesaArc</h1>
          <p className="text-xs mt-0.5" style={{ color: 'var(--subtle)' }}>Oracle aggregator · FX rate protection</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <WsStatus apiBase={API_BASE} />
          <NetworkToggle network={network} onChange={setNetwork} />
          <ConnectKitButton />
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center px-4 pb-8">
        <div className="w-full max-w-lg">
          {isConnected && <WrongChainBanner network={network} />}

          <div className="flex gap-1 p-1 rounded-2xl mb-4" style={{ background: 'var(--surface-muted)' }}>
            {TABS.map(t => (
              <Tooltip key={t.id} content={TAB_TIPS[t.id]}>
                <button
                  onClick={() => setTab(t.id)}
                  aria-label={`${t.label} — ${TAB_TIPS[t.id]}`}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                  style={{
                    background: tab === t.id ? 'var(--surface-strong)' : 'transparent',
                    color: tab === t.id ? 'var(--ink)' : 'var(--subtle)',
                    boxShadow: tab === t.id ? '0 1px 4px rgba(0,0,0,0.25)' : 'none',
                    outlineColor: 'var(--accent)',
                  }}
                >
                  {t.icon}
                  {t.label}
                  {/* Subtle info dot — signals there's a tooltip */}
                  <span
                    className="w-1 h-1 rounded-full flex-shrink-0 opacity-50"
                    style={{ background: tab === t.id ? 'var(--accent)' : 'var(--subtle)' }}
                  />
                </button>
              </Tooltip>
            ))}
          </div>

          <div className="rounded-2xl p-5" style={{ background: 'var(--surface-strong)', border: '1px solid var(--border)', backdropFilter: 'blur(12px)' }}>
            {!isConnected && tab !== 'prices' ? (
              <div className="flex flex-col items-center justify-center py-10 gap-4">
                <div className="w-14 h-14 rounded-2xl flex items-center justify-center" style={{ background: 'var(--surface-muted)' }}>
                  <Lock size={24} style={{ color: 'var(--accent)' }} />
                </div>
                <div className="text-center">
                  <p className="display font-semibold text-lg" style={{ color: 'var(--ink)' }}>Connect to transact</p>
                  <p className="text-sm mt-1" style={{ color: 'var(--subtle)' }}>View live rates above without connecting.</p>
                </div>
                <ConnectKitButton label="Connect Wallet" />
              </div>
            ) : (
              <>
                {tab === 'prices' && <OracleDashboard network={network} />}
                {tab === 'vault' && <VaultPanel network={network} />}
                {tab === 'lock' && <LockPanel network={network} />}
                {tab === 'settle' && <SettlePanel network={network} />}
              </>
            )}
          </div>

          <p className="text-center text-xs mt-4" style={{ color: 'var(--subtle)', opacity: 0.6 }}>
            Contracts on {CHAINS[network].label} · oracle.pesarc.xyz
          </p>
        </div>
      </main>
    </div>
  )
}
