import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, type View } from './App.js';
import './tokens.css';
import './main.css';
import './interact.css';
import './manage.css';
import './remember.css';
import './shell.css';
import './home.css';
import './orch.css';

// Both windows load this bundle; main picks the layout with ?view=main|widget.
const view: View = new URLSearchParams(window.location.search).get('view') === 'widget' ? 'widget' : 'main';
document.body.dataset['view'] = view;
document.title = view === 'widget' ? 'Agent Huddle widget' : 'Agent Huddle';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App view={view} />
    </StrictMode>,
  );
}
