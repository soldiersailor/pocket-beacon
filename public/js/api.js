/** Обёртка над fetch для JSON API. */
const api = {
  async req(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
    let data = null;
    try { data = await res.json(); } catch { /* пустой ответ */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || "Ошибка сервера");
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  },
  get(url) { return api.req("GET", url); },
  post(url, body) { return api.req("POST", url, body === undefined ? {} : body); },
  del(url) { return api.req("DELETE", url); },
};
