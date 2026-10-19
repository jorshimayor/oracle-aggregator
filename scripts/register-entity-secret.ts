#!/usr/bin/env bun
/**
 * One-time entity secret registration for Circle developer-controlled wallets.
 * Run: bun run scripts/register-entity-secret.ts
 *
 * SECURITY: This script never prints the entity secret to stdout.
 * It writes the secret directly to .env and the recovery file to .circle/.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { registerEntitySecretCiphertext, initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

// Load .env before reading any env vars
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
const ENV_PATH = path.join(APP_ROOT, ".env");
const RECOVERY_DIR = path.join(APP_ROOT, ".circle");
const RECOVERY_PATH = path.join(RECOVERY_DIR, "recovery_file.dat");

// Support both the canonical CIRCLE_API_KEY and project-specific aliases
const apiKey =
  process.env.CIRCLE_API_KEY ||
  process.env.CIRCLE_TESTNET_API_KEY ||
  process.env.CIRCLE_MAINNET_API_KEY;
if (!apiKey) {
  console.error("ERROR: No Circle API key found. Set CIRCLE_API_KEY, CIRCLE_TESTNET_API_KEY, or CIRCLE_MAINNET_API_KEY in .env.");
  process.exit(1);
}
// Entity secret registration is account-wide — it uses whichever key is available.
// The same entity secret works with both the testnet and mainnet API keys.

// 1. Generate secret — captured without printing
const entitySecret = crypto.randomBytes(32).toString("hex");

// 2. Register ciphertext with Circle
console.log("Registering entity secret ciphertext with Circle...");
fs.mkdirSync(RECOVERY_DIR, { recursive: true });
let response: Awaited<ReturnType<typeof registerEntitySecretCiphertext>>;
try {
  // Do NOT pass recoveryFileDownloadPath — we write the file ourselves
  // to avoid SDK-generated filename collisions.
  response = await registerEntitySecretCiphertext({
    apiKey,
    entitySecret,
  });
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("ERROR: Registration failed:", msg);
  process.exit(1);
}

// 3. Write recovery file ourselves
const recoveryContent = response.data?.recoveryFile;
if (recoveryContent) {
  fs.writeFileSync(RECOVERY_PATH, recoveryContent, "utf-8");
  console.log("Recovery file written to:", RECOVERY_PATH);
} else {
  console.warn("WARNING: No recovery file content in response — manual download required from Circle Console.");
}

// 4. Persist entity secret to .env (never printed)
const envLine = `\nCIRCLE_ENTITY_SECRET=${entitySecret}\n`;
fs.appendFileSync(ENV_PATH, envLine, "utf-8");
console.log("Entity secret persisted to .env as CIRCLE_ENTITY_SECRET.");

// 5. Verify round-trip
console.log("Verifying registration with a read-only SDK call...");
try {
  const client = initiateDeveloperControlledWalletsClient({
    apiKey,
    entitySecret,
  });
  await client.listWalletSets({ pageSize: 1 });
  console.log("SUCCESS: Entity secret registered and verified.");
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("ERROR: Verification call failed:", msg);
  process.exit(1);
}
