#!/usr/bin/env node

import { run } from "./commands.js";

process.exitCode = await run(process.argv.slice(2));
