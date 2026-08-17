/**
 * /schedule (aliased as /book) + the date → activity → event-list
 * navigation, plus the one-shot "🔔 Notify Me" subscription action. Moved
 * from bot.js.
 *
 * Gated behind a venue: /schedule|/book first calls
 * venue.handler.ensureActiveVenue, which either returns the user's already-
 * saved venue_id or kicks off the SELECT_VENUE step and stops the update
 * here (see venue.handler.js for how the flow resumes into sendDatePicker
 * once a venue is picked). Every fetchSchedule call below then reads the
 * active venue fresh from storage rather than threading it through
 * callback_data — see venue.handler.js's header comment for why.
 */

import { Markup } from 'telegraf';
import * as scheduleService from '../../services/schedule.service.js';
import * as storage from '../../services/storage.service.js';
import { ensureActiveVenue } from './venue.handler.js';
import { dayOfWeekFor, formatDateRu } from '../../utils/dates.js';
import * as logger from '../../utils/logger.js';

/** Step 0 (gated by /schedule|/book): sends/edits the Saturday-or-Sunday date picker. */
async function sendDatePicker(ctx, edit = false) {
  const { text, keyboard } = scheduleService.buildDatePickerMessage();
  if (edit) await ctx.editMessageText(text, keyboard);
  else await ctx.reply(text, keyboard);
}

/**
 * Step 1: sends/edits the list of activities available on a given date, for
 * the caller's active venue (see storage.getUserVenue). The venue gate in
 * the /schedule|/book command means this should always be set by the time
 * we get here — the check is just a defensive fallback, not the primary UX.
 */
async function sendActivityPicker(ctx, dateStr, edit = false) {
  const activeVenue = await storage.getUserVenue(ctx.chat.id);
  if (!activeVenue) {
    const text = '📍 Активная площадка не выбрана. Отправь /venue, чтобы выбрать.';
    if (edit) await ctx.editMessageText(text);
    else await ctx.reply(text);
    return;
  }

  const data = await scheduleService.fetchSchedule(dateStr, dayOfWeekFor(dateStr), 'limited', activeVenue.id);
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

export function registerScheduleHandlers(bot) {
  // /book is an alias — same flow, named to match the spec's "initiation" trigger.
  bot.command(['schedule', 'book'], async ctx => {
    try {
      // Step 0 (SELECT_VENUE gate): no active venue yet → shows the picker
      // and bails; the flow resumes into sendDatePicker via venue.handler's
      // sv: action once one is chosen.
      const venueId = await ensureActiveVenue(ctx, { resume: 'schedule' });
      if (!venueId) return;

      await sendDatePicker(ctx, false);
    } catch (err) {
      logger.error('bot', '/schedule error', { error: err.message });
      await ctx.reply('Произошла ошибка. Попробуй снова позже.');
    }
  });

  bot.action(/^d:(\d{4}-\d{2}-\d{2})$/, async ctx => {
    const dateStr = ctx.match[1];

    try {
      await ctx.answerCbQuery();
      await sendActivityPicker(ctx, dateStr, true);
    } catch (err) {
      logger.error('bot', 'date select error', { error: err.message });
      await ctx.reply('Не удалось загрузить расписание. Попробуй снова позже.');
    }
  });

  bot.action(/^a:(\d{4}-\d{2}-\d{2}):([0-9a-fA-F-]{36})$/, async ctx => {
    const [, dateStr, activityId] = ctx.match;

    try {
      await ctx.answerCbQuery();
      const activeVenue = await storage.getUserVenue(ctx.chat.id);
      if (!activeVenue) {
        await ctx.editMessageText('📍 Активная площадка не выбрана. Отправь /venue, чтобы выбрать.');
        return;
      }

      const data = await scheduleService.fetchSchedule(dateStr, dayOfWeekFor(dateStr), 'limited', activeVenue.id);
      const activity = (data.activities ?? []).find(a => a.activity_id === activityId);

      if (!activity || !activity.events?.length) {
        await ctx.editMessageText('Это занятие больше не найдено.');
        return;
      }

      const user = await storage.getUser(ctx.chat.id);
      const isLoggedIn = Boolean(user?.access_token);
      const { text, keyboard } = scheduleService.buildEventListMessage(dateStr, activity, isLoggedIn);
      await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
    } catch (err) {
      logger.error('bot', 'activity select error', { error: err.message });
      await ctx.reply('Не удалось загрузить расписание. Попробуй снова позже.');
    }
  });

  bot.action('b:dates', async ctx => {
    try {
      await ctx.answerCbQuery();
      await sendDatePicker(ctx, true);
    } catch (err) {
      logger.error('bot', 'back-to-dates error', { error: err.message });
    }
  });

  bot.action(/^b:acts:(\d{4}-\d{2}-\d{2})$/, async ctx => {
    const dateStr = ctx.match[1];

    try {
      await ctx.answerCbQuery();
      await sendActivityPicker(ctx, dateStr, true);
    } catch (err) {
      logger.error('bot', 'back-to-activities error', { error: err.message });
    }
  });

  bot.action(/^n:(\d{4}-\d{2}-\d{2}):([0-9a-fA-F-]{36})$/, async ctx => {
    const [, dateStr, eventId] = ctx.match;
    const chatId = String(ctx.chat.id);

    try {
      const activeVenue = await storage.getUserVenue(ctx.chat.id);
      if (!activeVenue) {
        await ctx.answerCbQuery('📍 Активная площадка не выбрана. Отправь /venue.', { show_alert: true });
        return;
      }

      const data = await scheduleService.fetchSchedule(dateStr, dayOfWeekFor(dateStr), 'limited', activeVenue.id);

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

      const db = await storage.readDb();
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
      await storage.writeDb(db);
      logger.info('bot', `Subscribed ${chatId} to event ${eventId} (${dateStr}).`);

      await ctx.answerCbQuery();
      await ctx.replyWithHTML(
        `✅ Уведомление установлено! Как только освободится место на <b>${matchedActivity.activity_name}</b> ` +
        `(${matchedEvent.start_time.slice(0, 5)}), мы сразу сообщим тебе.\n` +
        `Уведомление сработает только один раз.`
      );
    } catch (err) {
      logger.error('bot', 'notify subscribe error', { error: err.message });
      await ctx.answerCbQuery('Произошла ошибка. Попробуй снова позже.', { show_alert: true });
    }
  });
}
