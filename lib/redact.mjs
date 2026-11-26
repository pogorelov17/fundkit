// Redaction of secret values from text that leaves a profile process.

export const REDACTED = '[redacted:fundkit]';

const MIN_REDACTED_LENGTH = 4;

/** The raw, JSON-escaped and URL-encoded spellings of one value. */
function spellings(value) {
  const forms = new Set([value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)]);
  return [...forms];
}

/**
 * Build a function that replaces every spelling of every value in `values` by REDACTED.
 * Longer spellings are replaced first, so a value that contains another is fully hidden.
 */
export function createRedactor(values) {
  const forms = values
    .filter((value) => typeof value === 'string' && value.length >= MIN_REDACTED_LENGTH)
    .flatMap(spellings)
    .sort((a, b) => b.length - a.length);
  return (text) => forms.reduce((result, form) => result.replaceAll(form, REDACTED), text);
}
