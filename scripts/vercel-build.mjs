import { spawnSync } from "node:child_process";

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

// Production builds run the additive Prisma migrations with Vercel's protected DATABASE_URL.
if (process.env.VERCEL_ENV === "production") {
  run("pnpm", ["prisma", "migrate", "deploy"]);
}

run("pnpm", ["prisma", "generate"]);
run("pnpm", ["exec", "tsc", "--noEmit"]);
run("pnpm", ["exec", "vite", "build"]);
