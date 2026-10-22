# PesaArc — Oracle Aggregator and FX Rate Protection Protocol

> Live at [oracle.pesarc.xyz](https://oracle.pesarc.xyz) · Built on [Arc](https://arc.io) with [Arc Studio](https://studio.arc.io)

PesaArc is a decentralized oracle aggregator and FX rate-lock protocol built on Arc, Circle's USDC-native blockchain. It serves two audiences: end users who want protection against African currency depreciation, and Web3 dApps that need a reliable best-price feed for emerging market FX pairs.

---

## What It Does

### Oracle Aggregation

PesaArc pulls live price data from seven independent sources and combines them into a single best-bid quote with full source breakdown:

| Source | Type | Pairs |
|---|---|---|
| PushRateOracle | On-chain (Arc) | USD/NGN, USD/KES, USD/GHS, USD/ZAR, USD/EGP |
| DIA | On-chain decentralized REST | USD/NGN, EUR, GBP, BRL, JPY |
| Chainlink | On-chain (Ethereum mainnet) | ETH/USD, BTC/USD, LINK/USD, USDC/USD |
| ExchangeRate-API | Free REST | All African FX pairs |
| Fawaz Currency API | Free CDN REST | All African FX pairs |
| CurrencyAPI Mirror | Free REST fallback | All African FX pairs |
| Pyth | Pull oracle (key optional) | BTC/USD, ETH/USD and more |

Covers 8 African FX pairs (USD/NGN, KES, GHS, ZAR, EGP, TZS, UGX, XOF) and 4 crypto pairs. Refreshes every 30 seconds.

### Public Price API

Any dApp can query PesaArc as a backend oracle service:

```
GET  /price/:pair?network=testnet   — best bid, all source quotes, spread, timestamp
GET  /sources                       — list of all oracles with type, chain, status
WS   /ws                            — real-time push stream (30s interval, per-pair subscribe)
```

### FX Rate Lock (RateLock Protocol)

Three Solidity contracts on Arc form the on-chain settlement layer:

- **LiquidityVault** — USDC liquidity pool. LPs deposit to back rate locks and earn premiums.
- **PushRateOracle** — Operator-pushed FX rates with staleness validation.
- **RateLock** — Core lifecycle: open a lock at today's rate, pay a premium, settle at expiry and receive the difference if the rate moved against you.

---

## Deployed Contracts (Arc Testnet)

| Contract | Address | Explorer |
|---|---|---|
| LiquidityVault | `0x1b4e782b2d95bcaa14f4e8e9b59787878470b4a4` | [View](https://explorer.arc.io/address/0x1b4e782b2d95bcaa14f4e8e9b59787878470b4a4) |
| PushRateOracle | `0xe3d81cadae52ba4c3a56b2cbd180bd33ec16d154` | [View](https://explorer.arc.io/address/0xe3d81cadae52ba4c3a56b2cbd180bd33ec16d154) |
| RateLock | `0x372d0965f14dcd66263ee10941af08473a7149c3` | [View](https://explorer.arc.io/address/0x372d0965f14dcd66263ee10941af08473a7149c3) |

**Example deployment transaction (RateLock):**
[`0x3a25a5c0d73552d6c9fe48cc69ed418ee6afdd09007cccb7581264851f023de2`](https://explorer.arc.io/tx/0x3a25a5c0d73552d6c9fe48cc69ed418ee6afdd09007cccb7581264851f023de2)

**Corridor configuration** — USD/NGN registered, current rate: ~₦1,334/USDC. Premium: 100 bps (20 bps update queued via 24h timelock).

---

## The Stack

| Layer | Technology |
|---|---|
| Smart contracts | Solidity 0.8.28, OpenZeppelin, Foundry |
| Tests | 44 Foundry unit tests (all passing) |
| Security | Two full audit rounds (max severity) + Slither static analysis — 9 findings fixed |
| Chain | Arc Testnet / Arc Mainnet (USDC as native gas) |
| Frontend | React 18, Vite, TypeScript, Tailwind CSS |
| Web3 | wagmi v2, viem v2, ConnectKit |
| Oracle aggregation | viem (on-chain reads), REST APIs |
| Backend API | Express 5, TypeScript, Bun runtime |
| Deployment | Netlify (frontend), Render (API server) |

---

## Running Locally

```bash
# Install
bun install

# Frontend dev server
bun run dev

# API server
bun run server/index.ts

# Contracts
bun run contracts:build   # forge build
bun run contracts:test    # forge test
```

### Environment Variables

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Description |
|---|---|---|
| `ARC_TESTNET_RPC` | Yes | Arc Testnet RPC URL |
| `ARC_MAINNET_RPC` | Yes | Arc Mainnet RPC URL |
| `ETH_MAINNET_RPC` | Yes | Ethereum Mainnet RPC (for Chainlink reads) |
| `PYTH_API_KEY` | No | Pyth Hermes API key (graceful skip without it) |
| `CIRCLE_TESTNET_API_KEY` | Deploy only | Circle API key for testnet contract deployment |
| `CIRCLE_ENTITY_SECRET` | Deploy only | Circle entity secret for developer-controlled wallets |

---

## Architecture

```
oracle.pesarc.xyz (Netlify)
        │
        ├── Prices tab ──► browser fetches directly from free REST APIs + on-chain
        ├── Fund Pool tab ──► LiquidityVault contract (Arc)
        ├── Open Lock tab ──► RateLock + PushRateOracle contracts (Arc)
        └── Settle tab ──► RateLock contract (Arc)

API server (Render / bun run server/index.ts)
        ├── GET /price/:pair ──► aggregates all 7 sources, returns best bid
        ├── GET /sources ──► lists oracle sources with status
        └── WS /ws ──► real-time price stream
```

---

## Why Arc

Arc's USDC-as-gas model is ideal for this use case. Users pay gas in the same token they're locking — no need to hold a separate native asset. Sub-second finality means lock opens and settlements confirm before the user looks away. Predictable gas costs in USDC make it possible to quote the total cost of a rate lock (premium + gas) as a single USDC amount upfront.

---

## What's Unique

Most oracle aggregators cover ETH/BTC on major chains. PesaArc focuses on African FX pairs where price discovery is thin, centralized, and often stale. By aggregating multiple independent sources and publishing a best-bid with full provenance, and by combining that with an on-chain rate-lock mechanism settled in USDC, it creates infrastructure that's genuinely useful for African remittance apps, USDC-based merchant payments, and any protocol that needs NGN/KES/GHS prices it can trust.

---

## License

MIT
