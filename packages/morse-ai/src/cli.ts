#!/usr/bin/env node
// Order matters: silence the node:sqlite experimental warning before anything
// transitively imports it.
import "./warnings.js";
import { main } from "./cli/main.js";

await main(process.argv.slice(2));
