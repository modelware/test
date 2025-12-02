import type { LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node.js';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { LanguageClient, TransportKind } from 'vscode-languageclient/node.js';
import { AuthManager } from './auth.js';

let client: LanguageClient;

// This function is called when the extension is activated.
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const authManager = new AuthManager(context);
    await authManager.initialize();

    context.subscriptions.push(
        vscode.commands.registerCommand('modelware.login', () => authManager.startLoginFlow()),
        vscode.commands.registerCommand('modelware.logout', () => authManager.logout()),
        authManager
    );

    client = await startLanguageClient(context);
    // Track open diagram panels and their associated document URIs
    const openPanels: Array<{ panel: vscode.WebviewPanel, uri: string }> = [];

    // Register the UI command to open a read-only diagram
    context.subscriptions.push(vscode.commands.registerCommand('oml.openDiagram', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }
        const docUri = editor.document.uri.toString();
        // Open a webview panel and wire messaging to fetch the diagram model from the language server
        const panel = vscode.window.createWebviewPanel(
            'omlDiagram',
            `OML Diagram: ${path.basename(editor.document.fileName)}`,
            vscode.ViewColumn.Beside,
            { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out', 'webview')] }
        );

    const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'out', 'webview', 'diagram-client.js'));
    const cssUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'out', 'webview', 'diagram-client.css'));

        // Detect theme kind (light vs dark)
        const themeKind = vscode.window.activeColorTheme.kind;
        const isLight = themeKind === vscode.ColorThemeKind.Light || themeKind === vscode.ColorThemeKind.HighContrastLight;

        panel.webview.html = `<!DOCTYPE html>
<html style="width: 100%; height: 100%;" data-vscode-theme-kind="${isLight ? 'light' : 'dark'}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" type="text/css" href="${cssUri}">
</head>
<body style="width: 100%; height: 100%; margin: 0; padding: 0;">
  <div id="sprotty" style="width: 100%; height: 100%;"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;

        // Track this panel and its document URI
        openPanels.push({ panel, uri: docUri });

        // Handle messages from the webview
        const disposeListener = panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg?.type === 'requestModel') {
                const requestStart = Date.now();
                console.debug('[oml] webview requested model — forwarding to language server');
                try {
                    const model = await client.sendRequest('oml/diagramModel', { uri: docUri });
                    const requestDuration = Date.now() - requestStart;
                    console.debug(`[oml] received model from language server in ${requestDuration}ms`);
                    panel.webview.postMessage({ type: 'updateModel', model, _timings: { serverMs: requestDuration } });
                } catch (err) {
                    const requestDuration = Date.now() - requestStart;
                    console.error('[oml] Failed to get diagram model', err);
                    panel.webview.postMessage({ type: 'updateModel', model: { nodes: [], edges: [] }, _timings: { serverMs: requestDuration, error: true } });
                }
            } else if (msg?.type === 'navigateToElement') {
                // Navigate to the element in the source file
                try {
                    // If the message includes source location, use it directly
                    if (msg.startLine !== undefined && msg.startColumn !== undefined &&
                        msg.endLine !== undefined && msg.endColumn !== undefined) {
                        // Using source location supplied by the diagram model
                        // Open the document and reveal the entire syntax block
                        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(docUri));
                        const startPosition = new vscode.Position(msg.startLine - 1, msg.startColumn); // Convert to 0-based
                        const endPosition = new vscode.Position(msg.endLine - 1, msg.endColumn);
                        const range = new vscode.Range(startPosition, endPosition);
                        
                        await vscode.window.showTextDocument(document, {
                            selection: range,
                            viewColumn: vscode.ViewColumn.One,
                            preserveFocus: false
                        });
                        
                        // Highlight the entire element and reveal it
                        const editor = vscode.window.activeTextEditor;
                        if (editor) {
                            editor.selection = new vscode.Selection(startPosition, endPosition);
                            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                        }
                    } else if (msg.elementId) {
                        // Fallback: use language server to look up element
                        const response: any = await client.sendRequest('oml/navigateToElement', { 
                            uri: docUri, 
                            elementId: msg.elementId 
                        });
                        if (response?.startLine !== undefined && response?.startColumn !== undefined &&
                            response?.endLine !== undefined && response?.endColumn !== undefined) {
                            // Use the URI from the response (for imported members) or fall back to docUri
                            const targetUri = response.uri || docUri;
                            
                            // Open the document and reveal the entire syntax block
                            const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(targetUri));
                            const startPosition = new vscode.Position(response.startLine - 1, response.startColumn); // Convert to 0-based
                            const endPosition = new vscode.Position(response.endLine - 1, response.endColumn);
                            const range = new vscode.Range(startPosition, endPosition);
                            
                            await vscode.window.showTextDocument(document, {
                                selection: range,
                                viewColumn: vscode.ViewColumn.One,
                                preserveFocus: false
                            });
                            
                            // Highlight the entire element and reveal it
                            const editor = vscode.window.activeTextEditor;
                            if (editor) {
                                editor.selection = new vscode.Selection(startPosition, endPosition);
                                editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                            }
                        }
                    }
                } catch (err) {
                    console.error('[oml] Failed to navigate to element', err);
                }
            }
        });
        panel.onDidDispose(() => {
            disposeListener.dispose();
            // Remove from openPanels
            const idx = openPanels.findIndex(p => p.panel === panel);
            if (idx >= 0) openPanels.splice(idx, 1);
        });
    }));

    // React to VS Code theme changes: notify all open diagram webviews
    context.subscriptions.push(vscode.window.onDidChangeActiveColorTheme(theme => {
        const isLight = theme.kind === vscode.ColorThemeKind.Light || theme.kind === vscode.ColorThemeKind.HighContrastLight;
        const kind = isLight ? 'light' : 'dark';
        for (const { panel } of openPanels) {
            try {
                panel.webview.postMessage({ type: 'theme', kind });
            } catch {/* best-effort */}
        }
    }));

    // Debounced updates: schedule updates for changed documents and also update on save
    const updateTimeouts = new Map<string, NodeJS.Timeout>();

    async function updatePanelsForUri(uri: string) {
        for (const { panel, uri: panelUri } of openPanels) {
            if (panelUri === uri) {
                try {
                    console.debug(`[oml] requesting updated model for ${uri}`);
                    const model = await client.sendRequest('oml/diagramModel', { uri });
                    panel.webview.postMessage({ type: 'updateModel', model });
                    console.debug('[oml] posted updated model to webview');
                } catch (err) {
                    console.error('[oml] Failed to update diagram model after document change', err);
                }
            }
        }
    }

    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.languageId !== 'oml') return;
        const changedUri = event.document.uri.toString();
        // debounce rapid changes (typing)
        const existing = updateTimeouts.get(changedUri);
        if (existing) clearTimeout(existing);
        const t = setTimeout(() => {
            updateTimeouts.delete(changedUri);
            void updatePanelsForUri(changedUri);
        }, 300);
        updateTimeouts.set(changedUri, t);
    }));

    // Also update on save immediately
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc.languageId !== 'oml') return;
        const savedUri = doc.uri.toString();
        const existing = updateTimeouts.get(savedUri);
        if (existing) {
            clearTimeout(existing);
            updateTimeouts.delete(savedUri);
        }
        void updatePanelsForUri(savedUri);
    }));
}

// This function is called when the extension is deactivated.
export function deactivate(): Thenable<void> | undefined {
    if (client) {
        return client.stop();
    }
    return undefined;
}

async function startLanguageClient(context: vscode.ExtensionContext): Promise<LanguageClient> {
    // The language server bundle is emitted as `server.cjs` under `out/language` by esbuild.
    // Use that file when launching the server.
    const serverModule = context.asAbsolutePath(path.join('out', 'language', 'server.cjs'));
    // The debug options for the server
    // --inspect=6009: runs the server in Node's Inspector mode so VS Code can attach to the server for debugging.
    // By setting `process.env.DEBUG_BREAK` to a truthy value, the language server will wait until a debugger is attached.
    const debugOptions = { execArgv: ['--nolazy', `--inspect${process.env.DEBUG_BREAK ? '-brk' : ''}=${process.env.DEBUG_SOCKET || '6009'}`] };

    // If the extension is launched in debug mode then the debug server options are used
    // Otherwise the run options are used
    const serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: { module: serverModule, transport: TransportKind.ipc, options: debugOptions }
    };

    // Options to control the language client
    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: '*', language: 'oml' }]
    };

    // Create the language client and start the client.
    const client = new LanguageClient(
        'oml',
        'OML',
        serverOptions,
        clientOptions
    );

    // Start the client. This will also launch the server
    await client.start();
    return client;
}
