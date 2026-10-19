export type Box = [number, number, number, number];
export type Ring = [number, number][];
export type ShpRecord = { offset: number; length: number };
export type PolygonFeature = {
  type: 'Feature'; properties: Record<string, unknown>; geometry: { type: 'Polygon'; coordinates: Ring[] };
};
export function readShx(shxPath: string): ShpRecord[];
export function boxesIntersect(a: Box, b: Box): boolean;
export function quantise(v: number): number;
export function cleanRing(points: Ring): Ring | null;
export function parsePolygon(content: Buffer): { type: number; bbox: Box | null; rings: Ring[] };
export function filterShp(shpPath: string, box: Box): { features: PolygonFeature[]; points: number; records: number };
export function waterCollection(box: Box, features: unknown[]): Record<string, unknown>;
