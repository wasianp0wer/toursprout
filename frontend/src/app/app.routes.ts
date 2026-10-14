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
];
