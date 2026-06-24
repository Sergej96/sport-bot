/**
 * sport-bot — Telegram notifier for free Saturday workouts
 * at Парк 50-летия В.Октября (Minsk).
 *
 * Polls the schedule API every minute and broadcasts to all
 * subscribers when a new schedule appears or its event count changes.
 */

import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import 'dotenv/config';

// ─── Config ──────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

if (!BOT_TOKEN) throw new Error('BOT_TOKEN environment variable is required');
if (!ADMIN_CHAT_ID) throw new Error('ADMIN_CHAT_ID environment variable is required');

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, 'db.json');

const API_URL = 'https://xn--b1adewnfifgg2b6h.xn--90ais/api/v1/schedule';
const VENUE_ID = '55d51f65-d18c-4a49-bf3d-d5ed17b72c3a';

const POLL_INTERVAL_MS = 60_000;   // 1 minute
const MAX_NOTIFICATIONS = 2;       // per Saturday date
const MAX_CONSECUTIVE_FAILURES = 5;

// ─── State ───────────────────────────────────────────────────────────────────

let consecutiveFailures = 0;

// ─── Database helpers ────────────────────────────────────────────────────────

/**
 * Reads the JSON database from disk.
 * Returns a safe default if the file is missing or malformed.
 *
 * Schema:
 *   chat_ids:       string[]   — subscribed Telegram chat IDs
 *   schedule_state: Record<dateStr, {
 *     notifications_sent: number,   — how many notifications fired for this date
 *     last_total_events:  number    — last known total_events value from the API
 *   }>
 */
async function readDb() {
  try {
    const raw = await readFile(DB_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { chat_ids: [], schedule_state: {} };
  }
}

async function writeDb(data) {
  await writeFile(DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

/**
 * Returns YYYY-MM-DD for the upcoming Saturday (or today if today IS Saturday).
 * Uses local wall-clock time so the date matches the user's timezone expectations.
 */
function getNextSaturday() {
  const now = new Date();
  const daysUntilSat = now.getDay() === 6 ? 0 : 6 - now.getDay();
  const sat = new Date(now);
  sat.setDate(now.getDate() + daysUntilSat);
  const y = sat.getFullYear();
  const m = String(sat.getMonth() + 1).padStart(2, '0');
  const d = String(sat.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Converts "2026-06-27" → "27 июня 2026" */
function formatDateRu(dateStr) {
  const MONTHS = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
  ];
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// ─── API ─────────────────────────────────────────────────────────────────────

async function fetchSchedule(dateParam) {
  const response = await axios.get(API_URL, {
    params: {
      date_param: dateParam,
      day_of_week: 'saturday',
      entry_type: 'free',
      venue_ids: VENUE_ID,
    },
    timeout: 10_000,
  });
  return response.data;
}

// ─── Message builder ─────────────────────────────────────────────────────────

/**
 * Builds the HTML notification message.
 * Shows 🟢 for open slots and 🔴 for full/waitlist sessions.
 */
function buildNotificationMessage(dateStr, activities, totalEvents, isUpdate) {
  const dateRu = formatDateRu(dateStr);
  const header = isUpdate
    ? `🔄 Расписание тренировок на <b>${dateRu}</b> обновилось!`
    : `🔔 Появилось новое расписание тренировок на <b>${dateRu}</b>!`;

  const lines = [header, ''];

  for (const activity of activities) {
    if (!activity.events?.length) continue;

    lines.push(`<b>${activity.activity_name}:</b>`);

    for (const event of activity.events) {
      const freeSlots = event.is_unlimited
        ? '∞'
        : event.max_participants - event.occupied_slots;
      const statusIcon = event.is_full ? '🔴' : '🟢';
      const slotsLabel = event.is_full
        ? ' (лист ожидания)'
        : event.is_unlimited
        ? ''
        : ` (мест: ${freeSlots})`;

      lines.push(`  ${statusIcon} ${event.start_time} – ${event.end_time}${slotsLabel}`);
    }

    lines.push('');
  }

  lines.push(`<i>Всего мероприятий: ${totalEvents}</i>`);
  return lines.join('\n');
}

// ─── Broadcast ───────────────────────────────────────────────────────────────

/**
 * Sends a message to all subscribed chat IDs.
 * Uses Promise.allSettled so one failed delivery doesn't block the rest.
 */
async function broadcast(bot, message, chatIds) {
  if (chatIds.length === 0) {
    console.log('[broadcast] No subscribers, nothing to send.');
    return;
  }

  const results = await Promise.allSettled(
    chatIds.map(id =>
      bot.telegram.sendMessage(id, message, { parse_mode: 'HTML' })
    )
  );

  const failed = results.filter(r => r.status === 'rejected');
  console.log(`[broadcast] Sent to ${chatIds.length - failed.length}/${chatIds.length} subscribers.`);
  if (failed.length > 0) {
    failed.forEach(r => console.error('[broadcast] Delivery error:', r.reason?.message));
  }
}

// ─── Poll tick ───────────────────────────────────────────────────────────────

async function pollSchedule(bot) {
  const dateParam = getNextSaturday();
  let data;

  try {
    data = await fetchSchedule(dateParam);
    consecutiveFailures = 0;
  } catch (err) {
    consecutiveFailures++;
    const statusCode = err.response?.status ?? 'N/A';
    console.error(`[poll] API error #${consecutiveFailures} (HTTP ${statusCode}): ${err.message}`);

    if (consecutiveFailures === MAX_CONSECUTIVE_FAILURES) {
      try {
        await bot.telegram.sendMessage(
          ADMIN_CHAT_ID,
          `⚠️ <b>Алерт!</b> API недоступен уже <b>${MAX_CONSECUTIVE_FAILURES}</b> раз подряд.\n\n` +
          `Последняя ошибка (HTTP ${statusCode}):\n<code>${err.message}</code>`,
          { parse_mode: 'HTML' }
        );
        console.log('[poll] Admin alerted.');
      } catch (alertErr) {
        console.error('[poll] Failed to alert admin:', alertErr.message);
      }
    }
    return;
  }

  const { total_events, activities } = data;
  console.log(`[poll] date=${dateParam} total_events=${total_events}`);

  if (total_events === 0) {
    console.log('[poll] Schedule not published yet, skipping.');
    return;
  }

  const db = await readDb();

  // Purge state for any date that is no longer the target Saturday — this
  // naturally resets the notification cap when the week rolls over.
  for (const storedDate of Object.keys(db.schedule_state)) {
    if (storedDate !== dateParam) {
      delete db.schedule_state[storedDate];
    }
  }

  if (!db.schedule_state[dateParam]) {
    db.schedule_state[dateParam] = { notifications_sent: 0, last_total_events: 0 };
  }

  const state = db.schedule_state[dateParam];
  const isNew = state.notifications_sent === 0;
  const isUpdated = !isNew && total_events !== state.last_total_events;
  const underCap = state.notifications_sent < MAX_NOTIFICATIONS;

  if ((isNew || isUpdated) && underCap) {
    const message = buildNotificationMessage(dateParam, activities, total_events, !isNew);
    console.log(`[poll] Firing notification #${state.notifications_sent + 1} for ${dateParam}…`);
    await broadcast(bot, message, db.chat_ids);
    state.notifications_sent++;
    state.last_total_events = total_events;
    await writeDb(db);
  } else if (!underCap) {
    // Cap reached — just keep the last_total_events in sync so we don't
    // retroactively fire when the cap resets next week.
    if (total_events !== state.last_total_events) {
      state.last_total_events = total_events;
      await writeDb(db);
    }
    console.log(`[poll] Notification cap (${MAX_NOTIFICATIONS}) reached for ${dateParam}, skipping.`);
  } else {
    console.log(`[poll] No change detected for ${dateParam}, skipping.`);
  }
}

// ─── Bot commands ─────────────────────────────────────────────────────────────

async function handleUnsubscribe(ctx) {
  const chatId = String(ctx.chat.id);
  const db = await readDb();
  const index = db.chat_ids.indexOf(chatId);

  if (index !== -1) {
    db.chat_ids.splice(index, 1);
    await writeDb(db);
    console.log(`[bot] Unsubscribed: ${chatId}`);
    await ctx.reply(
      'Ты отписан(а) — уведомления больше не будут приходить.\n' +
      'Чтобы подписаться снова, отправь /start.'
    );
  } else {
    await ctx.reply(
      'Ты не подписан(а).\nОтправь /start, чтобы подписаться.'
    );
  }
}

const bot = new Telegraf(BOT_TOKEN);

bot.start(async ctx => {
  const chatId = String(ctx.chat.id);

  try {
    const db = await readDb();

    if (!db.chat_ids.includes(chatId)) {
      db.chat_ids.push(chatId);
      await writeDb(db);
      console.log(`[bot] New subscriber: ${chatId}`);
    }

    await ctx.replyWithHTML(
      `👋 <b>Привет!</b>\n\n` +
      `Я слежу за расписанием бесплатных тренировок в <b>Парке 50-летия В.Октября</b> (Минск).\n\n` +
      `Как только на ближайшую субботу появится расписание — ты получишь уведомление.\n` +
      `Если расписание изменится, я пришлю обновление ещё раз.\n\n` +
      `Ты подписан(а)! ✅`,
      Markup.inlineKeyboard([
        Markup.button.callback('❌ Отписаться', 'unsubscribe'),
      ])
    );
  } catch (err) {
    console.error('[bot] /start error:', err.message);
    await ctx.reply('Произошла ошибка. Попробуй снова позже.');
  }
});

bot.command('stop', async ctx => {
  try {
    await handleUnsubscribe(ctx);
  } catch (err) {
    console.error('[bot] /stop error:', err.message);
    await ctx.reply('Произошла ошибка. Попробуй снова позже.');
  }
});

bot.action('unsubscribe', async ctx => {
  try {
    await ctx.answerCbQuery();
    await handleUnsubscribe(ctx);
  } catch (err) {
    console.error('[bot] unsubscribe action error:', err.message);
  }
});

// ─── Launch ───────────────────────────────────────────────────────────────────

bot.launch();
console.log('[bot] Bot started. Polling every', POLL_INTERVAL_MS / 1000, 'seconds.');

// Run the first check shortly after startup, then on the fixed interval.
setTimeout(async () => {
  await pollSchedule(bot);
  setInterval(() => pollSchedule(bot), POLL_INTERVAL_MS);
}, 3_000);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
