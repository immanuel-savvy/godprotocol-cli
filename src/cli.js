import { init } from "./commands/init.js";
import { docs } from "./commands/docs.js";

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case "init":
    await init(args[1]);
    break;

  case "docs":
    await docs(args.slice(1)); // pass remaining args to docs
    break;

  case undefined:
  case "-h":
  case "--help":
    printHelp();
    break;

  case "-v":
  case "--version":
    await printVersion();
    break;

  default:
    console.error(`Unknown command: ${command}`);

    console.error("");

    printHelp();

    process.exit(1);
}

function printHelp() {
  console.log(`

GodProtocol CLI

Usage:

  godprotocol-cli <command> [project-name]

Commands:

  init [project-name]    Initialize a GodProtocol project

Options:

  -h, --help             Show this help message

  -v, --version          Show the CLI version

`);
}

async function printVersion() {
  const { readFile } = await import("node:fs/promises");

  const { fileURLToPath } = await import("node:url");

  const path = await import("node:path");

  const __filename = fileURLToPath(import.meta.url);

  const __dirname = path.dirname(__filename);

  const pkgPath = path.resolve(__dirname, "../package.json");

  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));

  console.log(pkg.version);
}
