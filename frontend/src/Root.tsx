import { useState, useEffect } from 'react';
import ControllerApp from './ControllerApp';
import TierApp from './TierApp';
import type { TierConfig } from './deployment';
import { Wrench, Server, Building2, SlidersHorizontal } from 'lucide-react';
import { deployment } from './deployment';
import { useSession } from './hooks/useSession';
import { SignedOut, CheckingSession } from './components/SignedOut';
import IdentityBadge from './components/releasability/IdentityBadge';
import ShapeErrorBanner from './components/ShapeErrorBanner';

// =============================================================================
// Root — two modes, and which one you get is a deployment fact
// =============================================================================
// TIER MODE (`deployment.json` carries a `tier` block): this process is one
// tier node's UI. It renders THAT tier's instance and nothing else. There is
// no switcher, because there is nothing to switch to — the tier a UI serves
// is decided by which endpoint you reached, not by a control on the page.
//
// DEMO-SHELL MODE (no `tier` block): the historical three-tab SPA, which
// composes every tier into one pane. ADR-0033's amendment blesses this
// explicitly — "legitimate as a demo shell, honestly labelled, possibly
// indefinitely" — as a CONSUMER of the tier-parameterized presentation
// rather than the thing itself.
//
// -----------------------------------------------------------------------------
// WHY THE TABS ARE A HAZARD AT A TIER NODE, AND NOT MERELY UNTIDY
// -----------------------------------------------------------------------------
// A tier node shipping the shell offers HQ and REGIONAL tabs whose panels
// then render THAT TIER's store under another tier's label. An operator at
// an edge clicking "HQ" sees edge data captioned as the whole force. That is
// mode confusion of the kind an HSI review names on sight, and it became
// visible rather than theoretical the moment tiers had their own stores.
//
// The shell is honest on ONE screen where an operator chose to compose
// tiers. It is not honest on a tier node, and tier mode is how a tier node
// stops shipping it.
// =============================================================================

type View = 'maintainer' | 'regional' | 'hq' | 'controller';
const VALID_VIEWS: View[] = ['maintainer', 'regional', 'hq', 'controller'];

function initialView(): View {
  const param = new URLSearchParams(window.location.search).get('role');
  return (param && (VALID_VIEWS as string[]).includes(param)) ? (param as View) : 'maintainer';
}

// The shapes the shell composes. Named for the SHAPE, not for the historical
// view, because that is the whole correction: "maintainer" was never a kind
// of view, it was a leaf node's instance.
const SHELL_LEAF: TierConfig = {
  id: 'shell-leaf', label: 'maintainer', scope: null,
  has_children: false, parent: 'shell-intermediate',
};
const SHELL_INTERMEDIATE: TierConfig = {
  id: 'shell-intermediate', label: 'regional', scope: null,
  has_children: true, parent: 'shell-root',
};
const SHELL_ROOT: TierConfig = {
  id: 'shell-root', label: 'hq', scope: null,
  has_children: true, parent: null,
};

/** The demo shell — every tier in one pane, behind tabs. */
function DemoShell({ title, logo }: { title: string; logo: string }) {
  const [view, setView] = useState<View>(initialView);

  // Keep ?role= in sync so a reload / shared link lands on the same view.
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('role', view);
    window.history.replaceState(null, '', url);
  }, [view]);

  const tabs: { id: View; label: string; icon: typeof Wrench }[] = [
    { id: 'maintainer', label: 'MAINTAINER', icon: Wrench },
    { id: 'regional', label: 'REGIONAL', icon: Server },
    { id: 'hq', label: 'HQ', icon: Building2 },
    { id: 'controller', label: 'DDIL CONTROLLER', icon: SlidersHorizontal },
  ];

  return (
    <div className="h-screen flex flex-col bg-slate-950 text-slate-300 overflow-hidden font-mono">
      <div className="h-10 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-4 shrink-0 z-50 relative">
        <div className="flex items-center gap-2 text-cyan-500 font-orbitron font-bold tracking-widest text-sm">
          {logo && <img src={logo} alt="" className="h-6 w-auto object-contain" />}
          {title}
          {/* HONESTLY LABELLED, per the amendment. Without this the shell is
              indistinguishable from a tier instance, which is the whole
              confusion the tier mode exists to remove — and a reader cannot
              tell "composed demo" from "this tier" by looking. */}
          <span className="ml-2 rounded border border-slate-600 px-1.5 py-0.5
                           text-[10px] font-normal tracking-normal text-slate-400"
                title="No tier is configured for this deployment, so every tier is composed into one pane. A tier node renders its own instance instead.">
            DEMO SHELL · all tiers composed · DEPRECATED
          </span>
          {/* The shell is a viewer, not a node — but the rows it shows are
              still filtered for whoever is looking, so it names them too. */}
          <div className="ml-3">
            <IdentityBadge />
          </div>
        </div>
        <div className="flex gap-2">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setView(id)}
              className={`px-3 py-1 flex items-center gap-2 text-xs font-bold transition-colors ${view === id ? 'bg-slate-800 text-white border border-slate-600' : 'text-slate-500 hover:text-slate-300'}`}
            >
              <Icon className="w-3 h-3" /> {label}
            </button>
          ))}
        </div>
      </div>

      <ShapeErrorBanner />

      {/* Main View Container. min-h-0 + overflow-hidden propagate the
          height constraint down — without min-h-0, this flex item's
          default `min-height: auto` lets it grow past parent if children
          (role views, which use h-full) try to size to it. */}
      <div className="flex-1 relative min-h-0 overflow-hidden">
        {/* THE SHELL COMPOSES TIER INSTANCES. It does not reimplement them,
            and after 2026-09-05 it does not even reference the three
            components directly — it hands TierApp a SHAPE and gets whatever
            that shape resolves to.

            That is the amendment's sentence made literally true rather than
            approximately: the shell became "a CONSUMER of the
            tier-parameterized presentation rather than the thing itself".
            The practical consequence is that the shell cannot drift from a
            tier node's rendering, because there is one code path and the
            shell is simply another caller of it.

            The synthetic tiers below have no `scope` — the shell reads the
            root's store, where scoping is the operator's job through the
            in-view pickers rather than a property of the instance. */}
        {view === 'maintainer' && <TierApp tier={SHELL_LEAF} />}
        {view === 'regional' && <TierApp tier={SHELL_INTERMEDIATE} />}
        {view === 'hq' && <TierApp tier={SHELL_ROOT} />}
        {/* The DDIL controller is NOT a tier instance. It is an operator
            tool that acts on the deployment, and whether it belongs to a
            tier at all is explicitly undecided (opening package §7). Left
            as itself rather than forced into a shape it may not have. */}
        {view === 'controller' && <ControllerApp />}
      </div>
    </div>
  );
}

/** The shell is reachable ONLY here, and never at a node's own endpoint.
 *
 *  It used to be what you got at the root host whenever no tier was
 *  configured, which put a composed multi-tier view on the HQ node's
 *  address. Two things were wrong with that at once: HQ had no instance of
 *  its own to serve, and the composition was sitting at an endpoint that
 *  reads as a node. Now the root host serves the root node's instance like
 *  any other tier, and the shell has its own path and says it is going. */
const DEMO_PATH = '/demo';
function atDemoPath(): boolean {
  return window.location.pathname === DEMO_PATH
      || window.location.pathname.startsWith(DEMO_PATH + '/');
}

function Root() {
  // Deployment config is loaded once before render (see main.tsx).
  const { title, logo, tier } = deployment();
  const session = useSession();

  // ---------------------------------------------------------------------
  // SESSION GATE — before anything renders, including the header.
  // ---------------------------------------------------------------------
  // Three states, and collapsing any two of them is a defect that has
  // already happened here:
  //
  //   undefined  /auth/me in flight. Render neither the app (its shape
  //              requests would 401 and every panel would say "Syncing…")
  //              nor the login prompt (it would flash on every load for
  //              users who are signed in).
  //   false      a finished answer. Say so; render nothing else. The old
  //              behaviour showed the tier id, the parent, the panel
  //              inventory and the buffer state to anyone who could reach
  //              the host — topology before any decision about the viewer.
  //   authDisabled  there is nothing to sign in to. Not the same as signed
  //              out, and offering a sign-in button here would be a lie.
  if (!session.authDisabled) {
    if (session.authenticated === undefined) return <CheckingSession />;
    if (session.authenticated === false) return <SignedOut />;
  }

  if (atDemoPath()) {
    return <DemoShell title={title} logo={logo} />;
  }

  if (tier) {
    return (
      <div className="h-screen flex flex-col bg-slate-950 text-slate-300 overflow-hidden font-mono">
        <div className="h-10 bg-slate-900 border-b border-slate-800 flex items-center gap-3 px-4 shrink-0 z-50 relative">
          <div className="flex items-center gap-2 text-cyan-500 font-orbitron font-bold tracking-widest text-sm">
            {logo && <img src={logo} alt="" className="h-6 w-auto object-contain" />}
            {title}
          </div>
          {/* WHICH TIER THIS IS, AND WHERE ITS DATA COMES FROM — stated on
              screen, because the whole class of defect this arc closes is a
              UI that reads one tier's store while wearing another's label
              (UD-9). A claim the UI can only make if something told it is
              the difference between a rung that checks its own heading and
              one that infers it. */}
          <span className="rounded border border-cyan-700/60 bg-cyan-500/10 px-2 py-0.5
                           text-[10px] tracking-widest text-cyan-300"
                title={`tier ${tier.id}${tier.parent ? ` · parent ${tier.parent}` : ' · root'}`}>
            TIER {(tier.label ?? tier.id).toUpperCase()}
          </span>
          <span className="text-[10px] text-slate-500"
                title="The scope this instance reads. Unscoped is correct at a tier node, whose store holds only its own subtree.">
            {tier.scope
              ? `${tier.scope.column} = ${tier.scope.value}`
              : 'unscoped (this tier’s own store)'}
          </span>
          {/* WHOSE SCREEN THIS IS. In the shared chrome so it renders for
              EVERY tier shape — it used to live in the edge-shaped header
              alone, which left the HQ and regional shapes showing a
              subject-scoped partition with no subject named. A partitioned
              view that does not display its subject is indistinguishable
              from an unpartitioned one, which is exactly the claim an
              operator cannot afford to guess at. */}
          <div className="ml-auto">
            <IdentityBadge />
          </div>
        </div>
        <ShapeErrorBanner />
        <div className="flex-1 relative min-h-0 overflow-hidden">
          <TierApp tier={tier} />
        </div>
      </div>
    );
  }

  // TIER PRESENT BUT REJECTED. Not the shell, not an implicit root, not a
  // best guess — a deployment that tried to declare its identity and got it
  // wrong must not be given one. Rendering a confident node here is exactly
  // UD-9: a screen reading one tier's store under another tier's label.
  return (
    <div className="h-screen w-screen bg-slate-950 text-slate-300 font-mono
                    flex flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="font-orbitron tracking-widest text-rose-400 text-lg">
        DEPLOYMENT CONFIGURATION REJECTED
      </div>
      <p className="max-w-md text-xs leading-relaxed text-slate-500">
        This deployment declares a <code className="text-slate-400">tier</code>{' '}
        block that could not be read, so this instance has no verified
        identity and will not render fleet data under a label it cannot
        stand behind. The console records which field was rejected.
      </p>
      <p className="max-w-md text-[10px] leading-relaxed text-slate-600">
        A partial tier identity is worse than none — see UD-9.
      </p>
    </div>
  );
}

export default Root;
