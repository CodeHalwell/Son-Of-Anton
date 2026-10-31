# Language-client glob compatibility

The shipped dependency audit rejects minimatch versions below 11.0.1 because of
GHSA-g3hv-75wg-m249 (glob-parts amplification). The CSS, HTML, JSON and Markdown
language clients still request older minimatch releases and call the removed
`Minimatch.makeRe()` method to validate patterns. Their matching uses `match()`;
they never use the generated regular expression.

These four dependency trees override minimatch to 11.0.1. The build adapts only
the reviewed validation guards from `!matcher.makeRe()` to
`matcher.set.length === 0`. Empty and comment patterns remain rejected. Matching
continues through minimatch 11's bounded matcher, including its pattern-size
limits; the adapter does not restore regular-expression generation.

`build/npm/patchLanguageClientGlobs.ts` accepts only the recorded client versions,
the actual resolved minimatch version and full-file original or patched hashes.
It validates all inputs before writing, replaces each file atomically, and
accepts already patched files. Unknown source or versions stop the build.

The root postinstall applies the adapter after nested installs, including its
cached-install path. Gulp applies it before extension compilation, transpilation
and watch builds. The common esbuild entry point applies it before Node and
browser bundling. Consequently an installation made with `--ignore-scripts`
still receives the adapter during the required compile/build step. Audit-only
dependency installation does not execute or bundle the language clients.

The installer regression suite exercises real file-operation, glob, notebook
and diagnostic consumers, plus npm task exclusions and bounded attack patterns.
Separate fixtures verify hashes, unknown-input rejection, idempotence and
concurrent bundle processes. Any dependency update must review these hashes and
run both suites. Remove the overrides and adapter when an upstream client
supports a patched matcher directly.

This is a Tier 3 build change: the install and build hooks are necessary to ship
the security update without breaking existing language features. The dependency
audit and its zero-advisory requirement remain unchanged.
