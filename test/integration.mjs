// Integration smoke test against the real Logseq CLI. Needs no account and no network
// when LOGSEQ_RUNTIME_ASAR points at an app.asar; otherwise the runtime is downloaded.
//   node test/integration.mjs [dataDir]
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '../lib/cli.js'
import { loadConfig } from '../lib/config.js'
import { ensureRuntime } from '../lib/runtime.js'
import { buildTools } from '../lib/tools.js'

const dataDir = process.argv[2] || (await mkdtemp(join(tmpdir(), 'lsq-int-')))
const config = loadConfig({ dataDir, graphs: ['itest'], runtimeAsar: process.env.LOGSEQ_RUNTIME_ASAR, sync: false })
const t0 = Date.now()
await ensureRuntime(config, console.log)
console.log(`runtime ready in ${Date.now() - t0}ms`)
console.log(await runCli(config, ['--version'], { output: 'human' }).catch((e) => e.message))
await runCli(config, ['graph', 'create', '--graph=itest']).catch((e) => console.log('create:', e.message))

const tools = Object.fromEntries(buildTools(config).map((t) => [t.name, t]))
const call = async (name, args) => {
  const out = await tools[name].execute(args, {})
  console.log(`--- ${name} ${JSON.stringify(args)}\n${out}`)
  return out
}
await call('logseq_upsert_property', { name: 'source', type: 'default', cardinality: 'one' })
await call('logseq_upsert_page', { page: 'Agent Notes', updateProperties: '{:source "integration test"}' })
await call('logseq_upsert_tag', { name: 'AI' })
await call('logseq_upsert_block', { targetPage: 'Agent Notes', blocks: '- 父块 [[Logseq]]\n  - 子块 #AI\n- -dash first' })
await call('logseq_upsert_block', { targetPage: 'Agent Notes', content: 'tagged via param', updateTags: '["AI"]' })
await call('logseq_upsert_task', { targetPage: 'Agent Notes', content: 'review sync', status: 'todo', priority: 'high' })
await call('logseq_show', { page: 'Agent Notes' })
await call('logseq_search', { type: 'block', content: '子块' })
await call('logseq_list', { type: 'task' })
await call('logseq_query', { query: '[:find (count ?b) . :where [?b :block/page ?p] [?p :block/title "Agent Notes"]]' })
await call('logseq_graphs', {})
await runCli(config, ['server', 'stop', '--graph=itest']).catch(() => {})
console.log('OK')
