import { phpLiteral } from './contracts.js';

/** The Vite loader exports this descriptor instead of executing a component in JavaScript. */
export interface PhpComponent {
	xph: true;
	development?: boolean;
	php?: string;
	runtime?: string;
	id: string;
}

export const markerPattern = /<!--xph:([A-Za-z0-9+/=]+)-->/g;

export interface PhpRender {
	id: string;
	props: Record<string, unknown>;
	slot?: string;
}

function serializable(value: unknown, ancestors = new Set<object>()): boolean {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
	if (typeof value === 'number') return Number.isFinite(value);
	if (typeof value !== 'object' || ancestors.has(value)) return false;
	if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return false;
	ancestors.add(value);
	const valid = Object.values(value).every((item) => serializable(item, ancestors));
	ancestors.delete(value);
	return valid;
}

export default {
	name: 'xph',
	supportsAstroStaticSlot: true,
	check(component: unknown) {
		return (component as PhpComponent | null)?.xph === true;
	},
	async renderToStaticMarkup(
		component: PhpComponent,
		props: Record<string, unknown>,
		slots: Record<string, string>,
	) {
		if (Object.keys(slots).some((name) => name !== 'default'))
			throw new Error('xph components support only the default slot.');
		if (!serializable(props))
			throw new Error('xph component props must be JSON-serializable values.');
		if (component.development) {
			const body = (component.php ?? '').replace(/^<\?php\s*declare\(strict_types=1\);\s*/, '');
			const slot =
				slots.default === undefined
					? 'null'
					: `static function (): string { ob_start(); ?>${slots.default}<?php return ob_get_clean(); }`;
			return {
				html: `<?php\nrequire_once ${phpLiteral(component.runtime)};\necho (static function () {\n${body}})()(${phpLiteral(props)}, ${slot});\n?>`,
			};
		}
		const payload: PhpRender = { id: component.id, props, slot: slots.default };
		return { html: `<!--xph:${Buffer.from(JSON.stringify(payload)).toString('base64')}-->` };
	},
};
