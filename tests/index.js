/**
 * Entry point so `node --test tests/` also works on Node builds that do not
 * expand a directory argument themselves (Node 24 resolves it as a module).
 * The runner normally discovers *.test.js files directly; these imports just
 * make the directory form run the same suites.
 */
import './metadata.test.js';
import './scan.test.js';
import './queue.test.js';
import './folders.test.js';
import './update-flow.test.js';
import './diagnostics.test.js';
import './garbled.test.js';
import './migrate.test.js';
import './i18n.test.js';
import './storage.test.js';
