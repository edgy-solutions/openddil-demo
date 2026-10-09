// =============================================================================
// ManualQuestionPanel — "Ask the manual"
// =============================================================================
// Lets a maintainer ask a question about the asset in view. The question
// goes to POST /manual/ask (gateway/pep.py), scoped to the data modules
// (DMCs) currently in view for this asset — lib/manualQa.ts's
// manualQaScope: the distinct dmc values from the asset's fault catalog
// (lib/cmReport.ts's loadFaultCatalog), plus the dmc of an open BIT-
// discrepancy card when one is showing. There is no client-side guessing of
// DMCs beyond that — an empty scope means there is nothing to ask against,
// and this panel sends nothing in that case.
//
// An answer is rendered ONLY when it carries at least one citation and
// every citation names a DMC inside the scope the question was actually
// sent with (lib/manualQa.ts's shouldRenderAnswer, re-checked here
// independently of whatever the gateway already enforced) — otherwise the
// panel says plainly that no cited answer is available. Answer text is
// never interpolated into the DOM except through that one gate.
//
// Split into a stateful container (this default export: owns the question
// text, the fetch, and whether a 404 has retroactively hidden the panel)
// and a pure view (ManualQuestionPanelView, exported separately) for the
// same reason FaultReportForm is split: the view is testable with
// react-dom/server's renderToStaticMarkup (no DOM dependency in this
// project — see vitest.config.ts), the container's fetch is not unit-
// tested directly, same as FaultReportForm's.
import { useState } from 'react';
import { BookOpen, Send } from 'lucide-react';
import DemoMockBanner from './DemoMockBanner';
import { deployment } from '../deployment';
import {
  askManualQuestion,
  citationsInScope,
  type AskResult,
  type Citation,
} from '../lib/manualQa';

const MAX_QUESTION_LENGTH = 1000;

export interface ManualQuestionPanelProps {
  assetId: string | null | undefined;
  /** For the empty-scope message ("No manual data modules in view for
   *  <variant>"). */
  platformVariant: string | null | undefined;
  /** manualQaScope(...)'s result — the DMCs this question may cite. */
  scope: string[];
  /** dmc -> a human label when one is known (this asset's fault-catalog
   *  text for a code carrying that dmc). Entries not present here render
   *  with just the bare dmc as their chip label. */
  scopeLabels?: Record<string, string>;
}

export default function ManualQuestionPanel({
  assetId,
  platformVariant,
  scope,
  scopeLabels,
}: ManualQuestionPanelProps) {
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [result, setResult] = useState<AskResult | null>(null);
  // Set once an ask attempt itself comes back 404 -- this feature has no
  // separate capability probe, so "not configured at this tier" is only
  // discoverable by asking. Once learned, the panel stays hidden for the
  // rest of this mount rather than flashing itself back in.
  const [hidden, setHidden] = useState(false);

  const handleAsk = async () => {
    if (!assetId || asking || scope.length === 0 || question.trim().length === 0) return;
    setAsking(true);
    try {
      const outcome = await askManualQuestion({ assetId, question, dmcs: scope });
      if (outcome.kind === 'hidden') {
        setHidden(true);
      } else {
        setResult(outcome);
      }
    } finally {
      setAsking(false);
    }
  };

  if (hidden) return null;

  return (
    <ManualQuestionPanelView
      platformVariant={platformVariant}
      scope={scope}
      scopeLabels={scopeLabels}
      question={question}
      onQuestionChange={setQuestion}
      onAsk={handleAsk}
      asking={asking}
      result={result}
      stubBanner={deployment().manualQa?.stub !== false}
    />
  );
}

// =============================================================================
// ManualQuestionPanelView — pure rendering, no hooks
// =============================================================================
export interface ManualQuestionPanelViewProps {
  platformVariant: string | null | undefined;
  scope: string[];
  scopeLabels?: Record<string, string>;
  question: string;
  onQuestionChange: (question: string) => void;
  onAsk: () => void;
  asking: boolean;
  result: AskResult | null;
  stubBanner: boolean;
}

function chipLabel(dmc: string, scopeLabels?: Record<string, string>): string {
  const label = scopeLabels?.[dmc];
  return label ? `${dmc} — ${label}` : dmc;
}

function CitationRow({ citation }: { citation: Citation }) {
  return (
    <li className="text-[11px] text-slate-400">
      {citation.dmc}
      {citation.title ? ` — ${citation.title}` : ''}
      {citation.step ? `: ${citation.step}` : ''}
    </li>
  );
}

export function ManualQuestionPanelView({
  platformVariant,
  scope,
  scopeLabels,
  question,
  onQuestionChange,
  onAsk,
  asking,
  result,
  stubBanner,
}: ManualQuestionPanelViewProps) {
  const variant = platformVariant ?? 'this asset';

  // THE ONLY PATH TO RENDERING ANSWER TEXT. Re-checked here against `scope`
  // regardless of what `result.kind` claims, so a citation naming a dmc
  // outside this question's own scope can never reach the DOM as an
  // answered reply -- it falls through to the no-cited-answer notice below
  // exactly as an empty-citations reply does.
  const renderableAnswer =
    result && result.kind === 'answered' && citationsInScope(result.citations, scope)
      ? result
      : null;

  return (
    <div className="panel shrink-0 p-3 relative">
      {stubBanner && <DemoMockBanner note="manual question service is a stub" position="inline" />}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm text-slate-400 tracking-wider uppercase flex items-center">
          <BookOpen className="w-4 h-4 mr-2" /> Ask the manual
        </h2>
      </div>

      {scope.length === 0 ? (
        <div className="text-[11px] text-slate-500">
          No manual data modules in view for {variant}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-1 mb-2">
            {scope.map((dmc) => (
              <span
                key={dmc}
                className="text-[10px] px-1.5 py-0.5 rounded-sm border border-slate-700 bg-slate-800 text-slate-400"
              >
                {chipLabel(dmc, scopeLabels)}
              </span>
            ))}
          </div>

          <div className="space-y-2">
            <textarea
              value={question}
              onChange={(e) => onQuestionChange(e.target.value)}
              maxLength={MAX_QUESTION_LENGTH}
              rows={2}
              className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-sm py-1.5 px-2 text-xs focus:outline-none focus:ring-2 focus:ring-cyan-500/50 resize-none"
              placeholder="Ask about this asset's fault isolation…"
            />
            <button
              type="button"
              onClick={onAsk}
              disabled={asking || question.trim().length === 0}
              className="w-full flex items-center justify-center gap-1.5 text-xs font-bold uppercase tracking-wider py-1.5 rounded-sm border border-cyan-700 bg-cyan-900/40 text-cyan-300 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-cyan-900/60 transition-colors"
            >
              <Send className="w-3.5 h-3.5" /> {asking ? 'Asking…' : 'Ask'}
            </button>
          </div>

          {renderableAnswer && (
            <div className="mt-2 space-y-1">
              <p className="text-xs text-slate-200">{renderableAnswer.answer}</p>
              <ul className="space-y-0.5 pl-3 list-disc">
                {renderableAnswer.citations.map((c, i) => (
                  <CitationRow key={`${c.dmc}-${i}`} citation={c} />
                ))}
              </ul>
            </div>
          )}

          {!renderableAnswer && result?.kind === 'answered' && (
            <div className="text-[11px] text-slate-500 mt-2">
              No cited answer in the manual for this question (citation outside scope)
            </div>
          )}
          {result?.kind === 'no_cited_answer' && (
            <div className="text-[11px] text-slate-500 mt-2">
              No cited answer in the manual for this question ({result.reason})
            </div>
          )}
          {result?.kind === 'unavailable' && (
            <div className="text-[11px] text-rose-400 mt-2">
              Manual question service unavailable
            </div>
          )}
          {result?.kind === 'error' && (
            <div className="text-[11px] text-rose-400 mt-2">
              {result.status}: {result.message}
            </div>
          )}
        </>
      )}
    </div>
  );
}
