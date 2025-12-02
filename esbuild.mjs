//@ts-check
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const minify = process.argv.includes('--minify');

const success = watch ? 'Watch build succeeded' : 'Build succeeded';

function getTime() {
    const date = new Date();
    return `[${`${padZeroes(date.getHours())}:${padZeroes(date.getMinutes())}:${padZeroes(date.getSeconds())}`}] `;
}

function padZeroes(/** @type {number} */ i) {
    return i.toString().padStart(2, '0');
}

const plugins = [{
    name: 'watch-plugin',
    setup(/** @type {esbuild.PluginBuild} */ build) {
        build.onEnd(result => {
            if (result.errors.length === 0) {
                console.log(getTime() + success);
            }
        });
    },
}];

const nodeCtx = await esbuild.context({
    // Entry points for the vscode extension and the language server
    entryPoints: ['src/extension/main.ts', 'src/language/server.ts'],
    outdir: 'out',
    bundle: true,
    target: "ES2017",
    // VSCode's extension host is still using cjs, so we need to transform the code
    format: 'cjs',
    // To prevent confusing node, we explicitly use the `.cjs` extension
    outExtension: {
        '.js': '.cjs'
    },
    loader: { '.ts': 'ts' },
    external: ['vscode'],
    platform: 'node',
    sourcemap: !minify,
    minify,
    plugins
});

const webExtensionCtx = await esbuild.context({
    entryPoints: ['src/extension/main-browser.ts'],
    outdir: 'out/extension',
    bundle: true,
    target: "es2020",
    format: 'cjs',
    loader: { '.ts': 'ts' },
    external: ['vscode'],
    platform: 'browser',
    sourcemap: !minify,
    minify,
    plugins
});

const webServerCtx = await esbuild.context({
    entryPoints: ['src/language/server-browser.ts'],
    outdir: 'out/language',
    bundle: true,
    target: "es2020",
    format: 'iife',
    loader: { '.ts': 'ts' },
    platform: 'browser',
    sourcemap: !minify,
    minify,
    plugins
});

// Build a separate bundle for the webview client (browser runtime)
const webviewCtx = await esbuild.context({
    entryPoints: ['src/extension/webview/diagram-client.ts'],
    outdir: 'out/webview',
    bundle: true,
    target: 'ES2017',
    format: 'iife',
    globalName: 'OMLDiagramClient',
    platform: 'browser',
    loader: { '.ts': 'ts', '.css': 'css' },
    external: ['web-worker'],
    sourcemap: !minify,
    minify,
    plugins
});

if (watch) {
    await nodeCtx.watch();
    await webExtensionCtx.watch();
    await webServerCtx.watch();
    await webviewCtx.watch();
} else {
    await nodeCtx.rebuild();
    await webExtensionCtx.rebuild();
    await webServerCtx.rebuild();
    await webviewCtx.rebuild();
    nodeCtx.dispose();
    webExtensionCtx.dispose();
    webServerCtx.dispose();
    webviewCtx.dispose();
}
