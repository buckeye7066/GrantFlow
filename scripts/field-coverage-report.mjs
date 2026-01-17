import fs from "node:fs";

function extractKeysFromComprehensiveApplicationForm(source) {
  const start = source.indexOf("const [formData");
  if (start < 0) return [];
  const brace = source.indexOf("{", start);
  if (brace < 0) return [];
  const end = source.indexOf("});", brace);
  if (end < 0) return [];
  const obj = source.slice(brace + 1, end);
  return [...obj.matchAll(/^\s*([a-zA-Z0-9_]+)\s*:\s*/gm)].map((m) => m[1]);
}

function extractProfileEditorFieldNames(source) {
  const idx = source.indexOf("export const SECTION_CONFIG");
  if (idx < 0) return [];
  const slice = source.slice(idx);
  return [...slice.matchAll(/\{\s*name:\s*"([^"]+)"/g)].map((m) => m[1]);
}

function uniq(values) {
  return [...new Set(values)];
}

function main() {
  const appPath = "./src/components/organizations/ComprehensiveApplicationForm.jsx";
  const profileEditorPath = "./src/components/profiles/ProfileSectionEditor.jsx";

  const appSrc = fs.readFileSync(appPath, "utf8");
  const profileEditorSrc = fs.readFileSync(profileEditorPath, "utf8");

  const appKeys = uniq(extractKeysFromComprehensiveApplicationForm(appSrc));
  const profileKeys = uniq(extractProfileEditorFieldNames(profileEditorSrc));

  const missingInProfile = appKeys.filter((k) => !profileKeys.includes(k));
  const extraInProfile = profileKeys.filter((k) => !appKeys.includes(k));

  console.log("Comprehensive application keys:", appKeys.length);
  console.log("Profile editor keys:", profileKeys.length);
  console.log("");
  console.log("Missing in profile editor:", missingInProfile.length);
  console.log(missingInProfile.sort().join("\n"));
  console.log("");
  console.log("Extra in profile editor (not in comprehensive form):", extraInProfile.length);
  console.log(extraInProfile.sort().join("\n"));
}

main();

