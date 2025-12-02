import * as vscode from 'vscode';

/**
 * Auth0-only authentication for the web extension using the same code+PKCE flow
 * as the desktop side: obtain a JWT via Auth0, store it in VS Code secrets, and
 * avoid any additional authorization calls.
 */
export class BrowserAuthManager implements vscode.Disposable {
    private readonly secretKey = 'auth0.jwt';
    private readonly disposables: vscode.Disposable[] = [];
    private token?: string;
    private uriHandlerDisposable?: vscode.Disposable;

    constructor(private readonly context: vscode.ExtensionContext) {}

    async initialize(): Promise<void> {
        this.token = await this.context.secrets.get(this.secretKey) ?? undefined;
    }

    getToken(): string | undefined {
        return this.token;
    }

    async startLoginFlow(): Promise<void> {
        // Web extension uses the Auth0 app dedicated for web
        const auth0Domain = 'https://auth.modelware.io';
        const auth0ClientId = 'Ep6H59nyrj0h3BWXUoCwNOWT2AWVpvQt';
        const callbackAuthority = this.context.extension.id ?? 'modelware.oml-code';
        const callbackPath = '/callback';
        const state = generateState();
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = await generateCodeChallenge(codeVerifier);

        const localCallback = vscode.Uri.parse(`${vscode.env.uriScheme}://${callbackAuthority}${callbackPath}`);
        const callbackUri = await vscode.env.asExternalUri(localCallback);
        const callbackUriString = callbackUri.toString();

        const authorizeUrl = new URL('/authorize', auth0Domain);
        authorizeUrl.searchParams.set('response_type', 'code');
        authorizeUrl.searchParams.set('client_id', auth0ClientId);
        authorizeUrl.searchParams.set('redirect_uri', callbackUriString);
        authorizeUrl.searchParams.set('code_challenge', codeChallenge);
        authorizeUrl.searchParams.set('code_challenge_method', 'S256');
        authorizeUrl.searchParams.set('state', state);
        authorizeUrl.searchParams.set('scope', 'openid profile email offline_access');

        const callbackPromise = new Promise<{ code: string }>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Login timed out')), 5 * 60 * 1000);

            const handler: vscode.UriHandler = {
                handleUri: uri => {
                    if (uri.authority !== callbackAuthority || uri.path !== callbackPath) {
                        return;
                    }

                    const searchParams = uri.query ? new URLSearchParams(uri.query) : new URLSearchParams();
                    const receivedState = searchParams.get('state') ?? undefined;
                    if (receivedState !== state) {
                        clearTimeout(timeout);
                        reject(new Error('State mismatch in callback'));
                        return;
                    }

                    const code = searchParams.get('code');
                    if (!code) {
                        clearTimeout(timeout);
                        reject(new Error('Missing authorization code in callback'));
                        return;
                    }

                    clearTimeout(timeout);
                    resolve({ code: code.trim() });
                }
            };

            this.uriHandlerDisposable = vscode.window.registerUriHandler(handler);
            this.disposables.push(this.uriHandlerDisposable);
        });

        void vscode.env.openExternal(vscode.Uri.parse(authorizeUrl.toString()));
        vscode.window.showInformationMessage('Complete Auth0 login in your browser to finish signing in.');

        try {
            const result = await vscode.window.withProgress<{ token: string }>({
                location: vscode.ProgressLocation.Notification,
                cancellable: true,
                title: 'Waiting for Auth0 login to complete...'
            }, async (_progress, cancellationToken) => {
                const { code } = await Promise.race([
                    callbackPromise,
                    new Promise<never>((_resolve, reject) => cancellationToken.onCancellationRequested(() => reject(new Error('Login cancelled'))))
                ]);
                const token = await exchangeAuth0CodeForToken({
                    domain: auth0Domain,
                    clientId: auth0ClientId,
                    code,
                    codeVerifier,
                    redirectUri: callbackUriString
                });
                return { token };
            });

            await this.persistToken(result.token);
            vscode.window.showInformationMessage('Signed in with Auth0.');
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Auth0 login did not complete: ${message}`);
        } finally {
            this.uriHandlerDisposable?.dispose();
            this.uriHandlerDisposable = undefined;
        }
    }

    async logout(): Promise<void> {
        this.token = undefined;
        await this.context.secrets.delete(this.secretKey);
        vscode.window.showInformationMessage('Signed out.');
    }

    dispose(): void {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }

    private async persistToken(token: string): Promise<void> {
        this.token = token;
        await this.context.secrets.store(this.secretKey, token);
    }
}

function generateCodeVerifier(): string {
    const random = globalThis.crypto?.getRandomValues?.(new Uint8Array(32));
    if (!random) {
        // Fallback: best-effort entropy if crypto is unavailable
        return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    }
    return base64UrlEncode(random);
}

async function generateCodeChallenge(verifier: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
    return base64UrlEncode(new Uint8Array(digest));
}

function generateState(): string {
    return (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 10));
}

function base64UrlEncode(bytes: Uint8Array): string {
    let binary = '';
    for (const b of bytes) {
        binary += String.fromCharCode(b);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function exchangeAuth0CodeForToken(params: {
    domain: string;
    clientId: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
}): Promise<string> {
    const tokenUrl = new URL('/oauth/token', params.domain);
    const body = JSON.stringify({
        grant_type: 'authorization_code',
        client_id: params.clientId,
        code: params.code,
        code_verifier: params.codeVerifier,
        redirect_uri: params.redirectUri
    });

    const response = await fetch(tokenUrl.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
    });

    const text = await response.text();
    if (response.ok) {
        try {
            const data = text ? JSON.parse(text) as { access_token?: string; id_token?: string } : {};
            const token = data.access_token ?? data.id_token;
            if (!token) {
                throw new Error('Auth0 token exchange did not return an access token');
            }
            return token;
        } catch (err) {
            throw new Error(`Failed to parse Auth0 token response: ${String(err)}`);
        }
    }

    throw new Error(`Auth0 token exchange failed: HTTP ${response.status} ${text}`);
}
