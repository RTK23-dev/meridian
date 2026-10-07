#!/usr/bin/env node
import { existsSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

console.log("\n=======================================================");
console.log("  🚀 Meridian Content OS — Developer Setup Wizard");
console.log("=======================================================\n");

// 1. Check Node version
const nodeVersion = process.versions.node;
const major = parseInt(nodeVersion.split(".")[0] || "0", 10);
if (major < 20) {
  console.error(`❌ Node.js 20 or higher is required. Current version: ${nodeVersion}`);
  process.exit(1);
}
console.log(`✅ Node.js runtime: v${nodeVersion}`);

// 2. Setup .env file
const envPath = resolve(".env");
const examplePath = resolve(".env.example");

if (!existsSync(envPath) && existsSync(examplePath)) {
  console.log("📝 Generating .env from .env.example with secure local secrets...");
  copyFileSync(examplePath, envPath);
  let envContent = readFileSync(envPath, "utf8");

  const authSecret = randomBytes(32).toString("hex");
  const tokenSecret = randomBytes(32).toString("hex");
  envContent = envContent.replace("BETTER_AUTH_SECRET=", `BETTER_AUTH_SECRET=${authSecret}`);
  envContent = envContent.replace("TOKEN_ENCRYPTION_KEY=", `TOKEN_ENCRYPTION_KEY=${tokenSecret}`);

  writeFileSync(envPath, envContent, "utf8");
  console.log("✅ Created .env with generated BETTER_AUTH_SECRET and TOKEN_ENCRYPTION_KEY.");
} else if (existsSync(envPath)) {
  console.log("✅ .env file found.");
} else {
  console.warn("⚠️  No .env.example found; skipping .env initialization.");
}

// 3. Check FFmpeg
try {
  const ffmpegVersion = execSync("ffmpeg -version", { stdio: "pipe" }).toString().split("\n")[0];
  console.log(`✅ FFmpeg installed: ${ffmpegVersion?.slice(0, 40)}`);
} catch {
  console.log("ℹ️  FFmpeg not found in PATH (optional for local mock mode; required for real video transcription/rendering).");
}

// 4. Run database migrations
console.log("\n📦 Running database migrations...");
try {
  execSync("node scripts/with-dotenv.mjs node scripts/migrate.mjs", { stdio: "inherit" });
  console.log("✅ Database migrations up to date.");
} catch (err) {
  console.warn("⚠️  Migration script finished with notice (PGlite fallback will migrate automatically on start).");
}

console.log("\n=======================================================");
console.log("  ✨ Meridian is ready to run!");
console.log("=======================================================");
console.log("  1. Dev Server:       npm run dev        (port 8080)");
console.log("  2. Background Jobs:  npm run worker     (needs DATABASE_URL)");
console.log("  3. Run Tests:        npm test");
console.log("  4. Verify Build:     npm run typecheck && npm run build");
console.log("=======================================================\n");
