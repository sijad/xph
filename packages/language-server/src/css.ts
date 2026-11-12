import {
	getCSSLanguageService,
	getSCSSLanguageService,
	getLESSLanguageService,
	type Position,
	type Stylesheet,
} from 'vscode-css-languageservice';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { HTMLDocument, Node } from 'vscode-html-languageservice';

const services = {
	css: getCSSLanguageService(),
	scss: getSCSSLanguageService(),
	less: getLESSLanguageService(),
};

function language(source: string, node: Node) {
	const opening = source.slice(node.start, node.startTagEnd);
	const match = /\slang\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(opening);
	return (match?.[1] ?? match?.[2] ?? match?.[3] ?? 'css').toLowerCase();
}

export class StylesheetLanguageService {
	private cache = new Map<
		string,
		{
			source: string;
			language: string;
			document: TextDocument;
			stylesheet: Stylesheet;
		}
	>();
	close(uri: string) {
		this.cache.delete(uri);
	}
	query(
		method: string,
		uri: string,
		source: string,
		version: number,
		position: Position,
		html: HTMLDocument,
		node: Node,
	) {
		const dialect = language(source, node);
		if (dialect !== 'css' && dialect !== 'scss' && dialect !== 'less') return null;
		const service = services[dialect];
		let cached = this.cache.get(uri);
		if (!cached || cached.source !== source || cached.language !== dialect) {
			// Mask markup without moving UTF-16 offsets, so edits and definitions use
			// the original buffer coordinates, including CRLF and astral characters.
			let text = source.replace(/[^\r\n]/g, ' ');
			const visit = (nodes: Node[]) => {
				for (const block of nodes) {
					if (
						block.tag === 'style' &&
						block.startTagEnd !== undefined &&
						language(source, block) === dialect
					) {
						const start = block.startTagEnd;
						const end = block.endTagStart ?? block.end;
						text = text.slice(0, start) + source.slice(start, end) + text.slice(end);
					} else visit(block.children);
				}
			};
			visit(html.roots);
			const document = TextDocument.create(uri, dialect, version, text);
			cached = {
				source,
				language: dialect,
				document,
				stylesheet: service.parseStylesheet(document),
			};
			this.cache.set(uri, cached);
		}
		const { document, stylesheet } = cached;
		if (method === 'textDocument/completion')
			return service.doComplete(document, position, stylesheet);
		if (method === 'textDocument/hover') return service.doHover(document, position, stylesheet);
		if (method === 'textDocument/definition')
			return service.findDefinition(document, position, stylesheet);
		return null;
	}
}
