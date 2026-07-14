import { spawn } from "node:child_process";

const commands = [
  ["api", "pnpm", ["run", "dev:api"]],
  ["web", "pnpm", ["run", "dev:web"]]
];

const children = commands.map(([name, command, args]) => {
  const child = spawn(command, args, {
    stdio: "pipe",
    shell: true,
    env: process.env
  });

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[${name}] ${chunk}`);
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[${name}] ${chunk}`);
  });

  child.on("exit", (code) => {
    if (code && code !== 0) {
      console.error(`[${name}] exited with code ${code}`);
      process.exitCode = code;
      children.forEach((running) => running.kill("SIGTERM"));
    }
  });

  return child;
});

const stop = () => {
  children.forEach((child) => child.kill("SIGTERM"));
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
