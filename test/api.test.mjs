import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { createTriageServer } from "../server.mjs";

const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

async function startServer(t, options) {
  const server = createTriageServer(options);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    const closed = new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    server.closeAllConnections();
    await closed;
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function post(baseUrl, body) {
  const response = await fetch(`${baseUrl}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  return { status: response.status, body: await response.json() };
}

test("некорректный ввод возвращает 400 без обращения к ИИ", async (t) => {
  let calls = 0;
  const baseUrl = await startServer(t, {
    classifyFn: async () => {
      calls += 1;
      return JSON.stringify({ topic: "other", draft: "Unexpected call" });
    },
  });
  const inputs = [
    ["пустое тело запроса", ""],
    ["повреждённый JSON", '{"text":'],
    ["тело запроса null", "null"],
    ["тело запроса — массив", "[]"],
    ["тело запроса — строка", '"hello"'],
    ["поле text отсутствует", "{}"],
    ["поле text равно null", '{"text":null}'],
    ["поле text — число", '{"text":123}'],
    ["поле text — логическое значение", '{"text":false}'],
    ["поле text — объект", '{"text":{}}'],
    ["поле text — массив", '{"text":[]}'],
    ["пустое поле text", '{"text":""}'],
    ["поле text содержит только пробелы", JSON.stringify({ text: " \n\t\u00a0 " })],
  ];
  for (const [name, body] of inputs) {
    await t.test(name, async () => {
      assert.deepEqual(await post(baseUrl, body), {
        status: 400,
        body: { status: "invalid_input" },
      });
    });
  }
  assert.equal(calls, 0);
});

test("исходный имитатор возвращает каждую допустимую тему", async (t) => {
  const baseUrl = await startServer(t);
  for (const [text, topic] of [
    ["Когда доставка?", "delivery"],
    ["Какая стоимость?", "pricing"],
    ["Здравствуйте!", "other"],
  ]) {
    const response = await post(baseUrl, JSON.stringify({ text }));
    assert.deepEqual(response, {
      status: 200,
      body: {
        status: "ready",
        topic,
        draft: "Спасибо за обращение. Уточним детали заявки.",
      },
    });
  }
});

test("ответ ИИ нормализуется и содержит только поля контракта", async (t) => {
  const baseUrl = await startServer(t, {
    classifyFn: async () => JSON.stringify({
      status: "unexpected_provider_status",
      topic: "pricing",
      draft: " \n Уточним стоимость. \t",
      extra: "not part of the API response",
    }),
  });
  assert.deepEqual(await post(baseUrl, JSON.stringify({ text: "Цена" })), {
    status: 200,
    body: { status: "ready", topic: "pricing", draft: "Уточним стоимость." },
  });
});

test("каждый сбой имитатора возвращает ответ для ручного разбора", async (t) => {
  const baseUrl = await startServer(t);
  for (const marker of ["[timeout]", "[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
    await t.test(marker, async () => {
      const started = performance.now();
      const response = await post(baseUrl, JSON.stringify({ text: `Заявка ${marker}` }));
      assert.deepEqual(response, { status: 200, body: MANUAL_REVIEW });
      if (marker === "[timeout]") {
        // Имитатор ждёт 1200 мс; учитываем задержки планировщика вокруг лимита 300 мс.
        assert.ok(performance.now() - started < 1_000, "response exceeded the AI deadline with scheduling slack");
      }
    });
  }
});

test("JSON с некорректной структурой ответа ИИ направляется на ручной разбор", async (t) => {
  let modelOutput;
  const baseUrl = await startServer(t, { classifyFn: async () => modelOutput });
  const invalidOutputs = [
    ["значение null", "null"],
    ["массив", "[]"],
    ["обязательные поля отсутствуют", "{}"],
    ["черновик отсутствует", JSON.stringify({ topic: "delivery" })],
    ["черновик не является строкой", JSON.stringify({ topic: "delivery", draft: 42 })],
    ["черновик равен null", JSON.stringify({ topic: "delivery", draft: null })],
    ["тема не является строкой", JSON.stringify({ topic: ["delivery"], draft: "Ответ" })],
    ["ключ прототипа в качестве темы", JSON.stringify({ topic: "toString", draft: "Ответ" })],
    ["__proto__ в качестве темы", JSON.stringify({ topic: "__proto__", draft: "Ответ" })],
    ["ответ провайдера не является строкой", { topic: "delivery", draft: "Ответ" }],
  ];
  for (const [name, output] of invalidOutputs) {
    await t.test(name, async () => {
      modelOutput = output;
      assert.deepEqual(await post(baseUrl, '{"text":"Заявка"}'), {
        status: 200,
        body: MANUAL_REVIEW,
      });
    });
  }
});

test("таймаут завершает ожидание даже при игнорировании отмены; поздняя ошибка обработана", async (t) => {
  let signal;
  let rejectProvider;
  const baseUrl = await startServer(t, {
    timeoutMs: 25,
    classifyFn: (_text, options) => {
      signal = options.signal;
      return new Promise((_resolve, reject) => { rejectProvider = reject; });
    },
  });
  assert.deepEqual(await post(baseUrl, '{"text":"Заявка"}'), {
    status: 200,
    body: MANUAL_REVIEW,
  });
  assert.equal(signal.aborted, true);
  rejectProvider(new Error("Provider rejected after the HTTP response"));
  // node:test обнаружит необработанную ошибку; даём позднему отказу выполниться.
  await nextTurn();
});

test("страница и браузерный модуль доступны с одного сервера", async (t) => {
  const baseUrl = await startServer(t);
  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /app\.mjs/);
  const script = await fetch(`${baseUrl}/app.mjs`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /javascript/);
  assert.match(await script.text(), /createTriageController/);
});
