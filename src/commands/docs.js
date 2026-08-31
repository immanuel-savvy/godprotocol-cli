import { generateDocs } from "./docs/generate.js";

export async function docs(args) {
  const subcommand = args[0];

  switch (subcommand) {
    case "generate":
      await generateDocs(process.cwd());
      break;

    case undefined:
      printDocsHelp();
      break;

    default:
      console.error(`Unknown docs command: ${subcommand}`);
      console.error("");
      printDocsHelp();
      process.exitCode = 1;
  }
}

function printDocsHelp() {
  console.log(`
Usage:

  godprotocol-cli docs <command>

Commands:

  generate    Scan the project and create/update Docusaurus documentation
`);
}
