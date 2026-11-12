import { createRoot } from 'react-dom/client';
import { boot } from './actions.ts';
import { App } from './App.tsx';
import '@fontsource-variable/bricolage-grotesque/wght.css';
import '@fontsource-variable/geist/wght.css';
import '@fontsource-variable/geist-mono/wght.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/controls.css';
import './styles/chrome.css';
import './styles/chat.css';
import './styles/pages.css';

// Keep the layout inside the visible area when a mobile keyboard opens (the composer stays reachable).
const viewport = window.visualViewport;
if (viewport) {
  const sync = () => document.documentElement.style.setProperty('--app-height', `${Math.round(viewport.height)}px`);
  viewport.addEventListener('resize', sync);
  sync();
}

void boot();

const root = document.getElementById('root');
if (root) {
  // No StrictMode: its dev-only double mount would push and pop the history entries that let the
  // Android back button close overlays (see useBackToClose).
  createRoot(root).render(<App />);
}
