import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/**
 * Load `lib/client.js` the way the browser module loader would: capture the
 * `__ModuleLoader__.load` payload, then run its factory with stubbed React.
 * This proves the browser half parses, runs once, and registers the sidebar
 * action — it does not render React.
 */
function loadClient() {
  let config
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(payload) {
          config = payload
        },
      },
    },
    document: {
      querySelector: () => null,
      createElement: () => ({ dataset: {}, textContent: '' }),
      head: { appendChild: () => {} },
      body: {},
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setInterval: () => 0,
    clearInterval: () => {},
    console,
  }
  runInNewContext(source, sandbox)
  assert.ok(config, 'client.js must call __ModuleLoader__.load')
  assert.equal(config.id, '@nethiel/dsh-llm-keypool')
  return config
}

/** Minimal React + ReactDOM stand-ins, exposed through a `require(name)` shim. */
function fakeRequire() {
  const createElement = (type, props, ...children) => ({ type, props, children })
  const React = {
    createElement,
    Fragment: Symbol('Fragment'),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
  }
  const modules = {
    react: React,
    'react-dom': { createPortal: (element) => element },
  }
  return (name) => {
    if (!(name in modules)) throw new Error(`unexpected client import: ${name}`)
    return modules[name]
  }
}

test('browser half loads and registers the sidebar action', () => {
  const config = loadClient()
  const client = config.factory(fakeRequire())
  assert.equal(Array.from(client.inject).join(','), 'slots')

  const registrations = []
  const injections = []
  client.apply({
    slots: {
      inject: (slot, callback) => {
        injections.push(slot)
        callback()
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  })
  assert.deepEqual(injections, ['sidebar.footer.action'])
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].options.name, 'sidebar.footer.action')
  assert.equal(registrations[0].options.id, 'llm-keypool')
  assert.equal(typeof registrations[0].component, 'function')
  assert.equal(registrations[0].options.locale, undefined)
})

test('browser half is a lazy module factory, not a side-effecting page', () => {
  const config = loadClient()
  const client = config.factory(fakeRequire())
  assert.equal(typeof client.apply, 'function')
  // No DOM work at module load: document.body must be untouched by the factory.
  assert.deepEqual(Object.keys(client).sort(), ['apply', 'inject'])
})

test('panel endpoints are addressed relative to the page, not from the origin root', () => {
  // A deployment may serve the GUI behind a path prefix (for example fnOS's
  // "/app/Harness/dsh" iframe). The page carries `<base href="./">`, so a
  // relative API path stays under that prefix; an absolute "/api/keypool/"
  // leaves the app and the gateway answers with its own HTML, which fails the
  // JSON read. The Host's own clients resolve the same way.
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(
    source.includes("const API = 'api/keypool/'"),
    'the API base must be a relative path',
  )
  assert.ok(
    !source.includes("const API = '/api/keypool/'"),
    'an absolute API base breaks a prefixed deployment',
  )
})
