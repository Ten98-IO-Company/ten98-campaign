(() => {
  let theme = 'system';
  try {
    const saved = localStorage.getItem('ten98-campaign-theme');
    if (saved === 'light' || saved === 'dark') theme = saved;
  } catch {}
  document.documentElement.dataset.theme = theme;
})();
