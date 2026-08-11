#!/usr/bin/env node
// The node:sqlite experimental warning is silenced by @morse-ai/bus, inside the
// module that opens the database — see packages/bus/src/db.ts. It used to be
// this file's job, which only worked while there was exactly one entrypoint.
import { main } from "./cli/main.js";

await main(process.argv.slice(2));
