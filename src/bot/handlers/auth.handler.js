/**
 * /login, /logout, and the email → password step-dialogue that collects
 * credentials inside the chat. Registered FIRST in bot/index.js so its
 * `bot.on('text')` middleware gets first look at every text message and can
 * `next()` through to the command handlers when no login is in progress.
 */

import * as auth from '../../services/auth.service.js';
import * as storage from '../../services/storage.service.js';
import { getSession, setSession, clearSession } from '../session.js';
import * as logger from '../../utils/logger.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function registerAuthHandlers(bot) {
  bot.on('text', async (ctx, next) => {
    const chatId = ctx.chat.id;
    const text = ctx.message.text.trim();

    if (text.startsWith('/')) {
      // A command interrupts any in-flight login dialogue — let it through.
      if (getSession(chatId)) clearSession(chatId);
      return next();
    }

    const session = getSession(chatId);
    if (!session) return next();

    if (session.step === 'awaiting_email') {
      if (!EMAIL_RE.test(text)) {
        await ctx.reply('Похоже, это не email. Попробуй ещё раз, или отправь /login, чтобы начать сначала.');
        return;
      }
      setSession(chatId, { step: 'awaiting_password', email: text });
      await ctx.reply('Отлично! Теперь отправь пароль от аккаунта спортдлявсех.бел.');
      return;
    }

    if (session.step === 'awaiting_password') {
      const { email } = session;
      const password = text;
      clearSession(chatId);

      // Best-effort: scrub the password out of the chat history immediately.
      // Never log `password` itself — only the outcome.
      try {
        await ctx.deleteMessage();
      } catch {
        // Bot may lack delete rights in this chat — not fatal.
      }

      // Step 1: authenticate against the API. Failures here are genuinely
      // about the credentials/service, so it's safe to tell the user why.
      let tokens;
      try {
        tokens = await auth.login(email, password);
      } catch (err) {
        const status = err.normalized?.status ?? err.response?.status;
        logger.warn('bot', 'Login failed', { chatId, email, status });
        const reason = status === 401 || status === 400
          ? 'Неверный email или пароль.'
          : 'Не удалось войти — сервис недоступен, попробуй позже.';
        await ctx.reply(`❌ ${reason}\nОтправь /login, чтобы попробовать снова.`);
        return;
      }

      // Step 2: persist the session locally. A failure here means the login
      // itself succeeded but we couldn't save it (e.g. ENCRYPTION_KEY
      // missing/misconfigured) — a server-side bug, not a credentials
      // problem, so it must never be reported as "wrong password".
      try {
        await auth.persistSession(chatId, {
          email,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          password,
        });
        logger.info('bot', 'Login succeeded', { chatId, email });
        await ctx.reply(
          '✅ Вход выполнен! Теперь можно бронировать и вставать в лист авто-бронирования через /schedule.'
        );
      } catch (err) {
        logger.error('bot', 'Failed to persist session after successful login', { chatId, email, error: err.message });
        await ctx.reply(
          '⚠️ Вход в спортдлявсех.бел прошёл успешно, но бот не смог сохранить сессию (внутренняя ошибка настройки). ' +
          'Сообщи администратору бота и попробуй /login позже.'
        );
      }
      return;
    }

    return next();
  });

  bot.command('login', async ctx => {
    setSession(ctx.chat.id, { step: 'awaiting_email' });
    await ctx.reply('Введи email от аккаунта спортдлявсех.бел:');
  });

  bot.command('logout', async ctx => {
    try {
      const deleted = await storage.deleteUser(ctx.chat.id);
      clearSession(ctx.chat.id);
      await ctx.reply(deleted ? '👋 Вышел(а) из аккаунта спортдлявсех.бел.' : 'Ты не был(а) авторизован(а).');
    } catch (err) {
      logger.error('bot', '/logout error', { error: err.message });
      await ctx.reply('Произошла ошибка. Попробуй снова позже.');
    }
  });
}
