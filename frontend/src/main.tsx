import React from 'react';
import ReactDOM from 'react-dom/client';
import { Toaster } from 'react-hot-toast';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
    <Toaster
      position="top-center"
      toastOptions={{
        duration: 3000,
        style: {
          background: '#1a1a1a',
          color: '#fff',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          borderRadius: '12px',
          padding: '12px 16px',
          fontFamily: 'IBM Plex Sans, system-ui, sans-serif',
        },
        success: {
          iconTheme: {
            primary: '#10b981',
            secondary: '#1a1a1a',
          },
        },
        error: {
          iconTheme: {
            primary: '#ef4444',
            secondary: '#1a1a1a',
          },
        },
      }}
    />
  </React.StrictMode>
);
