import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import crypto from "crypto";

dotenv.config();

const app = express();
app.set("trust proxy", 1); // پشت پروکسی Render، آی‌پی واقعی کاربر را بخوان
const PORT = process.env.PORT || 3000;

// ---------- تنظیمات هوش مصنوعی (CodeCraft API) ----------
const CODECRAFT_API_KEY = process.env.CODECRAFT_API_KEY;
const CODECRAFT_BASE_URL = (
  process.env.CODECRAFT_BASE_URL || "https://codecraftapi.com/v1"
).replace(/\/+$/, "");
const AI_MODEL = process.env.CODECRAFT_MODEL || "gpt-5.6-luna";
const AI_TEMPERATURE = 1;
const AI_MAX_TOKENS = 8192;
const AI_TIMEOUT_MS = 90_000; // بعد از ۹۰ ثانیه درخواست لغو می‌شود

const MAX_HISTORY_MESSAGES = 20; // چند پیام آخر مکالمه برای مدل فرستاده شود
const MAX_USER_CHARS = 4000; // سقف طول هر پیام کاربر
const MAX_ASSISTANT_CHARS = 16000; // سقف طول پاسخ‌های قبلی در تاریخچه
const RATE_LIMIT_PER_MINUTE = 15; // سقف پیام سایت در دقیقه برای هر آی‌پی

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = TELEGRAM_BOT_TOKEN
  ? `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`
  : null;

// ---------- متن شخصی‌سازی (درباره‌ی صاحب ربات) ----------
// اولویت با متغیر محیطی ABOUT_ME_TEXT است (که فقط توی پنل Render وارد می‌شه و
// هیچ‌وقت وارد گیت‌هاب نمی‌شه). اگه این متغیر ست نشده باشه، از فایل about-me.txt
// خونده می‌شه (برای تست لوکال یا اگه ترجیح دادی توی فایل نگهش داری).
function loadAboutMe() {
  if (process.env.ABOUT_ME_TEXT && process.env.ABOUT_ME_TEXT.trim()) {
    return process.env.ABOUT_ME_TEXT.trim();
  }
  try {
    const content = fs.readFileSync("./about-me.txt", "utf-8").trim();
    return content || null;
  } catch {
    return null;
  }
}

const ABOUT_ME_TEXT = loadAboutMe();

const SYSTEM_INSTRUCTIONS = ABOUT_ME_TEXT
  ? "تو یک دستیار هوش مصنوعی هستی که از طرف صاحب این ربات به سوالات کاربران جواب می‌دی. " +
    "فقط بر اساس اطلاعاتی که پایین‌تر اومده درباره‌ی این شخص جواب بده، با لحنی دوستانه، طبیعی و به فارسی. " +
    "اگه سوالی درباره چیزی بود که توی این اطلاعات نیست، صادقانه بگو که این اطلاعات رو نداری و حدس نزن. " +
    "اطلاعات درباره‌ی این شخص:\n\n" + ABOUT_ME_TEXT
  : "";

if (!ABOUT_ME_TEXT) {
  console.warn("⚠️  فایل about-me.txt پیدا نشد یا خالیه — ربات بدون شخصی‌سازی جواب می‌ده.");
}

// آیدی عددی تلگرام خودت و رمز عبور پنل ادمین (هر دو را در Render تنظیم کن)
// می‌شود چند آیدی را با کاما جدا کرد: ADMIN_TELEGRAM_ID=111111,222222
const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_ID || "")
  .split(/[,\s]+/)
  .map(Number)
  .filter(Number.isFinite);
const isAdminId = chatId => ADMIN_IDS.includes(chatId);

// شناسه‌ی این اجرای سرور؛ اگر در لاگ دو شناسه‌ی متفاوت دیدی یعنی دو نسخه‌ی سرور همزمان جواب می‌دهند
const BOOT_ID = crypto.randomBytes(3).toString("hex");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// ---------- ذخیره‌سازی ساده روی فایل (برای توکن‌ها) ----------
const DATA_FILE = "./data.json";

function loadData() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    if (!data.users) data.users = [];
    return data;
  } catch {
    return { tokens: {}, users: [] };
  }
}

// هر چت‌آیدی که تا حالا با ربات پیام رد و بدل کرده را برای اعلامیه‌ها ثبت کن
function trackUser(chatId) {
  if (!db.users.includes(chatId)) {
    db.users.push(chatId);
    saveData(db);
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

let db = loadData();

function generateToken() {
  return crypto.randomBytes(4).toString("hex"); // مثلا: a1b2c3d4
}

// آیا این چت اجازه‌ی صحبت با هوش مصنوعی را دارد؟
function isAuthorized(chatId) {
  if (isAdminId(chatId)) return true;

  return Object.values(db.tokens).some(
    t => t.usedBy === chatId && t.active
  );
}

// ---------- حافظه‌ی موقت مکالمه و وضعیت‌های در انتظار ----------
const chatConversations = new Map(); // chatId -> [{ role, content }, ...] (تاریخچه‌ی مکالمه)
const pendingAction = new Map(); // chatId -> "admin_password" | "redeem_token" | "broadcast_message"
const adminSessions = new Set(); // chatId هایی که با موفقیت لاگین ادمین کرده‌اند

const MAIN_KEYBOARD = {
  keyboard: [
    ["🆕 چت جدید", "❌ لغو"],
    ["📖 راهنما", "ℹ️ درباره ربات"],
    ["🔑 وارد کردن توکن"]
  ],
  resize_keyboard: true
};

const ADMIN_KEYBOARD = {
  inline_keyboard: [
    [{ text: "🎫 ساخت توکن جدید", callback_data: "admin_new_token" }],
    [{ text: "📋 لیست توکن‌ها", callback_data: "admin_list_tokens" }],
    [{ text: "📢 ارسال اعلامیه", callback_data: "admin_broadcast" }]
  ]
};

const HELP_TEXT =
  "📖 راهنما\n\n" +
  "هر سوالی داری همینجا بنویس تا جواب بدم.\n\n" +
  "🆕 چت جدید — مکالمه رو از صفر شروع می‌کنه\n" +
  "❌ لغو — مکالمه‌ی فعلی رو پاک می‌کنه\n" +
  "🔑 وارد کردن توکن — فعال‌سازی دسترسی با توکن\n" +
  "📖 راهنما — همین پیام\n" +
  "ℹ️ درباره ربات — توضیح کوتاه درباره من";

const ABOUT_TEXT =
  "ℹ️ درباره ربات\n\n" +
  "من یک دستیار هوش مصنوعی هستم و برای پاسخ به سوالات شما اینجا هستم 🤖";

const WELCOME_TEXT =
  "سلام 👋 من یک ربات هوش مصنوعی هستم.\nهر سوالی داری بپرس تا برات جواب بدم 🤖";

const NEED_TOKEN_TEXT =
  "🔒 برای استفاده از ربات به یک توکن دسترسی نیاز داری.\n" +
  "روی دکمه‌ی «🔑 وارد کردن توکن» بزن و توکن رو بفرست.";

app.use(express.json({ limit: "100kb" }));
app.use(express.static("public"));

// ---------- تابع مشترک: پرسیدن از CodeCraft API ----------
class AIError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

// متن خطا برای نمایش به کاربر (جزئیات فنی فقط در لاگ سرور می‌ماند)
function friendlyError(error) {
  if (error?.status === 429) {
    return "تعداد درخواست‌ها زیاد است. چند لحظه صبر کن و دوباره امتحان کن.";
  }
  if (error?.status === 504) {
    return "پاسخ دیر رسید. دوباره امتحان کن.";
  }
  return "الان نمی‌تونم به هوش مصنوعی وصل بشم. کمی بعد دوباره امتحان کن.";
}

function extractAnswer(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.map(part => part?.text ?? "").join("").trim();
  }
  return "";
}

// history: آرایه‌ای از { role: "user" | "assistant", content }
// این API حافظه ندارد، پس کل مکالمه در هر درخواست فرستاده می‌شود.
async function askAI(history) {
  if (!CODECRAFT_API_KEY) {
    throw new AIError("CODECRAFT_API_KEY is not set", 500);
  }

  const messages = SYSTEM_INSTRUCTIONS
    ? [{ role: "system", content: SYSTEM_INSTRUCTIONS }, ...history]
    : history;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  try {
    const response = await fetch(`${CODECRAFT_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${CODECRAFT_API_KEY}`
      },
      body: JSON.stringify({
        model: AI_MODEL,
        temperature: AI_TEMPERATURE,
        max_tokens: AI_MAX_TOKENS,
        messages
      }),
      signal: controller.signal
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error("CodeCraft API error:", response.status, JSON.stringify(data));
      throw new AIError(`CodeCraft API returned ${response.status}`, response.status);
    }

    return extractAnswer(data) || "پاسخی دریافت نشد.";
  } catch (error) {
    if (error instanceof AIError) throw error;
    if (error.name === "AbortError") {
      throw new AIError("CodeCraft API timed out", 504);
    }
    console.error("CodeCraft request failed:", error);
    throw new AIError(`Network error: ${error.message}`, 502);
  } finally {
    clearTimeout(timer);
  }
}

// تاریخچه‌ی دریافتی از کلاینت را تمیز کن (فقط user/assistant، طول محدود)
function sanitizeHistory(raw) {
  if (!Array.isArray(raw)) return [];

  const clean = raw
    .filter(m =>
      m &&
      (m.role === "user" || m.role === "assistant") &&
      typeof m.content === "string" &&
      m.content.trim()
    )
    .map(m => ({
      role: m.role,
      content: m.content.slice(0, m.role === "user" ? MAX_USER_CHARS : MAX_ASSISTANT_CHARS)
    }))
    .slice(-MAX_HISTORY_MESSAGES);

  while (clean.length && clean[0].role !== "user") clean.shift();
  return clean;
}

// ---------- محدودیت تعداد پیام سایت (برای جلوگیری از سوءاستفاده) ----------
const rateBuckets = new Map();

function rateLimit(req, res, next) {
  const now = Date.now();
  const recent = (rateBuckets.get(req.ip) || []).filter(t => now - t < 60_000);

  if (recent.length >= RATE_LIMIT_PER_MINUTE) {
    return res.status(429).json({
      error: "تعداد پیام‌ها زیاد بود. یک دقیقه صبر کن و دوباره امتحان کن."
    });
  }

  recent.push(now);
  rateBuckets.set(req.ip, recent);
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of rateBuckets) {
    if (times.every(t => now - t >= 60_000)) rateBuckets.delete(ip);
  }
}, 5 * 60_000).unref();

// ---------- Website chat endpoint (بدون سیستم توکن) ----------
app.post("/api/chat", rateLimit, async (req, res) => {
  const body = req.body || {};
  const history = sanitizeHistory(
    Array.isArray(body.messages)
      ? body.messages
      : [{ role: "user", content: body.message }]
  );

  if (!history.length || history[history.length - 1].role !== "user") {
    return res.status(400).json({ error: "پیام خالی است" });
  }

  try {
    const answer = await askAI(history);
    res.json({ answer });
  } catch (error) {
    console.error(error);
    res.status(error.status === 429 ? 429 : 502).json({ error: friendlyError(error) });
  }
});

// ---------- Telegram bot webhook ----------
app.post("/telegram-webhook", async (req, res) => {
  res.sendStatus(200);

  console.log(`[boot ${BOOT_ID}] Incoming Telegram update:`, JSON.stringify(req.body));

  if (!TELEGRAM_API) {
    console.error("TELEGRAM_BOT_TOKEN is not set");
    return;
  }

  try {
    // دکمه‌های شیشه‌ای پنل ادمین
    if (req.body.callback_query) {
      await handleCallbackQuery(req.body.callback_query);
      return;
    }

    const message = req.body.message;
    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const text = message.text.trim();

    trackUser(chatId);

    // ---------- دستور مخفی پنل ادمین (در منوی عمومی ثبت نشده) ----------
    // آیدی عددی چت را به خود کاربر نشان بده (برای ست کردن ADMIN_TELEGRAM_ID)
    if (text === "/id") {
      await sendTelegramMessage(chatId, `🆔 آیدی عددی تو: \`${chatId}\``);
      return;
    }

    if (text === "/admin") {
      if (!isAdminId(chatId)) {
        console.warn(`[boot ${BOOT_ID}] /admin رد شد: فرستنده ${chatId}، ادمین‌ها: [${ADMIN_IDS.join(", ")}]`);
        return; // سکوت کامل برای غیر ادمین
      }
      pendingAction.set(chatId, "admin_password");
      await sendTelegramMessage(chatId, "🔐 رمز عبور پنل ادمین را وارد کن:");
      return;
    }

    // در انتظار وارد کردن رمز پنل ادمین
    if (pendingAction.get(chatId) === "admin_password") {
      pendingAction.delete(chatId);
      if (text === ADMIN_PASSWORD) {
        adminSessions.add(chatId);
        await sendTelegramMessageWithMarkup(chatId, "✅ وارد پنل ادمین شدی:", ADMIN_KEYBOARD);
      } else {
        await sendTelegramMessage(chatId, "❌ رمز اشتباه است.");
      }
      return;
    }

    // ---------- دکمه‌های عمومی ----------
    if (text === "/start") {
      chatConversations.delete(chatId);
      await sendTelegramMessage(
        chatId,
        isAuthorized(chatId) ? WELCOME_TEXT : WELCOME_TEXT + "\n\n" + NEED_TOKEN_TEXT,
        MAIN_KEYBOARD
      );
      return;
    }

    if (text === "/new" || text === "🆕 چت جدید") {
      chatConversations.delete(chatId);
      await sendTelegramMessage(chatId, "✅ چت جدید شروع شد.", MAIN_KEYBOARD);
      return;
    }

    if (text === "/cancel" || text === "❌ لغو") {
      chatConversations.delete(chatId);
      pendingAction.delete(chatId);
      await sendTelegramMessage(chatId, "❌ لغو شد.", MAIN_KEYBOARD);
      return;
    }

    if (text === "/help" || text === "📖 راهنما") {
      await sendTelegramMessage(chatId, HELP_TEXT, MAIN_KEYBOARD);
      return;
    }

    if (text === "/about" || text === "ℹ️ درباره ربات") {
      await sendTelegramMessage(chatId, ABOUT_TEXT, MAIN_KEYBOARD);
      return;
    }

    // در انتظار متن اعلامیه از ادمین
    if (pendingAction.get(chatId) === "broadcast_message") {
      pendingAction.delete(chatId);
      await broadcastMessage(chatId, text);
      return;
    }

    // ---------- ورود توکن ----------
    if (text === "/token" || text === "🔑 وارد کردن توکن") {
      pendingAction.set(chatId, "redeem_token");
      await sendTelegramMessage(chatId, "🔑 توکن خودت را ارسال کن:");
      return;
    }

    if (pendingAction.get(chatId) === "redeem_token") {
      pendingAction.delete(chatId);
      const token = db.tokens[text];

      if (!token) {
        await sendTelegramMessage(chatId, "❌ این توکن معتبر نیست.", MAIN_KEYBOARD);
      } else if (!token.active) {
        await sendTelegramMessage(chatId, "🔒 این توکن غیرفعال شده است.", MAIN_KEYBOARD);
      } else if (token.usedBy && token.usedBy !== chatId) {
        await sendTelegramMessage(chatId, "❌ این توکن قبلاً توسط شخص دیگری استفاده شده است.", MAIN_KEYBOARD);
      } else {
        token.usedBy = chatId;
        saveData(db);
        await sendTelegramMessage(chatId, "✅ توکن با موفقیت فعال شد! حالا می‌تونی سوالت رو بپرسی.", MAIN_KEYBOARD);
      }
      return;
    }

    // ---------- چت با هوش مصنوعی (فقط برای کاربران مجاز) ----------
    if (!isAuthorized(chatId)) {
      await sendTelegramMessage(chatId, NEED_TOKEN_TEXT, MAIN_KEYBOARD);
      return;
    }

    if (!text) return;

    const history = chatConversations.get(chatId) ?? [];
    const userMessage = { role: "user", content: text.slice(0, MAX_USER_CHARS) };

    const typing = startTyping(chatId);
    try {
      const answer = await askAI([...history, userMessage]);
      chatConversations.set(
        chatId,
        trimHistory([...history, userMessage, { role: "assistant", content: answer }])
      );
      await sendTelegramMessage(chatId, answer, MAIN_KEYBOARD, "AI");
    } catch (error) {
      console.error("AI request failed:", error);
      await sendTelegramMessage(chatId, friendlyError(error), MAIN_KEYBOARD);
    } finally {
      clearInterval(typing);
    }

  } catch (error) {
    console.error("Telegram webhook error:", error);
  }
});

// ---------- مدیریت دکمه‌های شیشه‌ای پنل ادمین ----------
async function handleCallbackQuery(callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;

  await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQuery.id })
  });

  if (!adminSessions.has(chatId)) {
    await sendTelegramMessage(chatId, "⛔ ابتدا وارد پنل ادمین شو (/admin).");
    return;
  }

  if (data === "admin_new_token") {
    const token = generateToken();
    db.tokens[token] = { active: true, usedBy: null, createdAt: Date.now() };
    saveData(db);
    await sendTelegramMessage(chatId, `🎫 توکن جدید ساخته شد:\n\n\`${token}\`\n\nاین را برای کاربر مورد نظر بفرست.`);
    return;
  }

  if (data === "admin_list_tokens") {
    await sendTokenList(chatId);
    return;
  }

  if (data === "admin_broadcast") {
    pendingAction.set(chatId, "broadcast_message");
    await sendTelegramMessage(chatId, "📢 متن اعلامیه را بفرست تا برای همه‌ی کاربران ارسال شود:");
    return;
  }

  if (data.startsWith("toggle:")) {
    const token = data.replace("toggle:", "");
    if (db.tokens[token]) {
      db.tokens[token].active = !db.tokens[token].active;
      saveData(db);
    }
    await sendTokenList(chatId);
    return;
  }
}

// پیام اعلامیه را برای همه‌ی کاربران ثبت‌شده ارسال کن
async function broadcastMessage(adminChatId, text) {
  const recipients = db.users;
  let sent = 0;
  let failed = 0;

  await sendTelegramMessage(adminChatId, `⏳ در حال ارسال برای ${recipients.length} کاربر...`);

  for (const userChatId of recipients) {
    try {
      const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: userChatId,
          text: `📢 اعلامیه:\n\n${text}`
        })
      });

      const result = await response.json();
      if (result.ok) {
        sent++;
      } else {
        failed++;
      }

      // برای رعایت محدودیت نرخ ارسال تلگرام، کمی بین پیام‌ها فاصله بگذار
      await new Promise(resolve => setTimeout(resolve, 40));

    } catch {
      failed++;
    }
  }

  await sendTelegramMessage(
    adminChatId,
    `✅ اعلامیه ارسال شد.\nموفق: ${sent}\nناموفق: ${failed}`,
    ADMIN_KEYBOARD
  );
}

async function sendTokenList(chatId) {
  const entries = Object.entries(db.tokens);

  if (entries.length === 0) {
    await sendTelegramMessage(chatId, "هنوز هیچ توکنی ساخته نشده.");
    return;
  }

  let text = "📋 لیست توکن‌ها:\n\n";
  const buttons = [];

  for (const [token, info] of entries) {
    const status = info.active ? "🟢 فعال" : "🔴 غیرفعال";
    const owner = info.usedBy ? `استفاده‌شده (${info.usedBy})` : "استفاده‌نشده";
    text += `\`${token}\` — ${status} — ${owner}\n`;

    buttons.push([
      {
        text: `${info.active ? "🔒 غیرفعال کردن" : "🔓 فعال کردن"} ${token}`,
        callback_data: `toggle:${token}`
      }
    ]);
  }

  await sendTelegramMessageWithMarkup(chatId, text, { inline_keyboard: buttons });
}

// ---------- ارسال پیام به تلگرام ----------
async function postTelegram(method, payload) {
  const response = await fetch(`${TELEGRAM_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return response.json();
}

// نشانگر «در حال تایپ...» تا وقتی پاسخ آماده شود (هر ۴ ثانیه تازه می‌شود)
function startTyping(chatId) {
  const ping = () =>
    postTelegram("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
  ping();
  return setInterval(ping, 4000);
}

// فقط آخرین پیام‌ها نگه داشته می‌شوند و همیشه با پیام کاربر شروع می‌شوند
function trimHistory(history) {
  const trimmed = history.slice(-MAX_HISTORY_MESSAGES);
  while (trimmed.length && trimmed[0].role !== "user") trimmed.shift();
  return trimmed;
}

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// مارکداونِ خروجی مدل (**bold**، کد، لیست، لینک...) را به HTMLِ مجاز تلگرام تبدیل می‌کند
function markdownToTelegramHtml(markdown) {
  const stash = [];
  const keep = html => `\u0000${stash.push(html) - 1}\u0000`;

  let text = markdown
    .replace(/```[\w+-]*\n?([\s\S]*?)```/g, (_, code) =>
      keep(`<pre>${escapeHtml(code.replace(/\n$/, ""))}</pre>`))
    .replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${escapeHtml(code)}</code>`));

  text = escapeHtml(text)
    .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
    .replace(/^\s*[-*•]\s+/gm, "• ")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/__(.+?)__/g, "<b>$1</b>")
    .replace(/(^|[\s(])\*([^\s*](?:[^*\n]*[^\s*])?)\*(?=$|[\s).,،؛:!?؟])/gm, "$1<i>$2</i>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) =>
      `<a href="${url.replace(/"/g, "&quot;")}">${label}</a>`);

  return text.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]);
}

// متن بلند را (ترجیحاً سر خط) به تکه‌های کوچک‌تر از سقف تلگرام تقسیم کن
function splitText(text, limit = 3500) {
  const chunks = [];
  let rest = text;

  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }

  chunks.push(rest);
  return chunks;
}

async function sendTelegramMessage(chatId, text, keyboard, format) {
  return sendTelegramMessageWithMarkup(chatId, text, keyboard, format);
}

// format: "AI" (خروجی مدل، تبدیل به HTML) | undefined (متن‌های ثابت ربات، Markdown)
async function sendTelegramMessageWithMarkup(chatId, text, markup, format) {
  const chunks = splitText(text);

  for (let i = 0; i < chunks.length; i++) {
    const isLastChunk = i === chunks.length - 1;
    const isAI = format === "AI";

    const body = {
      chat_id: chatId,
      text: isAI ? markdownToTelegramHtml(chunks[i]) : chunks[i],
      parse_mode: isAI ? "HTML" : "Markdown"
    };

    if (isLastChunk && markup) {
      body.reply_markup = markup;
    }

    try {
      let result = await postTelegram("sendMessage", body);

      // اگر تلگرام فرمت را نپذیرفت، همان متن را بدون فرمت بفرست تا پیام گم نشود
      if (!result.ok) {
        console.error("Telegram sendMessage FAILED:", JSON.stringify(result));
        delete body.parse_mode;
        body.text = chunks[i];
        result = await postTelegram("sendMessage", body);
        if (!result.ok) {
          console.error("Telegram plain retry FAILED:", JSON.stringify(result));
        }
      }
    } catch (error) {
      console.error("Telegram sendMessage request crashed:", error);
    }
  }
}

app.get("/health", (req, res) => {
  res.send("OK");
});

// لیست دستورات منوی عمومی تلگرام (عمداً /admin در این لیست نیست تا مخفی بماند)
async function setupBotCommands() {
  if (!TELEGRAM_API) return;

  const commands = [
    { command: "start", description: "شروع مجدد ربات" },
    { command: "new", description: "شروع چت جدید" },
    { command: "cancel", description: "لغو مکالمه" },
    { command: "token", description: "وارد کردن توکن دسترسی" },
    { command: "help", description: "راهنما" },
    { command: "about", description: "درباره ربات" }
  ];

  try {
    const response = await fetch(`${TELEGRAM_API}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands })
    });
    console.log("setMyCommands result:", JSON.stringify(await response.json()));

    const menuButtonResponse = await fetch(`${TELEGRAM_API}/setChatMenuButton`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ menu_button: { type: "commands" } })
    });
    console.log("setChatMenuButton result:", JSON.stringify(await menuButtonResponse.json()));

  } catch (error) {
    console.error("setup commands crashed:", error);
  }
}

// خطای JSON خراب را به‌جای کرش، با پیام مناسب برگردان
app.use((error, req, res, next) => {
  if (error?.type === "entity.parse.failed" || error?.type === "entity.too.large") {
    return res.status(400).json({ error: "درخواست نامعتبر است" });
  }
  next(error);
});

app.listen(PORT, () => {
  console.log(`[boot ${BOOT_ID}] Server running on port ${PORT}`);
  console.log(`[boot ${BOOT_ID}] ادمین‌های تنظیم‌شده: [${ADMIN_IDS.join(", ")}] | رمز ادمین: ${ADMIN_PASSWORD ? "ست شده" : "ست نشده"}`);
  if (!CODECRAFT_API_KEY) {
    console.warn("⚠️  CODECRAFT_API_KEY تنظیم نشده — پاسخ‌دهی هوش مصنوعی کار نمی‌کند.");
  }
  setupBotCommands();
});
