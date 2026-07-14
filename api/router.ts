import { app } from "../src/server/routes.js";

export const config = {
  api: {
    bodyParser: false
  }
};

function requestUrl(req: { url?: string; headers: Record<string, string | string[] | undefined> }) {
  const host = req.headers.host || "localhost";
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const url = new URL(req.url || "/", `${String(protocol)}://${String(host)}`);
  const routedPath = url.searchParams.get("__path");

  if (routedPath) {
    url.pathname = `/api/${routedPath.replace(/^\/+/, "")}`;
    url.searchParams.delete("__path");
  }

  return url;
}

function requestHeaders(headers: Record<string, string | string[] | undefined>) {
  const nextHeaders = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        nextHeaders.append(key, item);
      }
    } else if (value !== undefined) {
      nextHeaders.set(key, value);
    }
  }
  return nextHeaders;
}

async function requestBody(req: NodeJS.ReadableStream & { method?: string; body?: unknown }) {
  if (req.method === "GET" || req.method === "HEAD") {
    return undefined;
  }

  if (typeof req.body === "string") {
    return req.body;
  }

  if (req.body && typeof req.body === "object") {
    return JSON.stringify(req.body);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

export default async function handler(
  req: NodeJS.ReadableStream & {
    method?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
    body?: unknown;
  },
  res: {
    statusCode: number;
    setHeader: (key: string, value: string) => void;
    end: (body?: Buffer | string) => void;
  }
) {
  const request = new Request(requestUrl(req), {
    method: req.method,
    headers: requestHeaders(req.headers),
    body: await requestBody(req)
  });

  const response = await app.fetch(request);
  res.statusCode = response.status;
  response.headers.forEach((value: string, key: string) => res.setHeader(key, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}
