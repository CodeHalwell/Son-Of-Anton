// Fast, deterministic transpile for the container image and local builds.
//
// We use esbuild rather than `tsc` because tsc must resolve and instantiate the
// MCP SDK's deeply-nested Zod tool-schema types, which pushes its heap past 4 GB
// (SIGABRT / exit 134) in the CI Docker builder even with `skipLibCheck`.
// esbuild strips types without resolving the declaration graph. Type-checking
// stays available out-of-band via `npm run typecheck`.
//
// Per-file output (not a bundle) mirrors the previous tsc layout, so `dist/`
// keeps the same shape and relative `require` paths (including the vendored
// `../_lib` / `../_shared` code) resolve exactly as before.
import { build, context } from 'esbuild';

/** @type {import('esbuild').BuildOptions} */
const options = {
	entryPoints: ['src/**/*.ts'],
	outdir: 'dist',
	platform: 'node',
	format: 'cjs',
	target: 'es2022',
	sourcemap: true,
	logLevel: 'info',
};

if (process.argv.includes('--watch')) {
	const ctx = await context(options);
	await ctx.watch();
	console.log('[mcp-gateway] esbuild watching for changes…');
} else {
	await build(options);
}
