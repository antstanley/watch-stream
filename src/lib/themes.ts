/** Built-in palettes. Their tokens live in themes.css. */
export const THEMES = [
	{ id: 'midnight', name: 'Midnight', mode: 'dark' },
	{ id: 'ocean', name: 'Ocean', mode: 'dark' },
	{ id: 'forest', name: 'Forest', mode: 'dark' },
	{ id: 'plum', name: 'Plum', mode: 'dark' },
	{ id: 'daylight', name: 'Daylight', mode: 'light' },
	{ id: 'sand', name: 'Sand', mode: 'light' },
	{ id: 'mint', name: 'Mint', mode: 'light' },
	{ id: 'lavender', name: 'Lavender', mode: 'light' },
] as const;
export type ThemeId = (typeof THEMES)[number]['id'];
export const THEME_STORAGE_KEY = 'watch-tail:theme';

/** Unknown or obsolete preferences fall back to Midnight. */
export function parseTheme(value: string | null): ThemeId {
	return THEMES.find((theme) => theme.id === value)?.id ?? 'midnight';
}
