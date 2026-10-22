// The reference uses Markdown headings, paragraphs with inline code,
// and fenced examples. Keep the website's layout here rather than in the content.
const escape = (text) =>
	text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const inline = (text) =>
	text
		.split(/(`[^`]+`)/g)
		.map((part) =>
			part.startsWith('`') ? `<code>${escape(part.slice(1, -1))}</code>` : escape(part),
		)
		.join('');

export function renderReference(markdown) {
	const groups = [];
	let group;
	let article;
	const ids = new Set();
	const headingId = (title) => {
		const slug = title
			.toLowerCase()
			.replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, '')
			.replaceAll(' ', '-');
		let id = slug;
		let suffix = 0;
		while (ids.has(id)) id = `${slug}-${++suffix}`;
		ids.add(id);
		return id;
	};
	const lines = markdown.trim().split('\n');
	if (lines.shift() !== '# Syntax reference') throw new Error('Missing reference title.');
	while (lines.length) {
		const line = lines.shift();
		if (!line) continue;
		const heading = /^(#{2,3}) (.+)$/.exec(line);
		if (heading) {
			const id = headingId(heading[2]);
			if (heading[1] === '##') {
				group = { id, title: inline(heading[2]), articles: [] };
				groups.push(group);
				article = undefined;
			} else {
				if (!group) throw new Error('Reference topic needs a group.');
				article = { id, title: inline(heading[2]), paragraphs: [] };
				group.articles.push(article);
			}
			continue;
		}
		if (!article) throw new Error('Reference content needs a topic.');
		if (line.startsWith('```')) {
			if (article.code !== undefined) throw new Error('Only one example per reference topic.');
			article.language = line.slice(3);
			const code = [];
			while (lines.length && lines[0] !== '```') code.push(lines.shift());
			if (lines.shift() !== '```') throw new Error('Unclosed reference example.');
			article.code = escape(code.join('\n'));
		} else {
			const paragraph = [line];
			while (lines.length && lines[0]) paragraph.push(lines.shift());
			article.paragraphs.push(paragraph.map((text) => '\t'.repeat(10) + inline(text)).join('\n'));
		}
	}
	if (!groups.length || groups.some((item) => !item.articles.length))
		throw new Error('Empty reference group.');
	const t = '\t';
	return `${t.repeat(5)}<nav class="syntax-topics" aria-label="Syntax sections">\n${groups.map((item) => `${t.repeat(6)}<a href="#${item.id}">${item.title}</a>`).join('\n')}\n${t.repeat(5)}</nav>\n${groups
		.map(
			(item) =>
				`${t.repeat(5)}<section class="syntax-group" aria-labelledby="${item.id}">\n${t.repeat(6)}<h3 id="${item.id}">${item.title}</h3>\n${t.repeat(6)}<div class="steps">\n${item.articles
					.map((topic) => {
						if (topic.code === undefined) throw new Error(`Missing example for ${topic.id}.`);
						return `${t.repeat(7)}<article class="step" id="${topic.id}">\n${t.repeat(8)}<div>\n${t.repeat(9)}<h4>${topic.title}</h4>\n${topic.paragraphs.map((paragraph) => `${t.repeat(9)}<p>\n${paragraph}\n${t.repeat(9)}</p>`).join('\n')}\n${t.repeat(8)}</div>\n${t.repeat(8)}<div class="code-block">\n${t.repeat(9)}<pre><code data-language="${escape(topic.language)}">${topic.code}</code></pre>\n${t.repeat(8)}</div>\n${t.repeat(7)}</article>`;
					})
					.join('\n')}\n${t.repeat(6)}</div>\n${t.repeat(5)}</section>`,
		)
		.join('\n')}`;
}
