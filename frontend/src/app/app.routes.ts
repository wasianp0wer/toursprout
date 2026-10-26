import { Routes } from '@angular/router';
import { EntryPage } from './entry/entry-page';
import { ViewerPage } from './viewer/viewer-page';

/**
 * '' is `EntryPage`, which works out which of three audiences has arrived —
 * the public reading a published tour, an author with a tour open, an author
 * with nothing open — and it is loaded eagerly for the reason '' was
 * eagerly the viewer before it: the published-site visitor is the dominant
 * real consumer, and should not pay for a second, sequential chunk fetch
 * before `tour-data/` can even start loading. `EntryPage` keeps that
 * promise by mounting `ViewerPage` immediately, concurrently with its probe,
 * so the eagerness still buys what it used to. It stays small for the same
 * reason; the welcome screen it can show instead is the lazy chunk, since
 * only an author ever reaches it.
 *
 * 'view' is the viewer with no probe and no redirect, for an author who
 * wants to see their open tour as a reader will: '' would send them back to
 * '/edit'. It must come before the wildcard.
 *
 * 'edit' is the authoring tool. It stays
 * lazy — there is no reason to make every published-site visitor download
 * editor code they can never use. Making both routes eager, or both lazy,
 * looks tidier and is a regression for one audience or the other.
 *
 * '**' is insurance for the viewer. With `<base href="./">` a published site
 * opened as `https://host/tour/index.html` leaves the router the remainder
 * `index.html`, which matches neither '' nor 'edit'; without a wildcard that
 * is a blank page. Static hosts that do not rewrite directory requests, and
 * unzip-and-serve, both produce that URL. It is `ViewerPage` and not
 * `EntryPage` because such a URL only ever comes from a published site, and
 * it must stay last.
 */
export const routes: Routes = [
  {
    path: '',
    component: EntryPage,
  },
  {
    path: 'view',
    component: ViewerPage,
  },
  {
    path: 'edit',
    loadComponent: () => import('./editor/editor-page').then((m) => m.EditorPage),
  },
  {
    path: '**',
    component: ViewerPage,
  },
];
