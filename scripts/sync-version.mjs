import { readFile, writeFile } from "node:fs/promises";

const packageJson = await readJson("package.json");
const manifestJson = await readJson("manifest.json");
const versionsJson = await readJson("versions.json");

if (!isVersion(packageJson.version)) {
  throw new Error(`package.json has an invalid version: ${String(packageJson.version)}`);
}
if (!isVersion(manifestJson.minAppVersion)) {
  throw new Error(`manifest.json has an invalid minAppVersion: ${String(manifestJson.minAppVersion)}`);
}

manifestJson.version = packageJson.version;
versionsJson[packageJson.version] = manifestJson.minAppVersion;

const sortedVersions = Object.fromEntries(
  Object.entries(versionsJson).sort(([left], [right]) => compareVersions(left, right)),
);

await Promise.all([
  writeJson("manifest.json", manifestJson),
  writeJson("versions.json", sortedVersions),
]);

function isVersion(value) {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

function compareVersions(left, right) {
  const [leftCore, leftPrerelease] = left.split("-", 2);
  const [rightCore, rightPrerelease] = right.split("-", 2);
  const leftParts = leftCore.split(".").map(Number);
  const rightParts = rightCore.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const comparison = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (comparison !== 0) return comparison;
  }
  if (leftPrerelease === undefined && rightPrerelease !== undefined) return 1;
  if (leftPrerelease !== undefined && rightPrerelease === undefined) return -1;
  return (leftPrerelease ?? "").localeCompare(rightPrerelease ?? "");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
