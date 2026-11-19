import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { classify } from "./mock-ai.mjs";

const topics = new Set(["delivery", "pricing", "other"]);
const manualReview = { status: "manual_review", topic: null, draft: null };

function json(response, status, body) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readText(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (
    body === null || typeof body !== "object" || Array.isArray(body) ||
    typeof body.text !== "string" || body.text.trim().length === 0
  ) {
    throw new Error("Invalid input");
  }
  return body.text.trim();
}

async function triage(text, classifyFn, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error("AI deadline exceeded"));
        controller.abort();
      }, timeoutMs);
    });
    // Ограничение времени действует и при игнорировании провайдером AbortSignal.
    const raw = await Promise.race([
      Promise.resolve().then(() => classifyFn(text, { signal: controller.signal })),
      deadline,
    ]);
    if (typeof raw !== "string") return manualReview;
    const result = JSON.parse(raw);
    if (
      result === null || typeof result !== "object" || Array.isArray(result) ||
      !topics.has(result.topic) || typeof result.draft !== "string" ||
      result.draft.trim().length === 0
    ) {
      return manualReview;
    }
    // Явно заданные поля не позволяют провайдеру подменить статус нашего ответа.
    return { status: "ready", topic: result.topic, draft: result.draft.trim() };
  } catch {
    return manualReview;
  } finally {
    clearTimeout(timer);
  }
}

export function createTriageServer({ classifyFn = classify, timeoutMs = 300 } = {}) {
  return createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://localhost").pathname;
      if (request.method === "GET" && (pathname === "/" || pathname === "/app.mjs")) {
        const file = pathname === "/" ? "index.html" : "app.mjs";
        const content = await readFile(new URL(`./${file}`, import.meta.url));
        response.writeHead(200, {
          "Content-Type": pathname === "/"
            ? "text/html; charset=utf-8"
            : "text/javascript; charset=utf-8",
        });
        response.end(content);
        return;
      }
      if (request.method !== "POST" || pathname !== "/api/triage") {
        return json(response, 404, { status: "not_found" });
      }
      let text;
      try {
        text = await readText(request);
      } catch {
        return json(response, 400, { status: "invalid_input" });
      }
      return json(response, 200, await triage(text, classifyFn, timeoutMs));
    } catch {
      json(response, 500, { status: "server_error" });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  createTriageServer().listen(Number(process.env.PORT || 3000), "127.0.0.1");
}
