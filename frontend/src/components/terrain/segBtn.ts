// The segmented terrain-control button, shared by the regional and HQ maps.
export const segBtn = (active: boolean) =>
  `px-2 py-0.5 border ${active
    ? 'border-cyan-400/70 bg-cyan-500/20 text-cyan-200'
    : 'border-slate-700 bg-slate-900/80 text-slate-400 hover:text-slate-200'}`;
