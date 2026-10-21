export function initializeCountdowns(): void {
	for (const countdown of document.querySelectorAll<HTMLElement>('[data-countdown]')) {
		const value = countdown.querySelector<HTMLOutputElement>('[data-countdown-value]');
		const button = countdown.querySelector<HTMLButtonElement>('[data-countdown-start]');
		if (!value || !button) continue;

		const duration = Number(value.textContent);
		let timer: ReturnType<typeof setInterval> | undefined;
		button.addEventListener('click', () => {
			clearInterval(timer);
			let remaining = duration;
			value.textContent = String(remaining);
			button.textContent = 'Restart countdown';
			timer = setInterval(() => {
				remaining -= 1;
				value.textContent = String(remaining);
				if (remaining === 0) clearInterval(timer);
			}, 1000);
		});
	}
}
