// theme.js — apply 'dark' | 'light' to <html data-theme>

export const applyTheme = (theme = 'dark') => {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
};
