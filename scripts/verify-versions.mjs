import { access, readFile } from "node:fs/promises";

const [packageJson, packageLockJson, manifestJson, versionsJson] = await Promise.all([
  readJson("package.json"),
  readJson("package-lock.json"),
  readJson("manifest.json"),
  readJson("versions.json"),
]);

const failures = [];
const packageVersion = packageJson.version;
const manifestVersion = manifestJson.version;
const minimumAppVersion = manifestJson.minAppVersion;
const lockRootVersion = packageLockJson.packages?.[""]?.version;
const obsidianDependency = packageJson.devDependencies?.obsidian;
const releaseTag = process.env.RELEASE_TAG;

if (!isVersion(packageVersion)) {
  failures.push(`package.json has an invalid version: ${String(packageVersion)}.`);
}
if (!isVersion(manifestVersion)) {
  failures.push(`manifest.json has an invalid version: ${String(manifestVersion)}.`);
}
if (!isVersion(minimumAppVersion)) {
  failures.push(`manifest.json has an invalid minAppVersion: ${String(minimumAppVersion)}.`);
}
if (packageVersion !== manifestVersion) {
  failures.push(`package.json version ${String(packageVersion)} does not match manifest.json version ${String(manifestVersion)}.`);
}
if (packageLockJson.version !== packageVersion || lockRootVersion !== packageVersion) {
  failures.push(`package-lock.json root versions must match package.json version ${String(packageVersion)}.`);
}
if (versionsJson[manifestVersion] !== minimumAppVersion) {
  failures.push(
    `versions.json must map ${String(manifestVersion)} to manifest minAppVersion ${String(minimumAppVersion)}.`,
  );
}
if (typeof obsidianDependency !== "string" || dependencyBaseVersion(obsidianDependency) !== minimumAppVersion) {
  failures.push(
    `The obsidian devDependency (${String(obsidianDependency)}) must use minAppVersion ${String(minimumAppVersion)} as its lower bound.`,
  );
}
if (releaseTag !== undefined && releaseTag !== manifestVersion) {
  failures.push(`Release tag ${releaseTag} must exactly match manifest.json version ${String(manifestVersion)}.`);
}

for (const [pluginVersion, appVersion] of Object.entries(versionsJson)) {
  if (!isVersion(pluginVersion) || !isVersion(appVersion)) {
    failures.push(`versions.json contains an invalid mapping: ${pluginVersion} -> ${String(appVersion)}.`);
  }
}

for (const asset of ["main.js", "manifest.json", "styles.css"]) {
  try {
    await access(asset);
  } catch {
    failures.push(`Required release asset is missing: ${asset}.`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(failure);
  }
  process.exitCode = 1;
}

function isVersion(value) {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

function dependencyBaseVersion(range) {
  return /^\D*(\d+\.\d+\.\d+)/.exec(range)?.[1];
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
