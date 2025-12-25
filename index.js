import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

const CLIENT_ID = process.env.GIGACHAT_CLIENT_ID;
const CLIENT_SECRET = process.env.GIGACHAT_CLIENT_SECRET; // твой API key
const SCOPE = process.env.GIGACHAT_SCOPE;
const APP_SECRET = process.env.APP_SECRET;

let cachedToken = null;
let cachedExp = 0; // unix seconds

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function uuid() {
  return (globalThis.crypto?.randomUUID?.() ||
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      const v = c === "x" ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    })
  );
}

async function getAccessToken() {
  if (cachedToken && cachedExp && (nowSec() + 120) < cachedExp) return cachedToken;

  if (!CLIENT_ID || !CLIENT_SECRET || !SCOPE) {
    throw new Error("Не заданы переменные окружения GIGACHAT_CLIENT_ID / GIGACHAT_CLIENT_SECRET / GIGACHAT_SCOPE");
  }

  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

  const resp = await fetch("https://ngw.devices.sberbank.ru:9443/api/v2/oauth", {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "RqUID": uuid(),
      "Authorization": `Basic ${basic}`
    },
    body: `scope=${encodeURIComponent(SCOPE)}`
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`OAuth ${resp.status}: ${text.slice(0, 500)}`);

  const data = JSON.parse(text);
  if (!data.access_token || !data.expires_at) {
    throw new Error(`Неожиданный ответ OAuth: ${text.slice(0, 500)}`);
  }

  cachedToken = data.access_token;
  cachedExp = Number(data.expires_at);
  return cachedToken;
}

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/analyze", async (req, res) => {
  try {
    if (!APP_SECRET) throw new Error("Не задан APP_SECRET в переменных окружения");

    const auth = req.headers["x-app-secret"];
    if (auth !== APP_SECRET) return res.status(401).json({ error: "Unauthorized" });

    const { title = "", snippet = "", url = "" } = req.body || {};
    if (!title && !snippet && !url) return res.status(400).json({ error: "Empty input" });

    const token = await getAccessToken();

    const chatResp = await fetch("https://gigachat.devices.sberbank.ru/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({
        model: "GigaChat",
        temperature: 0.2,
        max_tokens: 700,
        messages: [
          {
            role: "system",
            content:
              "Ты аналитик B2B IT-рынка (ITSM/ITAM/CMDB/SAM). " +
              "Верни ТОЛЬКО валидный JSON без markdown и пояснений. " +
              "JSON строго с полями: direction,type,entities,roles,potentialClients,potential,trigger,summary,mediaIndex. " +
              "Если не уверен — пустая строка или 'низкий'."
          },
          {
            role: "user",
            content:
              "Заполни поля по новости.\n" +
              "direction: продукт|партнёрство|рынок|конкуренты|прочее.\n" +
              "type: маркетинговая|пресс-релиз|публичный кейс|аналитический обзор|новостная заметка.\n" +
              "potential/mediaIndex: низкий|средний|высокий.\n\n" +
              `Заголовок: ${title}\nСниппет: ${snippet}\nURL: ${url}`
          }
        ]
      })
    });

    const chatText = await chatResp.text();
    if (!chatResp.ok) throw new Error(`Chat ${chatResp.status}: ${chatText.slice(0, 500)}`);

    const data = JSON.parse(chatText);
    const content = data?.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("Пустой ответ модели (нет content)");

    let obj;
    try {
      obj = JSON.parse(content);
    } catch {
      const m = content.match(/\{[\s\S]*\}/);
      if (!m) throw new Error("Модель не вернула JSON");
      obj = JSON.parse(m[0]);
    }

    res.json({
      direction: obj.direction || "прочее",
      type: obj.type || "новостная заметка",
      entities: obj.entities || "",
      roles: obj.roles || "",
      potentialClients: obj.potentialClients || "",
      potential: obj.potential || "низкий",
      trigger: obj.trigger || "информационный фон",
      summary: obj.summary || (title ? `Коротко: ${title}` : "Коротко: без заголовка"),
      mediaIndex: obj.mediaIndex || "низкий"
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("Listening on", port));
