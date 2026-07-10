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

// No booking API is available, so "Book"/"Quick Book" buttons just deep-link
// to the venue's site (спортдлявсех.бел) instead of reserving a slot directly.
const BOOKING_URL = 'https://xn--b1adewnfifgg2b6h.xn--90ais';

const POLL_INTERVAL_MS = 60_000;   // 1 minute
const MAX_NOTIFICATIONS = 2;       // per Saturday date
const MAX_CONSECUTIVE_FAILURES = 5;

const MONTHS_RU = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];
const WEEKDAYS_EN = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

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
 *   notification_subscriptions: Array<{
 *     user_id:       string,    — Telegram chat ID
 *     event_id:      string,    — event UUID from the schedule API
 *     date:          string,    — YYYY-MM-DD the event falls on
 *     activity_name: string,
 *     start_time:    string,    — HH:MM:SS
 *     end_time:      string,    — HH:MM:SS
 *     venue_name:    string,
 *     created_at:    string,    — ISO timestamp
 *   }>
 */
async function readDb() {
  try {
    const raw = await readFile(DB_PATH, 'utf-8');
    const db = JSON.parse(raw);
    if (!db.notification_subscriptions) db.notification_subscriptions = [];
    return db;
  } catch {
    return { chat_ids: [], schedule_state: {}, notification_subscriptions: [] };
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
function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getNextSaturday() {
  const now = new Date();
  const daysUntilSat = now.getDay() === 6 ? 0 : 6 - now.getDay();
  const sat = new Date(now);
  sat.setDate(now.getDate() + daysUntilSat);
  return toDateStr(sat);
}

/**
 * Returns the nearest upcoming Saturday and Sunday (today counts if it IS
 * that day) as { dateStr, label } pairs — the only two days users may pick.
 */
function getNextWeekendDates() {
  const now = new Date();
  const day = now.getDay(); // 0 = Sunday … 6 = Saturday
  const daysUntilSat = (6 - day + 7) % 7;
  const daysUntilSun = (7 - day) % 7;

  const sat = new Date(now);
  sat.setDate(now.getDate() + daysUntilSat);
  const sun = new Date(now);
  sun.setDate(now.getDate() + daysUntilSun);

  return {
    saturday: { dateStr: toDateStr(sat), label: `Суббота, ${sat.getDate()} ${MONTHS_RU[sat.getMonth()]}` },
    sunday: { dateStr: toDateStr(sun), label: `Воскресенье, ${sun.getDate()} ${MONTHS_RU[sun.getMonth()]}` },
  };
}

/** Converts "2026-06-27" → "27 июня 2026" */
function formatDateRu(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${d} ${MONTHS_RU[m - 1]} ${y}`;
}

/** Computes the English lowercase weekday name the API expects for a given YYYY-MM-DD. */
function dayOfWeekFor(dateStr) {
  const date = new Date(`${dateStr}T00:00:00`);
  return WEEKDAYS_EN[date.getDay()];
}

/** True once an event's date+start_time is in the past. */
function hasEventStarted(dateStr, startTime) {
  return Date.now() >= new Date(`${dateStr}T${startTime}`).getTime();
}

// ─── API ─────────────────────────────────────────────────────────────────────

async function fetchSchedule(dateParam, dayOfWeek = 'saturday', entryType = 'limited') {
  const response = await axios.get(API_URL, {
    params: {
      date_param: dateParam,
      day_of_week: dayOfWeek,
      entry_type: entryType,
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

/**
 * Builds the time-slot message + inline keyboard for a single activity on a
 * single date. Full, non-unlimited events get a "🔔 Notify Me" callback
 * button; open events get a "✅ Book" button that deep-links to the venue's
 * site. Ends with a "◀️ Назад" button back to the activity list.
 */
function buildEventListMessage(dateStr, activity) {
  const dateRu = formatDateRu(dateStr);
  const lines = [`📅 <b>${dateRu}</b>`, `<b>${activity.activity_name}</b>`, ''];
  const keyboardRows = [];

  for (const event of activity.events) {
    const timeLabel = `${event.start_time.slice(0, 5)}–${event.end_time.slice(0, 5)}`;
    const statusIcon = event.is_full ? '🔴' : '🟢';
    const slotsLabel = event.is_unlimited
      ? 'без ограничений'
      : event.is_full
      ? 'мест нет'
      : `мест: ${event.max_participants - event.occupied_slots}`;

    lines.push(`  ${statusIcon} ${timeLabel} · ${event.venue_name} · ${slotsLabel}`);

    if (event.is_full && !event.is_unlimited) {
      keyboardRows.push([
        Markup.button.callback(`🔔 Уведомить ${timeLabel}`, `n:${dateStr}:${event.event_id}`),
      ]);
    } else if (!event.is_unlimited) {
      keyboardRows.push([
        Markup.button.url(`✅ Записаться ${timeLabel}`, BOOKING_URL),
      ]);
    }
  }

  keyboardRows.push([Markup.button.callback('◀️ Назад', `b:acts:${dateStr}`)]);

  return { text: lines.join('\n'), keyboard: Markup.inlineKeyboard(keyboardRows) };
}

/** Builds the "slot just opened" alert message for a one-shot subscription. */
function buildSlotOpenedMessage(sub, event) {
  return (
    `🔥 <b>Освободилось место!</b>\n` +
    `🏋️ Тренировка: <b>${sub.activity_name}</b>\n` +
    `⏰ Время: ${event.start_time.slice(0, 5)}–${event.end_time.slice(0, 5)}\n` +
    `📍 Место: ${sub.venue_name}\n\n` +
    `Успей записаться, пока не заняли!`
  );
}

// ─── Broadcast ───────────────────────────────────────────────────────────────

/**
 * Sends a message to all given chat IDs concurrently.
 * Uses Promise.allSettled so one failed delivery doesn't block the rest.
 */
async function broadcast(bot, message, chatIds, extra = {}) {
  if (chatIds.length === 0) {
    console.log('[broadcast] No subscribers, nothing to send.');
    return;
  }

  const results = await Promise.allSettled(
    chatIds.map(id =>
      bot.telegram.sendMessage(id, message, { parse_mode: 'HTML', ...extra })
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

// ─── Subscription poll tick ──────────────────────────────────────────────────

/**
 * For every active one-shot "Notify Me" subscription: purges it if its event
 * has already started, otherwise checks whether a slot has opened up and, if
 * so, broadcasts to all subscribers of that event_id and clears them.
 */
async function pollSubscriptions(bot) {
  const db = await readDb();
  if (db.notification_subscriptions.length === 0) return;

  const beforeCount = db.notification_subscriptions.length;
  db.notification_subscriptions = db.notification_subscriptions.filter(
    s => !hasEventStarted(s.date, s.start_time)
  );
  const staleRemoved = beforeCount - db.notification_subscriptions.length;
  if (staleRemoved > 0) {
    console.log(`[subscriptions] Purged ${staleRemoved} expired subscription(s).`);
  }
  let changed = staleRemoved > 0;

  if (db.notification_subscriptions.length === 0) {
    if (changed) await writeDb(db);
    return;
  }

  const dates = [...new Set(db.notification_subscriptions.map(s => s.date))];
  const fetched = await Promise.allSettled(
    dates.map(async date => ({ date, data: await fetchSchedule(date, dayOfWeekFor(date)) }))
  );

  for (const result of fetched) {
    if (result.status !== 'fulfilled') {
      console.error('[subscriptions] Schedule fetch failed:', result.reason?.message);
      continue;
    }

    const { date, data } = result.value;
    const eventsById = new Map();
    for (const activity of data.activities ?? []) {
      for (const event of activity.events ?? []) {
        eventsById.set(event.event_id, event);
      }
    }

    const eventIdsForDate = [
      ...new Set(
        db.notification_subscriptions.filter(s => s.date === date).map(s => s.event_id)
      ),
    ];

    for (const eventId of eventIdsForDate) {
      const event = eventsById.get(eventId);
      if (!event || event.is_full || event.is_unlimited) continue;

      const subs = db.notification_subscriptions.filter(s => s.event_id === eventId);
      const message = buildSlotOpenedMessage(subs[0], event);
      console.log(`[subscriptions] Slot opened for event ${eventId}, notifying ${subs.length} subscriber(s).`);

      await broadcast(bot, message, subs.map(s => s.user_id), {
        reply_markup: Markup.inlineKeyboard([
          Markup.button.url('⚡ Забронировать', BOOKING_URL),
        ]).reply_markup,
      });

      db.notification_subscriptions = db.notification_subscriptions.filter(s => s.event_id !== eventId);
      changed = true;
    }
  }

  if (changed) await writeDb(db);
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
      `Отправь /schedule, чтобы посмотреть расписание на любой день и подписаться на уведомления о свободных местах.\n\n` +
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

/** Step 1: sends/edits the Saturday-or-Sunday date picker. */
async function sendDatePicker(ctx, edit = false) {
  const { saturday, sunday } = getNextWeekendDates();
  const text = '📅 Выбери день:';
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(saturday.label, `d:${saturday.dateStr}`)],
    [Markup.button.callback(sunday.label, `d:${sunday.dateStr}`)],
  ]);

  if (edit) await ctx.editMessageText(text, keyboard);
  else await ctx.reply(text, keyboard);
}

/** Step 2: sends/edits the list of activities available on a given date. */
async function sendActivityPicker(ctx, dateStr, edit = false) {
  const data = await fetchSchedule(dateStr, dayOfWeekFor(dateStr));
  const activities = (data.activities ?? []).filter(a => a.events?.length);

  if (activities.length === 0) {
    const text = `На ${formatDateRu(dateStr)} тренировок не найдено.`;
    if (edit) await ctx.editMessageText(text);
    else await ctx.reply(text);
    return;
  }

  const rows = activities.map(a => [
    Markup.button.callback(`${a.activity_name} (${a.events.length})`, `a:${dateStr}:${a.activity_id}`),
  ]);
  rows.push([Markup.button.callback('◀️ Назад', 'b:dates')]);

  const text = `📅 <b>${formatDateRu(dateStr)}</b>\nВыбери тренировку:`;
  const extra = { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) };

  if (edit) await ctx.editMessageText(text, extra);
  else await ctx.reply(text, extra);
}

bot.command('schedule', async ctx => {
  try {
    await sendDatePicker(ctx, false);
  } catch (err) {
    console.error('[bot] /schedule error:', err.message);
    await ctx.reply('Произошла ошибка. Попробуй снова позже.');
  }
});

bot.action(/^d:(\d{4}-\d{2}-\d{2})$/, async ctx => {
  const dateStr = ctx.match[1];

  try {
    await ctx.answerCbQuery();
    await sendActivityPicker(ctx, dateStr, true);
  } catch (err) {
    console.error('[bot] date select error:', err.message);
    await ctx.reply('Не удалось загрузить расписание. Попробуй снова позже.');
  }
});

bot.action(/^a:(\d{4}-\d{2}-\d{2}):([0-9a-fA-F-]{36})$/, async ctx => {
  const [, dateStr, activityId] = ctx.match;

  try {
    await ctx.answerCbQuery();
    const data = await fetchSchedule(dateStr, dayOfWeekFor(dateStr));
    const activity = (data.activities ?? []).find(a => a.activity_id === activityId);

    if (!activity || !activity.events?.length) {
      await ctx.editMessageText('Это занятие больше не найдено.');
      return;
    }

    const { text, keyboard } = buildEventListMessage(dateStr, activity);
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
  } catch (err) {
    console.error('[bot] activity select error:', err.message);
    await ctx.reply('Не удалось загрузить расписание. Попробуй снова позже.');
  }
});

bot.action('b:dates', async ctx => {
  try {
    await ctx.answerCbQuery();
    await sendDatePicker(ctx, true);
  } catch (err) {
    console.error('[bot] back-to-dates error:', err.message);
  }
});

bot.action(/^b:acts:(\d{4}-\d{2}-\d{2})$/, async ctx => {
  const dateStr = ctx.match[1];

  try {
    await ctx.answerCbQuery();
    await sendActivityPicker(ctx, dateStr, true);
  } catch (err) {
    console.error('[bot] back-to-activities error:', err.message);
  }
});

bot.action(/^n:(\d{4}-\d{2}-\d{2}):([0-9a-fA-F-]{36})$/, async ctx => {
  const [, dateStr, eventId] = ctx.match;
  const chatId = String(ctx.chat.id);

  try {
    const data = await fetchSchedule(dateStr, dayOfWeekFor(dateStr));

    let matchedEvent, matchedActivity;
    outer: for (const activity of data.activities ?? []) {
      for (const event of activity.events ?? []) {
        if (event.event_id === eventId) {
          matchedEvent = event;
          matchedActivity = activity;
          break outer;
        }
      }
    }

    if (!matchedEvent) {
      await ctx.answerCbQuery('Это занятие больше не найдено.', { show_alert: true });
      return;
    }

    if (!matchedEvent.is_full) {
      await ctx.answerCbQuery('Места уже есть — успей забронировать!', { show_alert: true });
      return;
    }

    const db = await readDb();
    const alreadySubscribed = db.notification_subscriptions.some(
      s => s.user_id === chatId && s.event_id === eventId
    );

    if (alreadySubscribed) {
      await ctx.answerCbQuery('Ты уже подписан(а) на это уведомление.');
      return;
    }

    db.notification_subscriptions.push({
      user_id: chatId,
      event_id: eventId,
      date: dateStr,
      activity_name: matchedActivity.activity_name,
      start_time: matchedEvent.start_time,
      end_time: matchedEvent.end_time,
      venue_name: matchedEvent.venue_name,
      created_at: new Date().toISOString(),
    });
    await writeDb(db);
    console.log(`[bot] Subscribed ${chatId} to event ${eventId} (${dateStr}).`);

    await ctx.answerCbQuery();
    await ctx.replyWithHTML(
      `✅ Уведомление установлено! Как только освободится место на <b>${matchedActivity.activity_name}</b> ` +
      `(${matchedEvent.start_time.slice(0, 5)}), мы сразу сообщим тебе.\n` +
      `Уведомление сработает только один раз.`
    );
  } catch (err) {
    console.error('[bot] notify subscribe error:', err.message);
    await ctx.answerCbQuery('Произошла ошибка. Попробуй снова позже.', { show_alert: true });
  }
});

// ─── Launch ───────────────────────────────────────────────────────────────────

bot.launch();
console.log('[bot] Bot started. Polling every', POLL_INTERVAL_MS / 1000, 'seconds.');

// Run the first check shortly after startup, then on the fixed interval.
setTimeout(async () => {
  await pollSchedule(bot);
  await pollSubscriptions(bot);
  setInterval(() => pollSchedule(bot), POLL_INTERVAL_MS);
  setInterval(() => pollSubscriptions(bot), POLL_INTERVAL_MS);
}, 3_000);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
