import { createAcfField, createAcfGroup } from 'xph-wordpress/acf';

export const heroField = createAcfField({
	type: 'group',
	name: 'hero',
	label: 'Hero',
	sub_fields: [
		{ type: 'text', name: 'title', label: 'Title' },
		{ type: 'textarea', name: 'text', label: 'Text' },
		{ type: 'link', name: 'cta', label: 'Call to action' },
	],
});

export const landing = createAcfGroup({
	key: 'landing_page',
	title: 'Landing Page',
	fields: [heroField],
	location: [[{ param: 'page_template', operator: '==', value: 'landing.php' }]],
});
