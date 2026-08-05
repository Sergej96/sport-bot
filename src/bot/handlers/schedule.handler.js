/**
 * /schedule command + the date → activity → event-list navigation, plus the
 * one-shot "🔔 Notify Me" subscription action. Moved from bot.js.
 */

import { Markup } from 'telegraf';
import * as scheduleService from '../../services/schedule.service.js';
import * as storage from '../../services/storage.service.js';
import { getNextWeekendDates, dayOfWeekFor, formatDateRu } from '../../utils/dates.js';
import * as logger from '../../utils/logger.js';

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
  const data = await scheduleService.fetchSchedule(dateStr, dayOfWeekFor(dateStr));
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
  bot.command('schedule', async ctx => {
    try {
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
      const data = await scheduleService.fetchSchedule(dateStr, dayOfWeekFor(dateStr));
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
      const data = await scheduleService.fetchSchedule(dateStr, dayOfWeekFor(dateStr));

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
