export type TerrainParts = { dem?: string; imagery?: string; 'patch-imagery'?: string; water?: string };
export type TerrainUrls = { elevationUrl?: string; imageryUrl?: string; patchImageryUrl?: string; waterUrl?: string };
export function listFiles(dir: string): string[];
export function hashFiles(dir: string, files?: string[]): string;
export function detectParts(files: string[]): TerrainParts;
export function terrainUrls(hash: string, parts: TerrainParts): TerrainUrls;
export function mergeDeployment<T extends { terrain?: object }>(deployment: T, urls: TerrainUrls): T & { terrain: object };
