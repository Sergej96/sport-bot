/** Small text helpers shared by the inline-keyboard label builders. */

/** Truncates a string to at most maxLen chars, appending an ellipsis if it had to cut. */
export function truncate(str, maxLen) {
  if (!str || str.length <= maxLen) return str;
  return `${str.slice(0, Math.max(0, maxLen - 1))}…`;
}

/**
 * Builds a Telegram inline-button label out of a variable-length `name`
 * (an activity name, which can run up to ~21 chars in Russian, e.g.
 * "Скандинавская ходьба") plus fixed surrounding text (icon, day, date,
 * time, separators). Truncates `name` so the combined label never exceeds
 * maxLen — without this, the longest activity names combined with a
 * day/time suffix can overflow and wrap awkwardly inside the button.
 */
export function fitLabel({ before = '', name, after = '', maxLen = 36 }) {
  const budget = Math.max(1, maxLen - before.length - after.length);
  return `${before}${truncate(name, budget)}${after}`;
}
