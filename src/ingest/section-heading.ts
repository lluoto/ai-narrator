/**
 * Structural heading recognition shared by cleaning and both downstream views.
 *
 * Colon-ended headings are explicit. Bare headings need stronger evidence: a
 * short title-shaped line must follow completed prose (or another accepted
 * heading), introduce a long prose line or a short heading group, and stay
 * outside Chinese quotation marks. This deliberately favors a missed heading
 * over turning ordinary wrapped prose into a new section.
 */
export const SECTION_TITLE_MAX_LEN = 12;

const COLON_TITLE_LINE = /^[▶►▷]?\s*(.{1,12}?)[：:]$/;
const COMPLETED_TEXT_LINE = /[。！？…；][」』"'”’）)】]*$/;
const ASCII_FULL_STOP = /\.[」』"'”’）)】]*$/;
const ASCII_FULL_STOP_WITH_CLOSER = /\.[」』"'”’）)】]+$/;
const BARE_TITLE_TEXT = /^[\p{L}\p{N}][\p{L}\p{N}\s·・.'’()（）—-]*$/u;
const CONTINUATION_TITLE_PREFIX = /^(?:[的地得了着过在从向对把被而但并也又就会要]|如果|当|这|那)/;
const ONE_CHARACTER_LABEL = /^[\p{L}\p{N}][：:]$/u;

function explicitTitle(line: string): string | undefined {
  const match = line.match(COLON_TITLE_LINE);
  if (!match || (match[1] as string).length > SECTION_TITLE_MAX_LEN) return undefined;
  if (!/^[▶►▷]/.test(line) && CONTINUATION_TITLE_PREFIX.test(match[1] as string)) return undefined;
  return match[1] as string;
}

function bareTitleCandidate(line: string): boolean {
  return line.length > 0
    && line.length <= SECTION_TITLE_MAX_LEN
    && BARE_TITLE_TEXT.test(line)
    && !CONTINUATION_TITLE_PREFIX.test(line)
    && !/[。！？…；：:，、】【.]$/.test(line);
}

function completedTextBefore(previous: string | undefined, next: string): boolean {
  if (!previous) return false;
  if (COMPLETED_TEXT_LINE.test(previous)) return true;
  // PDF extraction also leaves a trailing ASCII full stop after English stat
  // rows. A CJK line after `劳伦.` is more likely the rest of a split name than
  // a new heading, so only let this weaker boundary introduce an ASCII title.
  return ASCII_FULL_STOP.test(previous)
    && (/^[A-Za-z0-9]/.test(next) || ASCII_FULL_STOP_WITH_CLOSER.test(previous));
}

/**
 * A lone final character plus a colon cannot safely start a new page section
 * when unfinished prose runs into it from the preceding page. This catches
 * PDF column/page splits such as `下列文` + `字：` without changing ordinary
 * short labels or the long page-top labels protected by joinPages.
 */
export function isCrossPageLabelContinuation(previous: string, next: string): boolean {
  return ONE_CHARACTER_LABEL.test(next.trim())
    && !COMPLETED_TEXT_LINE.test(previous)
    && !ASCII_FULL_STOP.test(previous);
}

function quoteDepthBeforeLines(lines: readonly string[]): number[] {
  let depth = 0;
  return lines.map((line) => {
    const before = depth;
    for (const char of line) {
      if (char === "“" || char === "‘") depth++;
      if ((char === "”" || char === "’") && depth > 0) depth--;
    }
    return before;
  });
}

function hasLongProseAfter(lines: readonly string[], index: number, quoteDepths: readonly number[]): boolean {
  const next = lines[index + 1]?.trim();
  if (!next) return false;
  if (next.length > SECTION_TITLE_MAX_LEN) return true;
  return quoteDepths[index + 1] === 0
    && bareTitleCandidate(next)
    && hasLongProseAfter(lines, index + 1, quoteDepths);
}

/**
 * Return the title at every line position, preserving the line-based context
 * needed to distinguish a bare PDF heading from a short wrapped continuation.
 */
export function sectionTitleLines(lines: readonly string[]): Array<string | undefined> {
  const normalized = lines.map((line) => line.trim());
  const quoteDepths = quoteDepthBeforeLines(normalized);
  const titles: Array<string | undefined> = Array(normalized.length).fill(undefined);

  for (let index = 0; index < normalized.length; index++) {
    const line = normalized[index]!;
    const explicit = explicitTitle(line);
    if (explicit !== undefined) {
      titles[index] = explicit;
      continue;
    }
    if (!bareTitleCandidate(line) || quoteDepths[index] !== 0 || !hasLongProseAfter(normalized, index, quoteDepths)) continue;

    const previous = normalized[index - 1];
    if (index === 0 || titles[index - 1] !== undefined || completedTextBefore(previous, line)) {
      titles[index] = line;
    }
  }

  return titles;
}

/** Compatibility parser for explicit, one-line headings. Bare headings require line context. */
export function parseExplicitSectionTitleLine(line: string): string | undefined {
  return explicitTitle(line.trim());
}
