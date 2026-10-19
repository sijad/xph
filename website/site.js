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
