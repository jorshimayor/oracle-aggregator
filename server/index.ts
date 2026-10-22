/**
 * Oracle Aggregator API Server
 *
 * REST:
 *   GET /price/:pair              — aggregated price for a pair (testnet default)
 *   GET /price/:pair?network=mainnet
 *   GET /sources                  — list of sources + their status
 *   GET /pairs                    — supported pair list
 *   GET /health                   — health check
 *
 * WebSocket:
 *   ws://<host>/ws                — receives JSON push every 30s for all pairs
 *   Subscribe message: { type: "subscribe", pairs: ["USD/NGN"], network: "testnet" }
 *   Unsubscribe: { type: "unsubscribe", pairs: ["USD/NGN"] }
 *
 * CORS: open (any origin) — this is a public price API.
 */

import express from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { getCachedPrice, ALL_PAIRS, SUPPORTED_PAIRS, PYTH_FEED_IDS, type Network } from './oracles.js'

const app = express()
app.use(express.json())

// ── CORS (open) ───────────────────────────────────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  next()
})

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: Math.floor(Date.now() / 1000) })
})

// ── Pairs ─────────────────────────────────────────────────────────────────────
app.get('/pairs', (_req, res) => {
  res.json({
    fx: SUPPORTED_PAIRS,
    crypto: Object.keys(PYTH_FEED_IDS),
    all: ALL_PAIRS,
  })
})

// ── Sources ───────────────────────────────────────────────────────────────────
app.get('/sources', (_req, res) => {
  res.json([
    {
      id: 'PushRateOracle',
      type: 'onchain',
      chain: 'Arc',
      description: 'Operator-pushed FX rates on-chain. USD/NGN live on testnet; all African pairs after mainnet deploy.',
      pairs: 'USD/NGN USD/KES USD/GHS USD/ZAR USD/EGP USD/TZS USD/UGX USD/XOF',
      networks: ['testnet', 'mainnet'],
      requiresKey: false,
    },
    {
      id: 'Chainlink',
      type: 'onchain',
      chain: 'Ethereum',
      description: 'AggregatorV3 latestRoundData reads on Ethereum mainnet. Crypto pairs only.',
      pairs: 'ETH/USD BTC/USD LINK/USD USDC/USD',
      networks: ['testnet', 'mainnet'],
      requiresKey: false,
    },
    {
      id: 'Pyth',
      type: 'onchain',
      chain: 'Multi-chain (Hermes pull)',
      description: 'Pyth Network Hermes pull oracle. Crypto pairs only. Set PYTH_API_KEY to enable.',
      pairs: 'BTC/USD ETH/USD LINK/USD USDC/USD',
      networks: ['testnet', 'mainnet'],
      requiresKey: true,
      keyEnvVar: 'PYTH_API_KEY',
      keyStatus: process.env.PYTH_API_KEY ? 'set' : 'missing',
    },
    {
      id: 'DIA',
      type: 'offchain',
      chain: 'N/A',
      description: 'DIA blockchain oracle REST API. Free, no key. Covers NGN, EUR, GBP, BRL, JPY, CHF.',
      pairs: 'USD/NGN USD/EUR USD/GBP USD/BRL USD/JPY USD/CHF',
      networks: ['testnet', 'mainnet'],
      requiresKey: false,
    },
    {
      id: 'ExchangeRate-API',
      type: 'offchain',
      chain: 'N/A',
      description: 'open.er-api.com — free FX API, updated hourly. All African pairs.',
      pairs: 'USD/* (all)',
      networks: ['testnet', 'mainnet'],
      requiresKey: false,
    },
    {
      id: 'Fawaz Currency API',
      type: 'offchain',
      chain: 'N/A',
      description: 'CDN-backed FX rates via jsdelivr (@fawazahmed0/currency-api). All pairs.',
      pairs: 'USD/* (all)',
      networks: ['testnet', 'mainnet'],
      requiresKey: false,
    },
    {
      id: 'CurrencyAPI Mirror',
      type: 'offchain',
      chain: 'N/A',
      description: 'Cloudflare Pages mirror of the Fawaz Currency API. Fallback source.',
      pairs: 'USD/* (all)',
      networks: ['testnet', 'mainnet'],
      requiresKey: false,
    },
  ])
})

// ── Price ─────────────────────────────────────────────────────────────────────
app.get('/price/:pair', async (req, res) => {
  const raw = req.params.pair.replace('-', '/')
  const pair = raw.toUpperCase()
  const networkParam = (req.query.network as string | undefined) ?? 'testnet'
  const network: Network = networkParam === 'mainnet' ? 'mainnet' : 'testnet'

  if (!ALL_PAIRS.includes(pair)) {
    res.status(404).json({ error: `Unknown pair "${pair}". See /pairs for the full list.` })
    return
  }

  try {
    const data = await getCachedPrice(pair, network)
    res.json(data)
  } catch (e) {
    res.status(500).json({ error: String(e) })
  }
})

// ── Static frontend (served from /dist) ──────────────────────────────────────
// In Docker the Vite build output is copied to /app/dist
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const distPath = join(__dirname, '..', 'dist')

app.use(express.static(distPath))
// Express 5 uses path-to-regexp v8 — bare '*' is no longer valid; use '/{*path}'
app.get('/{*path}', (_req, res) => {
  res.sendFile(join(distPath, 'index.html'))
})

// ── WebSocket server ──────────────────────────────────────────────────────────
const server = createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })

interface ClientState {
  pairs: Set<string>
  network: Network
}

const clients = new Map<WebSocket, ClientState>()

wss.on('connection', (ws) => {
  const state: ClientState = { pairs: new Set(SUPPORTED_PAIRS), network: 'testnet' }
  clients.set(ws, state)

  // Send welcome + initial batch
  ws.send(JSON.stringify({ type: 'connected', pairs: SUPPORTED_PAIRS, message: 'Subscribed to all FX pairs on testnet. Send {"type":"subscribe","pairs":["USD/NGN"],"network":"mainnet"} to customise.' }))
  void sendBatch(ws, state)

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as { type: string; pairs?: string[]; network?: string }
      if (msg.type === 'subscribe') {
        if (msg.network === 'mainnet') state.network = 'mainnet'
        else if (msg.network === 'testnet') state.network = 'testnet'
        if (Array.isArray(msg.pairs)) {
          for (const p of msg.pairs) {
            const norm = p.replace('-', '/').toUpperCase()
            if (ALL_PAIRS.includes(norm)) state.pairs.add(norm)
          }
        }
        ws.send(JSON.stringify({ type: 'ack', subscribed: [...state.pairs], network: state.network }))
        void sendBatch(ws, state)
      } else if (msg.type === 'unsubscribe' && Array.isArray(msg.pairs)) {
        for (const p of msg.pairs) state.pairs.delete(p.replace('-', '/').toUpperCase())
        ws.send(JSON.stringify({ type: 'ack', subscribed: [...state.pairs], network: state.network }))
      }
    } catch { /* ignore malformed */ }
  })

  ws.on('close', () => clients.delete(ws))
  ws.on('error', () => clients.delete(ws))
})

async function sendBatch(ws: WebSocket, state: ClientState) {
  if (ws.readyState !== WebSocket.OPEN) return
  const results = await Promise.all(
    [...state.pairs].map(pair => getCachedPrice(pair, state.network))
  )
  if (ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify({ type: 'prices', data: results }))
}

// Broadcast to all clients every 30 s
setInterval(async () => {
  for (const [ws, state] of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      void sendBatch(ws, state)
    }
  }
}, 30_000)

// ── Startup cache warm-up ─────────────────────────────────────────────────────
// Pre-fetch all pairs on both networks so the first real request is instant.
async function warmCache() {
  console.log('Warming price cache for all pairs…')
  const networks: Network[] = ['testnet', 'mainnet']
  const results = await Promise.allSettled(
    networks.flatMap(net => ALL_PAIRS.map(pair => getCachedPrice(pair, net)))
  )
  const ok = results.filter(r => r.status === 'fulfilled').length
  const fail = results.filter(r => r.status === 'rejected').length
  console.log(`Cache warm-up complete: ${ok} ok, ${fail} failed`)
}

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? 3001)
server.listen(PORT, () => {
  console.log(`Oracle aggregator listening on :${PORT}`)
  console.log(`REST: GET /price/USD-NGN  |  WS: ws://localhost:${PORT}/ws`)
  console.log(`Sources: PushRateOracle · Chainlink · Pyth · DIA · ExchangeRate-API · Fawaz · CurrencyAPI`)
  void warmCache()
})

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown(signal: string) {
  console.log(`${signal} received — shutting down gracefully`)
  server.close(() => {
    console.log('HTTP server closed')
    process.exit(0)
  })
  // Force exit after 10s if connections are still open
  setTimeout(() => { console.log('Force exit'); process.exit(1) }, 10_000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
