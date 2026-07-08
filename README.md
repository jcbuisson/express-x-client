# AI changes

## Dirty records

They are local IndexedDB records whose metadata has: `__dirty__: true`

Meaning: the client has a local change that has not been safely acknowledged by the server yet.

Examples:
  - You create a row offline: `metadata = { uid, created_at, __dirty__: true, __operation__: 'create' }`

  - You update a row offline: `metadata = { uid, created_at, updated_at, __dirty__: true, __operation__: 'update' }`

  - You delete a row offline: `metadata = { uid, created_at, deleted_at, __dirty__: true, __operation__: 'delete' }`

Once the server confirms the mutation, the client stores: `__dirty__: false`
Dirty metadata is durable in IndexedDB. If the browser closes before sync succeeds, the mutation is still remembered and retried later.

