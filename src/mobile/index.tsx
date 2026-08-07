import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './mobile.css';

const container = document.getElementById('root');
if (!container) throw new Error('missing #root');

createRoot(container).render(<React.StrictMode><App /></React.StrictMode>);

// Registration is deliberately not awaited and its failure is not fatal: the
// service worker only makes the shell load offline, and a vault that refuses to
// open because a cache could not be installed would be a worse trade.
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('service-worker.js').catch((e: Error) => {
            console.warn('offline shell unavailable:', e.message);
        });
    });
}
