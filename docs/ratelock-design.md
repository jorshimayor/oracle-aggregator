# RateLock System — Design Document

**Status:** Draft  
**Target chain:** Arc Mainnet (Chain ID: 5042001)  
**Language/toolchain:** Solidity 0.8.28, Foundry (forge 0.3.x)  
**Milestone:** v1.0 initial deploy  
**Authors:** Arc Studio  

### Review tracker
- [ ] Design review
- [ ] Security review
- [ ] Ops review

---

## Action Items (living)

_Empty — fill after each review round._

---

## 1. Goals / Non-Goals

### Goals
- Allow a "taker" to lock in today's exchange rate (e.g. USD→NGN) and receive the promised local-currency equivalent in USDC at settlement, regardless of spot-rate movement.
- Allow liquidity providers (LPs) to earn a premium by taking the other side of that rate-lock.
- All settlement and custody in USDC on Arc mainnet (native USDC at `0x3600000000000000000000000000000000000000`).
- An operator-controlled oracle feeds live rates on-chain; the owner configures per-corridor parameters.

### Non-Goals
- No cross-chain bridging or multi-chain settlement.
- No order book, AMM, or secondary market for rate-lock positions.
- No automatic oracle updates (oracle is push-based / operator-set).
- No protocol fee or treasury; all premium goes to LPs.
- No governance token or on-chain DAO.

---

## 2. Requirements

### Functional
- **LiquidityVault:** Mint pro-rata shares on deposit; burn on withdrawal; reserve/release only callable by RateLock. Premium added to pool increases share value for all LPs.
- **PushRateOracle:** Operator sets `(pair, rate1e8, timestamp)`. Reads revert when price is stale (older than `maxAge`). Rates are expressed as "local currency units per 1 USDC, scaled 1e8" (e.g. ₦1,600/USDC = `160_000_000_000`).
- **RateLock:** Pull USDC from taker, reserve LP collateral, credit premium to vault, track lock state (Open → Settled/Refunded). At settlement, compute payout = `lockedLocal * 1e8 / realizedRate` clamped to `usdcIn + reserved`. LP covers the gap when the local currency weakened; LP keeps the surplus when it strengthened.
- **Refund path:** If the oracle is unavailable past a grace window after expiry, return `usdcIn` to the taker and release reserve.
- **Parameter governance:** Owner sets per-corridor `oracle`, `premiumBps`, `maxMoveBps`, `maxUsdcIn`, `maxExpiry`, `oracleMaxAge`, `graceWindow`.

### Security
- No path allows a non-owner to update corridor parameters.
- No path allows anyone but RateLock to call `vault.reserve()` or `vault.release()`.
- No path pays out more than `usdcIn + reserved` from the vault.
- A lock can only be settled once.
- Settlement is blocked before expiry.
- Stale oracle always reverts; refund requires grace window to have elapsed.
- All arithmetic rounds in the vault/LP's favor.
- Reentrancy guard on every external-call site.

---

## 3. Terminology & Actors

| Term | Definition |
|---|---|
| **Taker** | The user who opens a rate lock, paying `usdcIn + premium` |
| **LP** | Liquidity provider who deposits USDC into the vault and earns premiums |
| **Pair** | A `bytes32` corridor key, e.g. `keccak256("USD/NGN")` |
| **lockedRate1e8** | The agreed rate at lock open time (local units per USDC × 1e8) |
| **lockedLocal** | `usdcIn * lockedRate1e8 / 1e8` — the promised local-currency value |
| **realizedRate1e8** | Oracle rate at settlement |
| **payoutUsdc** | `lockedLocal * 1e8 / realizedRate1e8` — what the taker receives |
| **reserved** | USDC held back from the vault to cover max adverse move |
| **premium** | `usdcIn * premiumBps / 10000` — credited to the vault at open |
| **maxMoveBps** | Max adverse rate-move the vault is willing to cover (basis points) |

### Actors table

| Actor | On/Off-chain | Trust | Powers |
|---|---|---|---|
| **Owner** | Off-chain | Trusted | Set corridor params; transfer ownership |
| **Operator** | Off-chain | Trusted (for oracle accuracy) | Call `oracle.set()` to push rates |
| **LP** | On-chain | Untrusted | Deposit/withdraw from vault |
| **Taker** | On-chain | Untrusted | Open locks, receive payout/refund |
| **Settler** | On-chain | Untrusted | Anyone may call `settle()` after expiry |
| **RateLock contract** | On-chain | Trusted by vault (role-checked) | Call `vault.reserve()` and `vault.release()` |

---

## 4. Language / Runtime

- **Solidity 0.8.28** — checked arithmetic by default; `unchecked` only where overflow is impossible and documented.
- **EVM target:** Paris (`evm_version = "paris"` in `foundry.toml`) — Arc mainnet requires Paris.
- **OpenZeppelin 5.1.0** — `Ownable`, `ReentrancyGuard`, `SafeERC20`. (5.2+ uses `mcopy` which is Cancun-only and incompatible with Arc's Paris EVM.)
- **No upgradeability** — contracts are immutable; migration story is deploy new contracts and migrate LP funds manually.

---

## 5. Transaction & Execution Model

All three contracts are non-upgradeable. Every state-changing function follows **Checks-Effects-Interactions (CEI)**:
1. Validate inputs and authorization.
2. Mutate state (shares, reserves, lock status).
3. Transfer tokens.

`ReentrancyGuard` is applied to every function that moves USDC (deposit, withdraw, openLock, settle, refund, release).

---

## 6. Architecture Overview

### Components

```
  Taker / LP / Settler
         │
         ▼
    RateLock.sol ──────────reserve/release──────► LiquidityVault.sol
         │                                               ▲
         │                                        deposit/withdraw (LP)
         ▼
   PushRateOracle.sol (read-only by RateLock)
         ▲
      Operator (push)
```

### Flow: Open a lock

```
Taker ──USDC(usdcIn + premium)──► RateLock
RateLock ──premium──► LiquidityVault (increases share value)
RateLock ──reserve(usdcIn * maxMoveBps/10000)──► LiquidityVault (held aside)
Lock stored as Open
```

### Flow: Settle

```
Settler ──settle(id)──► RateLock
RateLock ──reads──► PushRateOracle
payoutUsdc = clamp(lockedLocal * 1e8 / realizedRate, 0, usdcIn + reserved)
if payout > usdcIn: cover gap from reserve; return excess reserve to vault
if payout < usdcIn: return surplus to vault; release full reserve to vault
RateLock ──payoutUsdc──► payoutTo
Lock marked Settled
```

### Flow: Refund

```
(oracle unavailable after graceWindow past expiry)
Settler ──refund(id)──► RateLock
RateLock ──usdcIn──► taker
RateLock ──release(reserved)──► LiquidityVault
Lock marked Refunded
```

### Flow-of-funds table

| Step | Who moves what | Invariant |
|---|---|---|
| LP deposit | LP → Vault (USDC) | `shares * price == vault balance` |
| Lock open | Taker → RateLock (usdcIn + premium); RateLock → Vault (premium); Vault.reserved += amount | Vault total unchanged; reserved portion locked |
| Lock settle | RateLock → payoutTo (payoutUsdc); Vault.reserved adjusted | `payout ≤ usdcIn + reserved`; vault balance non-negative |
| LP withdraw | Vault → LP (USDC pro-rata) | LP cannot withdraw reserved funds |
| Refund | RateLock → taker (usdcIn); reserved released to vault | Lock balance zeroed |

**Resting-state invariant:** RateLock holds no USDC at rest; all USDC is in the vault or in transit within a single transaction.

---

## 7. Contract Design

### LiquidityVault

**Roles:** Owner (= RateLock contract at construction), LPs (untrusted depositors).

**State:**
```
IERC20 usdc
address rateLock          // only caller for reserve/release
uint256 totalShares
uint256 totalReserved     // USDC reserved for open locks
mapping(address => uint256) shares
```

**Key invariant:** `availableBalance() == usdc.balanceOf(address(this)) - totalReserved`

**Write functions:**

| Function | Caller | State change | Events | Reverts |
|---|---|---|---|---|
| `deposit(uint256 usdc)` | Anyone | Mints pro-rata shares | `Deposited(lp, usdc, shares)` | zero amount |
| `withdraw(uint256 shares)` | LP | Burns shares, transfers USDC | `Withdrawn(lp, shares, usdc)` | insufficient shares; would drain reserved |
| `reserve(uint256 amount)` | rateLock only | `totalReserved += amount` | `Reserved(amount)` | insufficient available balance |
| `release(uint256 amount, address to)` | rateLock only | `totalReserved -= amount`; transfer USDC to `to` | `Released(amount, to)` | amount > totalReserved |

**Share price:** `totalShares == 0 ? 1e6 : usdc.balanceOf(this) * 1e18 / totalShares` (1e18 precision to avoid integer truncation; deposit/withdraw divide by 1e18).

---

### PushRateOracle

**Roles:** Owner (sets operator), Operator (pushes rates).

**State:**
```
address operator
mapping(bytes32 => RateData) rates   // pair → {rate1e8, updatedAt}
uint256 defaultMaxAge                // fallback max-age
```

**Write functions:**

| Function | Caller | State change | Events | Reverts |
|---|---|---|---|---|
| `set(bytes32 pair, uint256 rate1e8)` | operator only | stores rate + `block.timestamp` | `RateSet(pair, rate1e8, timestamp)` | rate == 0 |
| `setOperator(address)` | owner | updates operator | `OperatorSet(newOperator)` | zero address |

**Read function:** `rate(bytes32 pair) returns (uint256 rate1e8, uint256 updatedAt)` — reverts `StaleRate` if `block.timestamp - updatedAt > maxAge` (maxAge passed by caller or default).

---

### RateLock

**Roles:** Owner (corridor configuration), anyone (open/settle/refund).

**State:**
```
ILiquidityVault vault
struct CorridorParams { oracle, premiumBps, maxMoveBps, maxUsdcIn, maxExpiry, oracleMaxAge, graceWindow }
mapping(bytes32 => CorridorParams) corridors
uint256 nextId
mapping(uint256 => Lock) locks
struct Lock { pair, usdcIn, lockedRate1e8, lockedLocal, expiry, payoutTo, reserved, status }
enum LockStatus { Open, Settled, Refunded }
```

**Write functions:**

| Function | Caller | State change | Events | Reverts |
|---|---|---|---|---|
| `openLock(bytes32 pair, uint256 usdcIn, uint256 lockedRate1e8, uint64 expiry, address payoutTo) → id` | Anyone | Creates lock, pulls USDC, credits premium, reserves vault | `LockOpened(id, ...)` | usdcIn > maxUsdcIn; expiry > now+maxExpiry; zero payoutTo; zero lockedRate1e8 |
| `settle(uint256 id)` | Anyone | Marks Settled, pays out | `LockSettled(id, realizedRate, payoutUsdc, lpPnl)` | not Open; before expiry; oracle stale |
| `refund(uint256 id)` | Anyone | Marks Refunded, returns usdcIn | `LockRefunded(id)` | not Open; grace window not elapsed |
| `setCorridor(bytes32 pair, CorridorParams)` | owner | Updates params | `CorridorSet(pair, ...)` | — |

**`openLock` arithmetic (integer, rounds toward vault):**
```
premium   = usdcIn * premiumBps / 10000
reserved  = usdcIn * maxMoveBps / 10000
lockedLocal = usdcIn * lockedRate1e8 / 1e8   // integer division
```

**`settle` arithmetic:**
```
payoutUsdc = lockedLocal * 1e8 / realizedRate1e8   // integer division = rounds down (LP favor)
payoutUsdc = min(payoutUsdc, usdcIn + lock.reserved)
if payoutUsdc > usdcIn:
    gap = payoutUsdc - usdcIn
    // cover gap from reserved; release remainder to vault
    vault.release(lock.reserved - gap, address(vault))  // surplus stays in vault
else:
    surplus = usdcIn - payoutUsdc
    vault.release(lock.reserved, address(vault))        // full reserve back
    // surplus (usdcIn - payoutUsdc) stays in vault implicitly: taker paid usdcIn but gets less
```

Wait — the USDC flow needs care. Taker sends `usdcIn + premium`. RateLock receives it all. Then:
- `premium` goes to vault via `SafeERC20.safeTransfer(vault, premium)` — increases share value.
- `vault.reserve(reserved)` — marks `reserved` from vault's own balance as locked.
- RateLock holds `usdcIn` internally (not sent to vault).

At settle:
- RateLock pays `payoutUsdc` from its own `usdcIn` balance (always ≤ usdcIn if rate strengthened, or ≤ usdcIn+reserved if weakened).
- If `payoutUsdc > usdcIn`: gap = payoutUsdc - usdcIn. Call `vault.release(gap, payoutTo)` for the gap; `vault.release(reserved - gap, vault_address)` to put back unused reserve. Then `safeTransfer(payoutTo, usdcIn)` for the RateLock-held portion.
- If `payoutUsdc <= usdcIn`: `safeTransfer(payoutTo, payoutUsdc)`. Send surplus `(usdcIn - payoutUsdc)` to vault. `vault.release(reserved, vault_address)` to unlock reserve.

This way RateLock never holds USDC at rest.

---

## 8. Deployment & Initialization

**Order:**
1. Deploy `LiquidityVault(usdc)` — owner = deployer initially.
2. Deploy `PushRateOracle(operator)` — owner = deployer.
3. Deploy `RateLock(vault, usdc)` — owner = deployer.
4. Call `vault.setRateLock(rateLock)` to authorize RateLock to call reserve/release.
5. Call `rateLock.setCorridor(USD_NGN, params)` to register the first corridor.
6. Call `oracle.set(USD_NGN, initialRate1e8)` to seed a fresh rate.

**Constructor args:**
- `LiquidityVault(address _usdc)`
- `PushRateOracle(address _operator)` (owner = msg.sender)
- `RateLock(address _vault, address _usdc)` (owner = msg.sender)

**Key at genesis:** deployer wallet holds owner on all three contracts. Transfer to multisig after initial setup.

---

## 9. Upgradeability

Not upgradeable. Migration path: deploy new contracts, LP withdraws from old vault and deposits into new, transfer operator key, update oracle.

---

## 10. Security Considerations

| Vulnerability | Applicable? | Mitigation |
|---|---|---|
| Reentrancy | Yes — settle and withdraw move USDC | CEI + `ReentrancyGuard` on all fund-moving functions |
| Access control | Yes | `onlyOwner` on corridor params; `onlyRateLock` modifier on vault reserve/release; `onlyOperator` on oracle |
| Integer overflow/underflow | Solidity 0.8 checked | All arithmetic checked; `unchecked` not used |
| Unchecked external call | Yes | `SafeERC20.safeTransfer`/`safeTransferFrom` throughout |
| Oracle manipulation | Yes | Staleness check on every read; operator is trusted but single-key |
| Payout overflow/cap | Yes | `min(payoutUsdc, usdcIn + reserved)` hard cap |
| Settle twice | Yes | Status enum; revert if not Open |
| Premature settle | Yes | `require(block.timestamp >= expiry)` |
| Front-running | Low risk | Rate is locked at open; settlement is permissionless; no MEV upside |
| Denial of service | Low | Pull-over-push payouts; no loops |
| Timestamp dependence | Yes | Expiry uses `block.timestamp`; tolerance acceptable for day-scale locks |
| Centralization risk | Yes — operator | Operator key compromise = stale/wrong rates. Mitigation: staleness window limits exposure. Document in trust model. |
| Zero-address payoutTo | Yes | Revert on zero payoutTo in openLock |
| LP draining via reserve | Yes | `availableBalance` check in reserve; withdraw bounded by available |

---

## 11. Trust Model & Threat Analysis

| Actor | Compromised = max damage | Mitigation |
|---|---|---|
| Owner | Can set any corridor params (raise maxMoveBps to 100%, lower premiumBps to 0, set fake oracle) | Timelock/multisig recommended post-deploy |
| Operator | Can post manipulated rates, causing mis-settlement | Staleness window limits window; owner can replace operator |
| LP | Can withdraw up to their share of available balance (cannot touch reserved funds) | Reserve accounting prevents over-withdrawal |
| Taker | Can open locks within per-corridor caps; cannot drain vault beyond reserved | maxUsdcIn and maxMoveBps cap exposure |

---

## 12. Emergency Response

- **Pause:** Not implemented in v1. Owner can set `maxUsdcIn = 0` on a corridor to block new locks.
- **Stuck USDC:** RateLock sends all USDC out within the same transaction (no resting balance). Vault holds LP funds — no rescue path needed beyond normal withdraw.
- **Oracle goes dark:** Takers can refund after `expiry + graceWindow`. LPs are not harmed.

---

## 13. Testing Strategy

- **Unit tests (Foundry):** Happy path settle (rate weakens, rate strengthens), settle-before-expiry reverts, settle-twice reverts, stale oracle reverts, refund after grace window, vault share accounting with two LPs.
- **Fuzz:** `openLock` arithmetic invariant (payout always ≤ usdcIn + reserved); share price monotonically non-decreasing after premium.
- **Slither:** Static analysis at max severity before deploy.
- **Integration:** Manual end-to-end run on Arc mainnet with tiny USDC amounts.

---

## 14. Third-party Libraries

| Library | Version | Dep? | Why | Audited? |
|---|---|---|---|---|
| `@openzeppelin/contracts` | 5.1.0 | Yes | `Ownable`, `ReentrancyGuard`, `SafeERC20` | Yes (OZ audited) |

---

## 15. Monitoring & Alerting

| Event | Threshold | Severity | Action |
|---|---|---|---|
| `LockOpened` | — | Info | Log |
| `LockSettled` | `lpPnl < 0` and large | High | Alert LP team |
| `LockRefunded` | High volume | Medium | Check oracle health |
| `RateSet` | Gap > 5% from prior | High | Alert oracle operator |
| `Reserved` failure | Any revert | Critical | Page on-call |
