import type { ReactNode } from 'react';

/**
 * How the posture header is set off from the map behind it.
 *   * rule  — an accent rule under the title (the default).
 *   * plate — a faint plate with corner brackets.
 * Both carry the same eyebrow, title and meta; only the framing differs.
 */
export type PostureHeaderVariant = 'rule' | 'plate';

/**
 * The title block over the HQ and regional posture maps: the scope as an
 * eyebrow, the view's title on one line (it truncates rather than wrapping
 * under the link card), and a meta line. A severed link turns it rose and
 * adds a LINK SEVERED tag to the eyebrow.
 */
export function PostureHeader({ eyebrow, title, meta, severed = false, variant = 'rule', children }: {
  eyebrow: string;
  title: string;
  meta: ReactNode;
  severed?: boolean;
  variant?: PostureHeaderVariant;
  /** Under the meta line, e.g. regional's camera presets. */
  children?: ReactNode;
}) {
  const body = (
    <>
      <div className="flex items-center gap-2 font-mono text-[10px] tracking-[0.25em] text-slate-500">
        <span>{eyebrow}</span>
        {severed && (
          <span data-testid="posture-header-severed" className="border border-rose-700 bg-rose-950/60 px-1.5 tracking-widest text-rose-300">
            LINK SEVERED
          </span>
        )}
      </div>
      <h1 className={`truncate whitespace-nowrap text-2xl font-bold tracking-wide transition-colors ${severed ? 'text-rose-400' : 'text-emerald-400'}`}>
        {title}
      </h1>
      {variant === 'rule' && (
        <div
          data-testid="posture-header-rule"
          className={`mt-1 h-px w-full max-w-md bg-gradient-to-r to-transparent ${severed ? 'from-rose-500/70' : 'from-emerald-500/70'}`}
        />
      )}
      <p className="mt-1 font-mono text-[10px] tracking-widest text-slate-400">{meta}</p>
    </>
  );

  if (variant === 'rule') {
    return <div data-testid="posture-header" className="min-w-0">{body}{children}</div>;
  }

  const corner = `absolute h-2.5 w-2.5 ${severed ? 'border-rose-500/80' : 'border-emerald-400/80'}`;
  return (
    <div data-testid="posture-header" className="min-w-0">
      <div className="relative bg-slate-950/60 px-4 py-2">
        <span className={`${corner} left-0 top-0 border-l border-t`} />
        <span className={`${corner} right-0 top-0 border-r border-t`} />
        <span className={`${corner} bottom-0 left-0 border-b border-l`} />
        <span className={`${corner} bottom-0 right-0 border-b border-r`} />
        {body}
      </div>
      {children}
    </div>
  );
}
