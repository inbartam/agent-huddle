/**
 * Both windows load this bundle; `view` picks the layout. One store per window, started once.
 * Every agent string is rendered as a React text node (docs/SECURITY.md).
 */
import { useEffect, useState } from 'react';
import { HuddleStore } from './store.js';
import { MainView } from './views/MainView.js';
import { ViewModeProvider } from './viewMode.js';
import { WidgetView } from './views/WidgetView.js';

export type View = 'main' | 'widget';

export function App({ view }: { view: View }) {
  const [store] = useState(() => new HuddleStore(window.huddle));
  useEffect(() => store.start(), [store]);
  return view === 'widget' ? (
    <WidgetView store={store} />
  ) : (
    <ViewModeProvider>
      <MainView store={store} />
    </ViewModeProvider>
  );
}
