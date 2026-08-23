import { access, cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const root = path.resolve(import.meta.dirname, "..");
const execFileAsync = promisify(execFile);
const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const version = manifest.version;
const distDir = path.join(root, "dist");
const stagingDir = path.join(distDir, `adlock-${version}`);
const archivePath = path.join(distDir, `adlock-${version}.zip`);
const checkOnly = process.argv.includes("--check");

if (packageJson.version !== version) {
  throw new Error(`manifest.json version ${version} does not match package.json version ${packageJson.version}`);
}

const files = new Set(["manifest.json", "LICENSE", "PRIVACY.md"]);
const add = (relativePath) => {
  if (relativePath) files.add(relativePath.replaceAll("\\", "/"));
};

add(manifest.background?.service_worker);
add(manifest.action?.default_popup);
add(manifest.options_page);
for (const file of Object.values(manifest.icons || {})) add(file);
for (const file of Object.values(manifest.action?.default_icon || {})) add(file);
for (const declaration of manifest.content_scripts || []) {
  for (const file of [...(declaration.js || []), ...(declaration.css || [])]) add(file);
}
for (const entry of manifest.web_accessible_resources || []) {
  for (const file of entry.resources || []) add(file);
}
for (const resource of manifest.declarative_net_request?.rule_resources || []) add(resource.path);

const sortedFiles = [...files].sort();
for (const relativePath of sortedFiles) {
  try {
    await access(path.join(root, relativePath));
  } catch {
    throw new Error(`Manifest release resource is missing: ${relativePath}`);
  }
}

if (checkOnly) {
  console.log(`Release package is ready: ${sortedFiles.length} files, version ${version}.`);
  process.exit(0);
}

await rm(stagingDir, { recursive: true, force: true });
await rm(archivePath, { force: true });
await mkdir(stagingDir, { recursive: true });

for (const relativePath of sortedFiles) {
  const destination = path.join(stagingDir, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(path.join(root, relativePath), destination);
}

const zipWithTar = async () => {
  await execFileAsync("tar", ["-a", "-c", "-f", archivePath, "-C", stagingDir, ...sortedFiles]);
};

const zipWithPowerShell = async () => {
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const command = `Compress-Archive -Path (Join-Path -Path ${quote(stagingDir)} -ChildPath '*') -DestinationPath ${quote(archivePath)} -CompressionLevel Optimal`;
  const args = ["-NoProfile", "-NonInteractive", "-Command", command];
  const windowsRoot = process.env.SystemRoot || "C:\\Windows";
  const candidates = [
    path.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    "powershell.exe",
    "pwsh"
  ];
  for (const executable of candidates) {
    try {
      await execFileAsync(executable, args, { windowsHide: true });
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw new Error("Unable to find PowerShell to create the release ZIP.");
};

const zipOnUnix = async () => {
  await execFileAsync("zip", ["-q", "-r", archivePath, "."], { cwd: stagingDir });
};

if (process.platform === "win32") {
  try {
    // Windows PowerShell writes backslash entry names. Edge's validator
    // resolves manifest paths using forward slashes, so prefer bsdtar.
    await zipWithTar();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await zipWithPowerShell();
  }
} else {
  await zipOnUnix();
}

const archiveStat = await stat(archivePath);
console.log(`Created ${path.relative(root, archivePath)} (${archiveStat.size} bytes) with ${sortedFiles.length} files.`);
