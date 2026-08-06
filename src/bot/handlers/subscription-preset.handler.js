/**
 * "⚙️ Мои подписки" — weekend auto-booking presets. Lets a user pre-select a
 * day + activity + time slot; the watcher (see watcher.service.js
 * pollAutoSubscriptionPresets) then books it automatically the moment a
 * matching event shows up in a freshly-polled weekend schedule, falling back
 * to the waitlist queue if it's already full — see booking.service.js
 * processAutoSubscriptionMatch.
 *
 * The wizard (day → activity → time) is entirely encoded in callback_data,
 * no session state needed — same style as schedule.handler's
 * date → activity → event browser.
 */

import { Markup } from 'telegraf';
import * as storage from '../../services/storage.service.js';
import { ACTIVITIES, TIME_SLOTS, WEEKEND_DAYS_RU } from '../../config.js';
import { fitLabel } from '../../utils/text.js';
import * as logger from '../../utils/logger.js';

const DAY_NAME_BY_CODE = { Sat: 'Saturday', Sun: 'Sunday' };
const DAY_ORDER = ['Saturday', 'Sunday'];

function dayLabel(dayName) {
  return WEEKEND_DAYS_RU[dayName] ?? dayName;
}

/** Step 1: day picker. */
async function sendDayPicker(ctx, edit = false) {
  const text = '📅 На какой день недели настроить авто-подписку?';
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📅 Суббота', 'subday:Sat')],
    [Markup.button.callback('📅 Воскресенье', 'subday:Sun')],
  ]);

  if (edit) await ctx.editMessageText(text, keyboard);
  else await ctx.reply(text, keyboard);
}

/** Step 2: activity picker for the chosen day. */
async function sendActivityPicker(ctx, dayCode, edit = false) {
  const dayName = DAY_NAME_BY_CODE[dayCode];
  const rows = ACTIVITIES.map((name, idx) => [Markup.button.callback(name, `subact:${dayCode}:${idx}`)]);
  rows.push([Markup.button.callback('◀️ Назад', 'subback:day')]);

  const text = `📅 <b>${dayLabel(dayName)}</b>\nВыбери тренировку:`;
  const extra = { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) };

  if (edit) await ctx.editMessageText(text, extra);
  else await ctx.reply(text, extra);
}

/** Step 3: time-slot picker for the chosen day + activity. */
async function sendTimePicker(ctx, dayCode, activityIdx, edit = false) {
  const dayName = DAY_NAME_BY_CODE[dayCode];
  const activityName = ACTIVITIES[activityIdx];

  const buttons = TIME_SLOTS.map((time, idx) => Markup.button.callback(time, `subtime:${dayCode}:${activityIdx}:${idx}`));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([Markup.button.callback('◀️ Назад', `subback:act:${dayCode}`)]);

  const text = `📅 <b>${dayLabel(dayName)}</b> · <b>${activityName}</b>\nВыбери время:`;
  const extra = { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) };

  if (edit) await ctx.editMessageText(text, extra);
  else await ctx.reply(text, extra);
}

/** Renders the "⚙️ Мои подписки" list, grouped by day and sorted by time within each day. */
async function renderMySubscriptions(ctx, edit = false) {
  const chatId = String(ctx.chat.id);
  const presets = await storage.getAutoSubscriptionsForUser(chatId);

  const lines = ['⚙️ <b>Мои подписки на авто-бронирование</b>', ''];
  const keyboardRows = [];

  if (presets.length === 0) {
    lines.push('Пока нет активных подписок.');
  } else {
    for (const dayName of DAY_ORDER) {
      const dayPresets = presets
        .filter(p => p.dayOfWeek === dayName)
        .sort((a, b) => a.startTime.localeCompare(b.startTime));

      if (dayPresets.length === 0) continue;

      lines.push(`<b>${dayLabel(dayName)}:</b>`);
      for (const preset of dayPresets) {
        const timeLabel = preset.startTime.slice(0, 5);
        lines.push(`🔁 ${timeLabel} — ${preset.activityName}`);
        const text = fitLabel({ before: `❌ ${dayLabel(dayName)} ${timeLabel} · `, name: preset.activityName });
        keyboardRows.push([Markup.button.callback(text, `subdel:${preset.id}`)]);
      }
      lines.push('');
    }
  }

  keyboardRows.push([Markup.button.callback('➕ Добавить подписку', 'subnew')]);

  const text = lines.join('\n');
  const extra = { parse_mode: 'HTML', ...Markup.inlineKeyboard(keyboardRows) };

  if (edit) await ctx.editMessageText(text, extra);
  else await ctx.reply(text, extra);
}

export function registerSubscriptionPresetHandlers(bot) {
  bot.command('my_subscriptions', async ctx => {
    try {
      await renderMySubscriptions(ctx, false);
    } catch (err) {
      logger.error('bot', '/my_subscriptions error', { error: err.message });
      await ctx.reply('Произошла ошибка. Попробуй снова позже.');
    }
  });

  bot.action('subnew', async ctx => {
    try {
      await ctx.answerCbQuery();
      await sendDayPicker(ctx, true);
    } catch (err) {
      logger.error('bot', 'subnew error', { error: err.message });
    }
  });

  bot.action('subback:day', async ctx => {
    try {
      await ctx.answerCbQuery();
      await sendDayPicker(ctx, true);
    } catch (err) {
      logger.error('bot', 'subback:day error', { error: err.message });
    }
  });

  bot.action(/^subday:(Sat|Sun)$/, async ctx => {
    const dayCode = ctx.match[1];

    try {
      await ctx.answerCbQuery();
      await sendActivityPicker(ctx, dayCode, true);
    } catch (err) {
      logger.error('bot', 'subday error', { error: err.message });
    }
  });

  bot.action(/^subback:act:(Sat|Sun)$/, async ctx => {
    const dayCode = ctx.match[1];

    try {
      await ctx.answerCbQuery();
      await sendActivityPicker(ctx, dayCode, true);
    } catch (err) {
      logger.error('bot', 'subback:act error', { error: err.message });
    }
  });

  bot.action(/^subact:(Sat|Sun):(\d{1,2})$/, async ctx => {
    const dayCode = ctx.match[1];
    const activityIdx = Number(ctx.match[2]);

    try {
      await ctx.answerCbQuery();
      if (!ACTIVITIES[activityIdx]) {
        await ctx.editMessageText('Эта тренировка больше не поддерживается.');
        return;
      }
      await sendTimePicker(ctx, dayCode, activityIdx, true);
    } catch (err) {
      logger.error('bot', 'subact error', { error: err.message });
    }
  });

  // Final step: Time Conflict Guard, then save.
  bot.action(/^subtime:(Sat|Sun):(\d{1,2}):(\d{1,2})$/, async ctx => {
    const dayCode = ctx.match[1];
    const activityIdx = Number(ctx.match[2]);
    const timeIdx = Number(ctx.match[3]);
    const chatId = String(ctx.chat.id);

    try {
      const dayName = DAY_NAME_BY_CODE[dayCode];
      const activityName = ACTIVITIES[activityIdx];
      const timeLabel = TIME_SLOTS[timeIdx];

      if (!dayName || !activityName || !timeLabel) {
        await ctx.answerCbQuery('Некорректный выбор.', { show_alert: true });
        return;
      }

      const startTime = `${timeLabel}:00`;
      const conflict = await storage.findConflictingAutoSubscription(chatId, dayName, startTime);

      if (conflict) {
        if (conflict.activityName === activityName) {
          await ctx.answerCbQuery('У тебя уже есть такая подписка.', { show_alert: true });
          return;
        }

        await ctx.answerCbQuery();
        await ctx.editMessageText(
          `⚠️ У тебя уже есть подписка на ${dayLabel(dayName)} в ${timeLabel} (${conflict.activityName}).\n` +
          `Выбери другое время или удали существующую подписку в «⚙️ Мои подписки».`
        );
        return;
      }

      await storage.addAutoSubscription({ userId: chatId, dayOfWeek: dayName, activityName, startTime });
      logger.info('bot', `Auto-subscription created for ${chatId}: ${dayName} ${startTime} ${activityName}`);

      await ctx.answerCbQuery('Подписка создана ✅');
      await ctx.editMessageText(
        `✅ Готово! Как только на ${dayLabel(dayName).toLowerCase()} появится <b>${activityName}</b> в ${timeLabel}, ` +
        `мы автоматически попробуем забронировать место (или поставим в лист ожидания, если мест не будет).`,
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      logger.error('bot', 'subtime error', { error: err.message });
      await ctx.answerCbQuery('Произошла ошибка. Попробуй снова позже.', { show_alert: true });
    }
  });

  bot.action(/^subdel:([0-9a-fA-F-]{36})$/, async ctx => {
    const id = ctx.match[1];
    const chatId = String(ctx.chat.id);

    try {
      const removed = await storage.removeAutoSubscription(id, chatId);
      if (!removed) {
        await ctx.answerCbQuery('Эта подписка уже неактуальна.', { show_alert: true });
        return;
      }

      logger.info('bot', `Auto-subscription removed for ${chatId}: ${id}`);
      await ctx.answerCbQuery('Убрано ✅');
      await renderMySubscriptions(ctx, true);
    } catch (err) {
      logger.error('bot', 'subdel error', { error: err.message });
      await ctx.answerCbQuery('Не удалось удалить подписку. Попробуй позже.', { show_alert: true });
    }
  });
}
