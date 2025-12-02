import { startLanguageServer } from 'langium/lsp';
import { NodeFileSystem } from 'langium/node';
import { createConnection, ProposedFeatures, RequestType } from 'vscode-languageserver/node.js';
import { createOmlServices, isOntology } from 'oml-language';
import type { SModelRoot } from 'sprotty-protocol';
import { computeLaidOutSModelForUri } from './diagram-layout.js';

// Create a connection to the client
const connection = createConnection(ProposedFeatures.all);

// Inject the shared services and language-specific services
const { shared } = createOmlServices({ connection, ...NodeFileSystem });

// Custom request: fetch a laid-out Sprotty SModel for a given document URI
const DiagramModelRequest = new RequestType<{ uri: string }, SModelRoot, void>('oml/diagramModel');

connection.onRequest(DiagramModelRequest, async ({ uri }) => {
	try {
		return await computeLaidOutSModelForUri(shared, uri);
	} catch (err) {
		// Return an empty model on failure to keep the client resilient
		console.error('[oml] diagram model error', err);
	return { id: 'root', type: 'graph', children: [] } as unknown as SModelRoot;
	}
});

// Custom request: navigate to an element in the source file
const NavigateToElementRequest = new RequestType<
	{ uri: string; elementId: string }, 
	{ uri?: string; startLine: number; startColumn: number; endLine: number; endColumn: number } | null, 
	void
>('oml/navigateToElement');

connection.onRequest(NavigateToElementRequest, async ({ uri, elementId }) => {
	try {
		console.log('[oml] Navigate request:', { uri, elementId });
		
		// Parse the URI and get the document
		const { URI } = await import('langium');
		const parsedUri = URI.parse(uri);
		const document = await shared.workspace.LangiumDocuments.getOrCreateDocument(parsedUri);
		
		if (!document || !document.parseResult?.value) {
			console.log('[oml] Document not found or not parsed');
			return null;
		}
		
		const root: any = document.parseResult.value;
		console.log('[oml] Searching for element in', root.ownedStatements?.length || 0, 'statements');
		
		// Check if this is an edge ID or equivalence group ID
		// New ID schemes:
		// - Specialization: [sub]->[super]
		// - Direct equivalence: [sub]<->[super]
		// - Equivalence group node: [sub]<->[index]
		// - Equivalence group edges: [sub]<->[index]-edge#
		// - Relation entity edges: qualifiedName-edge1 or qualifiedName-edge2
		// - Unreified relation: qualifiedName (direct edge)
		let memberName = elementId;

		// If the clicked id looks like an ontology namespace / IRI, try to navigate to the ontology declaration.
		if (typeof elementId === 'string' && (elementId.includes('://') || elementId.startsWith('http') || elementId.includes('/'))) {
			// Check the current document first
			if (root?.ownedStatements) {
				for (const stmt of root.ownedStatements) {
					if (isOntology(stmt) && stmt.namespace === elementId) {
						const cstNode = stmt.$cstNode;
						if (cstNode && document.textDocument) {
							const startPosition = document.textDocument.positionAt(cstNode.offset);
							const endPosition = document.textDocument.positionAt(cstNode.offset + cstNode.length);
							return {
								uri: uri,
								startLine: startPosition.line + 1,
								startColumn: startPosition.character,
								endLine: endPosition.line + 1,
								endColumn: endPosition.character
							};
						}
					}
				}
			}

			// Recursively search imports for the ontology
			const visited = new Set<string>();
			function findImportedOntology(docRoot: any): any | undefined {
				for (const imp of docRoot.ownedImports ?? []) {
					const imported = imp.imported?.ref;
					if (!imported || !imported.namespace) continue;
					if (visited.has(imported.namespace)) continue;
					visited.add(imported.namespace);
					if (imported.namespace === elementId) return imported;
					const found = findImportedOntology(imported);
					if (found) return found;
				}
				return undefined;
			}

			const importedOntology = findImportedOntology(root);
			if (importedOntology) {
				const importedDoc = importedOntology.$document;
				if (importedDoc && importedOntology.$cstNode && importedDoc.textDocument) {
					const cstNode = importedOntology.$cstNode;
					const startPosition = importedDoc.textDocument.positionAt(cstNode.offset);
					const endPosition = importedDoc.textDocument.positionAt(cstNode.offset + cstNode.length);
					return {
						uri: importedDoc.uri.toString(),
						startLine: startPosition.line + 1,
						startColumn: startPosition.character,
						endLine: endPosition.line + 1,
						endColumn: endPosition.character
					};
				}
			}
		}
		
		// Check for specialization edge: [sub]->[super]
		// Note: brackets are literal characters in the ID, need to escape them in regex
		let match = elementId.match(/^\\[(.+?)\")->\\[.+?\"]$/);
		if (match) {
			memberName = match[1];
			console.log('[oml] Specialization edge detected, navigating to:', memberName);
		}
		// Check for direct equivalence edge: [sub]<->[super]
		else if ((match = elementId.match(/^\\[(.+?)\"]<->\\[.+?\"]$/))) {
			memberName = match[1];
			console.log('[oml] Direct equivalence edge detected, navigating to:', memberName);
		}
		// Check for equivalence group node: [sub]<->[index]
		else if ((match = elementId.match(/^\\[(.+?)\"]<->\\[\d+\"]$/))) {
			memberName = match[1];
			console.log('[oml] Equivalence group node detected, navigating to:', memberName);
		}
		// Check for equivalence group edge: [sub]<->[index]-edge#
		else if ((match = elementId.match(/^\\[(.+?)\"]<->\\[\d+\"]-edge\d+$/))) {
			memberName = match[1];
			console.log('[oml] Equivalence group edge detected, navigating to:', memberName);
		}
		// Check for relation entity edge: qualifiedName-edge1 or qualifiedName-edge2
		else if (elementId.endsWith('-edge1') || elementId.endsWith('-edge2')) {
			memberName = elementId.replace(/-edge[12]$/, '');
			console.log('[oml] Relation entity edge detected, navigating to:', memberName);
		}
		// Check for description relation instance edges: qualifiedName-source-edge# or qualifiedName-target-edge#
		else if ((match = elementId.match(/^(.+?)-(source|target)-edge\d+$/))) {
			memberName = match[1];
			console.log('[oml] Description relation instance edge detected, navigating to:', memberName);
		}
		// Otherwise, assume it's a direct member name (node or unreified relation edge)
		else {
			console.log('[oml] Direct member name:', memberName);
		}
		
		// Check if this is a qualified name (imported member) like "base:Named"
		let targetDocument = document;
		let targetMemberName = memberName;
		
		if (memberName.includes(':')) {
			const [prefix, simpleName] = memberName.split(':');

			// Find the import with this prefix
			if (root.ownedImports) {
				for (const imp of root.ownedImports) {
					if (imp?.prefix === prefix && imp?.imported?.ref) {
						const importedOntology = imp.imported.ref;
						const importedDoc = importedOntology?.$document;
						if (importedDoc) {
							targetDocument = importedDoc;
							targetMemberName = simpleName;

							// Update the URI to return for navigation
							uri = importedDoc.uri.toString();
							break;
						}
					}
				}
			}
		}
		
		// Search for a member by name in the target document
		const targetRoot: any = targetDocument.parseResult?.value;
		if (targetRoot?.ownedStatements) {
			for (const stmt of targetRoot.ownedStatements) {
				// Check if this statement matches the member name
				if (stmt?.name === targetMemberName) {
					const cstNode = stmt.$cstNode;
					if (cstNode && targetDocument.textDocument) {
						const startPosition = targetDocument.textDocument.positionAt(cstNode.offset);
						const endPosition = targetDocument.textDocument.positionAt(cstNode.offset + cstNode.length);
						return {
							uri,
							startLine: startPosition.line + 1,
							startColumn: startPosition.character,
							endLine: endPosition.line + 1,
							endColumn: endPosition.character
						};
					}
				}
			}
		}
		
		console.log('[oml] Element not found:', elementId);
		return null;
	} catch (err) {
		console.error('[oml] navigate to element error', err);
		return null;
	}
});

// Start the language server with the shared services
startLanguageServer(shared);
