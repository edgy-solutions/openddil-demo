import { useState, useEffect } from 'react';
import MaintainerApp from './MaintainerApp';
import RegionalApp from './RegionalApp';
import HqApp from './HqApp';
import ControllerApp from './ControllerApp';
import { Wrench, Server, Building2, SlidersHorizontal } from 'lucide-react';

// Phase 4c: three role-aware views (maintainer / regional / HQ) plus the
// DDIL controller. The Phase 4b SIMULATOR tab is gone. A dev-only ?role=
// URL param can override the active view for development — real
// auth/role binding is deferred to Phase 5+.

type View = 'maintainer' | 'regional' | 'hq' | 'controller';
const VALID_VIEWS: View[] = ['maintainer', 'regional', 'hq', 'controller'];

function initialView(): View {
  const param = new URLSearchParams(window.location.search).get('role');
  return (param && (VALID_VIEWS as string[]).includes(param)) ? (param as View) : 'maintainer';
}

function Root() {
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
      {/* Dev Navigation Bar (not part of the role UIs — just for switching) */}
      <div className="h-10 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-4 shrink-0 z-50 relative">
        <div className="flex items-center gap-2 text-cyan-500 font-orbitron font-bold tracking-widest text-sm">
          <span className="text-white">OpenDDIL</span> DEMO
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

      {/* Main View Container */}
      <div className="flex-1 relative">
        {view === 'maintainer' && <MaintainerApp />}
        {view === 'regional' && <RegionalApp />}
        {view === 'hq' && <HqApp />}
        {view === 'controller' && <ControllerApp />}
      </div>
    </div>
  );
}

export default Root;
