# Production Deployment Guide

PesaArc Oracle Aggregator — two parts: an Express API server and a static React frontend.

---

## Architecture

```
oracle.pesarc.xyz  →  Render (Docker, Express server + WebSocket)
                       serves REST + WS to the frontend and to external dApps
                       reads from 7 oracle sources on startup and every 30s

pesarc.netlify.app  →  Netlify (static Vite build)
                        VITE_API_BASE=https://oracle.pesarc.xyz
```

---

## 1. Deploy the API server to Render

### A. Push this repo to GitHub

```bash
git add -A && git commit -m "production build" && git push
```

### B. Create a new Render Web Service

1. Go to https://dashboard.render.com → New → Web Service
2. Connect your GitHub repo (`jorshimayor/oracle-aggregator`)
3. Render will auto-detect `render.yaml` — click **Apply**
   > Note: `render.yaml` uses the **Node** runtime (free tier). Docker runtime requires a paid Render plan; the Dockerfile is kept for self-hosting elsewhere.
4. Set the following Environment Variables in the Render dashboard:

| Variable | Value | Notes |
|---|---|---|
| `RPC_PROXY_BASE_URL` | (from your `.env`) | Arc RPC proxy base URL |
| `RPC_PROXY_TOKEN` | (from your `.env`) | Arc RPC proxy token |
| `RPC_PROXY_CHAINS` | (from your `.env`) | Comma-separated chain list |
| `ETH_MAINNET_RPC` | `https://ethereum.publicnode.com` | Free public Ethereum RPC |
| `PYTH_API_KEY` | (get from pyth.network/api) | Optional — enables Pyth crypto prices |
| `VITE_TESTNET_VAULT` | `0x1b4e782b2d95bcaa14f4e8e9b59787878470b4a4` | Arc Testnet |
| `VITE_TESTNET_PUSH_ORACLE` | `0xe3d81cadae52ba4c3a56b2cbd180bd33ec16d154` | Arc Testnet |
| `VITE_TESTNET_RATELOCK` | `0x372d0965f14dcd66263ee10941af08473a7149c3` | Arc Testnet |
| `VITE_MAINNET_VAULT` | (fill after mainnet deploy) | Arc Mainnet |
| `VITE_MAINNET_PUSH_ORACLE` | (fill after mainnet deploy) | Arc Mainnet |
| `VITE_MAINNET_RATELOCK` | (fill after mainnet deploy) | Arc Mainnet |
| `VITE_CHAINLINK_ETH_USD` | (from `.env`) | Ethereum mainnet Chainlink feed |
| `VITE_CHAINLINK_BTC_USD` | (from `.env`) | Ethereum mainnet Chainlink feed |
| `VITE_CHAINLINK_LINK_USD` | (from `.env`) | Ethereum mainnet Chainlink feed |
| `VITE_CHAINLINK_USDC_USD` | (from `.env`) | Ethereum mainnet Chainlink feed |

5. Render assigns a URL like `https://pesaarc-oracle.onrender.com` — note it for step 2.

### C. Custom domain (oracle.pesarc.xyz)

1. In Render → your service → Settings → Custom Domains → Add `oracle.pesarc.xyz`
2. Render shows a CNAME target. In your DNS provider add:
   - **Type:** CNAME
   - **Name:** `oracle`
   - **Value:** (the Render-provided target, e.g. `pesaarc-oracle.onrender.com`)
3. Wait for DNS propagation (usually under 10 minutes). Render auto-provisions SSL.

---

## 2. Deploy the frontend to Netlify

After the Render server is live:

1. In Arc Studio chat: say **"rebuild and deploy to Netlify"** — Arc Studio will set `VITE_API_BASE` to your Render URL and rebuild.

Or manually:
```bash
VITE_API_BASE=https://oracle.pesarc.xyz bun run build
# then deploy dist/ to Netlify
```

In Netlify dashboard, also add `VITE_API_BASE = https://oracle.pesarc.xyz` under Site Settings → Environment Variables, so future deploys pick it up automatically.

---

## 3. Oracle sources

| Source | Type | Pairs | Key required |
|---|---|---|---|
| PushRateOracle | On-chain (Arc) | USD/NGN, USD/KES, USD/GHS, USD/ZAR, USD/EGP, USD/TZS, USD/UGX, USD/XOF | No |
| Chainlink | On-chain (Ethereum) | ETH/USD, BTC/USD, LINK/USD, USDC/USD | No |
| Pyth | Pull oracle (Hermes) | BTC/USD, ETH/USD, LINK/USD, USDC/USD | Yes (`PYTH_API_KEY`) |
| DIA | REST API | USD/NGN, USD/EUR, USD/GBP, USD/BRL, USD/JPY, USD/CHF | No |
| ExchangeRate-API | REST API | All pairs | No |
| Fawaz Currency API | REST API (CDN) | All pairs | No |
| CurrencyAPI Mirror | REST API (Cloudflare) | All pairs | No |

---

## 4. API reference

```
GET  /health                         → { status: "ok", timestamp }
GET  /pairs                          → { fx: [...], crypto: [...], all: [...] }
GET  /sources                        → array of source descriptors
GET  /price/:pair?network=testnet    → AggregatedPrice
GET  /price/:pair?network=mainnet    → AggregatedPrice

WS   ws://oracle.pesarc.xyz/ws
  on connect: receives all FX pairs, testnet
  send: { "type": "subscribe", "pairs": ["USD/NGN"], "network": "mainnet" }
  send: { "type": "unsubscribe", "pairs": ["USD/KES"] }
  receives: { "type": "prices", "data": [AggregatedPrice, ...] } every 30s
```

### AggregatedPrice shape

```json
{
  "pair": "USD/NGN",
  "network": "testnet",
  "bestPrice": 1600.5,
  "bestSource": "PushRateOracle",
  "quotes": [
    { "source": "PushRateOracle", "price": 1600.5, "updatedAt": 1792146655, "staleSecs": 120 },
    { "source": "ExchangeRate-API", "price": 1598.2, "updatedAt": 1792146000, "staleSecs": 775 },
    { "source": "DIA", "price": 1601.1, "updatedAt": 1792146300, "staleSecs": 475 },
    { "source": "Chainlink", "price": 0, "updatedAt": 0, "error": "pair USD/NGN not in Chainlink forex feed" }
  ],
  "fetchedAt": 1792146775
}
```

---

## 5. Mainnet deploy (when ready)

```bash
# Set CIRCLE_API_KEY to mainnet key, then:
bun run compass:deploy -- --network mainnet --contract LiquidityVault
bun run compass:deploy -- --network mainnet --contract PushRateOracle
bun run compass:deploy -- --network mainnet --contract RateLock
# Then set VITE_MAINNET_* env vars in Render and redeploy
```

---

## 6. Local development

```bash
cp .env.example .env   # fill in your keys
bun install
bun run dev            # Vite frontend on :5173
bun run dev:server     # Express server on :3001 with --watch
```

Frontend talks to the server at `VITE_API_BASE` (or `localhost:3001` if unset).
