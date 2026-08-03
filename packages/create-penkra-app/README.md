# create-penkra-app

Scaffold an isolated Penkra App with a valid manifest, visual entrypoint, optional operation
controller, Theme adaptation, App Bar, instructions, tests, and packaging setup.

```sh
npm create penkra-app@latest my-app
cd my-app
npm install
npm test
npm run build
penkra app test ./dist
```

The generated App uses browser-standard JavaScript. React is not required. Change the reverse-domain
App ID and globally unique slug before publishing. Keep `README.md` for people and
`INSTRUCTIONS.md` for agent-facing operational constraints; operation flags and schemas are
generated from `penkra-app.json`.
