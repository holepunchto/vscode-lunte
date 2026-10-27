const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { mkdtemp, mkdir, readFile, realpath, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests
} = require('@vscode/test-electron')

const root = resolve(__dirname, '..')

async function main() {
  // macOS's default TMPDIR can exceed the Unix socket path limit used by VS Code.
  const temporary = await realpath(
    await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'vscode-lunte-test-'))
  )
  let serverPid
  try {
    const consumer = join(temporary, 'consumer')
    const workspace = consumer
    const driver = join(temporary, 'driver')
    const extensions = join(temporary, 'extensions')
    const userData = join(temporary, 'user-data')
    for (const dir of [consumer, driver, extensions, userData]) {
      await mkdir(dir)
    }
    const manifest = {
      private: true,
      dependencies: {
        'lunte-lsp': process.env.LUNTE_LSP_TARBALL
          ? `file:${resolve(process.env.LUNTE_LSP_TARBALL)}`
          : 'latest'
      }
    }
    if (process.env.LUNTE_TARBALL) {
      manifest.overrides = { lunte: `file:${resolve(process.env.LUNTE_TARBALL)}` }
    }
    await writeFile(join(consumer, 'package.json'), JSON.stringify(manifest))
    execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: consumer,
      stdio: 'inherit'
    })

    // Install the VSIX, rather than loading the extension's source checkout.
    const vsix = join(temporary, 'lunte.vsix')
    execFileSync(join(root, 'node_modules/.bin/vsce'), ['package', '--out', vsix], {
      cwd: root,
      stdio: 'inherit'
    })
    const executable =
      process.env.VSCODE_EXECUTABLE_PATH ||
      (await downloadAndUnzipVSCode({
        version: process.env.VSCODE_VERSION || 'stable',
        cachePath: join(temporary, 'vscode')
      }))
    const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(executable, {
      reuseMachineInstall: true
    })
    const isolation = ['--extensions-dir', extensions, '--user-data-dir', userData]
    execFileSync(cli, [...cliArgs, ...isolation, '--install-extension', vsix, '--force'], {
      stdio: 'inherit'
    })

    // A separate empty driver runs tests against the installed extension.
    await writeFile(
      join(driver, 'package.json'),
      JSON.stringify({
        name: 'lunte-test-driver',
        publisher: 'lunte-tests',
        version: '0.0.0',
        engines: { vscode: '^1.90.0' },
        main: './extension.js'
      })
    )
    await writeFile(join(driver, 'extension.js'), 'exports.activate = () => {}\n')

    // Record server exit without altering its stdio or protocol.
    const lifecycle = join(temporary, 'server-lifecycle.jsonl')
    const probe = join(temporary, 'probe.cjs')
    await writeFile(
      probe,
      `
      const fs = require('node:fs')
      const file = ${JSON.stringify(lifecycle)}
      fs.appendFileSync(file, JSON.stringify({ event: 'start', pid: process.pid }) + '\\n')
      process.on('exit', code => {
        fs.appendFileSync(file, JSON.stringify({ event: 'exit', pid: process.pid, code }) + '\\n')
      })
    `
    )
    await mkdir(join(workspace, '.vscode'))
    await writeFile(
      join(workspace, '.vscode/settings.json'),
      JSON.stringify({
        'lunte.lsp.command': process.env.LUNTE_TEST_NPX ? 'npx' : process.execPath,
        'lunte.lsp.args': process.env.LUNTE_TEST_NPX
          ? ['--no-install', `--node-options=--require=${probe}`, 'lunte-lsp']
          : ['--require', probe, join(consumer, 'node_modules/lunte-lsp/bin/lunte-lsp')],
        'telemetry.telemetryLevel': 'off',
        'files.autoSave': 'off',
        'extensions.autoUpdate': false,
        'update.mode': 'none'
      })
    )
    await writeFile(join(workspace, 'file.js'), 'missingGlobal\n')
    await writeFile(join(workspace, 'ignored.js'), 'ignoredGlobal\n')
    await writeFile(join(workspace, '.lunteignore'), 'ignored.js\n')
    await writeFile(join(workspace, '.lunterc.json'), '{}\n')

    console.log(
      `Testing installed VSIX with ${process.env.LUNTE_TEST_NPX ? 'npx' : 'Node'} server launch`
    )
    const exitCode = await runTests({
      vscodeExecutablePath: executable,
      reuseMachineInstall: true,
      extensionDevelopmentPath: driver,
      extensionTestsPath: join(__dirname, 'suite/index.js'),
      extensionTestsEnv: {
        LUNTE_TEST_WORKSPACE: workspace,
        LUNTE_TEST_EXTENSIONS: extensions,
        // npx must resolve the local tarball, never fetch a published substitute.
        npm_config_offline: 'true',
        npm_config_yes: 'false'
      },
      launchArgs: [
        workspace,
        ...isolation,
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-workspace-trust',
        '--disable-updates',
        '--disable-telemetry',
        '--new-window'
      ]
    })
    assert.equal(exitCode, 0)
    const events = (await readFile(lifecycle, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const starts = events.filter((event) => event.event === 'start')
    assert.equal(starts.length, 1, 'one language server should have been launched')
    serverPid = starts[0].pid
    assert.ok(
      events.some((event) => event.event === 'exit' && event.pid === serverPid && event.code === 0),
      'the server must shut down successfully with VS Code'
    )
    assert.throws(() => process.kill(serverPid, 0), { code: 'ESRCH' }, 'no orphan server')
    console.log('ok - installed VSIX lifecycle and graceful server shutdown')
  } finally {
    // Do not leave an orphan process behind if an assertion fails.
    try {
      const events = (await readFile(join(temporary, 'server-lifecycle.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      const exited = new Set(
        events.filter((event) => event.event === 'exit').map((event) => event.pid)
      )
      for (const event of events) {
        if (event.event !== 'start' || exited.has(event.pid)) continue
        try {
          process.kill(event.pid, 'SIGTERM')
          for (let attempt = 0; attempt < 20; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 50))
            process.kill(event.pid, 0)
          }
          process.kill(event.pid, 'SIGKILL')
        } catch (error) {
          if (error.code !== 'ESRCH') throw error
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await rm(temporary, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
