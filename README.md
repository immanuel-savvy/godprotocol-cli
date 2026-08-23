# GodProtocol CLI

Scaffold a new GodProtocol Node.js application in seconds.

## Installation

No global installation is required.

```bash
npx godprotocol-cli init <project-name>
```

Example:

```bash
npx godprotocol-cli init social_handler
```

This creates:

```text
social_handler/
├── .env
├── .gitignore
├── handlers/
│   └── v1/
├── libs/
│   └── boot.js
├── routes/
│   ├── index.js
│   └── router-v1.js
├── services/
│   └── index.js
├── services.config.js
├── index.js
├── social_handler.js
└── package.json
```

You can also initialize the current directory:

```bash
mkdir social_handler
cd social_handler

npx godprotocol-cli init
```

## Getting Started

After initialization:

```bash
cd social_handler
npm install
```

Populate your environment variables:

```env
PORT=

API_KEY=

REPOSITORY_URI=

REPOSITORY_NAME=

# v1

PLATFORM_URI=

PLATFORM_NAME=

DEV=true
```

Then start the application:

```bash
node index.js
```

## Commands

### Initialize a Project

```bash
godprotocol-cli init [project-name]
```

Examples:

```bash
godprotocol-cli init
```

Initializes the current directory.

```bash
godprotocol-cli init social_handler
```

Creates a new `social_handler` directory and scaffolds a GodProtocol project inside it.

### Show Help

```bash
godprotocol-cli --help
```

or

```bash
godprotocol-cli -h
```

### Show Version

```bash
godprotocol-cli --version
```

or

```bash
godprotocol-cli -v
```

## Development

Run the CLI locally:

```bash
node bin/godprotocol-cli.js init demo
```

Preview the package contents before publishing:

```bash
npm pack --dry-run
```

Publish to npm:

```bash
npm publish
```

## Architecture

`godprotocol-cli` is intentionally lightweight.

The CLI is responsible only for generating a project skeleton from the template directory.

```text
godprotocol-cli
        │
        │ init
        ▼
templates/project/
        │
        ▼
Generated GodProtocol Application
```

The framework runtime and the CLI evolve independently:

- **godprotocol-cli** → project generation
- **godprotocol** → framework runtime
- **application** → user business logic

This separation keeps project creation simple while allowing the GodProtocol framework itself to evolve without requiring frequent CLI changes.

## License

MIT
