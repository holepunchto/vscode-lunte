const assert = require('node:assert/strict')
const { join, sep } = require('node:path')
const vscode = require('vscode')

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(description, predicate) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await pause(100)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

function diagnostics(uri) {
  return vscode.languages.getDiagnostics(uri).filter((diagnostic) => diagnostic.source === 'lunte')
}

async function replace(document, text) {
  const edit = new vscode.WorkspaceEdit()
  edit.replace(
    document.uri,
    new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
    text
  )
  assert.equal(await vscode.workspace.applyEdit(edit), true)
}

async function run() {
  const workspace = process.env.LUNTE_TEST_WORKSPACE
  const uri = vscode.Uri.file(join(workspace, 'file.js'))
  const extension = vscode.extensions.getExtension('holepunch.vscode-lunte')
  assert.ok(extension, 'the VSIX must be installed')
  assert.ok(
    extension.extensionPath.startsWith(process.env.LUNTE_TEST_EXTENSIONS + sep),
    'must run the packaged extension, not its source checkout'
  )

  const document = await vscode.workspace.openTextDocument(uri)
  await vscode.window.showTextDocument(document)
  await extension.activate()
  assert.equal(extension.isActive, true)
  await waitFor('initial no-undef diagnostic', () =>
    diagnostics(uri).some((d) => d.code === 'no-undef')
  )
  console.log('ok - installed VSIX activation and initial diagnostics')

  await replace(document, 'console.log(1)\n')
  assert.equal(document.isDirty, true, 'test must exercise unsaved edits')
  await waitFor('diagnostics to clear after an unsaved fix', () => diagnostics(uri).length === 0)
  console.log('ok - unsaved edits clear diagnostics')

  await replace(document, 'missingGlobal\n')
  await waitFor('diagnostic after an unsaved regression', () =>
    diagnostics(uri).some((d) => d.code === 'no-undef')
  )
  console.log('ok - unsaved edits introduce diagnostics')

  const config = vscode.Uri.file(join(workspace, '.lunterc.json'))
  await vscode.workspace.fs.writeFile(
    config,
    Buffer.from(JSON.stringify({ rules: { 'no-undef': 'off' } }))
  )
  await waitFor('configuration reload to disable the rule', () => diagnostics(uri).length === 0)
  await vscode.workspace.fs.writeFile(config, Buffer.from('{}\n'))
  await waitFor('configuration reload to restore the rule', () =>
    diagnostics(uri).some((d) => d.code === 'no-undef')
  )
  console.log('ok - configuration file watcher revalidates open documents')

  const ignoredUri = vscode.Uri.file(join(workspace, 'ignored.js'))
  const ignored = await vscode.workspace.openTextDocument(ignoredUri)
  await vscode.window.showTextDocument(ignored)
  await replace(ignored, 'anotherIgnoredGlobal\n')
  // Wait for a subsequent response on a watched document before checking the ignored one.
  await replace(document, 'missingGlobalAgain\n')
  await waitFor('server to process subsequent changes', () =>
    diagnostics(uri).some((d) => d.message.includes('missingGlobalAgain'))
  )
  assert.equal(diagnostics(ignoredUri).length, 0)
  console.log('ok - ignored documents have no Lunte diagnostics')

  const ignore = vscode.Uri.file(join(workspace, '.lunteignore'))
  await vscode.workspace.fs.writeFile(ignore, Buffer.from(''))
  await waitFor('removed ignore pattern to reveal diagnostics', () =>
    diagnostics(ignoredUri).some((d) => d.code === 'no-undef')
  )
  await vscode.workspace.fs.writeFile(ignore, Buffer.from('ignored.js\n'))
  await waitFor(
    'restored ignore pattern to clear diagnostics',
    () => diagnostics(ignoredUri).length === 0
  )
  console.log('ok - ignore file watcher revalidates open documents')

  await vscode.window.showTextDocument(document)
  // Closing a tab need not close its cached TextDocument. Changing language
  // deterministically sends didClose when the document leaves our selector.
  await vscode.languages.setTextDocumentLanguage(document, 'plaintext')
  await waitFor(
    'diagnostics to clear when the LSP document closes',
    () => diagnostics(uri).length === 0
  )
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor')
  await vscode.window.showTextDocument(ignored)
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor')
  console.log('ok - leaving the JavaScript selector closes the LSP document and clears diagnostics')
}

module.exports = { run }
