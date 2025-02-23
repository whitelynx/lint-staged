import fs from 'fs-extra'
import path from 'path'
import tmp from 'tmp'

import execGitBase from '../src/execGit'
import runAll from '../src/runAll'

tmp.setGracefulCleanup()
jest.unmock('execa')

const testJsFilePretty = `module.exports = {
  foo: "bar"
};
`

const testJsFileUgly = `module.exports = {
    'foo': 'bar',
}
`

const testJsFileUnfixable = `const obj = {
    'foo': 'bar'
`

let wcDir
let cwd

// Get file content
const readFile = async (filename, dir = cwd) =>
  fs.readFile(path.join(dir, filename), { encoding: 'utf-8' })

// Append to file, creating if it doesn't exist
const appendFile = async (filename, content, dir = cwd) =>
  fs.appendFile(path.join(dir, filename), content)

// Wrap execGit to always pass `gitOps`
const execGit = async args => execGitBase(args, { cwd })

// Execute runAll before git commit to emulate lint-staged
const gitCommit = async options => {
  try {
    await runAll({ ...options, cwd, quiet: true })
    await execGit(['commit', '-m "test"'])
    return true
  } catch (error) {
    return false
  }
}

describe('runAll', () => {
  it('should throw when not in a git directory', async () => {
    const nonGitDir = tmp.dirSync({ unsafeCleanup: true })
    await expect(runAll({ cwd: nonGitDir })).rejects.toThrowErrorMatchingInlineSnapshot(
      `"Current directory is not a git directory!"`
    )
    nonGitDir.removeCallback()
  })
})

describe('runAll', () => {
  beforeEach(async () => {
    wcDir = tmp.dirSync({ unsafeCleanup: true })
    cwd = await fs.realpath(wcDir.name)

    // Init repository with initial commit
    await execGit('init')
    await execGit(['config', 'user.name', '"test"'])
    await execGit(['config', 'user.email', '"test@test.com"'])
    await appendFile('README.md', '# Test\n')
    await execGit(['add', 'README.md'])
    await execGit(['commit', '-m initial commit'])
  })

  it('Should commit entire staged file when no errors from linter', async () => {
    // Stage pretty file
    await appendFile('test.js', testJsFilePretty)
    await execGit(['add', 'test.js'])

    // Run lint-staged with `prettier --list-different` and commit pretty file
    const success = await gitCommit({ config: { '*.js': 'prettier --list-different' } })
    expect(success).toEqual(true)

    // Nothing is wrong, so a new commit is created
    expect(await execGit(['rev-list', '--count', 'HEAD'])).toEqual('2')
    expect(await execGit(['log', '-1', '--pretty=%B'])).toMatchInlineSnapshot(`
" \\"test\\"
"
`)
    expect(await readFile('test.js')).toEqual(testJsFilePretty)
  })

  it('Should succeed when conflicting tasks sequentially edit a file', async () => {
    await appendFile('test.js', testJsFileUgly)

    await fs.mkdir(cwd + '/files')
    await appendFile('file.js', testJsFileUgly, cwd + '/files')

    await execGit(['add', 'test.js'])
    await execGit(['add', 'files'])

    const success = await gitCommit({
      config: {
        'file.js': ['prettier --write', 'git add'],
        'test.js': files => {
          // concurrent: false, means this should still work
          fs.removeSync(`${cwd}/files`)
          return [`prettier --write ${files.join(' ')}`, `git add ${files.join(' ')}`]
        }
      },
      concurrent: false
    })

    expect(success).toEqual(true)
  })

  it('Should fail when conflicting tasks concurrently edit a file', async () => {
    await appendFile('test.js', testJsFileUgly)
    await appendFile('test2.js', testJsFileUgly)

    await fs.mkdir(cwd + '/files')
    await appendFile('file.js', testJsFileUgly, cwd + '/files')

    await execGit(['add', 'test.js'])
    await execGit(['add', 'test2.js'])
    await execGit(['add', 'files'])

    const success = await gitCommit({
      config: {
        'file.js': ['prettier --write', 'git add'],
        'test.js': ['prettier --write', 'git add'],
        'test2.js': files => {
          // remove `files` so the 1st command should fail
          fs.removeSync(`${cwd}/files`)
          return [`prettier --write ${files.join(' ')}`, `git add ${files.join(' ')}`]
        }
      },
      concurrent: true
    })

    expect(success).toEqual(false)
  })

  it('Should succeed when conflicting tasks concurrently (max concurrency 1) edit a file', async () => {
    await appendFile('test.js', testJsFileUgly)

    await fs.mkdir(cwd + '/files')
    await appendFile('file.js', testJsFileUgly, cwd + '/files')

    await execGit(['add', 'test.js'])
    await execGit(['add', 'files'])

    const success = await gitCommit({
      config: {
        'file.js': ['prettier --write', 'git add'],
        'test2.js': files => {
          // concurrency of one should prevent save this operation
          fs.removeSync(`${cwd}/files`)
          return [`prettier --write ${files.join(' ')}`, `git add ${files.join(' ')}`]
        }
      },
      concurrent: 1
    })

    expect(success).toEqual(true)
  })

  it('Should commit entire staged file when no errors and linter modifies file', async () => {
    // Stage ugly file
    await appendFile('test.js', testJsFileUgly)
    await execGit(['add', 'test.js'])

    // Run lint-staged with `prettier --write` and commit pretty file
    const success = await gitCommit({ config: { '*.js': ['prettier --write', 'git add'] } })
    expect(success).toEqual(true)

    // Nothing is wrong, so a new commit is created and file is pretty
    expect(await execGit(['rev-list', '--count', 'HEAD'])).toEqual('2')
    expect(await execGit(['log', '-1', '--pretty=%B'])).toMatchInlineSnapshot(`
" \\"test\\"
"
`)
    expect(await readFile('test.js')).toEqual(testJsFilePretty)
  })

  it('Should fail to commit entire staged file when errors from linter', async () => {
    // Stage ugly file
    await appendFile('test.js', testJsFileUgly)
    await execGit(['add', 'test.js'])
    const status = await execGit(['status'])

    // Run lint-staged with `prettier --list-different` to break the linter
    const success = await gitCommit({ config: { '*.js': 'prettier --list-different' } })
    expect(success).toEqual(false)

    // Something was wrong so the repo is returned to original state
    expect(await execGit(['rev-list', '--count', 'HEAD'])).toEqual('1')
    expect(await execGit(['log', '-1', '--pretty=%B'])).toMatchInlineSnapshot(`
" initial commit
"
`)
    expect(await execGit(['status'])).toEqual(status)
    expect(await readFile('test.js')).toEqual(testJsFileUgly)
  })

  it('Should fail to commit entire staged file when errors from linter and linter modifies files', async () => {
    // Add unfixable file to commit so `prettier --write` breaks
    await appendFile('test.js', testJsFileUnfixable)
    await execGit(['add', 'test.js'])
    const status = await execGit(['status'])

    // Run lint-staged with `prettier --write` to break the linter
    const success = await gitCommit({ config: { '*.js': ['prettier --write', 'git add'] } })
    expect(success).toEqual(false)

    // Something was wrong so the repo is returned to original state
    expect(await execGit(['rev-list', '--count', 'HEAD'])).toEqual('1')
    expect(await execGit(['log', '-1', '--pretty=%B'])).toMatchInlineSnapshot(`
" initial commit
"
`)
    expect(await execGit(['status'])).toEqual(status)
    expect(await readFile('test.js')).toEqual(testJsFileUnfixable)
  })

  it('Should commit partial change from partially staged file when no errors from linter', async () => {
    // Stage pretty file
    await appendFile('test.js', testJsFilePretty)
    await execGit(['add', 'test.js'])

    // Edit pretty file but do not stage changes
    const appended = '\nconsole.log("test");\n'
    await appendFile('test.js', appended)

    // Run lint-staged with `prettier --list-different` and commit pretty file
    const success = await gitCommit({ config: { '*.js': 'prettier --list-different' } })
    expect(success).toEqual(true)

    // Nothing is wrong, so a new commit is created and file is pretty
    expect(await execGit(['rev-list', '--count', 'HEAD'])).toEqual('2')
    expect(await execGit(['log', '-1', '--pretty=%B'])).toMatchInlineSnapshot(`
" \\"test\\"
"
`)

    // Latest commit contains pretty file
    // `git show` strips empty line from here here
    expect(await execGit(['show', 'HEAD:test.js'])).toEqual(testJsFilePretty.replace(/\n$/, ''))

    // Since edit was not staged, the file is still modified
    const status = await execGit(['status'])
    expect(status).toMatch('modified:   test.js')
    expect(status).toMatch('no changes added to commit')
    expect(await readFile('test.js')).toEqual(testJsFilePretty + appended)
  })

  it('Should commit partial change from partially staged file when no errors from linter and linter modifies file', async () => {
    // Stage ugly file
    await appendFile('test.js', testJsFileUgly)
    await execGit(['add', 'test.js'])

    // Edit ugly file but do not stage changes
    const appended = '\n\nconsole.log("test");\n'
    await appendFile('test.js', appended)

    // Run lint-staged with `prettier --write` and commit pretty file
    const success = await gitCommit({ config: { '*.js': ['prettier --write', 'git add'] } })
    expect(success).toEqual(true)

    // Nothing is wrong, so a new commit is created and file is pretty
    expect(await execGit(['rev-list', '--count', 'HEAD'])).toEqual('2')
    expect(await execGit(['log', '-1', '--pretty=%B'])).toMatchInlineSnapshot(`
" \\"test\\"
"
`)

    // Latest commit contains pretty file
    // `git show` strips empty line from here here
    expect(await execGit(['show', 'HEAD:test.js'])).toEqual(testJsFilePretty.replace(/\n$/, ''))

    // Nothing is staged
    const status = await execGit(['status'])
    expect(status).toMatch('modified:   test.js')
    expect(status).toMatch('no changes added to commit')

    // File is pretty, and has been edited
    expect(await readFile('test.js')).toEqual(testJsFilePretty + appended)
  })

  it('Should fail to commit partial change from partially staged file when errors from linter', async () => {
    // Stage ugly file
    await appendFile('test.js', testJsFileUgly)
    await execGit(['add', 'test.js'])

    // Edit ugly file but do not stage changes
    const appended = '\nconsole.log("test");\n'
    await appendFile('test.js', appended)
    const status = await execGit(['status'])

    // Run lint-staged with `prettier --list-different` to break the linter
    const success = await gitCommit({ config: { '*.js': 'prettier --list-different' } })
    expect(success).toEqual(false)

    // Something was wrong so the repo is returned to original state
    expect(await execGit(['rev-list', '--count', 'HEAD'])).toEqual('1')
    expect(await execGit(['log', '-1', '--pretty=%B'])).toMatchInlineSnapshot(`
" initial commit
"
`)
    expect(await execGit(['status'])).toEqual(status)
    expect(await readFile('test.js')).toEqual(testJsFileUgly + appended)
  })

  it('Should fail to commit partial change from partially staged file when errors from linter and linter modifies files', async () => {
    // Add unfixable file to commit so `prettier --write` breaks
    await appendFile('test.js', testJsFileUnfixable)
    await execGit(['add', 'test.js'])

    // Edit unfixable file but do not stage changes
    const appended = '\nconsole.log("test");\n'
    await appendFile('test.js', appended)
    const status = await execGit(['status'])

    // Run lint-staged with `prettier --write` to break the linter
    const success = await gitCommit({ config: { '*.js': ['prettier --write', 'git add'] } })
    expect(success).toEqual(false)

    // Something was wrong so the repo is returned to original state
    expect(await execGit(['rev-list', '--count', 'HEAD'])).toEqual('1')
    expect(await execGit(['log', '-1', '--pretty=%B'])).toMatchInlineSnapshot(`
" initial commit
"
`)
    expect(await execGit(['status'])).toEqual(status)
    expect(await readFile('test.js')).toEqual(testJsFileUnfixable + appended)
  })

  it('Should clear unstaged changes when linter applies same changes', async () => {
    // Stage ugly file
    await appendFile('test.js', testJsFileUgly)
    await execGit(['add', 'test.js'])

    // Replace ugly file with pretty but do not stage changes
    await fs.remove(path.join(cwd, 'test.js'))
    await appendFile('test.js', testJsFilePretty)

    // Run lint-staged with `prettier --write` and commit pretty file
    const success = await gitCommit({ config: { '*.js': ['prettier --write', 'git add'] } })
    expect(success).toEqual(true)

    // Nothing is wrong, so a new commit is created and file is pretty
    expect(await execGit(['rev-list', '--count', 'HEAD'])).toEqual('2')
    expect(await execGit(['log', '-1', '--pretty=%B'])).toMatchInlineSnapshot(`
" \\"test\\"
"
`)

    // Latest commit contains pretty file
    // `git show` strips empty line from here here
    expect(await execGit(['show', 'HEAD:test.js'])).toEqual(testJsFilePretty.replace(/\n$/, ''))

    // Nothing is staged
    expect(await execGit(['status'])).toMatchInlineSnapshot(`
"On branch master
nothing to commit, working tree clean"
`)

    // File is pretty, and has been edited
    expect(await readFile('test.js')).toEqual(testJsFilePretty)
  })

  it('Should fail when linter creates a .git/index.lock', async () => {
    // Stage ugly file
    await appendFile('test.js', testJsFileUgly)
    await execGit(['add', 'test.js'])

    // Edit ugly file but do not stage changes
    const appended = '\n\nconsole.log("test");\n'
    await appendFile('test.js', appended)
    expect(await readFile('test.js')).toEqual(testJsFileUgly + appended)
    const diff = await execGit(['diff'])

    // Run lint-staged with `prettier --write` and commit pretty file
    // The task creates a git lock file to simulate failure
    const success = await gitCommit({
      config: {
        '*.js': files => [
          `touch ${cwd}/.git/index.lock`,
          `prettier --write ${files.join(' ')}`,
          `git add ${files.join(' ')}`
        ]
      }
    })
    expect(success).toEqual(false)

    // Something was wrong so new commit wasn't created
    expect(await execGit(['rev-list', '--count', 'HEAD'])).toEqual('1')
    expect(await execGit(['log', '-1', '--pretty=%B'])).toMatchInlineSnapshot(`
" initial commit
"
`)

    // But local modifications are gone
    expect(await execGit(['diff'])).not.toEqual(diff)
    expect(await execGit(['diff'])).toMatchInlineSnapshot(`
"diff --git a/test.js b/test.js
index f80f875..1c5643c 100644
--- a/test.js
+++ b/test.js
@@ -1,3 +1,3 @@
 module.exports = {
-    'foo': 'bar',
-}
+  foo: \\"bar\\"
+};"
`)

    expect(await readFile('test.js')).not.toEqual(testJsFileUgly + appended)
    expect(await readFile('test.js')).toEqual(testJsFilePretty)

    // Remove lock file
    await fs.remove(`${cwd}/.git/index.lock`)
  })

  afterEach(async () => {
    wcDir.removeCallback()
  })
})
