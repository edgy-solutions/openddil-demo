// Shows the illustrated-parts figure a released record cites, with the
// object it names highlighted. The fetch lives in `FigureView`; the
// rendering lives in the pure `FigureViewBody` so a test can render each
// state with renderToStaticMarkup (see ReleasedRecordsPane.tsx on why).
// The markup is sanitized by `prepareFigure` before it reaches
// dangerouslySetInnerHTML.
import { useEffect, useState } from 'react';
import { figureUrl, isSafeIcn, prepareFigure } from './figure';

export type FigureState =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'error' }
  | { status: 'unreadable' }
  | { status: 'ready'; svg: string; found: boolean };

export interface FigureViewProps {
  icn: string;
  applicationStructureIdent: string | null;
}

export function FigureViewBody({
  icn, applicationStructureIdent, state,
}: FigureViewProps & { state: FigureState }) {
  switch (state.status) {
    case 'loading':
      return <div className="text-xs text-slate-500">Loading figure {icn}…</div>;
    case 'missing':
      return <div className="text-xs text-slate-500">Figure {icn} is not deployed on this hub.</div>;
    case 'error':
      return <div className="text-xs text-rose-400">Could not load figure {icn}.</div>;
    case 'unreadable':
      return <div className="text-xs text-rose-400">Figure {icn} could not be read.</div>;
    case 'ready':
      return (
        <div>
          <div
            className="max-h-80 overflow-auto rounded border border-slate-800 bg-slate-900 p-2 [&>svg]:mx-auto [&>svg]:h-auto [&>svg]:max-h-72 [&>svg]:w-full"
            dangerouslySetInnerHTML={{ __html: state.svg }}
          />
          <div className="mt-1 text-[11px] text-slate-400">
            {applicationStructureIdent === null
              ? icn
              : state.found
                ? `${icn} — applicationStructureIdent ${applicationStructureIdent} highlighted`
                : `${icn} — applicationStructureIdent ${applicationStructureIdent} is not in this figure`}
          </div>
        </div>
      );
  }
}

function FigureFetch({ icn, applicationStructureIdent }: FigureViewProps) {
  const [state, setState] = useState<FigureState>({ status: 'loading' });

  useEffect(() => {
    if (!isSafeIcn(icn)) return;
    let cancelled = false;
    fetch(figureUrl(icn), { credentials: 'same-origin' })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 404) return setState({ status: 'missing' });
        if (!res.ok) return setState({ status: 'error' });
        const prepared = prepareFigure(await res.text(), applicationStructureIdent);
        if (cancelled) return;
        setState(prepared ? { status: 'ready', ...prepared } : { status: 'unreadable' });
      })
      .catch(() => { if (!cancelled) setState({ status: 'error' }); });
    return () => { cancelled = true; };
  }, [icn, applicationStructureIdent]);

  // Never render a figure control for an unsafe number.
  if (!isSafeIcn(icn)) return null;
  return <FigureViewBody icn={icn} applicationStructureIdent={applicationStructureIdent} state={state} />;
}

// Keyed so a different figure or ident starts again from loading.
export default function FigureView(props: FigureViewProps) {
  return <FigureFetch key={`${props.icn}|${props.applicationStructureIdent ?? ''}`} {...props} />;
}
