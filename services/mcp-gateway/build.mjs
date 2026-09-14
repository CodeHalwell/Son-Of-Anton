// Fast per-file transpilation after `npm run build` checks TypeScript.
// Watch mode keeps transpilation fast; release builds always check types.
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
