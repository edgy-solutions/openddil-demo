// The holo terrain style's options and their defaults.
export const HUES = { cyan: '#22d3ee', green: '#34d399', amber: '#fbbf24', magenta: '#e879f9' } as const;
export type HoloOpts = {
  coast: boolean; contours: boolean; depth: boolean; grid: boolean; dots: boolean; sweep: boolean; wire: boolean;
  /** Land contour step, metres. */ step: number;
  /** Sea-floor contour step, metres. */ seaStep: number;
  /** Height below which the ground counts as sea, metres (polders sit around -1 to -2 m). */ seaLevel: number;
  glow: number;
  /** Blur radius on the heights the lines follow, grid cells (~85 m each); hides DEM noise on the flat polders. */ smooth: number;
  /** Land contours start at this height, metres. */ floor: number;
  /** Dot spacing, km. */ dot: number;
  hue: keyof typeof HUES;
};
export const HOLO_DEFAULTS: HoloOpts = {
  coast: true, contours: true, depth: true, grid: true, dots: false, sweep: true, wire: false,
  step: 2, seaStep: 5, seaLevel: -2.5, glow: 1, smooth: 2, floor: 1, dot: 0.25, hue: 'cyan',
};
