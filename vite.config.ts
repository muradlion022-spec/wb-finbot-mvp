import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const localEnv = loadEnv(mode, process.cwd(), "");
  const requestedApiBase =
    mode === "production"
      ? process.env.VITE_API_BASE_URL?.trim() || ""
      : localEnv.VITE_API_BASE_URL?.trim() || "";
  const isLocalApiBase = /(^|\/\/)(localhost|127\.0\.0\.1)(:|\/|$)/i.test(requestedApiBase);

  if (mode === "production" && isLocalApiBase) {
    throw new Error(
      "VITE_API_BASE_URL must be empty in a production build. The Mini App uses relative /api routes; localhost is only allowed through the local Vite proxy."
    );
  }

  const version = (process.env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_DEPLOYMENT_ID || "local").slice(0, 12);
  const builtAt = process.env.BUILD_TIMESTAMP || process.env.VERCEL_DEPLOYMENT_CREATED_AT || new Date().toISOString();

  return {
    plugins: [react()],
    envPrefix: "VITE_",
    define: {
      "import.meta.env.VITE_APP_VERSION": JSON.stringify(version),
      "import.meta.env.VITE_APP_BUILT_AT": JSON.stringify(builtAt)
    },
    root: ".",
    server: {
      port: 5173,
      proxy: {
        "/api": requestedApiBase || "http://localhost:3000"
      }
    },
    build: {
      outDir: "dist/web",
      emptyOutDir: true
    }
  };
});
