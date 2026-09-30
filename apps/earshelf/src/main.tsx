import '@fontsource-variable/inter';
import '@fontsource-variable/literata';
import '@wells/design-tokens/tokens.css';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { installGlobalHandlers } from './monitor';

registerSW({ immediate: true });
installGlobalHandlers();
createRoot(document.getElementById('root')!).render(<StrictMode><ErrorBoundary><App /></ErrorBoundary></StrictMode>);
