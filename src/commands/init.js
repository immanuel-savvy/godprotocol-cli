import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const templateRoot = path.resolve(__dirname, "../../templates/project");

export async function init() {
  const targetRoot = process.cwd();

  console.log("");
  console.log("GodProtocol");
  console.log("───────────");
  console.log("");

  const files = await collectFiles(templateRoot);

  if (files.length === 0) {
    console.error("No template files found. Is the CLI installed correctly?");
    process.exitCode = 1;
    return;
  }

  const projectName = path.basename(targetRoot);

  for (const file of files) {
    const relativePath = path.relative(templateRoot, file);

    const targetPath = path.join(
      targetRoot,
      relativePath.replaceAll("__PROJECT_NAME__", projectName)
    );

    await fs.mkdir(path.dirname(targetPath), { recursive: true });

    const isBinary = await looksBinary(file);

    if (isBinary) {
      await fs.copyFile(file, targetPath);
    } else {
      const raw = await fs.readFile(file, "utf8");
      const content = render(raw, { projectName });
      await fs.writeFile(targetPath, content);
    }

    console.log(`✔ ${path.relative(targetRoot, targetPath)}`);
  }

  console.log("");
  console.log("GodProtocol project initialized.");
  console.log("");
  console.log("Next steps:");
  console.log("  npm install express");
  console.log("  node index.js");
  console.log("");
}

async function collectFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });

  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath)));
      continue;
    }

    files.push(fullPath);
  }

  return files;
}

async function looksBinary(file) {
  // .gitkeep and similar text placeholders should always be treated as text.
  const textExtensions = new Set([".js", ".json", ".md", ".gitkeep", ""]);
  const ext = path.extname(file);
  return !textExtensions.has(ext) && !file.endsWith(".gitkeep");
}

function render(content, variables) {
  return content.replaceAll("{{PROJECT_NAME}}", variables.projectName);
}
