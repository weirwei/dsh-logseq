'use strict'
// Drop-in replacement for the `keytar` native module used by Logseq's db-worker-node.
//
// A headless container has no OS keychain (libsecret / D-Bus), and the real keytar is a
// native addon built for Electron. The worker only uses it to cache the decrypted E2EE
// key under service "Logseq E2EE", so a small JSON file (mode 0600) is enough. Without
// persistence the E2EE password would have to be re-entered on every worker start.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const file = process.env.LOGSEQ_KEYTAR_FILE || path.join(os.homedir(), '.keytar.json')

function load() {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

function save(data) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

const key = (service, account) => `${service}\u0000${account}`

module.exports = {
  async getPassword(service, account) {
    return load()[key(service, account)] ?? null
  },
  async setPassword(service, account, password) {
    const data = load()
    data[key(service, account)] = password
    save(data)
  },
  async deletePassword(service, account) {
    const data = load()
    const existed = key(service, account) in data
    delete data[key(service, account)]
    save(data)
    return existed
  },
  async findCredentials(service) {
    return Object.entries(load())
      .filter(([k]) => k.startsWith(`${service}\u0000`))
      .map(([k, password]) => ({ account: k.slice(service.length + 1), password }))
  },
  async findPassword(service) {
    const hit = Object.entries(load()).find(([k]) => k.startsWith(`${service}\u0000`))
    return hit ? hit[1] : null
  },
}
