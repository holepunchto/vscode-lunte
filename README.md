# vscode-lunte

VS Code extension for Lunte.

## Development

```sh
cd vscode-lunte
npm install
code --extensionDevelopmentPath="${PWD}"
```

By default the extension runs `npx lunte-lsp`. Adjust `lunte.lsp.command` / `lunte.lsp.args` in VS Code settings to point at another binary.

## Testing

```sh
npm test        # installed-VSIX tests inside an isolated VS Code instance
npm run package # produce a VSIX for manual installation/review
```

The tests verify activation, diagnostics, unsaved changes, configuration watching,
ignore changes, LSP document close, and graceful server shutdown. They download stable VS Code
by default, or reuse `VSCODE_EXECUTABLE_PATH` when provided. `VSCODE_VERSION` selects
a specific download. Your normal VS Code settings/extensions are not used.

The server comes from npm unless `LUNTE_LSP_TARBALL` points to a local server tarball.
Set `LUNTE_TARBALL` as well to override its core dependency with a local tarball.
The watched-file tests require the new server handler, which is absent from
published `lunte-lsp@1.8.3`; until released, use a local tarball or the full
integration workflow. Set `LUNTE_TEST_NPX=1` to test local `npx` launching.
On headless Linux, run with `xvfb-run -a npm test`.

For the complete three-repository workflow and manual review checklist, see
[Testing](https://github.com/holepunchto/lunte/blob/main/docs/testing.md).

## Repository

https://github.com/holepunchto/vscode-lunte

## License

Apache-2.0
