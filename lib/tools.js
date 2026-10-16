/**
 * Model-facing tools. Each tool maps validated JSON arguments to one CLI invocation.
 *
 * Values are always passed as `--flag=value` so a value starting with `-` can never be
 * parsed as another flag, and argv is an array (no shell), so there is no injection path.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from './cli.js'

const ARG_INLINE_LIMIT = 64 * 1024 // Linux MAX_ARG_STRLEN is 128 KiB; stay well below.

const str = (description, extra = {}) => ({ type: 'string', description, ...extra })
const int = (description) => ({ type: 'integer', minimum: 0, description })
const bool = (description) => ({ type: 'boolean', description })
const EDN_TAGS = 'EDN vector of tag names, e.g. ["Project" "AI"]'
const EDN_PROPS = 'EDN map of property → value, e.g. {:status "active" :rating 5}'
const EDN_KEYS = 'EDN vector of property names, e.g. [:status]'

/**
 * @param {import('./config.js').LogseqConfig} config
 * @param {{ snapshot(): object } | undefined} daemon
 */
export function buildTools(config, daemon) {
  const graphParam = {
    graph: str(
      config.graphs.length
        ? `Graph name. Defaults to "${config.graphs[0]}". Synced graphs: ${config.graphs.join(', ')}.`
        : 'Graph name (see logseq_graphs).',
    ),
  }

  /** @type {Array<{name: string, description: string, write?: boolean, output?: 'human', properties: object, required?: string[], argv: (a: any) => string[] | Promise<string[]>}>} */
  const tools = [
    {
      name: 'logseq_graphs',
      description:
        'List local Logseq DB graphs and the sync state of each synced graph (ws state, local/remote tx, pending changes, last error). Use it to check that writes have reached the sync server.',
      properties: {},
      async run() {
        const data = await runCli(config, ['graph', 'list'])
        return { graphs: data.graphs, sync: daemon ? daemon.snapshot() : 'sync disabled' }
      },
    },
    {
      name: 'logseq_search',
      description:
        'Full-text search by title in a Logseq DB graph. type=block searches block content, page/tag/property search entity names. Returns matching ids and titles; follow up with logseq_show.',
      properties: {
        ...graphParam,
        type: str('What to search', { enum: ['block', 'page', 'tag', 'property'] }),
        content: str('Search text (case-insensitive substring)'),
      },
      required: ['type', 'content'],
      argv: (a) => ['search', a.type, flag('content', a.content)],
    },
    {
      name: 'logseq_show',
      description:
        'Render a page or block tree as text: each line is "<db-id> <content>", children indented, with #tags and properties. Use the db-ids as targets for upsert/remove.',
      output: 'human',
      properties: {
        ...graphParam,
        page: str('Page name (journal pages use the journal title)'),
        id: int('Block or page db id'),
        uuid: str('Block or page UUID'),
        level: int('Tree depth limit'),
        linkedReferences: bool('Also show linked references'),
      },
      argv: (a) => {
        oneOf(a, ['page', 'id', 'uuid'])
        return ['show', ...flags(a, { page: 'page', id: 'id', uuid: 'uuid', level: 'level' }), ...boolFlag('linked-references', a.linkedReferences)]
      },
    },
    {
      name: 'logseq_list',
      description:
        'List entities of one type. page: pages (journalOnly to restrict); tag/property: schema entities; task: tasks filtered by status/priority/content; node: blocks/pages filtered by tags/properties (comma-separated, AND).',
      properties: {
        ...graphParam,
        type: str('Entity type', { enum: ['page', 'tag', 'property', 'task', 'node'] }),
        limit: int('Max results (default 50)'),
        offset: int('Result offset'),
        sort: str('Sort field, e.g. updated-at, created-at, title'),
        order: str('Sort order', { enum: ['asc', 'desc'] }),
        journalOnly: bool('page only: journal pages only'),
        includeJournal: bool('page only: include journal pages (default true)'),
        status: str('task only: status filter, e.g. todo, doing, done'),
        priority: str('task only: priority filter'),
        content: str('task only: content filter'),
        tags: str('node only: comma-separated tag filters'),
        properties: str('node only: comma-separated property filters'),
      },
      required: ['type'],
      argv: (a) => [
        'list',
        a.type,
        flag('limit', a.limit ?? 50),
        ...flags(a, { offset: 'offset', sort: 'sort', order: 'order', status: 'status', priority: 'priority', content: 'content', tags: 'tags', properties: 'properties' }),
        ...(a.journalOnly ? ['--journal-only'] : []),
        ...(a.includeJournal === false ? ['--include-journal=false'] : []),
      ],
    },
    {
      name: 'logseq_query',
      description:
        'Run a Datascript (Datalog) query against the graph DB, e.g. [:find ?title :where [?b :block/title ?title] [?b :block/tags ?t] [?t :block/title "Project"]]. Use for structural questions search/list cannot answer.',
      properties: {
        ...graphParam,
        query: str('Datascript query in EDN'),
        inputs: str('EDN vector of query inputs'),
      },
      required: ['query'],
      argv: (a) => ['query', flag('query', a.query), ...flags(a, { inputs: 'inputs' })],
    },
    {
      name: 'logseq_upsert_block',
      description:
        'Create or update blocks. Create: give targetPage/targetId/targetUuid plus content (one block) or blocks (indented markdown outline "- a\\n  - child"). Update: give id/uuid plus content and/or tag/property changes; id with a target moves the block. Tags: use updateTags (in content, #tag is plain text; in blocks markdown, #tag is parsed and the tag must already exist — create it with logseq_upsert_tag); properties go in updateProperties and must already exist (logseq_upsert_property). Caution: updating an existing block\'s content via id drops its existing [[refs]] — prefer adding a new block.',
      write: true,
      properties: {
        ...graphParam,
        id: int('Existing block db id to update/move'),
        uuid: str('Existing block UUID to update/move'),
        targetPage: str('Target page name (created if missing)'),
        targetId: int('Target block db id'),
        targetUuid: str('Target block UUID'),
        pos: str('Position relative to target', { enum: ['first-child', 'last-child', 'sibling'] }),
        content: str('Block content (single block)'),
        blocks: str('Markdown outline of several (nested) blocks'),
        updateTags: str(`Tags to add: ${EDN_TAGS}`),
        updateProperties: str(`Properties to set: ${EDN_PROPS}`),
        removeTags: str(`Tags to remove: ${EDN_TAGS}`),
        removeProperties: str(`Properties to remove: ${EDN_KEYS}`),
      },
      argv: async (a, scratch) => {
        if (a.content !== undefined && a.blocks !== undefined) throw new Error('give either content or blocks, not both')
        const out = [
          'upsert',
          'block',
          ...flags(a, {
            id: 'id',
            uuid: 'uuid',
            targetPage: 'target-page',
            targetId: 'target-id',
            targetUuid: 'target-uuid',
            pos: 'pos',
            content: 'content',
            updateTags: 'update-tags',
            updateProperties: 'update-properties',
            removeTags: 'remove-tags',
            removeProperties: 'remove-properties',
          }),
        ]
        if (a.blocks !== undefined) {
          if (Buffer.byteLength(a.blocks) > ARG_INLINE_LIMIT) out.push(flag('blocks-file', await scratch('blocks.md', a.blocks)))
          else out.push(flag('blocks', a.blocks))
        }
        return out
      },
    },
    {
      name: 'logseq_upsert_page',
      description: 'Create a page (if missing) or update its tags/properties (properties must already exist, see logseq_upsert_property). Use logseq_upsert_block to add content to it.',
      write: true,
      properties: {
        ...graphParam,
        page: str('Page name'),
        id: int('Existing page db id'),
        updateTags: str(`Tags to add: ${EDN_TAGS}`),
        updateProperties: str(`Properties to set: ${EDN_PROPS}`),
        removeTags: str(`Tags to remove: ${EDN_TAGS}`),
        removeProperties: str(`Properties to remove: ${EDN_KEYS}`),
      },
      argv: (a) => {
        oneOf(a, ['page', 'id'])
        return [
          'upsert',
          'page',
          ...flags(a, { page: 'page', id: 'id', updateTags: 'update-tags', updateProperties: 'update-properties', removeTags: 'remove-tags', removeProperties: 'remove-properties' }),
        ]
      },
    },
    {
      name: 'logseq_upsert_task',
      description:
        'Create or update a task with structured status/priority/dates (do not write TODO markers into content). Create: content plus page or target*. Update: id/uuid plus fields to change.',
      write: true,
      properties: {
        ...graphParam,
        id: int('Existing task db id'),
        uuid: str('Existing task UUID'),
        content: str('Task content'),
        page: str('Page to put a new task on'),
        targetPage: str('Target page name'),
        targetId: int('Target block db id'),
        targetUuid: str('Target block UUID'),
        pos: str('Position relative to target', { enum: ['first-child', 'last-child', 'sibling'] }),
        status: str('Task status, e.g. todo, doing, done, canceled, backlog'),
        priority: str('Priority, e.g. low, medium, high, urgent'),
        scheduled: str('Scheduled date (YYYY-MM-DD)'),
        deadline: str('Deadline date (YYYY-MM-DD)'),
      },
      argv: (a) => [
        'upsert',
        'task',
        ...flags(a, {
          id: 'id',
          uuid: 'uuid',
          content: 'content',
          page: 'page',
          targetPage: 'target-page',
          targetId: 'target-id',
          targetUuid: 'target-uuid',
          pos: 'pos',
          status: 'status',
          priority: 'priority',
          scheduled: 'scheduled',
          deadline: 'deadline',
        }),
      ],
    },
    {
      name: 'logseq_upsert_tag',
      description: 'Create a tag (class) or change its schema properties. Reuse existing tags (logseq_list type=tag) before creating new ones.',
      write: true,
      properties: {
        ...graphParam,
        name: str('Tag name'),
        id: int('Existing tag db id'),
        addProperties: str(`Schema properties to add: ${EDN_KEYS}`),
        removeProperties: str(`Schema properties to remove: ${EDN_KEYS}`),
      },
      argv: (a) => {
        oneOf(a, ['name', 'id'])
        return ['upsert', 'tag', ...flags(a, { name: 'name', id: 'id', addProperties: 'add-properties', removeProperties: 'remove-properties' })]
      },
    },
    {
      name: 'logseq_upsert_property',
      description: 'Create a typed property or update its settings. Reuse existing properties (logseq_list type=property) first.',
      write: true,
      properties: {
        ...graphParam,
        name: str('Property name'),
        id: int('Existing property db id'),
        type: str('Value type', { enum: ['default', 'number', 'date', 'checkbox', 'url'] }),
        cardinality: str('Cardinality', { enum: ['one', 'many'] }),
        hide: bool('Hide the property'),
        public: bool('Make the property public'),
      },
      argv: (a) => {
        oneOf(a, ['name', 'id'])
        return [
          'upsert',
          'property',
          ...flags(a, { name: 'name', id: 'id', type: 'type', cardinality: 'cardinality' }),
          ...boolFlag('hide', a.hide),
          ...boolFlag('public', a.public),
        ]
      },
    },
    {
      name: 'logseq_remove',
      description:
        'Remove a block, page, tag or property. Pages go to the recycle bin unless force=true (permanent). Block removal is permanent. Only use when the user asked for deletion.',
      write: true,
      properties: {
        ...graphParam,
        type: str('Entity type', { enum: ['block', 'page', 'tag', 'property'] }),
        id: int('Entity db id'),
        uuid: str('block only: UUID'),
        page: str('page only: page name'),
        name: str('tag/property only: name'),
        force: bool('page only: permanently delete instead of recycling'),
      },
      required: ['type'],
      argv: (a) => {
        const allowed = { block: ['id', 'uuid'], page: ['id', 'page'], tag: ['id', 'name'], property: ['id', 'name'] }[a.type]
        oneOf(a, allowed)
        return ['remove', a.type, ...flags(a, Object.fromEntries(allowed.map((k) => [k, k]))), ...(a.type === 'page' && a.force ? ['--force'] : [])]
      },
    },
  ]

  return tools
    .filter((t) => !(config.readOnly && t.write))
    .map((t) => toDefinition(config, t, Boolean(daemon)))
}

function toDefinition(config, tool, syncing) {
  return {
    name: tool.name,
    description: tool.description,
    parameters: {
      type: 'object',
      properties: tool.properties,
      ...(tool.required?.length ? { required: tool.required } : {}),
      additionalProperties: false,
    },
    timeoutMs: config.timeoutMs + 20_000,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(rawArgs, exec) {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
      if (tool.run) return clip(config, JSON.stringify(await tool.run(args), null, 1))
      const graph = args.graph || config.graphs[0]
      if (!graph) throw new Error('no graph given and no default graph configured')
      let dir
      const scratch = async (name, body) => {
        dir ??= await mkdtemp(join(tmpdir(), 'dsh-logseq-'))
        const path = join(dir, name)
        await writeFile(path, body, { mode: 0o600 })
        return path
      }
      try {
        const argv = [...(await tool.argv(args, scratch)), flag('graph', graph)]
        const data = await runCli(config, argv, { output: tool.output, signal: exec?.signal })
        const text = tool.output === 'human' ? data : JSON.stringify(data, null, 1)
        return clip(config, tool.write && syncing ? `${text}\n(written locally; the sync daemon pushes it to the server — check with logseq_graphs)` : text)
      } catch (error) {
        // Surface CLI errors to the model as tool errors with the hint, not as fake success.
        throw new Error(error.hint ? `${error.message}\nhint: ${error.hint}` : error.message)
      } finally {
        if (dir) await rm(dir, { recursive: true, force: true })
      }
    },
  }
}

function flag(name, value) {
  return `--${name}=${value}`
}

function flags(args, mapping) {
  return Object.entries(mapping)
    .filter(([key]) => args[key] !== undefined && args[key] !== null && args[key] !== '')
    .map(([key, name]) => flag(name, args[key]))
}

function boolFlag(name, value) {
  return value === undefined ? [] : [flag(name, value ? 'true' : 'false')]
}

function oneOf(args, keys) {
  if (!keys.some((k) => args[k] !== undefined && args[k] !== '')) throw new Error(`one of ${keys.join(', ')} is required`)
}

function clip(config, text) {
  const max = config.maxOutputChars
  return text.length > max ? `${text.slice(0, max)}\n… [truncated ${text.length - max} chars; narrow the query]` : text
}
