# [App Name]

> Built with Arc Studio - money-powered apps in minutes

This is the **project memory** - what Arc Studio remembers about building this app. It helps future agents (or humans) understand and extend the project.

---

## What This App Does

RateLock — FX rate protection on Arc. Users lock today's USD/NGN rate in USDC; the vault backs the guarantee. Three Solidity contracts: LiquidityVault (LP pool), PushRateOracle (operator-pushed rates), RateLock (lock lifecycle). UI: Fund Pool, Open Lock, Settle tabs.

## Tech Stack

- Frontend: React 18, Vite, TypeScript, Tailwind CSS
- Web3: wagmi v2, viem v2, ConnectKit
- Contracts: Solidity 0.8.28 + Foundry. Sources in `contracts/`, unit tests in `contracts/test/*.t.sol`. Build with `bun run contracts:build` (`forge build`), test with `bun run contracts:test` (`forge test`).
- Wallet: injected (MetaMask, etc.)
- Chain: Arc Testnet (Chain ID: 5042002, imported from `viem/chains`)
- Token: USDC testnet (6 decimals) — `0x3600000000000000000000000000000000000001`

## Deployed Contracts (Arc Testnet)

| Contract | Address |
|---|---|
| LiquidityVault | `0x1b4e782b2d95bcaa14f4e8e9b59787878470b4a4` |
| PushRateOracle | `0xe3d81cadae52ba4c3a56b2cbd180bd33ec16d154` |
| RateLock | `0x372d0965f14dcd66263ee10941af08473a7149c3` |

Corridor configured: USD/NGN (`0x5553442f4e474e00...`). Owner/deployer: `0xbbb577c598960744009a5f57de2ba3eef1646317`.
- Toasts: Sonner

## Key Files

- `src/App.tsx` - Main application logic
- `src/components/` - UI components
- `src/config.ts` - wagmi config (chains, connectors, transports)

## To Run

```bash
bun install
bun run dev
```
