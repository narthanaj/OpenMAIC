import type { Classroom } from '../../validation/classroom.js';

// Generates imsmanifest.xml for SCORM 1.2 Content Aggregation Model (CAM).
//
// Minimum viable manifest per ADL SCORM 1.2 spec requires:
//   - Root <manifest> with identifier, version, xmlns, and schemaLocation declarations.
//   - <metadata> with <schema>ADL SCORM</schema> + <schemaversion>1.2</schemaversion>.
//   - <organizations default="..."> with one <organization> containing <item> elements
//     (one per scene in our case — the LMS uses these for the sidebar table-of-contents).
//   - <resources> with one <resource> per launchable HTML, listing all dependent files.
//
// We keep things as small as possible while still being accepted by the major LMS
// platforms (Moodle, Canvas, SCORM Cloud, TalentLMS, Docebo, Cornerstone).

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface ManifestInputs {
  classroom: Classroom;
  entryHref: string;        // typically "index.html"
  sceneHrefs: string[];     // in scene-order, same length as classroom.scenes
  runtimeHref: string;      // typically "runtime.js"
  // Language for <lom> metadata; defaults to classroom.stage.language ?? 'en'.
  language: string;
}

export function buildManifest(inputs: ManifestInputs): string {
  const { classroom, entryHref, sceneHrefs, runtimeHref, language } = inputs;

  if (sceneHrefs.length !== classroom.scenes.length) {
    throw new Error(
      `manifest inputs mismatch: ${classroom.scenes.length} scenes but ${sceneHrefs.length} hrefs`,
    );
  }

  const manifestId = `OpenMAIC-${classroom.id}`;
  const orgId = `ORG-${classroom.id}`;
  const entryResourceId = `RES-ENTRY-${classroom.id}`;

  // Items are the table-of-contents tree the LMS renders. For v1 we keep it flat
  // (no nesting) — every scene is a top-level item under the single organization.
  const items = classroom.scenes
    .map((scene, i) => {
      const title = xmlEscape(scene.title ?? `Slide ${i + 1}`);
      // All items point at the same resource (entry), but with parameters the runtime
      // could use later. For v1 simplicity, every item launches the same entry and
      // navigation is handled by prev/next links within the scene HTMLs.
      return `      <item identifier="ITEM-${xmlEscape(scene.id)}" identifierref="${entryResourceId}">
        <title>${title}</title>
      </item>`;
    })
    .join('\n');

  // The entry resource lists EVERY file in the package as a dependency — the LMS
  // unpacks the whole ZIP before launching, so missing file references here mostly
  // affect how the LMS computes "package integrity." Being thorough helps.
  const fileEntries = [entryHref, runtimeHref, ...sceneHrefs]
    .map((href) => `      <file href="${xmlEscape(href)}"/>`)
    .join('\n');

  // The schemaLocation is a space-separated pair of (namespace, schemaFile) tuples
  // for each declared xmlns. LMSs use these to validate; we ship stub schema files
  // under the `schema/` directory of the ZIP (optional per SCORM 1.2 — most LMSs
  // tolerate their absence, but including them is canonical).

  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="${manifestId}" version="1.2"
          xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
          xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
          xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
          xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd
                              http://www.imsglobal.org/xsd/imsmd_rootv1p2p1 imsmd_rootv1p2p1.xsd
                              http://www.adlnet.org/xsd/adlcp_rootv1p2 adlcp_rootv1p2.xsd">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>
  <organizations default="${orgId}">
    <organization identifier="${orgId}">
      <title>${xmlEscape(classroom.stage.name)}</title>
${items}
    </organization>
  </organizations>
  <resources>
    <resource identifier="${entryResourceId}" type="webcontent"
              adlcp:scormtype="sco" href="${xmlEscape(entryHref)}">
${fileEntries}
    </resource>
  </resources>
</manifest>
`;
}

// Exported for tests so we can assert the manifest's well-formedness independently.
export function manifestFilename(): string {
  return 'imsmanifest.xml';
}
