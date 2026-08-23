import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);

const __dirname = path.dirname(__filename);

const templateRoot = path.resolve(__dirname, "../../templates/project");

const templateNameMap = {
  _env: ".env",
  _gitignore: ".gitignore",
};

export async function init(projectName) {
  const currentDirectory = process.cwd();

  const targetRoot = projectName
    ? path.resolve(currentDirectory, projectName)
    : currentDirectory;

  const projectDirectoryName = path.basename(targetRoot);

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

  // Create the project directory when a name was supplied.
  if (projectName) {
    await fs.mkdir(targetRoot, {
      recursive: true,
    });
  }

  for (const file of files) {
    const relativePath = path.relative(templateRoot, file);

    const templatePath = relativePath
      .split(path.sep)
      .map((part) => templateNameMap[part] ?? part)
      .join(path.sep);

    const targetPath = path.join(
      targetRoot,
      templatePath.replaceAll("__PROJECT_NAME__", projectDirectoryName),
    );

    await fs.mkdir(path.dirname(targetPath), {
      recursive: true,
    });

    const raw = await fs.readFile(file);

    const content = raw.includes(Buffer.from("{{PROJECT_NAME}}"))
      ? raw
          .toString("utf8")
          .replaceAll("{{PROJECT_NAME}}", projectDirectoryName)
      : raw;

    await fs.writeFile(targetPath, content);

    console.log(`✔ ${path.relative(targetRoot, targetPath)}`);
  }

  console.log("");

  console.log("GodProtocol project initialized.");

  console.log("");

  console.log("Next steps:");

  console.log("");

  if (projectName) {
    console.log("  1. Enter the project:");

    console.log(`     cd ${projectName}`);

    console.log("");
  }

  console.log(`${projectName ? "  2" : "  1"}. Install dependencies:`);

  console.log("     npm install");

  console.log("     npm install godprotocol");

  console.log("");

  console.log(`${projectName ? "  3" : "  2"}. Configure your environment:`);

  console.log("     .env");

  console.log("");

  console.log(`${projectName ? "  4" : "  3"}. Start the application:`);

  console.log("     node index.js");

  console.log("");
}

async function collectFiles(directory) {
  const entries = await fs.readdir(directory, {
    withFileTypes: true,
  });

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

function render(content, variables) {
  return content.replaceAll("{{PROJECT_NAME}}", variables.projectName);
}
