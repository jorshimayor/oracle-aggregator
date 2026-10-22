/**
 * Oracle aggregator — fetches FX and crypto rates from multiple sources.
 *
 * Sources:
 *   1. PushRateOracle  — on-chain contract (Arc testnet / mainnet)
 *   2. ExchangeRate-API — open.er-api.com (free, no key)
 *   3. Fawaz Currency API — cdn.jsdelivr.net/@fawazahmed0/currency-api (free)
 *   4. CurrencyAPI Mirror — latest.currency-api.pages.dev (free fallback)
 *   5. Pyth — Hermes REST (needs PYTH_API_KEY; gracefully omitted without it)
 *   6. DIA — api.diadata.org/v1/rwa/Fiat (free, no key; NGN/EUR/GBP/BRL/JPY/CHF)
 *   7. Chainlink — Ethereum mainnet on-chain reads via publicnode (ETH/USD, BTC/USD)
 */

import { createPublicClient, http as viemHttp, parseAbi } from 'viem'

// ── RPC URL resolver ──────────────────────────────────────────────────────────
// On Render: set ARC_TESTNET_RPC / ARC_MAINNET_RPC to the direct Arc JSON-RPC
// endpoints (no token required server-side — see render.yaml comments).
// In the Arc Studio sandbox: RPC_PROXY_BASE_URL + RPC_PROXY_TOKEN are pre-set;
// we fall back to them automatically so local dev works without extra config.
function resolveRpcUrl(directEnvKey: string, proxyChain: string): string {
  const direct = process.env[directEnvKey]
  if (direct) return direct
  const base = process.env.RPC_PROXY_BASE_URL
  const token = process.env.RPC_PROXY_TOKEN
  if (!base || !token) throw new Error(
    `${directEnvKey} is not set and RPC_PROXY_BASE_URL / RPC_PROXY_TOKEN are also missing. ` +
    `On Render, set ${directEnvKey} (see render.yaml).`
  )
  return `${base}/api/rpc/${proxyChain}?_rpc_token=${token}`
}

// ── Network config (addresses from env, not hardcoded) ────────────────────────
export type Network = 'testnet' | 'mainnet'

function getNetworkConfig(network: Network) {
  if (network === 'testnet') {
    return {
      id: 5042002,
      name: 'Arc Testnet',
      rpcUrl: resolveRpcUrl('ARC_TESTNET_RPC', 'Arc_Testnet'),
      explorerUrl: 'https://explorer.testnet.arc.io',
      pushOracle: (process.env.VITE_TESTNET_PUSH_ORACLE ?? '') as `0x${string}`,
      pythCore: (process.env.VITE_PYTH_TESTNET ?? '') as `0x${string}`,
    }
  }
  return {
    id: 5042,
    name: 'Arc',
    rpcUrl: resolveRpcUrl('ARC_MAINNET_RPC', 'Arc'),
    explorerUrl: 'https://explorer.arc.io',
    pushOracle: (process.env.VITE_MAINNET_PUSH_ORACLE ?? '') as `0x${string}`,
    pythCore: (process.env.VITE_PYTH_MAINNET ?? '') as `0x${string}`,
  }
}

// ── Pair keys (bytes32 right-padded ASCII) ────────────────────────────────────
function pairKey(s: string): `0x${string}` {
  const hex = Buffer.from(s, 'ascii').toString('hex').padEnd(64, '0')
  return `0x${hex}` as `0x${string}`
}

export const PAIR_KEYS: Record<string, `0x${string}`> = {
  'USD/NGN': pairKey('USD/NGN'),
  'USD/KES': pairKey('USD/KES'),
  'USD/GHS': pairKey('USD/GHS'),
  'USD/ZAR': pairKey('USD/ZAR'),
  'USD/EGP': pairKey('USD/EGP'),
  'USD/TZS': pairKey('USD/TZS'),
  'USD/UGX': pairKey('USD/UGX'),
  'USD/XOF': pairKey('USD/XOF'),
}

export const SUPPORTED_PAIRS = Object.keys(PAIR_KEYS)

// Pyth feed IDs — for crypto pairs only (African FX not on Pyth)
export const PYTH_FEED_IDS: Record<string, string> = {
  'BTC/USD': 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  'ETH/USD': 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  'USDC/USD': 'eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
  'LINK/USD': '8ac0c70fff57e9aefdf5edf44b51d62c2d433653cbb2cf5cc06bb115af04d221',
}

// Crypto pairs sourced from Chainlink on Ethereum mainnet
export const CHAINLINK_PAIRS: Set<string> = new Set(['ETH/USD', 'BTC/USD', 'LINK/USD', 'USDC/USD'])

export const ALL_PAIRS = [...SUPPORTED_PAIRS, ...Object.keys(PYTH_FEED_IDS)]

// ── Types ─────────────────────────────────────────────────────────────────────
export interface OracleQuote {
  source: string
  price: number        // plain float, e.g. 1600.5 means 1 USD = 1600.5 NGN
  updatedAt: number    // unix timestamp seconds
  confidence?: number
  staleSecs?: number
  error?: string
}

export interface AggregatedPrice {
  pair: string
  network: Network
  bestPrice: number
  bestSource: string
  quotes: OracleQuote[]
  fetchedAt: number
}

// ── ABIs ──────────────────────────────────────────────────────────────────────
const PUSH_ORACLE_ABI = parseAbi([
  'function latestData(bytes32 pair) view returns (uint256 rate1e8, uint256 updatedAt)',
])

// Chainlink AggregatorV3Interface
const CHAINLINK_ABI = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
])

// Chainlink feed addresses — loaded from env (set at deploy time, VITE_ so frontend can also read)
const CHAINLINK_FEEDS: Record<string, `0x${string}` | undefined> = {
  'ETH/USD': process.env.VITE_CHAINLINK_ETH_USD as `0x${string}` | undefined,
  'BTC/USD': process.env.VITE_CHAINLINK_BTC_USD as `0x${string}` | undefined,
  'LINK/USD': process.env.VITE_CHAINLINK_LINK_USD as `0x${string}` | undefined,
  'USDC/USD': process.env.VITE_CHAINLINK_USDC_USD as `0x${string}` | undefined,
}

// DIA supports these FX pairs (others return 404)
const DIA_SUPPORTED: Set<string> = new Set([
  'USD/NGN', 'USD/EUR', 'USD/GBP', 'USD/BRL', 'USD/JPY', 'USD/CHF',
])

// ── viem clients ──────────────────────────────────────────────────────────────
const clients = new Map<string, ReturnType<typeof createPublicClient>>()

function getClient(network: Network) {
  if (clients.has(network)) return clients.get(network)!
  const cfg = getNetworkConfig(network)
  const client = createPublicClient({
    transport: viemHttp(cfg.rpcUrl),
    chain: {
      id: cfg.id,
      name: cfg.name,
      nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
      rpcUrls: { default: { http: [cfg.rpcUrl] } },
    },
  })
  clients.set(network, client)
  return client
}

// Ethereum mainnet client for Chainlink reads
// Uses a public RPC (ETH_MAINNET_RPC env var); falls back gracefully if unset.
let ethClient: ReturnType<typeof createPublicClient> | null = null
function getEthClient() {
  if (ethClient) return ethClient
  const rpc = process.env.ETH_MAINNET_RPC
  if (!rpc) return null
  ethClient = createPublicClient({
    transport: viemHttp(rpc),
    chain: {
      id: 1,
      name: 'Ethereum',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [rpc] } },
    },
  })
  return ethClient
}

// ── Source: PushRateOracle ────────────────────────────────────────────────────
async function fetchPushOracle(pair: string, network: Network): Promise<OracleQuote> {
  const cfg = getNetworkConfig(network)
  if (!cfg.pushOracle) {
    return { source: 'PushRateOracle', price: 0, updatedAt: 0, error: 'not deployed on this network' }
  }
  try {
    const client = getClient(network)
    const key = PAIR_KEYS[pair] ?? pairKey(pair)
    const [rate1e8, updatedAt] = await client.readContract({
      address: cfg.pushOracle,
      abi: PUSH_ORACLE_ABI,
      functionName: 'latestData',
      args: [key],
    }) as [bigint, bigint]

    if (rate1e8 === 0n) {
      return { source: 'PushRateOracle', price: 0, updatedAt: 0, error: 'pair not configured' }
    }
    const nowSec = Math.floor(Date.now() / 1000)
    const ts = Number(updatedAt)
    return {
      source: 'PushRateOracle',
      price: Number(rate1e8) / 1e8,
      updatedAt: ts,
      staleSecs: nowSec - ts,
    }
  } catch (e) {
    return { source: 'PushRateOracle', price: 0, updatedAt: 0, error: String(e) }
  }
}

// ── FX API cache helpers ──────────────────────────────────────────────────────
interface FxCache {
  data: Record<string, number>
  ts: number
}

const TTL = 300_000 // 5 min

async function cachedFetch<T>(
  cache: { current: FxCache | null },
  url: string,
  extract: (json: T) => Record<string, number>,
): Promise<FxCache> {
  if (cache.current && Date.now() - cache.current.ts < TTL) return cache.current
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json() as T
  cache.current = { data: extract(json), ts: Date.now() }
  return cache.current
}

// ── Source: ExchangeRate-API ──────────────────────────────────────────────────
const erApiState = { current: null as FxCache | null }

async function fetchErApi(pair: string): Promise<OracleQuote> {
  const [, quote] = pair.split('/')
  if (!quote) return { source: 'ExchangeRate-API', price: 0, updatedAt: 0, error: 'invalid pair' }
  try {
    const cache = await cachedFetch<{ rates: Record<string, number> }>(
      erApiState,
      'https://open.er-api.com/v6/latest/USD',
      j => j.rates,
    )
    const rate = cache.data[quote]
    if (!rate) return { source: 'ExchangeRate-API', price: 0, updatedAt: 0, error: `no rate for ${quote}` }
    return { source: 'ExchangeRate-API', price: rate, updatedAt: Math.floor(cache.ts / 1000), staleSecs: Math.floor((Date.now() - cache.ts) / 1000) }
  } catch (e) {
    return { source: 'ExchangeRate-API', price: 0, updatedAt: 0, error: String(e) }
  }
}

// ── Source: Fawaz Currency API ────────────────────────────────────────────────
const fawazState = { current: null as FxCache | null }

async function fetchFawaz(pair: string): Promise<OracleQuote> {
  const [, quote] = pair.split('/')
  if (!quote) return { source: 'Fawaz Currency API', price: 0, updatedAt: 0, error: 'invalid pair' }
  const q = quote.toLowerCase()
  try {
    const cache = await cachedFetch<{ usd: Record<string, number> }>(
      fawazState,
      'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
      j => j.usd,
    )
    const rate = cache.data[q]
    if (!rate) return { source: 'Fawaz Currency API', price: 0, updatedAt: 0, error: `no rate for ${q}` }
    return { source: 'Fawaz Currency API', price: rate, updatedAt: Math.floor(cache.ts / 1000), staleSecs: Math.floor((Date.now() - cache.ts) / 1000) }
  } catch (e) {
    return { source: 'Fawaz Currency API', price: 0, updatedAt: 0, error: String(e) }
  }
}

// ── Source: CurrencyAPI Mirror ────────────────────────────────────────────────
const mirrorState = { current: null as FxCache | null }

async function fetchMirror(pair: string): Promise<OracleQuote> {
  const [, quote] = pair.split('/')
  if (!quote) return { source: 'CurrencyAPI Mirror', price: 0, updatedAt: 0, error: 'invalid pair' }
  const q = quote.toLowerCase()
  try {
    const cache = await cachedFetch<{ usd: Record<string, number> }>(
      mirrorState,
      'https://latest.currency-api.pages.dev/v1/currencies/usd.json',
      j => j.usd,
    )
    const rate = cache.data[q]
    if (!rate) return { source: 'CurrencyAPI Mirror', price: 0, updatedAt: 0, error: `no rate for ${q}` }
    return { source: 'CurrencyAPI Mirror', price: rate, updatedAt: Math.floor(cache.ts / 1000), staleSecs: Math.floor((Date.now() - cache.ts) / 1000) }
  } catch (e) {
    return { source: 'CurrencyAPI Mirror', price: 0, updatedAt: 0, error: String(e) }
  }
}

// ── Source: Pyth (Hermes REST) ────────────────────────────────────────────────
async function fetchPyth(pair: string): Promise<OracleQuote> {
  const feedId = PYTH_FEED_IDS[pair]
  if (!feedId) return { source: 'Pyth', price: 0, updatedAt: 0, error: 'no feed ID for pair' }
  const apiKey = process.env.PYTH_API_KEY
  if (!apiKey) return { source: 'Pyth', price: 0, updatedAt: 0, error: 'PYTH_API_KEY not set — add it to enable Pyth prices' }
  try {
    const res = await fetch(
      `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${feedId}`,
      { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(8000) },
    )
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json() as { parsed: Array<{ price: { price: string; expo: number; conf: string; publish_time: number } }> }
    const p = json.parsed?.[0]?.price
    if (!p) throw new Error('no price in response')
    const price = Number(p.price) * Math.pow(10, p.expo)
    const conf = Number(p.conf) * Math.pow(10, p.expo)
    const nowSec = Math.floor(Date.now() / 1000)
    return { source: 'Pyth', price, updatedAt: p.publish_time, confidence: conf, staleSecs: nowSec - p.publish_time }
  } catch (e) {
    return { source: 'Pyth', price: 0, updatedAt: 0, error: String(e) }
  }
}

// ── Source: DIA (free Forex API — NGN/EUR/GBP/BRL/JPY/CHF only) ──────────────
// DIA quote convention is {quote}-USD, price = quote per 1 USD
async function fetchDia(pair: string): Promise<OracleQuote> {
  if (!DIA_SUPPORTED.has(pair)) {
    return { source: 'DIA', price: 0, updatedAt: 0, error: `pair ${pair} not in DIA forex feed` }
  }
  const [, quote] = pair.split('/')  // e.g. NGN from USD/NGN
  if (!quote) return { source: 'DIA', price: 0, updatedAt: 0, error: 'invalid pair' }
  try {
    const url = `https://api.diadata.org/v1/rwa/Fiat/${quote}-USD`
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json() as { Ticker: string; Price: number; Timestamp: string }
    if (!json.Price) throw new Error('no price in DIA response')
    // DIA price = quote/USD (e.g. NGN per USD = 1 / NGN-USD price)
    const price = 1 / json.Price
    const updatedAt = Math.floor(new Date(json.Timestamp).getTime() / 1000)
    const nowSec = Math.floor(Date.now() / 1000)
    return { source: 'DIA', price, updatedAt, staleSecs: nowSec - updatedAt }
  } catch (e) {
    return { source: 'DIA', price: 0, updatedAt: 0, error: String(e) }
  }
}

// ── Source: Chainlink (Ethereum mainnet on-chain reads) ───────────────────────
async function fetchChainlink(pair: string): Promise<OracleQuote> {
  const feedAddr = CHAINLINK_FEEDS[pair]
  if (!feedAddr) {
    return { source: 'Chainlink', price: 0, updatedAt: 0, error: `no Chainlink feed configured for ${pair}` }
  }
  const client = getEthClient()
  if (!client) {
    return { source: 'Chainlink', price: 0, updatedAt: 0, error: 'ETH_MAINNET_RPC not set' }
  }
  try {
    const [roundData, decimals] = await Promise.all([
      client.readContract({ address: feedAddr, abi: CHAINLINK_ABI, functionName: 'latestRoundData' }),
      client.readContract({ address: feedAddr, abi: CHAINLINK_ABI, functionName: 'decimals' }),
    ]) as [[bigint, bigint, bigint, bigint, bigint], number]

    const [, answer, , updatedAt] = roundData
    if (answer <= 0n) throw new Error('zero or negative answer')
    const price = Number(answer) / Math.pow(10, decimals)
    const ts = Number(updatedAt)
    const nowSec = Math.floor(Date.now() / 1000)
    return { source: 'Chainlink', price, updatedAt: ts, staleSecs: nowSec - ts }
  } catch (e) {
    return { source: 'Chainlink', price: 0, updatedAt: 0, error: String(e) }
  }
}

// ── Aggregator ────────────────────────────────────────────────────────────────
export async function getAggregatedPrice(pair: string, network: Network): Promise<AggregatedPrice> {
  const nowSec = Math.floor(Date.now() / 1000)
  const isFxPair = SUPPORTED_PAIRS.includes(pair)
  const isCryptoPair = pair in PYTH_FEED_IDS

  const isCryptoChainlinkPair = CHAINLINK_PAIRS.has(pair)

  const fetchers: Promise<OracleQuote>[] = []
  if (isFxPair) {
    fetchers.push(
      fetchPushOracle(pair, network),
      fetchErApi(pair),
      fetchFawaz(pair),
      fetchMirror(pair),
      fetchDia(pair),          // DIA: NGN/EUR/GBP/BRL/JPY/CHF; graceful no-op for others
    )
  }
  if (isCryptoPair) fetchers.push(fetchPyth(pair))
  if (isCryptoChainlinkPair) fetchers.push(fetchChainlink(pair))

  if (fetchers.length === 0) {
    return { pair, network, bestPrice: 0, bestSource: 'none', quotes: [{ source: 'none', price: 0, updatedAt: 0, error: 'unsupported pair' }], fetchedAt: nowSec }
  }

  const quotes = await Promise.all(fetchers)
  const valid = quotes.filter(q => q.price > 0 && !q.error)

  // Best = median of valid quotes to resist outliers
  let bestPrice = 0
  let bestSource = 'none'
  if (valid.length > 0) {
    const sorted = [...valid].sort((a, b) => a.price - b.price)
    const mid = sorted[Math.floor(sorted.length / 2)]
    bestPrice = mid.price
    bestSource = mid.source
  }

  return { pair, network, bestPrice, bestSource, quotes, fetchedAt: nowSec }
}

// ── Cache layer (30s TTL) ─────────────────────────────────────────────────────
const priceCache = new Map<string, { data: AggregatedPrice; expiresAt: number }>()
const CACHE_TTL = 30_000

export async function getCachedPrice(pair: string, network: Network): Promise<AggregatedPrice> {
  const key = `${network}:${pair}`
  const cached = priceCache.get(key)
  if (cached && Date.now() < cached.expiresAt) return cached.data
  const data = await getAggregatedPrice(pair, network)
  priceCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL })
  return data
}

export function invalidateCache(network?: Network) {
  if (!network) { priceCache.clear(); return }
  for (const key of priceCache.keys()) {
    if (key.startsWith(`${network}:`)) priceCache.delete(key)
  }
}
