import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const wrangler = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const exportedD1 = join(root, "data", "exports", "d1");
const migrationsDirectory = join(root, "worker", "migrations");

const files = readdirSync(exportedD1)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => join(exportedD1, name));
const migrations = readdirSync(migrationsDirectory)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => join(migrationsDirectory, name));

for (const file of [...files, ...migrations]) {
  console.log(`Import D1 local : ${file.slice(root.length + 1)}`);
  const result = spawnSync(
    process.execPath,
    [wrangler, "d1", "execute", "monjuris-local", "--local", `--file=${file}`],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr || `Échec de l'import ${file}.\n`);
    process.exit(result.status ?? 1);
  }
}

console.log("Base D1 locale prête.");
