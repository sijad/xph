for (const button of document.querySelectorAll('[data-copy]')) {
	button.addEventListener('click', async () => {
		const code = button.closest('.code-block').querySelector('pre code').textContent;
		const status = document.querySelector('#copy-status');
		try {
			await navigator.clipboard.writeText(code);
			button.textContent = 'Copied!';
			status.textContent = 'Code copied to clipboard.';
		} catch {
			button.textContent = 'Select code';
			const selection = window.getSelection();
			const range = document.createRange();
			range.selectNodeContents(button.closest('.code-block').querySelector('pre code'));
			selection.removeAllRanges();
			selection.addRange(range);
			status.textContent = 'Code selected. Use your keyboard to copy it.';
		}
		setTimeout(() => {
			button.textContent = 'Copy';
		}, 2000);
	});
}

const tickerTrack = document.querySelector('.feature-ticker-track');
if (tickerTrack) {
	const group = tickerTrack.querySelector('.feature-ticker-group');
	const originalItems = [...group.children].map((item) => item.cloneNode(true));
	const fillTicker = () => {
		while (group.scrollWidth < tickerTrack.clientWidth) {
			for (const item of originalItems) {
				const copy = item.cloneNode(true);
				copy.setAttribute('aria-hidden', 'true');
				group.append(copy);
			}
		}
		const duplicate = group.cloneNode(true);
		duplicate.setAttribute('aria-hidden', 'true');
		tickerTrack.lastElementChild.replaceWith(duplicate);
	};
	new ResizeObserver(fillTicker).observe(tickerTrack);
	document.fonts.ready.then(fillTicker);
}
