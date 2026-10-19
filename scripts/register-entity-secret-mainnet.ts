/**
 * Register the EXISTING entity secret ciphertext with the mainnet Circle entity.
 * The entity secret value is already in .env as CIRCLE_ENTITY_SECRET.
 * This script registers it against CIRCLE_MAINNET_API_KEY.
 *
 * SECURITY: Never prints the entity secret value.
 */
import fs from "node:fs";
import path from "node:path";
import { registerEntitySecretCiphertext, initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const APP_ROOT = "/home/user/app";

// Load .env
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

const mainnetApiKey = process.env.CIRCLE_MAINNET_API_KEY;
if (!mainnetApiKey) {
  console.error("ERROR: CIRCLE_MAINNET_API_KEY not found in .env");
  process.exit(1);
}

const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
if (!entitySecret || entitySecret.length !== 64) {
  console.error("ERROR: CIRCLE_ENTITY_SECRET not found or invalid in .env (expected 64 hex chars)");
  process.exit(1);
}

const RECOVERY_DIR = path.join(APP_ROOT, ".circle");
const RECOVERY_PATH = path.join(RECOVERY_DIR, "recovery_file_mainnet.dat");

async function main() {
  console.log("Registering entity secret ciphertext with Circle mainnet entity...");
  fs.mkdirSync(RECOVERY_DIR, { recursive: true });

  let response: Awaited<ReturnType<typeof registerEntitySecretCiphertext>>;
  try {
    response = await registerEntitySecretCiphertext({
      apiKey: mainnetApiKey!,
      entitySecret: entitySecret!,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("ERROR: Registration failed:", msg);
    process.exit(1);
  }

  const recoveryContent = response.data?.recoveryFile;
  if (recoveryContent) {
    fs.writeFileSync(RECOVERY_PATH, recoveryContent, "utf-8");
    console.log("Mainnet recovery file written to:", RECOVERY_PATH);
  } else {
    console.warn("WARNING: No recovery file in response.");
  }

  // Verify with a read-only call
  console.log("Verifying registration...");
  const client = initiateDeveloperControlledWalletsClient({
    apiKey: mainnetApiKey!,
    entitySecret: entitySecret!,
  });
  await client.listWalletSets({ pageSize: 1 });
  console.log("SUCCESS: Mainnet entity secret registered and verified.");
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
