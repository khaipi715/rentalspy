import * as maplibregl from 'maplibre-gl';
// MapLibre runs its tile work in a separate worker file. It's copied to /public/maplibre/ by
// scripts/copy-maplibre-worker.mjs (runs automatically before dev and build).
maplibregl.setWorkerUrl('/maplibre/maplibre-gl-worker.mjs');
export default maplibregl;
