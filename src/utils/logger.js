/**
 * Thin console wrapper. The rule that matters: NEVER pass a raw password
 * (or token) string into these — always pass structured context that omits
 * secret fields. redact() is a defensive backstop for anything that slips
 * through with a recognizably-named secret key.
 */

const SECRET_KEYS = ['password', 'access_token', 'refresh_token', 'accessToken', 'refreshToken'];

function redact(context) {
  if (!context || typeof context !== 'object') return context;
  const safe = { ...context };
  for (const key of SECRET_KEYS) {
    if (key in safe) safe[key] = '[REDACTED]';
  }
  return safe;
}

function format(scope, message, context) {
  const suffix = context ? ` ${JSON.stringify(redact(context))}` : '';
  return `[${scope}] ${message}${suffix}`;
}

export function info(scope, message, context) {
  console.log(format(scope, message, context));
}

export function warn(scope, message, context) {
  console.warn(format(scope, message, context));
}

export function error(scope, message, context) {
  console.error(format(scope, message, context));
}
