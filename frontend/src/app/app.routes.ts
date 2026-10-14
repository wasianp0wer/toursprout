import { Routes } from '@angular/router';

/**
 * '' is the published-site viewer; 'edit' is the authoring tool this
 * sub-project is building. Both load lazily, which costs nothing here but
 * keeps either from pulling the other's code into a bundle that does not
 * need it.
 */
export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./viewer/viewer-page').then((m) => m.ViewerPage),
  },
  {
    path: 'edit',
    loadComponent: () => import('./editor/editor-page').then((m) => m.EditorPage),
  },
];
