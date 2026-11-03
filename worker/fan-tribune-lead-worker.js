/**
 * Cloudflare Worker — приём заявок с fan-tribune.ru
 * Доставка: Telegram-группа + e-mail (MailChannels).
 * Секреты (задаются через Dashboard/Wrangler, в коде НЕ хранятся):
 *   TG_TOKEN   — токен бота Telegram
 *   TG_CHAT_ID — id группы (-1004331026655)
 *   LEAD_EMAIL — куда слать почту (magicgardenn5@yandex.ru)
 *
 * Защита:
 *  - CORS только для fan-tribune.ru / www.fan-tribune.ru
 *  - honeypot: заполненное скрытое поле "company" => молчаливый отказ
 *  - rate-limit: не более 5 заявок с одного IP за 10 минут (in-memory на изолят)
 *  - валидация телефона (>= 10 цифр)
 */

const ALLOWED_ORIGINS = new Set([
  "https://fan-tribune.ru",
  "https://www.fan-tribune.ru",
  "http://localhost:8000",
]);

// ---- простой in-memory rate limit (на изолят) ----
const buckets = new Map(); // ip -> [ts, ...]
const RL_WINDOW_MS = 10 * 60 * 1000;
const RL_MAX = 5;

function rateLimited(ip) {
  const now = Date.now();
  const arr = (buckets.get(ip) || []).filter((t) => now - t < RL_WINDOW_MS);
  if (arr.length >= RL_MAX) {
    buckets.set(ip, arr);
    return true;
  }
  arr.push(now);
  buckets.set(ip, arr);
  return false;
}

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.has(origin) ? origin : "https://fan-tribune.ru";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json; charset=utf-8",
  };
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function sendTelegram(env, text) {
  const res = await fetch(
    `https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TG_CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    }
  );
  return res.ok;
}

async function sendEmail(env, subject, text) {
  // MailChannels — бесплатная отправка почты из Workers
  const res = await fetch("https://api.mailchannels.net/tx/v1/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: env.LEAD_EMAIL }] }],
      from: { email: "noreply@fan-tribune.ru", name: "Сайт fan-tribune.ru" },
      subject,
      content: [{ type: "text/plain", value: text }],
    }),
  });
  return res.ok;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const headers = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ ok: false, error: "method" }), {
        status: 405,
        headers,
      });
    }

    // rate limit по IP
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (rateLimited(ip)) {
      return new Response(
        JSON.stringify({ ok: false, error: "rate_limited" }),
        { status: 429, headers }
      );
    }

    let data;
    try {
      data = await request.json();
    } catch {
      return new Response(JSON.stringify({ ok: false, error: "bad_json" }), {
        status: 400,
        headers,
      });
    }

    // honeypot: боты заполняют скрытое поле
    if (data.company && String(data.company).trim() !== "") {
      // притворяемся успешными, чтобы бот не перепробовал
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    }

    const name = String(data.name || "").trim().slice(0, 100);
    const phone = String(data.phone || "").trim().slice(0, 40);
    const product = String(data.product || "").trim().slice(0, 60);
    const page = String(data.page || "").trim().slice(0, 120);
    const extra = String(data.extra || "").trim().slice(0, 300); // места/объект для квиза

    if (phone.replace(/\D/g, "").length < 10) {
      return new Response(
        JSON.stringify({ ok: false, error: "bad_phone" }),
        { status: 400, headers }
      );
    }

    const tgText =
      "🔔 <b>Новая заявка — fan-tribune.ru</b>\n\n" +
      "👤 Имя: " + esc(name || "—") + "\n" +
      "📞 Телефон: " + esc(phone) + "\n" +
      (product ? "🪑 Модель: " + esc(product) + "\n" : "") +
      (extra ? "📋 " + esc(extra) + "\n" : "") +
      (page ? "📄 Страница: " + esc(page) : "");

    const mailText =
      "Новая заявка с сайта fan-tribune.ru\n\n" +
      "Имя: " + (name || "—") + "\n" +
      "Телефон: " + phone + "\n" +
      (product ? "Модель: " + product + "\n" : "") +
      (extra ? extra + "\n" : "") +
      (page ? "Страница: " + page + "\n" : "") +
      "\nIP: " + ip;

    const [tgOk, mailOk] = await Promise.all([
      sendTelegram(env, tgText).catch(() => false),
      sendEmail(env, "Заявка с fan-tribune.ru" + (product ? " — " + product : ""), mailText).catch(() => false),
    ]);

    // считаем успехом доставку хотя бы в один канал
    return new Response(
      JSON.stringify({ ok: tgOk || mailOk, tg: tgOk, mail: mailOk }),
      { status: tgOk || mailOk ? 200 : 502, headers }
    );
  },
};
