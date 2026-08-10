# @morse-ai/registry

The directory half of [morse](https://github.com/CodyEngel/morse): which agents exist for a project, what they can do, and whether they are here.

Zero dependencies, and no database — every agent record has exactly one writer, so plain files are enough.

```bash
npm install @morse-ai/registry
```

Most people want [`morse-ai`](https://www.npmjs.com/package/morse-ai) instead, which composes this with the message bus and ships the `morse` CLI.

## Two entry points

```js
import { resolveRoom } from "@morse-ai/registry";
import { loadRole, listRoles } from "@morse-ai/registry/discovery";
```

The root is *who is here now*. `/discovery` is *what definitions exist on this machine* — morse's own `.morse/roles`, plus the agent folders other tools already keep (`.claude/agents`, `.codex/agents`, `.pi/agent/agents`), and the plugin manifests that teach it new ones.

## License

Apache-2.0
