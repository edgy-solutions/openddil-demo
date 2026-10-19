// Scene scale shared by the regional map and the terrain drawn under it.
/** ~80 scene units per degree of latitude puts a regional bbox (~3 deg) at ~240 units. */
export const SCENE_SCALE_UNITS_PER_DEG = 80;
/** Scene units per kilometre (a degree of latitude is ~111 km). */
export const UNITS_PER_KM = SCENE_SCALE_UNITS_PER_DEG / 111;
/** Scene units per metre. */
export const M = UNITS_PER_KM / 1000;
