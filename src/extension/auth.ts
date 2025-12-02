import * as crypto from 'node:crypto';
import * as https from 'node:https';
import { URL } from 'node:url';
import * as vscode from 'vscode';

/**
 * Auth0-only authentication: obtains a JWT via the Auth0 app and stores it in VS Code secrets.
 * No additional authorization/validation calls are made.
 */
export class AuthManager implements vscode.Disposable {
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
        const auth0Domain = 'https://dev-to3h0wnro50u3n7s.us.auth0.com';
        const auth0ClientId = 'xfk43ZTspl9SrqNpxp9tjFwvvfSJQ33l';
        const callbackAuthority = this.context.extension.id ?? 'modelware.oml-code';
        const callbackPath = '/callback';
        const callbackUri = vscode.Uri.parse(`vscode://${callbackAuthority}${callbackPath}`);
        const state = generateState();
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = await generateCodeChallenge(codeVerifier);

        const authorizeUrl = new URL('/authorize', auth0Domain);
        authorizeUrl.searchParams.set('response_type', 'code');
        authorizeUrl.searchParams.set('client_id', auth0ClientId);
        authorizeUrl.searchParams.set('redirect_uri', callbackUri.toString());
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
                    const params = uri.query ? new URLSearchParams(uri.query) : new URLSearchParams();
                    const receivedState = params.get('state');
                    if (receivedState && receivedState !== state) {
                        return;
                    }
                    const code = params.get('code');
                    if (!code) {
                        clearTimeout(timeout);
                        reject(new Error('Missing authorization code in callback'));
                        return;
                    }
                    clearTimeout(timeout);
                    resolve({ code });
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
                    redirectUri: callbackUri.toString()
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
    return crypto.randomBytes(32).toString('base64url');
}

async function generateCodeChallenge(verifier: string): Promise<string> {
    const hash = crypto.createHash('sha256').update(verifier).digest('base64');
    return hash.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateState(): string {
    return crypto.randomUUID?.() ?? crypto.randomBytes(16).toString('hex');
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

    return await new Promise<string>((resolve, reject) => {
        const req = https.request(
            {
                hostname: tokenUrl.hostname,
                path: tokenUrl.pathname + tokenUrl.search,
                port: tokenUrl.port || 443,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body)
                }
            },
            res => {
                const chunks: Buffer[] = [];
                res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf-8');
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            const data = text ? JSON.parse(text) as { access_token?: string; id_token?: string } : {};
                            const token = data.access_token ?? data.id_token;
                            if (!token) {
                                reject(new Error('Auth0 token exchange did not return an access token'));
                                return;
                            }
                            resolve(token);
                        } catch (err) {
                            reject(new Error(`Failed to parse Auth0 token response: ${String(err)}`));
                        }
                        return;
                    }
                    reject(new Error(`Auth0 token exchange failed: HTTP ${res.statusCode ?? 500} ${text}`));
                });
            }
        );
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}
