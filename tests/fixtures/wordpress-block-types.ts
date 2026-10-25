import { defineBlock } from '../../packages/xph-wordpress/src/index.js';

interface Props {
	title: string;
	count: number;
	size: 'small' | 'large';
	optional?: boolean;
}
const attributes = {
	title: { default: 'Hello', control: 'Title' },
	count: { default: 1 },
	size: { default: 'small' as const },
};
const valid = defineBlock<Props>({
	name: 'example/card',
	title: 'Card',
	apiVersion: 3,
	attributes: { ...attributes, optional: { control: false } },
	supports: { html: false, spacing: { margin: ['top', 'bottom'] }, color: { text: true } },
	variations: [
		{ name: 'large', title: 'Large', attributes: { size: 'large' }, isActive: ['size'] },
	],
});
const title: string = valid.metadata.attributes.title.default;
void title;
// @ts-expect-error only v3
defineBlock<Props>({ name: 'example/card', title: 'Card', apiVersion: 2, attributes });
defineBlock<Props>({
	name: 'example/card',
	title: 'Card',
	// @ts-expect-error defaults match Props
	attributes: { ...attributes, count: { default: 'bad' } },
});
// @ts-expect-error required props need defaults
defineBlock<Props>({ name: 'example/card', title: 'Card' });
defineBlock<Props>({
	name: 'example/card',
	title: 'Card',
	// @ts-expect-error enums match literal unions
	attributes: { ...attributes, size: { default: 'small', enum: ['huge'] } },
});
defineBlock<Props>({
	name: 'example/card',
	title: 'Card',
	// @ts-expect-error the declared type matches Props
	attributes: { ...attributes, title: { default: '', type: 'number' } },
});
defineBlock<Props>({
	name: 'example/card',
	title: 'Card',
	// @ts-expect-error controls reference actual props through attribute keys
	attributes: { ...attributes, typo: { control: 'Typo' } },
});
defineBlock<Props>({
	name: 'example/card',
	title: 'Card',
	// @ts-expect-error controls accept labels or false
	attributes: { ...attributes, title: { default: '', control: true } },
});
defineBlock<Props>({
	name: 'example/card',
	title: 'Card',
	attributes,
	// @ts-expect-error supports use the official schema types
	supports: { html: 'false' },
});
defineBlock<Props>({
	name: 'example/card',
	title: 'Card',
	attributes,
	// @ts-expect-error nested support values are typed
	supports: { spacing: { margin: ['diagonal'] } },
});
// @ts-expect-error generated render paths cannot be overridden
defineBlock<Props>({ name: 'example/card', title: 'Card', attributes, render: 'file:custom.php' });
// @ts-expect-error top-level misspellings are rejected
defineBlock<Props>({ name: 'example/card', title: 'Card', attributes, titlle: 'Typo' });
defineBlock<Props>({
	name: 'example/card',
	title: 'Card',
	attributes,
	// @ts-expect-error variation attribute values match Props
	variations: [{ name: 'bad', title: 'Bad', attributes: { size: 'huge' } }],
});
