// condition -- pure helpers for the DIS-state condition the edge stamps on an
// asset (envelope) and rolls up to the region. Every field is optional and
// every string may be an enum name this build has never seen: helpers render
// the raw text and never throw.

export type ConditionLevelName =
  | 'CONDITION_LEVEL_UNSPECIFIED'
  | 'CONDITION_LEVEL_NOMINAL'
  | 'CONDITION_LEVEL_DEGRADED'
  | 'CONDITION_LEVEL_CRITICAL'
  | 'CONDITION_LEVEL_NOT_EMITTING'
  | 'CONDITION_LEVEL_SENSOR_FAILED'
  | 'CONDITION_LEVEL_DEACTIVATED'
  | 'CONDITION_LEVEL_DESTROYED';

export interface ConditionClaim {
  source?: string;
  level?: string;
  detail?: string;
  observed_at?: string;
}

export interface Condition {
  level?: string;
  moved_by?: string[];
  claims?: ConditionClaim[];
}

export type ConditionTone = 'nominal' | 'degraded' | 'critical' | 'off';

const LEVEL_PREFIX = 'CONDITION_LEVEL_';
const SOURCE_PREFIX = 'CONDITION_SOURCE_';

/** Levels at which the asset is not emitting at all (the card shows the
 *  off block rather than charts). Full enum names. */
export const OFF_LEVELS: ReadonlySet<string> = new Set([
  'CONDITION_LEVEL_NOT_EMITTING',
  'CONDITION_LEVEL_DEACTIVATED',
  'CONDITION_LEVEL_DESTROYED',
]);

/** "CONDITION_LEVEL_SENSOR_FAILED" -> "SENSOR FAILED"; unknown/empty -> "UNKNOWN". */
export function levelWords(level: string | null | undefined): string {
  if (!level) return 'UNKNOWN';
  const bare = level.startsWith(LEVEL_PREFIX) ? level.slice(LEVEL_PREFIX.length) : level;
  const words = bare.replace(/_/g, ' ').trim();
  return words || 'UNKNOWN';
}

function oneSourceWords(source: string): string {
  const bare = source.startsWith(SOURCE_PREFIX) ? source.slice(SOURCE_PREFIX.length) : source;
  return bare.replace(/_/g, ' ').trim().toLowerCase();
}

/** Enum name or element short code -> words. "+"-joined codes join as
 *  "appearance damage + data health". */
export function sourceWords(source: string | null | undefined): string {
  if (!source) return '';
  return source
    .split('+')
    .map((s) => oneSourceWords(s.trim()))
    .filter((s) => s !== '')
    .join(' + ');
}

/** One-line statement of the condition and what moved it; null when there
 *  is no condition to state. */
export function conditionLine(c: Condition | null | undefined): string | null {
  if (!c || !c.level) return null;
  const head = `CONDITION ${levelWords(c.level)}`;
  if (c.level === 'CONDITION_LEVEL_NOMINAL') {
    return `${head} · ${(c.claims ?? []).length} source(s) reporting`;
  }
  const movers = (c.moved_by ?? []).map(sourceWords).filter((s) => s !== '');
  let line = head;
  if (movers.length > 0) line += ` · moved by ${movers.join(' + ')}`;
  const moved = new Set(c.moved_by ?? []);
  const details = (c.claims ?? [])
    .filter((cl) => cl.source != null && moved.has(cl.source) && cl.detail)
    .map((cl) => cl.detail as string);
  if (details.length > 0) line += ` (${details.join('; ')})`;
  return line;
}

export function conditionTone(c: Condition | null | undefined): ConditionTone {
  switch (c?.level) {
    case 'CONDITION_LEVEL_DEGRADED':
      return 'degraded';
    case 'CONDITION_LEVEL_CRITICAL':
    case 'CONDITION_LEVEL_SENSOR_FAILED':
      return 'critical';
    case 'CONDITION_LEVEL_NOT_EMITTING':
    case 'CONDITION_LEVEL_DEACTIVATED':
    case 'CONDITION_LEVEL_DESTROYED':
      return 'off';
    default:
      return 'nominal';
  }
}
