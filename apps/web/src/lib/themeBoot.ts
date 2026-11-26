/** Inline <head> script: set <html data-theme> and data-palette before first paint (no flash). Keep keys in sync with theme.ts / PalettePicker. */
export const THEME_KEY = 'chapi-theme';
export const PALETTE_KEY = 'chapi-palette';
export const THEME_BOOT_SCRIPT = `try{var d=document.documentElement;var t=localStorage.getItem('${THEME_KEY}');if(t==='light'||t==='dark')d.dataset.theme=t;var p=localStorage.getItem('${PALETTE_KEY}');d.dataset.palette=/^(amber|harbour|sage|slate|terracotta)$/.test(p||'')?p:'amber';}catch(e){document.documentElement.dataset.palette='amber';}`;
