# SCORM 1.2 Schema Files

This directory is reserved for the ADL-published SCORM 1.2 schema files that the
`imsmanifest.xml` references:

- `adlcp_rootv1p2.xsd`
- `imscp_rootv1p1p2.xsd`
- `imsmd_rootv1p2p1.xsd`
- `ims_xml.xsd`

The files are **public-domain** reference schemas from the Advanced Distributed
Learning initiative (ADL). Most LMSs (Moodle, Canvas, SCORM Cloud, TalentLMS, Docebo,
Cornerstone) accept SCORM 1.2 packages without these XSDs present — they parse
the manifest directly. For stricter LMSs or SCORM-compliance certification, drop
the files into this directory; they will be bundled automatically on next build
(`pnpm build` runs `cpSync` over this whole dir into `dist/`).

Source: https://www.adlnet.gov/adl-assets/uploads/2014/02/SCORM_1.2_Content_Aggregation_Model.zip
