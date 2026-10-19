/**
 * Post-deploy setup for Arc Testnet:
 * 1. RateLock.setCorridor(USD_NGN, corridorParams)  — already called setRateLock successfully
 * 2. PushRateOracle.set(USD_NGN, rate1e8)           — set initial ₦1,600/USDC rate
 *
 * Uses raw calldata via viem encodeFunctionData to avoid Circle SDK tuple encoding issues.
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

const apiKey = process.env.CIRCLE_API_KEY || process.env.CIRCLE_TESTNET_API_KEY;
const entitySecret = process.env.CIRCLE_ENTITY_SECRET || process.env.ENTITY_SECRET;
if (!apiKey || !entitySecret) {
  console.error("Missing CIRCLE_API_KEY or CIRCLE_ENTITY_SECRET");
  process.exit(1);
}

const WALLET_ID     = "32becdc1-246f-53ef-bdfa-085062996b19";
const ORACLE_ADDRESS  = "0xe3d81cadae52ba4c3a56b2cbd180bd33ec16d154" as `0x${string}`;
const RATELOCK_ADDRESS = "0x372d0965f14dcd66263ee10941af08473a7149c3" as `0x${string}`;

// bytes32 encoding of "USD/NGN" — right-padded with zeros to exactly 32 bytes
// padRight pads the byte array (not the hex string) to 32 bytes
const USD_NGN_PAIR = pad(toHex(Buffer.from("USD/NGN")), { size: 32, dir: "right" });
console.log("USD/NGN pair key:", USD_NGN_PAIR, "(length:", USD_NGN_PAIR.length, "chars)");

const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

async function sendTx(label: string, contractAddress: `0x${string}`, calldata: `0x${string}`) {
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
  if (state === "FAILED") throw new Error(`Transaction FAILED for ${label}`);
}

// RateLock ABI for setCorridor — field order matches the Solidity struct EXACTLY:
// oracle, premiumBps, maxMoveBps, slippageBps, maxUsdcIn, maxExpiry, oracleMaxAge, graceWindow
const RATELOCK_ABI = [
  {
    name: "setCorridor",
    type: "function",
    inputs: [
      { name: "pair", type: "bytes32" },
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "oracle", type: "address" },
          { name: "premiumBps", type: "uint32" },
          { name: "maxMoveBps", type: "uint32" },
          { name: "slippageBps", type: "uint32" },   // <-- 3rd, NOT last
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
] as const;

// PushRateOracle ABI for set
const ORACLE_ABI = [
  {
    name: "set",
    type: "function",
    inputs: [
      { name: "pair", type: "bytes32" },
      { name: "rate1e8", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

async function main() {
  console.log("=== Testnet Post-Deploy Setup (Step 2) ===");
  console.log("(setRateLock already completed in previous run)\n");

  // 1. setCorridor USD/NGN
  const setCorridorData = encodeFunctionData({
    abi: RATELOCK_ABI,
    functionName: "setCorridor",
    args: [
      USD_NGN_PAIR,
      {
        oracle: ORACLE_ADDRESS,
        premiumBps: 100,         // 1%
        maxMoveBps: 2000,        // 20%
        slippageBps: 500,        // 5% — 3rd field, matching struct order
        maxUsdcIn: 100_000_000n, // 100 USDC (6 dec)
        maxExpiry: 604800n,      // 7 days
        oracleMaxAge: 86400n,    // 24h
        graceWindow: 7200n,      // 2h
      },
    ],
  });
  await sendTx("1. setCorridor(USD/NGN)", RATELOCK_ADDRESS, setCorridorData);

  // 2. Set initial oracle rate: ₦1,600 / USDC → rate1e8 = 160_000_000_000
  const setRateData = encodeFunctionData({
    abi: ORACLE_ABI,
    functionName: "set",
    args: [USD_NGN_PAIR, 160_000_000_000n],
  });
  await sendTx("2. PushRateOracle.set(USD/NGN, 160_000_000_000)", ORACLE_ADDRESS, setRateData);

  console.log("\n=== Setup complete ===");
  console.log("USD/NGN corridor registered on testnet.");
  console.log("Initial rate: ₦1,600 / USDC");
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
