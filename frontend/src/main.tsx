import { createRoot } from 'react-dom/client';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import App from './App';

// Outside the Wails shell (plain `npm run dev` in a browser) use an
// in-memory backend so the UI can be developed without Go.
async function boot() {
  if (!window.go) {
    const { installMock } = await import('./mock');
    installMock();
  }
  createRoot(document.getElementById('root')!).render(<App />);
}

void boot();
