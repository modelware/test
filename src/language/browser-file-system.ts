import type { FileSystemNode, FileSystemProvider } from 'langium';
import { URI } from 'langium';
import type { Connection } from 'vscode-languageserver';
import { FsRequests, type FsDirectoryEntry, type FsStatResult } from './fs-protocol.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8');

/**
 * File system provider that proxies requests back to the VS Code web extension host.
 * This lets the browser-based language server read workspace files for cross-file references.
 */
export class BrowserFileSystemProvider implements FileSystemProvider {
    constructor(private readonly connection: Connection) {}

    async stat(uri: URI): Promise<FileSystemNode> {
        const result = await this.connection.sendRequest<FsStatResult | null>(FsRequests.stat, { uri: uri.toString() });
        if (!result) {
            throw new Error(`File not found: ${uri.toString()}`);
        }
        return {
            uri,
            isFile: result.type === 'file',
            isDirectory: result.type === 'directory'
        };
    }

    statSync(): FileSystemNode {
        throw new Error('Synchronous file system access is not available in the browser.');
    }

    async exists(uri: URI): Promise<boolean> {
        try {
            await this.stat(uri);
            return true;
        } catch {
            return false;
        }
    }

    existsSync(): boolean {
        return false;
    }

    async readBinary(uri: URI): Promise<Uint8Array> {
        const content = await this.readFile(uri);
        return textEncoder.encode(content);
    }

    readBinarySync(): Uint8Array {
        throw new Error('Synchronous file system access is not available in the browser.');
    }

    async readFile(uri: URI): Promise<string> {
        const content = await this.connection.sendRequest<string | Uint8Array | ArrayBuffer | null>(FsRequests.readFile, { uri: uri.toString() });
        if (typeof content === 'string') {
            return content;
        }
        if (content instanceof Uint8Array) {
            return textDecoder.decode(content);
        }
        if (content instanceof ArrayBuffer) {
            return textDecoder.decode(new Uint8Array(content));
        }
        throw new Error(`Unexpected response for ${uri.toString()}`);
    }

    readFileSync(): string {
        throw new Error('Synchronous file system access is not available in the browser.');
    }

    async readDirectory(uri: URI): Promise<FileSystemNode[]> {
        const entries = await this.connection.sendRequest<FsDirectoryEntry[]>(FsRequests.readDirectory, { uri: uri.toString() }) ?? [];
        return entries.map(entry => ({
            uri: URI.parse(entry.uri),
            isFile: entry.type === 'file',
            isDirectory: entry.type === 'directory'
        }));
    }

    readDirectorySync(): FileSystemNode[] {
        return [];
    }
}

export const BrowserFileSystem = (connection: Connection) => ({
    fileSystemProvider: () => new BrowserFileSystemProvider(connection)
});
