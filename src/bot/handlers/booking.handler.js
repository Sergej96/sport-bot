/**
 * "✅ Забронировать" (book now) and "🤖 Авто-бронь" (add to waitlist) actions,
 * wired into the event-list keyboard built by schedule.service for logged-in
 * users. See schedule.service.buildEventListMessage for the button wiring.
 */

import * as scheduleService from '../../services/schedule.service.js';
import * as bookingService from '../../services/booking.service.js';
import * as storage from '../../services/storage.service.js';
import * as auth from '../../services/auth.service.js';
import { dayOfWeekFor } from '../../utils/dates.js';
import * as logger from '../../utils/logger.js';

/** Finds the activity+event pair for an event_id on a given date, within one venue. */
async function findEvent(venueId, dateStr, eventId) {
  const data = await scheduleService.fetchSchedule(dateStr, dayOfWeekFor(dateStr), 'limited', venueId);
  for (const activity of data.activities ?? []) {
    for (const event of activity.events ?? []) {
      if (event.event_id === eventId) return { activity, event };
    }
  }
  return { activity: null, event: null };
}

export function registerBookingHandlers(bot) {
  // "✅ Забронировать" — book an open slot right now.
  bot.action(/^bk:(\d{4}-\d{2}-\d{2}):([0-9a-fA-F-]{36})$/, async ctx => {
    const [, dateStr, eventId] = ctx.match;
    const chatId = String(ctx.chat.id);

    const activeVenue = await storage.getUserVenue(chatId);
    if (!activeVenue) {
      await ctx.answerCbQuery('📍 Активная площадка не выбрана. Отправь /venue.', { show_alert: true });
      return;
    }

    try {
      const { activity, event } = await findEvent(activeVenue.id, dateStr, eventId);
      if (!event) {
        await ctx.answerCbQuery('Это занятие больше не найдено.', { show_alert: true });
        return;
      }

      await bookingService.bookEvent(chatId, eventId);
      logger.info('bot', `Booked event ${eventId} for ${chatId}`);
      await ctx.answerCbQuery('Забронировано! ✅', { show_alert: true });
      await ctx.replyWithHTML(
        `✅ <b>Забронировано!</b>\n${activity.activity_name} · ${event.start_time.slice(0, 5)}–${event.end_time.slice(0, 5)}\n📍 ${event.venue_name}`
      );
    } catch (err) {
      if (err instanceof auth.ReauthRequiredError) {
        await ctx.answerCbQuery('Сессия истекла. Отправь /login.', { show_alert: true });
        return;
      }

      const status = err.normalized?.status ?? err.response?.status;
      if (status === 409 || status === 400) {
        // Lost the race — slot filled between browsing and clicking. Fall
        // back to the waitlist automatically instead of just failing.
        try {
          const { activity, event } = await findEvent(activeVenue.id, dateStr, eventId);
          await bookingService.addToQueue(chatId, eventId, {
            activityName: activity?.activity_name,
            dateStr,
            startTime: event?.start_time,
            endTime: event?.end_time,
            venueName: event?.venue_name,
          });
          await ctx.answerCbQuery(
            'Места уже заняли — добавили тебя в лист ожидания, попробуем забронировать автоматически.',
            { show_alert: true }
          );
        } catch (queueErr) {
          logger.error('bot', 'Fallback to queue failed', { error: queueErr.message });
          await ctx.answerCbQuery('Мест не осталось, и добавить в очередь не удалось. Попробуй позже.', { show_alert: true });
        }
        return;
      }

      logger.error('bot', 'Book now error', { error: err.message });
      await ctx.answerCbQuery('Произошла ошибка. Попробуй снова позже.', { show_alert: true });
    }
  });

  // "🤖 Авто-бронь" — add a full event to the auto-booking waitlist.
  bot.action(/^q:(\d{4}-\d{2}-\d{2}):([0-9a-fA-F-]{36})$/, async ctx => {
    const [, dateStr, eventId] = ctx.match;
    const chatId = String(ctx.chat.id);

    const activeVenue = await storage.getUserVenue(chatId);
    if (!activeVenue) {
      await ctx.answerCbQuery('📍 Активная площадка не выбрана. Отправь /venue.', { show_alert: true });
      return;
    }

    try {
      const { activity, event } = await findEvent(activeVenue.id, dateStr, eventId);
      if (!event) {
        await ctx.answerCbQuery('Это занятие больше не найдено.', { show_alert: true });
        return;
      }

      const item = await bookingService.addToQueue(chatId, eventId, {
        activityName: activity.activity_name,
        dateStr,
        startTime: event.start_time,
        endTime: event.end_time,
        venueName: event.venue_name,
      });

      if (!item) {
        await ctx.answerCbQuery('Ты уже в листе ожидания на это занятие.');
        return;
      }

      logger.info('bot', `Queued event ${eventId} for auto-booking (${chatId})`);
      await ctx.answerCbQuery();
      await ctx.replyWithHTML(
        `🤖 Добавлено в лист авто-бронирования: <b>${activity.activity_name}</b> ` +
        `(${event.start_time.slice(0, 5)}–${event.end_time.slice(0, 5)}).\n` +
        `Мы будем автоматически пытаться забронировать место каждую минуту и сообщим, когда получится.`
      );
    } catch (err) {
      logger.error('bot', 'Auto-book queue error', { error: err.message });
      await ctx.answerCbQuery('Произошла ошибка. Попробуй снова позже.', { show_alert: true });
    }
  });
}
