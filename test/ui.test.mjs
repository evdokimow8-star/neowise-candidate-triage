import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { createTriageController } from "../app.mjs";

const READY = { status: "ready", topic: "delivery", draft: "Новый ответ клиенту" };
const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

function reply(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function setup(t, fetchImpl, options = {}) {
  const states = [];
  const controller = createTriageController({
    render: (state) => states.push({ ...state }),
    fetchImpl,
    ...options,
  });
  t.after(() => controller.dispose());
  return { controller, states, current: () => states.at(-1) };
}

function assertCleared(state, status) {
  assert.equal(state.status, status);
  assert.equal(state.topic, null);
  assert.equal(state.draft, null);
  assert.equal(typeof state.message, "string");
  assert.ok(state.message.trim().length > 0);
}

test("пустой ввод сопровождается пояснением без отправки запроса", async (t) => {
  let calls = 0;
  const ui = setup(t, async () => { calls += 1; return reply(READY); });
  await ui.controller.submit(" \n\t ");
  assertCleared(ui.current(), "invalid_input");
  assert.equal(calls, 0);
});

test("ручной разбор очищает тему и черновик предыдущего успешного запроса", async (t) => {
  let response = READY;
  const ui = setup(t, async () => reply(response));
  await ui.controller.submit("Когда доставка?");
  assert.equal(ui.current().draft, READY.draft);
  response = MANUAL_REVIEW;
  const pending = ui.controller.submit("Заявка [error]");
  assertCleared(ui.current(), "loading");
  await pending;
  assertCleared(ui.current(), "manual_review");
});

test("ошибки сети и некорректные ответы API очищают предыдущий черновик", async (t) => {
  const failures = [
    ["ошибка сети", async () => { throw new Error("offline"); }],
    ["ошибка HTTP", async () => reply({ status: "server_error" }, 500)],
    ["некорректный JSON", async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("invalid JSON"); } })],
    ["тело ответа null", async () => reply(null)],
    ["неизвестный статус", async () => reply({ status: "unexpected" })],
    ["неизвестная тема", async () => reply({ ...READY, topic: "refund" })],
    ["черновик содержит только пробелы", async () => reply({ ...READY, draft: " \n\t " })],
  ];
  for (const [name, failedFetch] of failures) {
    await t.test(name, async (subtest) => {
      let implementation = async () => reply(READY);
      const ui = setup(subtest, (...args) => implementation(...args));
      await ui.controller.submit("Первая заявка");
      implementation = failedFetch;
      await ui.controller.submit("Следующая заявка");
      assertCleared(ui.current(), "manual_review");
    });
  }
});

test("отклонение ввода сервером также очищает предыдущий черновик", async (t) => {
  let response = reply(READY);
  const ui = setup(t, async () => response);
  await ui.controller.submit("Первая заявка");
  response = reply({ status: "invalid_input" }, 400);
  await ui.controller.submit("Следующая заявка");
  assertCleared(ui.current(), "invalid_input");
});

test("клиентский таймаут включает ручной разбор, даже если fetch игнорирует отмену", async (t) => {
  let signal;
  const ui = setup(t, (_url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  }, { timeoutMs: 25 });
  await ui.controller.submit("Заявка");
  assertCleared(ui.current(), "manual_review");
  assert.equal(signal.aborted, true);
});

test("обратный порядок ответов сохраняет результат последнего отправленного запроса", async (t) => {
  const requests = [];
  const ui = setup(t, () => {
    const request = deferred();
    requests.push(request);
    return request.promise;
  });
  const first = ui.controller.submit("A");
  await nextTurn();
  const second = ui.controller.submit("B");
  await nextTurn();
  requests[1].resolve(reply({ ...READY, draft: "Результат B" }));
  await second;
  requests[0].resolve(reply({ ...READY, draft: "Устаревший результат A" }));
  await first;
  await nextTurn();
  assert.equal(ui.current().status, "ready");
  assert.equal(ui.current().draft, "Результат B");
});

test("устаревшая ошибка не заменяет последний успешный результат", async (t) => {
  const requests = [];
  const ui = setup(t, () => {
    const request = deferred();
    requests.push(request);
    return request.promise;
  });
  const first = ui.controller.submit("A");
  await nextTurn();
  const second = ui.controller.submit("B");
  await nextTurn();
  requests[1].resolve(reply(READY));
  await second;
  requests[0].reject(new Error("Late error A"));
  await first;
  await nextTurn();
  assert.equal(ui.current().status, "ready");
  assert.equal(ui.current().draft, READY.draft);
});

test("завершение старого запроса не останавливает текущую загрузку", async (t) => {
  const requests = [];
  const ui = setup(t, () => {
    const request = deferred();
    requests.push(request);
    return request.promise;
  });
  const first = ui.controller.submit("A");
  await nextTurn();
  const second = ui.controller.submit("B");
  await nextTurn();
  requests[0].resolve(reply(READY));
  await first;
  await nextTurn();
  assertCleared(ui.current(), "loading");
  requests[1].resolve(reply(READY));
  await second;
  assert.equal(ui.current().status, "ready");
});

test("ошибка последнего запроса не заменяется более старым успешным ответом", async (t) => {
  const requests = [];
  const ui = setup(t, () => {
    const request = deferred();
    requests.push(request);
    return request.promise;
  });
  const first = ui.controller.submit("A");
  await nextTurn();
  const second = ui.controller.submit("B");
  await nextTurn();
  requests[1].reject(new Error("Latest request failed"));
  await second;
  requests[0].resolve(reply(READY));
  await first;
  await nextTurn();
  assertCleared(ui.current(), "manual_review");
});

test("изменение ввода делает ожидаемый ответ неактуальным", async (t) => {
  const request = deferred();
  const ui = setup(t, () => request.promise);
  const pending = ui.controller.submit("Старая заявка");
  await nextTurn();
  ui.controller.reset();
  assert.equal(ui.current().status, "idle");
  assert.equal(ui.current().draft, null);
  request.resolve(reply(READY));
  await pending;
  await nextTurn();
  assert.equal(ui.current().status, "idle");
  assert.equal(ui.current().draft, null);
});
