import { createRoot } from 'react-dom/client';
import { boot } from './actions.ts';
import { App } from './App.tsx';
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/chat.css';
import './styles/pages.css';
import './styles/touch.css';

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
