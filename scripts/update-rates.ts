/**
 * Push fresh FX rates to PushRateOracle on Arc Testnet.
 * Fetches current market rates from free APIs and pushes them on-chain.
 * Also queues a corridor update with tighter premiumBps (20 bps = 0.2%).
 * Run with: bun run scripts/update-rates.ts
 */
import fs from "node:fs";
import path from "node:path";
import { encodeFunctionData, toHex, pad } from "viem";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

// Load .env
const APP_ROOT = "/home/user/app";
const envRaw = fs.readFileSync(path.join(APP_ROOT, ".env"), "utf-8");
for (const line of envRaw.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq < 1) continue;
  const key = trimmed.slice(0, eq).trim();
  const val = trimmed.slice(eq + 1).trim();
  if (!process.env[key]) process.env[key] = val;
}

// Prefer the testnet key explicitly — CIRCLE_API_KEY may point at mainnet
const apiKey = process.env.CIRCLE_TESTNET_API_KEY || process.env.CIRCLE_API_KEY;
const entitySecret = process.env.CIRCLE_ENTITY_SECRET || process.env.ENTITY_SECRET;
if (!apiKey || !entitySecret) {
  console.error("Missing CIRCLE_API_KEY or CIRCLE_ENTITY_SECRET");
  process.exit(1);
}

const WALLET_ID = "32becdc1-246f-53ef-bdfa-085062996b19";
const ORACLE_ADDRESS = "0xe3d81cadae52ba4c3a56b2cbd180bd33ec16d154" as `0x${string}`;
const RATELOCK_ADDRESS = "0x372d0965f14dcd66263ee10941af08473a7149c3" as `0x${string}`;

function pairKey(s: string): `0x${string}` {
  return pad(toHex(Buffer.from(s)), { size: 32, dir: "right" });
}

const PAIRS: Record<string, `0x${string}`> = {
  "USD/NGN": pairKey("USD/NGN"),
  "USD/KES": pairKey("USD/KES"),
  "USD/GHS": pairKey("USD/GHS"),
  "USD/ZAR": pairKey("USD/ZAR"),
  "USD/EGP": pairKey("USD/EGP"),
};

const ORACLE_ABI = [
  {
    name: "set",
    type: "function",
    inputs: [{ name: "pair", type: "bytes32" }, { name: "rate1e8", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

const RATELOCK_ABI = [
  {
    name: "setCorridor",
    type: "function",
    inputs: [
      { name: "pair", type: "bytes32" },
      {
        name: "params", type: "tuple",
        components: [
          { name: "oracle", type: "address" },
          { name: "premiumBps", type: "uint32" },
          { name: "maxMoveBps", type: "uint32" },
          { name: "slippageBps", type: "uint32" },
          { name: "maxUsdcIn", type: "uint256" },
          { name: "maxExpiry", type: "uint64" },
          { name: "oracleMaxAge", type: "uint64" },
          { name: "graceWindow", type: "uint64" },
        ],
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    name: "applyCorridor",
    type: "function",
    inputs: [{ name: "pair", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

async function sendTx(label: string, contractAddress: `0x${string}`, calldata: `0x${string}`): Promise<boolean> {
  console.log(`\n${label}...`);
  const tx = await client.createContractExecutionTransaction({
    walletId: WALLET_ID,
    contractAddress,
    callData: calldata,
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  const id = tx.data?.id;
  console.log("  TX ID:", id);
  let state = tx.data?.state;
  let attempts = 0;
  while (attempts < 40 && state !== "COMPLETE" && state !== "FAILED") {
    await new Promise(r => setTimeout(r, 3000));
    const check = await client.getTransaction({ id: id! });
    state = check.data?.transaction?.state;
    attempts++;
    if (attempts % 5 === 0) console.log(`  Polling... state=${state}`);
  }
  console.log(`  Final state: ${state}`);
  return state === "COMPLETE";
}

async function fetchRates(): Promise<Record<string, number>> {
  console.log("Fetching live rates from ExchangeRate-API...");
  const res = await fetch("https://open.er-api.com/v6/latest/USD");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json() as { rates: Record<string, number> };
  return j.rates;
}

async function main() {
  console.log("=== PushRateOracle Rate Update ===\n");

  // 1. Fetch current market rates
  const rates = await fetchRates();
  console.log("Market rates fetched:");
  for (const [pair] of Object.entries(PAIRS)) {
    const currency = pair.split("/")[1];
    const rate = rates[currency];
    if (rate) console.log(`  ${pair}: ${rate.toFixed(4)} (rate1e8: ${Math.round(rate * 1e8)})`);
  }

  // 2. Push each rate on-chain
  for (const [pair, key] of Object.entries(PAIRS)) {
    const currency = pair.split("/")[1];
    const marketRate = rates[currency];
    if (!marketRate || marketRate <= 0) {
      console.log(`\nSkipping ${pair} — no market rate`);
      continue;
    }
    // rate1e8 = market rate * 1e8 (e.g. NGN/USD = 1600 → rate1e8 = 160_000_000_000)
    const rate1e8 = BigInt(Math.round(marketRate * 1e8));
    const calldata = encodeFunctionData({ abi: ORACLE_ABI, functionName: "set", args: [key, rate1e8] });
    await sendTx(`Push ${pair} @ ${marketRate.toFixed(4)} (rate1e8=${rate1e8})`, ORACLE_ADDRESS, calldata);
  }

  // 3. Queue corridor update for USD/NGN with tight 20 bps premium
  // This goes into the 24h timelock. Run applyCorridor tomorrow to activate.
  console.log("\n=== Queuing corridor update: USD/NGN premiumBps → 20 (0.2%) ===");
  const setCorridorData = encodeFunctionData({
    abi: RATELOCK_ABI,
    functionName: "setCorridor",
    args: [
      PAIRS["USD/NGN"],
      {
        oracle: ORACLE_ADDRESS,
        premiumBps: 20,          // 0.2% — tight spread, operator makes profit in basis points
        maxMoveBps: 2000,        // 20% max settlement payout
        slippageBps: 500,        // 5% slippage tolerance at open
        maxUsdcIn: 10_000_000_000n, // 10,000 USDC max per lock
        maxExpiry: 2592000n,     // 30 days
        oracleMaxAge: 86400n,    // 24h oracle max age
        graceWindow: 7200n,      // 2h grace
      },
    ],
  });
  const queued = await sendTx("Queue setCorridor(USD/NGN, premiumBps=20)", RATELOCK_ADDRESS, setCorridorData);
  if (queued) {
    console.log("\nCorridor update queued with 24h timelock.");
    console.log("Run 'applyCorridor' after 24h to activate the new 20 bps premium.");
    console.log("In the meantime, the current 100 bps corridor is still active.");
  }

  console.log("\n=== Rate update complete ===");
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
