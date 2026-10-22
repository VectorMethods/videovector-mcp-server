import { rmSync } from 'node:fs';

// Prevent deleted handlers from leaking into packages built in a reused checkout.
rmSync(new URL('../dist/', import.meta.url), { recursive: true, force: true });
