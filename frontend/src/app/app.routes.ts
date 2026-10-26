import { Routes } from '@angular/router';
import { ViewerPage } from './viewer/viewer-page';

/**
 * '' is the published-site viewer — the dominant real consumer, who never
 * reaches '/edit' and for whom the editor's `/api` calls could not work
 * anyway, since a published site has no backend. It is loaded eagerly: a
 * visitor who just navigated to the site should not pay for a second,
 * sequential chunk fetch before `ViewerPage` can even start fetching
 * tour-data/ for real.
 *
 * 'edit' is the authoring tool this sub-project is building. It stays
 * lazy — there is no reason to make every published-site visitor download
 * editor code they can never use.
 *
 * '**' is insurance for the viewer. With `<base href="./">` a published site
 * opened as `https://host/tour/index.html` leaves the router the remainder
 * `index.html`, which matches neither '' nor 'edit'; without a wildcard that
 * is a blank page. Static hosts that do not rewrite directory requests, and
 * unzip-and-serve, both produce that URL. It must stay last.
 */
export const routes: Routes = [
  {
    path: '',
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
