# godprotocol-cli

CLI for scaffolding GodProtocol Node.js framework projects.

## Usage

```bash
mkdir my-api
cd my-api
npx godprotocol-cli init
```

This copies the GodProtocol project skeleton into the current directory:

```text
my-api/
├── handlers/
│   └── v1/
├── routes/
│   ├── index.js
│   └── router-v1.js
├── services/
│   └── index.js
├── services.config.js
├── index.js
└── my-api.js
```

Then install the peer dependency and run it:

```bash
npm install express
node index.js
```

## Development

Run the CLI locally without publishing:

```bash
node bin/godprotocol-cli.js init
```

Run tests:

```bash
npm test
```

## Design

`godprotocol-cli` stays thin. It doesn't encode the framework's architecture
itself — it just renders the skeleton in `templates/project/` into the
current working directory, substituting `{{PROJECT_NAME}}` for the target
directory's name.

```text
godprotocol-cli
        │
        │ init
        ▼
 templates/project/
        │
        ▼
 user's GodProtocol application
```

As the framework grows, the generated project can depend on a versioned
GodProtocol runtime package, while this CLI stays responsible only for
initialization.
