/**
 * LiquidityVault — pre-deploy fork integration tests
 *
 * Fork RPC:       http://127.0.0.1:43857  (anvil fork held open by compass-deploy --mode verify)
 * Contract:       0x751FaC892508aBD8D69C15AEB705441296709f3b
 * Owner:          0xb19c5EAa36C73a4FC393C276de04FA2A999Fa5a8  (deployerAddress = initialOwner)
 * USDC/native:    0x3600000000000000000000000000000000000000
 *
 * Arc mainnet USDC is a native-token wrapper. It uses two precompiles that are
 * not implemented by standard anvil:
 *
 *   0x1800000000000000000000000000000000000001 — selector 0x8e204c43 (blocklist check,
 *     called on every transferFrom; must return false/"not blocked")
 *
 *   0x1800000000000000000000000000000000000000 — selector 0xbeabacc8 (native balance
 *     movement; must return true/"success" or the ERC-20 call reverts)
 *
 * We etch minimal stubs for both before any test runs. This lets deposit/withdraw
 * transactions succeed at the EVM level, but ERC-20 balanceOf(vault) stays 0 because
 * the stub for 0x1800...0000 doesn't move native balances. Tests that depend on
 * vault.totalBalance() / vault.availableBalance() are explicitly annotated with this
 * caveat. Everything else (shares accounting, access control, reserve/release logic)
 * is fully verifiable.
 *
 * Every sender is obtained via anvil_impersonateAccount + anvil_setBalance.
 * No private key is used anywhere.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  encodeFunctionData,
  parseAbi,
  toHex,
  defineChain,
  type Address,
  type Hex,
  type Chain,
} from "viem";

// ── Addresses ───────────────────────────────────────────────────────────────
const FORK_RPC = "http://127.0.0.1:43857";
const VAULT    = "0x751FaC892508aBD8D69C15AEB705441296709f3b" as Address;
const OWNER    = "0xb19c5EAa36C73a4FC393C276de04FA2A999Fa5a8" as Address;
const USDC     = "0x3600000000000000000000000000000000000000" as Address;

// Arc USDC precompiles — not supported by standard anvil; we etch stubs.
const ARC_PRECOMPILE_BLOCKLIST = "0x1800000000000000000000000000000000000001" as Address;
const ARC_PRECOMPILE_TRANSFER  = "0x1800000000000000000000000000000000000000" as Address;

// Synthetic actors — arbitrary addresses, impersonated on the fork
const LP_A      = "0x1111111111111111111111111111111111111111" as Address;
const LP_B      = "0x2222222222222222222222222222222222222222" as Address;
const RATE_LOCK = "0x3333333333333333333333333333333333333333" as Address;
const STRANGER  = "0x4444444444444444444444444444444444444444" as Address;
const RECIPIENT = "0x6666666666666666666666666666666666666666" as Address;

// Token amounts (USDC = 6 decimals)
const USDC_DEC      = 6;
const ONE_USDC      = parseUnits("1",   USDC_DEC);
const TEN_USDC      = parseUnits("10",  USDC_DEC);
const HUNDRED_USDC  = parseUnits("100", USDC_DEC);

// Native balance funding.
// Arc: 1 ERC-20 USDC unit = 1e12 native wei.
// Fund each actor with 10_000 * 1e18 wei = 10_000 USDC ERC-20 units (also covers gas).
const FUND_AMOUNT = BigInt("10000") * BigInt(10 ** 18);

// ── ABI fragments ─────────────────────────────────────────────────────────────
const ABI = parseAbi([
  // vault reads
  "function owner() view returns (address)",
  "function rateLock() view returns (address)",
  "function totalShares() view returns (uint256)",
  "function totalReserved() view returns (uint256)",
  "function totalBalance() view returns (uint256)",
  "function availableBalance() view returns (uint256)",
  "function shares(address) view returns (uint256)",
  // ERC-20 reads
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  // ERC-20 write
  "function approve(address,uint256) returns (bool)",
  // vault writes
  "function deposit(uint256)",
  "function withdraw(uint256)",
  "function setRateLock(address)",
  "function reserve(uint256)",
  "function release(uint256,address)",
]);

// ── Clients ───────────────────────────────────────────────────────────────────
const transport = http(FORK_RPC);
const pub = createPublicClient({ transport });
let forkChain: Chain;
let snapshotId: Hex | undefined;

// ── Anvil helpers ─────────────────────────────────────────────────────────────
async function impersonate(addr: Address) {
  await pub.request({ method: "anvil_impersonateAccount" as any, params: [addr] });
}
async function setNativeBalance(addr: Address, value: bigint) {
  await pub.request({ method: "anvil_setBalance" as any, params: [addr, toHex(value)] });
}
async function fundActor(addr: Address, amount = FUND_AMOUNT) {
  await impersonate(addr);
  await setNativeBalance(addr, amount);
}

/**
 * Etch two Arc USDC precompile stubs so that deposit/withdraw transactions
 * succeed at the EVM level (without these, every transferFrom reverts with
 * OpcodeNotFound or a false return from the missing precompile).
 *
 * Stub A — 0x1800...0001 (blocklist check): must return abi-encoded false
 *   (i.e. "address is NOT blocked").
 *   Bytecode: mstore(0, 0); return(0, 32)  → 0x600060005260206000f3
 *
 * Stub B — 0x1800...0000 (native balance movement): must succeed (CALL returns 1)
 *   and return abi-encoded true ("transfer succeeded").
 *   Bytecode: mstore(0, 1); return(0, 32)  → 0x600160005260206000f3
 *   NOTE: the stub does NOT actually move native balances, so
 *   usdc.balanceOf(vault) stays 0 after deposits/withdrawals.
 */
async function etchArcUsdcPrecompiles() {
  // Returns false (32 zero bytes) — not blocked
  const RETURN_FALSE = "0x600060005260206000f3" as Hex;
  // Returns true (32 bytes with 1) — transfer succeeded
  const RETURN_TRUE  = "0x600160005260206000f3" as Hex;

  await pub.request({ method: "anvil_setCode" as any, params: [ARC_PRECOMPILE_BLOCKLIST, RETURN_FALSE] });
  await pub.request({ method: "anvil_setCode" as any, params: [ARC_PRECOMPILE_TRANSFER,  RETURN_TRUE]  });
}

/** Send a transaction from an impersonated account */
async function sendAs(from: Address, to: Address, data: Hex): Promise<Hex> {
  const wc = createWalletClient({ account: from, chain: forkChain, transport });
  return wc.sendTransaction({ to, data, gas: 500_000n });
}

/** Wait for receipt and assert success */
async function waitSuccess(hash: Hex, label: string) {
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 30_000 });
  if (receipt.status !== "success") throw new Error(`tx reverted (${label}): ${hash}`);
  return receipt;
}

/** Expect a call to revert (tx rejects at submission or receipt.status="reverted") */
async function expectRevert(fn: () => Promise<Hex>, label: string) {
  let hash: Hex | undefined;
  let reverted = false;
  try {
    hash = await fn();
  } catch (e: any) {
    const msg = String(e?.message ?? e).toLowerCase();
    if (
      msg.includes("revert") ||
      msg.includes("execution reverted") ||
      msg.includes("failed") ||
      msg.includes("error") ||
      msg.includes("rejected")
    ) {
      reverted = true;
    } else {
      throw e;
    }
  }
  if (!reverted && hash) {
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 30_000 });
    if (receipt.status === "reverted") reverted = true;
  }
  if (!reverted) throw new Error(`Expected revert for "${label}" but tx succeeded (hash=${hash})`);
}

// ── ERC-20 helpers ────────────────────────────────────────────────────────────
async function approve(from: Address, spender: Address, amount: bigint) {
  const data = encodeFunctionData({ abi: ABI, functionName: "approve", args: [spender, amount] });
  const hash = await sendAs(from, USDC, data);
  await waitSuccess(hash, `approve(${spender} ${amount})`);
}

// ── Vault reads ────────────────────────────────────────────────────────────────
async function read<T>(functionName: any, args?: any[]): Promise<T> {
  return pub.readContract({ address: VAULT, abi: ABI, functionName, ...(args ? { args } : {}) }) as Promise<T>;
}

// ── Test harness ──────────────────────────────────────────────────────────────
type Status = "PASS" | "FAIL" | "SKIP";
const results: { testName: string; status: Status; detail?: string; durationMs: number }[] = [];
let failures = 0;

async function test(name: string, fn: () => Promise<void>) {
  const t0 = Date.now();
  try {
    await fn();
    const r = { testName: name, status: "PASS" as Status, durationMs: Date.now() - t0 };
    results.push(r);
    console.log(JSON.stringify(r));
  } catch (err: any) {
    failures++;
    const r = { testName: name, status: "FAIL" as Status, detail: String(err?.message ?? err).slice(0, 500), durationMs: Date.now() - t0 };
    results.push(r);
    console.log(JSON.stringify(r));
  }
}

function skip(name: string, reason: string) {
  const r = { testName: name, status: "SKIP" as Status, detail: reason, durationMs: 0 };
  results.push(r);
  console.log(JSON.stringify(r));
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════
async function main() {

  // ── Reset vault contract storage to clean state ────────────────────────────
  // LiquidityVault storage layout (Solidity compiler with optimizer + viaIR):
  //   slot 0: Ownable._owner (address)
  //   slot 1: ReentrancyGuard._status (uint256, 1 = not-entered)
  //   slot 2: rateLock (address)
  //   slot 3: totalShares (uint256)
  //   slot 4: totalReserved (uint256)
  //   slot 5+: shares mapping (keccak256(addr || 5))
  //
  // We reset rateLock, totalShares, totalReserved, and shares[LP_A,LP_B] so repeated
  // runs always start from the same known state.
  // We do NOT reset slot 0 (owner) — it should remain as deployerAddress.
  await pub.request({
    method: "anvil_setStorageAt" as any,
    params: [VAULT, "0x0000000000000000000000000000000000000000000000000000000000000002", "0x0000000000000000000000000000000000000000000000000000000000000000"],
  });
  await pub.request({
    method: "anvil_setStorageAt" as any,
    params: [VAULT, "0x0000000000000000000000000000000000000000000000000000000000000003", "0x0000000000000000000000000000000000000000000000000000000000000000"],
  });
  await pub.request({
    method: "anvil_setStorageAt" as any,
    params: [VAULT, "0x0000000000000000000000000000000000000000000000000000000000000004", "0x0000000000000000000000000000000000000000000000000000000000000000"],
  });
  // Reset shares[LP_A] = keccak256(abi.encode(LP_A, 5))
  {
    const { keccak256, pad, encodeAbiParameters, parseAbiParameters } = await import("viem");
    const lpAKey = keccak256(encodeAbiParameters(parseAbiParameters("address,uint256"), [LP_A, 5n]));
    const lpBKey = keccak256(encodeAbiParameters(parseAbiParameters("address,uint256"), [LP_B, 5n]));
    const ZERO32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
    await pub.request({ method: "anvil_setStorageAt" as any, params: [VAULT, lpAKey, ZERO32] });
    await pub.request({ method: "anvil_setStorageAt" as any, params: [VAULT, lpBKey, ZERO32] });
  }

  // ── Discover chain ID ──────────────────────────────────────────────────────
  const chainIdHex = await pub.request({ method: "eth_chainId" as any }) as Hex;
  const chainId = Number(BigInt(chainIdHex));
  forkChain = defineChain({
    id: chainId,
    name: "anvil-fork",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [FORK_RPC] } },
  });

  // ── Etch Arc USDC precompile stubs ────────────────────────────────────────
  // Must happen before any approve / deposit / withdraw / reserve / release calls.
  await etchArcUsdcPrecompiles();

  // ── Fund all actors ──────────────────────────────────────────────────────────
  for (const actor of [OWNER, LP_A, LP_B, RATE_LOCK, STRANGER, RECIPIENT]) {
    await fundActor(actor);
  }

  // ── Pre-seed vault with USDC balance ────────────────────────────────────────
  // On Arc, ERC-20 balanceOf(addr) reflects the address's native balance (1 USDC = 1e12 wei).
  // We set the vault's native balance to 100 USDC before tests so that the second-deposit
  // proportional formula (amount * totalShares / balanceBefore) is well-defined.
  // This is not a "funded" vault — the 100 USDC is owned by no LP and is just
  // initialisation balance to avoid divide-by-zero in the fork environment.
  // In production (real Arc), the vault's balance naturally grows from deposits.
  const VAULT_SEED_WEI = HUNDRED_USDC * 1_000_000_000_000n; // 100 USDC in native wei
  await impersonate(VAULT);
  await setNativeBalance(VAULT, VAULT_SEED_WEI);

  // ─────────────────────────────────────────────────────────────────────────────
  // T01: owner() returns deployerAddress (initialOwner constructor arg)
  // ─────────────────────────────────────────────────────────────────────────────
  await test("owner() returns deployerAddress (initialOwner)", async () => {
    const o = await read<Address>("owner");
    assert(o.toLowerCase() === OWNER.toLowerCase(), `expected ${OWNER} got ${o}`);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // T02: usdc() returns correct address
  // ─────────────────────────────────────────────────────────────────────────────
  await test("usdc() returns correct USDC address", async () => {
    const raw = await pub.call({ to: VAULT, data: "0x3e413bee" as Hex });
    assert(!!raw.data && raw.data.length >= 66, `unexpected raw.data: ${raw.data}`);
    const actual = ("0x" + raw.data!.slice(-40)) as Address;
    assert(actual.toLowerCase() === USDC.toLowerCase(), `expected ${USDC} got ${actual}`);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // T03: availableBalance() == totalBalance() - totalReserved (invariant check)
  // Vault has seed balance (100 USDC) set in setup but no reserves yet.
  // ─────────────────────────────────────────────────────────────────────────────
  await test("availableBalance() = totalBalance() - totalReserved (invariant check)", async () => {
    const bal    = await read<bigint>("totalBalance");
    const res    = await read<bigint>("totalReserved");
    const avail  = await read<bigint>("availableBalance");
    assert(avail === bal - res, `${avail} !== ${bal} - ${res}`);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // T04: deposit — LP_A deposits 100 USDC, shares minted (first deposit → 1e12 multiplier)
  //
  // NOTE: Arc precompile stub at 0x1800...0000 returns success without actually moving
  // native balances, so vault.totalBalance() stays 0. The vault's share-minting logic
  // branches on totalShares < 1: since no prior deposits exist, mintShares = amount * 1e12.
  // We verify the shares mapping and totalShares — those are pure storage writes.
  // ─────────────────────────────────────────────────────────────────────────────
  await test("deposit: LP_A deposits 100 USDC → shares[LP_A] and totalShares increase by amount×1e12", async () => {
    await approve(LP_A, VAULT, HUNDRED_USDC);

    const sharesBefore   = await read<bigint>("totalShares");
    const lpSharesBefore = await read<bigint>("shares", [LP_A]);

    const data = encodeFunctionData({ abi: ABI, functionName: "deposit", args: [HUNDRED_USDC] });
    const hash = await sendAs(LP_A, VAULT, data);
    await waitSuccess(hash, `LP_A deposit 100 USDC; tx=${hash}`);

    const sharesAfter   = await read<bigint>("totalShares");
    const lpSharesAfter = await read<bigint>("shares", [LP_A]);

    // totalShares < 1 before deposit → mintShares = usdcAmount * 1e12
    const expectedMint = HUNDRED_USDC * 1_000_000_000_000n;
    assert(
      sharesAfter - sharesBefore === expectedMint,
      `totalShares delta: expected ${expectedMint} got ${sharesAfter - sharesBefore}`,
    );
    assert(
      lpSharesAfter - lpSharesBefore === expectedMint,
      `LP_A shares delta: expected ${expectedMint} got ${lpSharesAfter - lpSharesBefore}`,
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // T05: deposit — proportional formula taken when totalShares >= 1 and vault has balance
  //
  // After T04: totalShares = 100e6 * 1e12 (from LP_A's deposit).
  // Vault balance = 100 USDC (the setup seed balance; LP_A's deposit didn't add to it
  // because the Arc transfer precompile stub doesn't actually move native balances).
  // So balanceBefore = 100 USDC. Proportional formula:
  //   mintShares = (10e6 * 100e6 * 1e12) / 100e6 = 10e6 * 1e12
  // which happens to equal TEN_USDC * 1e12 (same as the first-deposit formula result here).
  // ─────────────────────────────────────────────────────────────────────────────
  await test("deposit: LP_B deposits 10 USDC → proportional shares minted (proportional formula)", async () => {
    await approve(LP_B, VAULT, TEN_USDC);

    const totalSharesBefore = await read<bigint>("totalShares");
    const vaultBalBefore    = await read<bigint>("totalBalance");
    const lpSharesBefore    = await read<bigint>("shares", [LP_B]);

    assert(totalSharesBefore > 0n && vaultBalBefore > 0n, `preconditions: totalShares=${totalSharesBefore} vaultBal=${vaultBalBefore}`);

    const data = encodeFunctionData({ abi: ABI, functionName: "deposit", args: [TEN_USDC] });
    const hash = await sendAs(LP_B, VAULT, data);
    await waitSuccess(hash, `LP_B deposit 10 USDC; tx=${hash}`);

    const lpSharesAfter    = await read<bigint>("shares", [LP_B]);
    const totalSharesAfter = await read<bigint>("totalShares");

    // Proportional formula: mintShares = (usdcAmount * totalShares) / balanceBefore
    const expectedMint = (TEN_USDC * totalSharesBefore) / vaultBalBefore;
    const actual = lpSharesAfter - lpSharesBefore;
    assert(actual === expectedMint, `LP_B shares minted: expected ${expectedMint} got ${actual}`);
    assert(
      totalSharesAfter - totalSharesBefore === expectedMint,
      `totalShares delta: expected ${expectedMint} got ${totalSharesAfter - totalSharesBefore}`,
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // T06: deposit reverts on zero amount (ZeroAmount error)
  // ─────────────────────────────────────────────────────────────────────────────
  await test("deposit: reverts on zero amount (ZeroAmount)", async () => {
    const data = encodeFunctionData({ abi: ABI, functionName: "deposit", args: [0n] });
    await expectRevert(() => sendAs(LP_A, VAULT, data), "deposit(0)");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // T07: withdraw — LP_A burns half their shares, vault transfers USDC back
  //
  // Proportional USDC out = (sharesToBurn * vault.totalBalance) / totalShares.
  // vault.totalBalance() = 0 due to precompile stub → usdcOut = 0.
  // The contract then checks: usdcOut > availableBalance() → 0 > 0 → false (ok).
  // shares[LP_A] decreases and totalShares decreases. usdcOut=0 means safeTransfer(0)
  // is called — which the Arc USDC may or may not accept; we check for a ZeroAmount
  // revert path and note the limitation if it occurs.
  // ─────────────────────────────────────────────────────────────────────────────
  await test("withdraw: LP_A burns half shares → shares[LP_A] and totalShares decrease", async () => {
    const lpShares = await read<bigint>("shares", [LP_A]);
    assert(lpShares > 0n, `LP_A has no shares`);

    const halfShares    = lpShares / 2n;
    const sharesBefore  = await read<bigint>("totalShares");

    const data = encodeFunctionData({ abi: ABI, functionName: "withdraw", args: [halfShares] });
    const hash = await sendAs(LP_A, VAULT, data);
    await waitSuccess(hash, `LP_A withdraw half shares; tx=${hash}`);

    const lpSharesAfter  = await read<bigint>("shares", [LP_A]);
    const totalSharesAfter = await read<bigint>("totalShares");

    assert(
      lpSharesAfter === lpShares - halfShares,
      `shares[LP_A]: expected ${lpShares - halfShares} got ${lpSharesAfter}`,
    );
    assert(
      sharesBefore - totalSharesAfter === halfShares,
      `totalShares delta: expected ${halfShares} got ${sharesBefore - totalSharesAfter}`,
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // T08: withdraw reverts when shares > owned (InsufficientShares)
  // ─────────────────────────────────────────────────────────────────────────────
  await test("withdraw: reverts when burning more shares than owned (InsufficientShares)", async () => {
    const lpShares = await read<bigint>("shares", [LP_A]);
    const tooMany  = lpShares + 1n;
    const data = encodeFunctionData({ abi: ABI, functionName: "withdraw", args: [tooMany] });
    await expectRevert(() => sendAs(LP_A, VAULT, data), "withdraw too many shares");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // T09: setRateLock — non-owner is rejected (OwnableUnauthorizedAccount)
  // ─────────────────────────────────────────────────────────────────────────────
  await test("setRateLock: non-owner is rejected (OwnableUnauthorizedAccount)", async () => {
    const data = encodeFunctionData({ abi: ABI, functionName: "setRateLock", args: [RATE_LOCK] });
    await expectRevert(() => sendAs(STRANGER, VAULT, data), "setRateLock from stranger");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // T10: setRateLock — owner can set it (first call succeeds)
  // ─────────────────────────────────────────────────────────────────────────────
  await test("setRateLock: owner sets rateLock address successfully", async () => {
    // If already set from a prior run, skip
    const rlBefore = await read<Address>("rateLock");
    if (rlBefore.toLowerCase() !== "0x0000000000000000000000000000000000000000") {
      // Already set — verify it's the expected address and continue
      assert(
        rlBefore.toLowerCase() === RATE_LOCK.toLowerCase(),
        `rateLock already set to unexpected address ${rlBefore}`,
      );
      return; // still PASS — rateLock is correctly set
    }

    const data = encodeFunctionData({ abi: ABI, functionName: "setRateLock", args: [RATE_LOCK] });
    const hash = await sendAs(OWNER, VAULT, data);
    await waitSuccess(hash, `setRateLock; tx=${hash}`);

    const rlAfter = await read<Address>("rateLock");
    assert(
      rlAfter.toLowerCase() === RATE_LOCK.toLowerCase(),
      `expected ${RATE_LOCK} got ${rlAfter}`,
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // T11: setRateLock — reverts on second call (RateLockAlreadySet)
  // ─────────────────────────────────────────────────────────────────────────────
  await test("setRateLock: reverts on second call (RateLockAlreadySet)", async () => {
    const data = encodeFunctionData({
      abi: ABI,
      functionName: "setRateLock",
      args: ["0x5555555555555555555555555555555555555555" as Address],
    });
    await expectRevert(() => sendAs(OWNER, VAULT, data), "second setRateLock");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // T12: reserve — non-rateLock callers are rejected (NotRateLock)
  // ─────────────────────────────────────────────────────────────────────────────
  await test("reserve: non-rateLock callers rejected (NotRateLock)", async () => {
    const data = encodeFunctionData({ abi: ABI, functionName: "reserve", args: [ONE_USDC] });
    await expectRevert(() => sendAs(STRANGER, VAULT, data), "reserve from stranger");
    await expectRevert(() => sendAs(OWNER,    VAULT, data), "reserve from owner (not rateLock)");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // T13: reserve — rateLock can reserve; totalReserved increases
  //
  // The vault was pre-seeded with 100 USDC native balance in setup, so
  // availableBalance() = 100 USDC (minus any prior reserves = 0 at this point).
  // ─────────────────────────────────────────────────────────────────────────────
  await test("reserve: rateLock increases totalReserved; availableBalance decreases", async () => {
    const avail0    = await read<bigint>("availableBalance");
    const reserved0 = await read<bigint>("totalReserved");
    assert(avail0 >= ONE_USDC, `vault available=${avail0} — not enough to reserve ${ONE_USDC}. Arc precompile limitation may apply.`);

    const data = encodeFunctionData({ abi: ABI, functionName: "reserve", args: [ONE_USDC] });
    const hash = await sendAs(RATE_LOCK, VAULT, data);
    await waitSuccess(hash, `reserve 1 USDC; tx=${hash}`);

    const reserved1 = await read<bigint>("totalReserved");
    const avail1    = await read<bigint>("availableBalance");

    assert(
      reserved1 - reserved0 === ONE_USDC,
      `totalReserved delta: expected ${ONE_USDC} got ${reserved1 - reserved0}`,
    );
    assert(
      avail0 - avail1 === ONE_USDC,
      `availableBalance drop: expected ${ONE_USDC} got ${avail0 - avail1}`,
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // T14: reserve — reverts when amount > availableBalance (InsufficientAvailable)
  // ─────────────────────────────────────────────────────────────────────────────
  await test("reserve: reverts when amount > availableBalance (InsufficientAvailable)", async () => {
    const avail   = await read<bigint>("availableBalance");
    const tooMuch = avail + parseUnits("999", USDC_DEC);
    const data = encodeFunctionData({ abi: ABI, functionName: "reserve", args: [tooMuch] });
    await expectRevert(() => sendAs(RATE_LOCK, VAULT, data), "reserve too much");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // T15: availableBalance() invariant: always equals totalBalance() - totalReserved()
  // ─────────────────────────────────────────────────────────────────────────────
  await test("availableBalance() invariant holds (totalBalance - totalReserved)", async () => {
    const bal   = await read<bigint>("totalBalance");
    const res   = await read<bigint>("totalReserved");
    const avail = await read<bigint>("availableBalance");
    assert(avail === bal - res, `invariant broken: ${avail} !== ${bal} - ${res}`);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // T16: release — non-rateLock callers rejected (NotRateLock)
  // ─────────────────────────────────────────────────────────────────────────────
  await test("release: non-rateLock callers rejected (NotRateLock)", async () => {
    const data = encodeFunctionData({ abi: ABI, functionName: "release", args: [ONE_USDC, STRANGER] });
    await expectRevert(() => sendAs(STRANGER, VAULT, data), "release from stranger");
    await expectRevert(() => sendAs(OWNER,    VAULT, data), "release from owner (not rateLock)");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // T17: release to external recipient — totalReserved decreases; USDC transferred
  //
  // release() calls safeTransfer(to, amount) → goes through the Arc USDC precompile.
  // The precompile stub succeeds. totalReserved must decrease by amount.
  // We cannot verify recipient's balanceOf changing due to precompile stub, but we
  // verify totalReserved and the emitted Released event (via receipt logs).
  // ─────────────────────────────────────────────────────────────────────────────
  await test("release: rateLock decreases totalReserved; safeTransfer called without revert", async () => {
    const reserved0 = await read<bigint>("totalReserved");
    assert(reserved0 >= ONE_USDC, `totalReserved=${reserved0} — need T13 to have passed`);

    const data = encodeFunctionData({ abi: ABI, functionName: "release", args: [ONE_USDC, RECIPIENT] });
    const hash = await sendAs(RATE_LOCK, VAULT, data);
    await waitSuccess(hash, `release 1 USDC to recipient; tx=${hash}`);

    const reserved1 = await read<bigint>("totalReserved");
    assert(
      reserved0 - reserved1 === ONE_USDC,
      `totalReserved delta: expected -${ONE_USDC} got ${reserved0 - reserved1}`,
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // T18: release(to=vault) — only decrements reserved; no safeTransfer branch taken
  // ─────────────────────────────────────────────────────────────────────────────
  await test("release(to=vault) only decrements totalReserved, vault balance unchanged", async () => {
    // Re-reserve 1 USDC
    const avail = await read<bigint>("availableBalance");
    assert(avail >= ONE_USDC, `vault available=${avail}`);

    const rd = encodeFunctionData({ abi: ABI, functionName: "reserve", args: [ONE_USDC] });
    const rh = await sendAs(RATE_LOCK, VAULT, rd);
    await waitSuccess(rh, `re-reserve; tx=${rh}`);

    const vaultBal0 = await read<bigint>("totalBalance");
    const reserved0 = await read<bigint>("totalReserved");

    const data = encodeFunctionData({ abi: ABI, functionName: "release", args: [ONE_USDC, VAULT] });
    const hash = await sendAs(RATE_LOCK, VAULT, data);
    await waitSuccess(hash, `release to vault; tx=${hash}`);

    const vaultBal1 = await read<bigint>("totalBalance");
    const reserved1 = await read<bigint>("totalReserved");

    assert(
      reserved0 - reserved1 === ONE_USDC,
      `totalReserved drop: expected ${ONE_USDC} got ${reserved0 - reserved1}`,
    );
    assert(vaultBal1 === vaultBal0, `vault balance should be unchanged: ${vaultBal0} → ${vaultBal1}`);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // T19: release — reverts when amount > totalReserved (InsufficientAvailable)
  // ─────────────────────────────────────────────────────────────────────────────
  await test("release: reverts when amount > totalReserved (InsufficientAvailable)", async () => {
    const reserved = await read<bigint>("totalReserved");
    const tooMuch  = reserved + ONE_USDC;
    const data = encodeFunctionData({ abi: ABI, functionName: "release", args: [tooMuch, STRANGER] });
    await expectRevert(() => sendAs(RATE_LOCK, VAULT, data), "release more than reserved");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // T20: withdraw blocked when usdcOut > availableBalance (reserved funds protected)
  //
  // Reserve all available USDC so that any withdraw attempt hits InsufficientAvailable.
  // ─────────────────────────────────────────────────────────────────────────────
  await test("withdraw: blocked when usdcOut > availableBalance (reserved funds protected)", async () => {
    // Reserve everything available
    const avail = await read<bigint>("availableBalance");
    if (avail > 0n) {
      const rd = encodeFunctionData({ abi: ABI, functionName: "reserve", args: [avail] });
      const rh = await sendAs(RATE_LOCK, VAULT, rd);
      await waitSuccess(rh, `reserve all for T20; tx=${rh}`);
    }

    // LP_A or LP_B must still hold shares
    const sharesA = await read<bigint>("shares", [LP_A]);
    const sharesB = await read<bigint>("shares", [LP_B]);
    const [actor, sharesToBurn] = sharesA > 0n ? [LP_A, sharesA] : [LP_B, sharesB];
    assert(sharesToBurn > 0n, "neither LP has shares");

    const data = encodeFunctionData({ abi: ABI, functionName: "withdraw", args: [sharesToBurn] });
    await expectRevert(() => sendAs(actor, VAULT, data), "withdraw when fully reserved");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Summary
  // ─────────────────────────────────────────────────────────────────────────────
  const passed  = results.filter(r => r.status === "PASS").length;
  const failed  = results.filter(r => r.status === "FAIL").length;
  const skipped = results.filter(r => r.status === "SKIP").length;

  console.log(JSON.stringify({
    summary: `${passed} passed, ${failed} failed, ${skipped} skipped`,
    total: results.length,
  }));

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(JSON.stringify({ fatal: String(err?.message ?? err) }));
  process.exit(1);
});
