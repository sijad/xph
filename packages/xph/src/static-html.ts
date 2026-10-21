/** Compile-time equivalents of the runtime's scalar HTML serialization. */
export function escapeHTML(value: unknown): string {
	if (value == null || typeof value === 'boolean') return '';
	if (typeof value !== 'string' && typeof value !== 'number')
		throw new Error('Only scalar values can be escaped');
	return String(value).replace(
		/[&<>"']/g,
		(character) =>
			({
				'&': '&amp;',
				'<': '&lt;',
				'>': '&gt;',
				'"': '&quot;',
				"'": '&#039;',
			})[character]!,
	);
}

const booleanAttributes = new Set(
	'allowfullscreen async autofocus autoplay checked controls default defer disabled formnovalidate hidden inert ismap itemscope loop multiple muted nomodule novalidate open playsinline readonly required reversed selected'.split(
		' ',
	),
);
const urlAttributes = new Set(
	'href src action formaction poster data background cite longdesc manifest codebase profile xlink:href'.split(
		' ',
	),
);
const urlLists = new Set('srcset imagesrcset ping archive'.split(' '));
function safeUrl(value: string, name: string, tag: string): void {
	// Match the URL parser's C0 trimming, including NUL.
	// eslint-disable-next-line no-control-regex
	const url = value.replace(/[\t\r\n]/g, '').replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '');
	const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
	if (
		scheme === 'data' &&
		tag === 'img' &&
		name === 'src' &&
		/^data:image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon);base64,[a-z0-9+/=\t\n\v\f\r ]*$/i.test(url)
	)
		return;
	if (scheme && ['javascript', 'vbscript', 'data'].includes(scheme))
		throw new Error('Unsafe URL scheme in ' + name);
}

export function staticAttribute(name: string, value: unknown, tag: string): string {
	const lower = name.toLowerCase();
	if (!/^[a-zA-Z_][\w:.-]*$/.test(name) || lower.startsWith('on') || lower === 'srcdoc')
		throw new Error('Unsupported HTML attribute: ' + name);
	if (value == null) return '';
	if (!['string', 'number', 'boolean'].includes(typeof value))
		throw new Error('HTML attributes require scalar values');
	const text = value === false ? '' : value === true ? '1' : String(value);
	if (urlAttributes.has(lower)) safeUrl(text, lower, tag.toLowerCase());
	else if (urlLists.has(lower))
		for (const url of text.split(/[\t\n\v\f\r ,]+/).filter(Boolean))
			safeUrl(url, lower, tag.toLowerCase());
	if (lower.startsWith('aria-') || lower.startsWith('data-')) {
		if (typeof value === 'boolean') value = value ? 'true' : 'false';
	} else if (booleanAttributes.has(lower)) return value === false ? '' : ' ' + name;
	else if (value === false) return '';
	if (value === true) value = 'true';
	return ' ' + name + '="' + escapeHTML(value) + '"';
}
