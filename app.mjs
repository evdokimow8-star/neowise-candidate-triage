const TOPICS = new Set(["delivery", "pricing", "other"]);

const MESSAGES = {
  idle: "Введите текст заявки — здесь появится результат разбора.",
  loading: "Готовим черновик ответа…",
  ready: "Черновик готов. Проверьте его и при необходимости отредактируйте.",
  invalid_input: "Введите непустой текст заявки.",
  manual_review: "Автоматический разбор не завершён. Выберите тему и напишите ответ вручную. Исходный текст заявки сохранён.",
};

/** Отделяем сетевые детали от интерфейса и игнорируем устаревшие запросы. */
export function createTriageController({
  render,
  fetchImpl = globalThis.fetch,
  timeoutMs = 5_000,
}) {
  let version = 0;
  let active = null;
  let disposed = false;

  function show(status, { topic = null, draft = null } = {}) {
    render({ status, topic, draft, message: MESSAGES[status] });
  }

  function invalidate() {
    version += 1;
    active?.abort();
    active = null;
  }

  async function submit(text) {
    if (disposed) return;
    invalidate();
    const requestVersion = version;

    if (typeof text !== "string" || text.trim().length === 0) {
      show("invalid_input");
      return;
    }

    show("loading");
    const controller = new AbortController();
    active = controller;
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    const timer = setTimeout(() => {
      controller.abort(new DOMException("Request timed out", "TimeoutError"));
    }, timeoutMs);

    try {
      const operation = (async () => {
        const response = await fetchImpl("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: text.trim() }),
          signal: controller.signal,
        });
        return { response, body: await response.json() };
      })();

      // Ограничиваем время и на fetch, и на чтение JSON, даже если транспорт
      // не может отменить операцию, которая уже дошла до сервера.
      const { response, body } = await Promise.race([operation, aborted]);
      if (disposed || requestVersion !== version) return;

      if (response.status === 400 && body?.status === "invalid_input") {
        show("invalid_input");
      } else if (
        response.status === 200 &&
        body !== null &&
        typeof body === "object" &&
        !Array.isArray(body) &&
        body.status === "ready" &&
        TOPICS.has(body.topic) &&
        typeof body.draft === "string" &&
        body.draft.trim().length > 0
      ) {
        show("ready", { topic: body.topic, draft: body.draft.trim() });
      } else {
        show("manual_review");
      }
    } catch {
      if (!disposed && requestVersion === version) show("manual_review");
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      // Завершение устаревшего запроса не должно затрагивать новый запрос.
      if (active === controller) active = null;
    }
  }

  function reset() {
    if (disposed) return;
    invalidate();
    show("idle");
  }

  function dispose() {
    disposed = true;
    invalidate();
  }

  show("idle");
  return { submit, reset, dispose };
}

if (typeof document !== "undefined") {
  const form = document.querySelector("#triage-form");
  const input = document.querySelector("#message");
  const result = document.querySelector("#result");
  const status = document.querySelector("#status");
  const badge = document.querySelector("#status-badge");
  const topic = document.querySelector("#topic");
  const draft = document.querySelector("#draft");
  const button = document.querySelector("#submit");
  const labels = {
    idle: "Ожидает заявку",
    loading: "Обрабатываем",
    ready: "Черновик готов",
    invalid_input: "Нужен текст",
    manual_review: "Ручной разбор",
  };

  const controller = createTriageController({
    render(state) {
      result.dataset.status = state.status;
      status.textContent = state.message;
      badge.textContent = labels[state.status];
      topic.value = state.topic ?? "";
      draft.value = state.draft ?? "";
      const editable = state.status === "ready" || state.status === "manual_review";
      topic.disabled = !editable;
      draft.disabled = !editable;
      input.setAttribute("aria-invalid", String(state.status === "invalid_input"));
      form.setAttribute("aria-busy", String(state.status === "loading"));
      button.textContent = state.status === "loading" ? "Повторить разбор" : "Подготовить черновик";
    },
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void controller.submit(input.value);
  });
  input.addEventListener("input", () => controller.reset());
}
