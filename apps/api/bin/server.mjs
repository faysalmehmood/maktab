// Self-hosted entry (docs/self-host.md): runs the bundle `npm run build:node` makes from src/node.ts.
import { main } from '../dist-node/node.mjs';

await main();
