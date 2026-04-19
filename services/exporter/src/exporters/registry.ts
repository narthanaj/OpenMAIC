import type { ContentExporter } from './types.js';
import { scormV1_2Exporter } from './scorm1_2/index.js';
import { htmlExporter } from './html/index.js';

// Static map of available export formats. Adding a new format = add a line here
// and implement ContentExporter in a sibling folder. No other code changes needed;
// routes and metrics labels discover new entries at startup.

const byId: Record<string, ContentExporter> = {
  [scormV1_2Exporter.id]: scormV1_2Exporter,
  [htmlExporter.id]: htmlExporter,
};

export function getExporter(id: string): ContentExporter | null {
  return byId[id] ?? null;
}

export function listExporters(): ContentExporter[] {
  return Object.values(byId);
}

export function knownFormats(): string[] {
  return Object.keys(byId);
}
